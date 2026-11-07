"""Appeals: a user disputes one criterion, GPT reassesses it, a manager decides.

1. ``create`` stores the appeal with the disputed result and a snapshot of the criterion as configured in the
   evaluation's checklist version, then queues a reassessment.
2. A reassessment is a new, separate call to the reassessor adapter (GPT, ``ATLAS_CQA_REASSESSOR``) with the
   original transcript, that criterion, the disputed result and the appeal (see reassessment.py). Its answer is
   validated against the stored configuration. A failure is recorded with its reason and can be retried a limited
   number of times (``reassess``). A reassessment never decides anything and never rejects an appeal.
3. ``decide``: the manager keeps the disputed result (confirm), accepts GPT's recommendation (accept, taken from
   the stored reassessment) or sets another allowed answer (override), always with an explanation. A changed
   answer is stored as an override, never as a score: the scoring engine recomputes the final result from the
   original answers plus the overrides, with the evaluation's own checklist snapshot (weights, scales, N/A
   redistribution, critical errors kept separate).

The original evaluation, the disputed result, every reassessment attempt with GPT's recommendation, the decision and
the totals before and after are all kept, and every step is written to the audit trail.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError, ValidationFailed
from app.cqa.adapters import EvaluatorAdapter, EvaluatorError
from app.cqa.contract import evidence_ref
from app.cqa.evaluations import EvaluationService, _jsonable
from app.cqa.reassessment import build_reassessment_request, check_reassessment, flag_allowed, same_value
from app.cqa.schemas import (
    Appeal,
    AppealCreate,
    AppealDecision,
    AppealDecisionIn,
    AppealDetail,
    Criterion,
    CriterionResult,
    EvaluationError,
    EvaluationRecord,
    Message,
    Override,
    OverrideAnswer,
    Reassessment,
    RecommendationImpact,
)
from app.cqa.scoring import AnswerError, answer_score, apply_overrides, compute_score
from app.cqa.store import CqaStore, now_iso
from app.storage.paths import check_id, new_id

logger = logging.getLogger("atlas.cqa")
CONTEXT_RADIUS = 2
MAX_CONTEXT = 40
MAX_REASSESSMENTS = 3  # reassessment attempts that may reach the model per appeal; no loops, no unbounded retries
# Failures that happen before any model call (they do not count towards MAX_REASSESSMENTS).
NO_CALL_CODES = frozenset({"reassessor_unavailable", "evaluator_not_configured", "transcript_changed",
                           "conversation_missing", "evaluation_missing", "criterion_missing"})


class AppealService:
    def __init__(self, store: CqaStore, evaluations: EvaluationService, adapters: dict[str, EvaluatorAdapter],
                 settings: Settings) -> None:
        self.store = store
        self.evaluations = evaluations
        self.adapters = adapters
        self.settings = settings
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cqa-appeal")
        self._recover()

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)

    def _recover(self) -> None:
        """After a restart: re-queue reassessments that never started, fail the ones that were mid-call."""
        for appeal in list(self.store.appeals.values()):
            latest = appeal.reassessment
            if appeal.status != "pending" or latest is None:
                continue
            if latest.status == "running":
                self._finish(appeal.id, latest.id, error=EvaluationError(
                    code="interrupted", message="The API restarted while GPT was reassessing this appeal. Retry."))
            elif latest.status == "pending":
                self.pool.submit(self._run, appeal.id, latest.id)

    # ---- reads --------------------------------------------------------------------------------
    def get(self, appeal_id: str) -> Appeal:
        check_id(appeal_id)
        appeal = self.store.appeals.get(appeal_id)
        if appeal is None:
            raise NotFoundError(f"Appeal {appeal_id} does not exist.", code="appeal_not_found")
        return appeal

    def list(self, *, status: str | None = None, evaluation_id: str | None = None,
             conversation_id: str | None = None, stage: str | None = None) -> list[Appeal]:
        items = [a for a in self.store.appeals.values()
                 if (status is None or a.status == status)
                 and (stage is None or a.stage == stage)
                 and (evaluation_id is None or a.evaluation_id == evaluation_id)
                 and (conversation_id is None or a.conversation_id == conversation_id)]
        return sorted(items, key=lambda a: a.created_at + a.id, reverse=True)

    # ---- submit -------------------------------------------------------------------------------
    def create(self, payload: AppealCreate) -> Appeal:
        with self.store.lock:
            record = self.evaluations.get(payload.evaluation_id)
            if record.status != "completed" or record.final_score is None:
                raise ConflictError("Only a completed evaluation can be appealed.", code="evaluation_not_completed")
            criterion = record.checklist.criterion(payload.criterion_id)
            if criterion is None or not criterion.enabled:
                raise ValidationFailed(f"Criterion '{payload.criterion_id}' is not part of this evaluation.",
                                       code="criterion_not_found")
            if any(a.evaluation_id == record.id and a.criterion_id == criterion.id and a.status == "pending"
                   for a in self.store.appeals.values()):
                raise ConflictError("This criterion already has an appeal waiting for review.", code="appeal_exists")
            final = {r.criterion_id: r for r in apply_overrides(record.original_results, record.overrides)}
            score = next((c for c in record.final_score.criteria if c.criterion_id == criterion.id), None)
            now = now_iso()
            appeal = Appeal(id=new_id(), evaluation_id=record.id, conversation_id=record.conversation_id,
                            checklist_id=record.checklist_id, checklist_version=record.checklist_version,
                            criterion_id=criterion.id, criterion_name=criterion.name, comment=payload.comment.strip(),
                            submitted_by=payload.submitted_by.strip(), created_at=now, updated_at=now,
                            status="pending", disputed_result=final.get(criterion.id),
                            disputed_points=score.points if score else None,
                            disputed_max_points=score.max_points if score else None,
                            total_at_submission=record.final_score.total,
                            percent_at_submission=record.final_score.percent, criterion_config=criterion,
                            explanation_language=payload.explanation_language or record.explanation_language)
            self.store.save_appeal(appeal)
            self.store.log("appeal.submitted", f"{appeal.submitted_by} appealed '{criterion.name}' on "
                                               f"{record.conversation_id}.", actor=appeal.submitted_by,
                           conversation_id=record.conversation_id, evaluation_id=record.id,
                           checklist_id=record.checklist_id, appeal_id=appeal.id,
                           details={"criterion_id": criterion.id, "comment": appeal.comment[:300],
                                    "checklist_version": record.checklist_version})
            return self._queue_reassessment(appeal.id)

    # ---- GPT reassessment ---------------------------------------------------------------------
    def _reassessor(self) -> tuple[EvaluatorAdapter | None, str, str]:
        """(adapter, error code, reason). The adapter is None when it cannot run now."""
        name = self.settings.cqa_reassessor
        adapter = self.adapters.get(name)
        if adapter is None or not adapter.supports_reassessment:
            return None, "reassessor_unavailable", (f"Reassessor '{name}' is not available or cannot reassess "
                                                    "appeals (ATLAS_CQA_REASSESSOR).")
        ready, reason = adapter.availability()
        if not ready:
            return None, "evaluator_not_configured", f"GPT reassessment is not available: {reason}"
        return adapter, "", ""

    def _queue_reassessment(self, appeal_id: str, actor: str = "system") -> Appeal:
        adapter, code, reason = self._reassessor()
        now = now_iso()
        with self.store.lock:
            appeal = self.get(appeal_id)
            reassessment = Reassessment(
                id=new_id(), status="pending", reassessor=self.settings.cqa_reassessor,
                requested_model=adapter.version if adapter else "", explanation_language=appeal.explanation_language,
                created_at=now)
            if adapter is None:  # recorded as a failed attempt: the appeal stays open and can be retried
                reassessment = reassessment.model_copy(update={
                    "status": "failed", "completed_at": now, "error": EvaluationError(code=code, message=reason)})
            appeal = appeal.model_copy(update={"reassessments": [*appeal.reassessments, reassessment],
                                               "updated_at": now})
            self.store.save_appeal(appeal)
            if adapter is None:
                self.store.log("appeal.reassessment_failed", f"GPT reassessment of '{appeal.criterion_name}' on "
                                                             f"{appeal.conversation_id} could not start: {reason}",
                               actor=actor, conversation_id=appeal.conversation_id,
                               evaluation_id=appeal.evaluation_id, checklist_id=appeal.checklist_id,
                               appeal_id=appeal.id, details={"code": code, "reassessment_id": reassessment.id})
            else:
                self.store.log("appeal.reassessment_queued", f"GPT reassessment of '{appeal.criterion_name}' on "
                                                             f"{appeal.conversation_id} queued.", actor=actor,
                               conversation_id=appeal.conversation_id, evaluation_id=appeal.evaluation_id,
                               checklist_id=appeal.checklist_id, appeal_id=appeal.id,
                               details={"reassessment_id": reassessment.id, "reassessor": adapter.name,
                                        "model": adapter.version})
                self.pool.submit(self._run, appeal.id, reassessment.id)
        return appeal

    def reassess(self, appeal_id: str, actor: str = "Manager") -> Appeal:
        """Retry after a failed reassessment (bounded by MAX_REASSESSMENTS model attempts)."""
        with self.store.lock:
            appeal = self.get(appeal_id)
            if appeal.status != "pending":
                raise ConflictError("This appeal has already been decided.", code="appeal_already_decided")
            latest = appeal.reassessment
            if latest is not None and latest.status in ("pending", "running"):
                raise ConflictError("GPT is already reassessing this appeal.", code="reassessment_in_progress")
            if latest is not None and latest.status == "completed":
                raise ConflictError("GPT has already reassessed this appeal. Review its recommendation and decide.",
                                    code="reassessment_completed")
            used = sum(1 for r in appeal.reassessments if not (r.error and r.error.code in NO_CALL_CODES))
            if used >= MAX_REASSESSMENTS:
                raise ConflictError(f"GPT reassessment was already attempted {used} times for this appeal. Decide it "
                                    "without a recommendation.", code="reassessment_limit_reached")
            return self._queue_reassessment(appeal_id, actor)

    def _replace(self, appeal: Appeal, reassessment: Reassessment) -> Appeal:
        items = [reassessment if r.id == reassessment.id else r for r in appeal.reassessments]
        updated = appeal.model_copy(update={"reassessments": items, "updated_at": now_iso()})
        self.store.save_appeal(updated)
        return updated

    def _run(self, appeal_id: str, reassessment_id: str) -> None:
        with self.store.lock:
            appeal = self.store.appeals.get(appeal_id)
            current = appeal.reassessment if appeal else None
            if appeal is None or appeal.status != "pending" or current is None or current.id != reassessment_id \
                    or current.status != "pending":
                return
            appeal = self._replace(appeal, current.model_copy(update={"status": "running", "started_at": now_iso()}))

        def fail(code: str, message: str, issues: list[str] | None = None, raw: dict | None = None) -> None:
            self._finish(appeal_id, reassessment_id, error=EvaluationError(code=code, message=message,
                                                                          issues=(issues or [])[:50]), raw=raw)

        record = self.store.evaluations.get(appeal.evaluation_id)
        if record is None:
            return fail("evaluation_missing", "The appealed evaluation no longer exists.")
        conversation = self.store.conversations.get(record.conversation_id)
        if conversation is None:
            return fail("conversation_missing", "The conversation no longer exists.")
        if conversation.transcript_hash != record.transcript_hash:
            return fail("transcript_changed", "The transcript changed after this evaluation, so GPT cannot reassess "
                                              "the original transcript. Evaluate the conversation again.")
        criterion = appeal.criterion_config or record.checklist.criterion(appeal.criterion_id)
        if criterion is None:
            return fail("criterion_missing", "The appealed criterion is missing from the evaluation's checklist.")
        adapter, code, reason = self._reassessor()
        if adapter is None:
            return fail(code, reason)
        request = build_reassessment_request(reassessment_id=reassessment_id, appeal=appeal, record=record,
                                             conversation=conversation, criterion=criterion,
                                             language=appeal.explanation_language)
        output: object = None
        try:
            output = adapter.reassess(request)
            result, issues = check_reassessment(request, output)  # again here: never trust the adapter's own check
            if result is None:
                raise EvaluatorError("The reassessment broke the validation rules; nothing was recorded.",
                                     code="invalid_output", issues=issues, raw=_jsonable(output))
        except EvaluatorError as error:
            return fail(error.code, error.message, error.issues, error.raw)
        except Exception as error:  # the adapter is third-party code: contain anything it raises
            logger.exception("CQA reassessor '%s' crashed", adapter.name)
            return fail("reassessor_crashed", f"The reassessor raised {type(error).__name__}.")
        by_turn = {m.index + 1: m for m in conversation.messages}
        meta = output.get("meta") if isinstance(output, dict) and isinstance(output.get("meta"), dict) else {}
        self._finish(appeal_id, reassessment_id, result=result, meta=meta,
                     evidence=[evidence_ref(by_turn[t]).model_dump() for t in result["evidence_turns"]])

    def _finish(self, appeal_id: str, reassessment_id: str, *, error: EvaluationError | None = None,
                raw: dict | None = None, result: dict[str, Any] | None = None, meta: dict | None = None,
                evidence: list[dict] | None = None) -> None:
        details = meta if meta is not None else (raw or {})
        usage = details.get("usage") if isinstance(details.get("usage"), dict) else {}
        update: dict[str, Any] = {
            "status": "failed" if error else "completed", "completed_at": now_iso(),
            "attempts": details["attempts"] if isinstance(details.get("attempts"), int)
            else len(details.get("rejected_answers") or []),
            "request_ids": [str(i)[:120] for i in (details.get("request_ids") or [])][:10],
            "usage": {k: v for k, v in usage.items() if isinstance(v, int) and not isinstance(v, bool)},
            "model": str(details["model"])[:120] if details.get("model") else None,
        }
        if error is not None:
            update.update(error=error.model_dump(), raw=_jsonable(raw) if raw else None)
        else:
            assert result is not None
            update.update(result, evidence=evidence or [],
                          raw=_jsonable({"model_answer": details.get("model_answer"),
                                         "rejected_answers": details.get("rejected_answers", [])}))
        with self.store.lock:
            appeal = self.store.appeals.get(appeal_id)
            current = next((r for r in appeal.reassessments if r.id == reassessment_id), None) if appeal else None
            if appeal is None or current is None:
                return
            done = Reassessment.model_validate({**current.model_dump(), **update})
            self._replace(appeal, done)
        where = f"'{appeal.criterion_name}' on {appeal.conversation_id}"
        if error is not None:
            self.store.log("appeal.reassessment_failed", f"GPT reassessment of {where} failed: {error.message}",
                           actor="GPT", conversation_id=appeal.conversation_id, evaluation_id=appeal.evaluation_id,
                           checklist_id=appeal.checklist_id, appeal_id=appeal.id,
                           details={"code": error.code, "issues": error.issues[:10], "reassessment_id": done.id})
        else:
            self.store.log("appeal.reassessed", f"GPT recommends to {done.recommendation} {where}.",
                           actor=done.model or "GPT", conversation_id=appeal.conversation_id,
                           evaluation_id=appeal.evaluation_id, checklist_id=appeal.checklist_id, appeal_id=appeal.id,
                           details={"reassessment_id": done.id, "recommendation": done.recommendation,
                                    "original_value": done.original_value,
                                    "recommended_value": done.recommended_value, "model": done.model,
                                    "attempts": done.attempts})

    # ---- decide -------------------------------------------------------------------------------
    @staticmethod
    def _manual_result(criterion: Criterion, answer: OverrideAnswer, explanation: str,
                       previous: CriterionResult | None) -> CriterionResult:
        if answer.is_na:
            if not criterion.na_allowed:
                raise ValidationFailed("N/A is not allowed for this criterion.", code="invalid_override")
            if answer.severe_error:
                raise ValidationFailed("An N/A criterion cannot carry a severe error.", code="invalid_override")
            value = None
        else:
            value = answer.value
            if criterion.answer_type == "scale" and isinstance(value, int) and not isinstance(value, bool):
                value = float(value)
            try:
                answer_score(criterion, value)
            except AnswerError as error:
                raise ValidationFailed(str(error), code="invalid_override") from None
        if answer.severe_error and not criterion.severe_error_enabled:
            raise ValidationFailed("Severe errors are not enabled for this criterion.", code="invalid_override")
        return CriterionResult(
            criterion_id=criterion.id, value=value, is_na=answer.is_na,
            na_reason=(answer.na_reason or explanation).strip() if answer.is_na else None,
            explanation=explanation, evidence=previous.evidence if previous else [],
            inspected_spans=previous.inspected_spans if previous else [], severe_error=answer.severe_error,
            severe_error_reason=(answer.severe_error_reason or explanation).strip() if answer.severe_error else None,
            source="reviewer")

    @staticmethod
    def _recommended_result(criterion: Criterion, gpt: Reassessment, explanation: str) -> CriterionResult:
        """GPT's recommended answer as the manager's accepted result (checked against the criterion once more)."""
        if gpt.recommended_is_na:
            if not criterion.na_allowed:
                raise ValidationFailed("GPT recommended N/A, which this criterion does not allow.",
                                       code="invalid_recommendation")
        else:
            try:
                answer_score(criterion, gpt.recommended_value)
            except AnswerError as error:
                raise ValidationFailed(f"GPT's recommended answer is not valid: {error}",
                                       code="invalid_recommendation") from None
        critical = gpt.recommended_critical_error and flag_allowed(criterion) and not gpt.recommended_is_na
        return CriterionResult(
            criterion_id=criterion.id, value=None if gpt.recommended_is_na else gpt.recommended_value,
            is_na=gpt.recommended_is_na, na_reason=gpt.rationale if gpt.recommended_is_na else None,
            explanation=explanation, evidence=gpt.evidence, inspected_spans=[], severe_error=critical,
            severe_error_reason=gpt.rationale if critical else None, source="reviewer")

    @staticmethod
    def _matches(criterion: Criterion, result: CriterionResult | None, gpt: Reassessment) -> bool:
        if result is None:
            return False
        value = None if result.is_na else result.value
        if not same_value(value, None if gpt.recommended_is_na else gpt.recommended_value):
            return False
        return not flag_allowed(criterion) or bool(result.severe_error) == gpt.recommended_critical_error

    def decide(self, appeal_id: str, payload: AppealDecisionIn) -> Appeal:
        with self.store.lock:
            appeal = self.get(appeal_id)
            if appeal.status != "pending":
                raise ConflictError("This appeal has already been decided.", code="appeal_already_decided")
            latest = appeal.reassessment
            if latest is not None and latest.status in ("pending", "running"):
                raise ConflictError("GPT is still reassessing this appeal. Decide once its recommendation is ready.",
                                    code="reassessment_in_progress")
            gpt = latest if latest is not None and latest.status == "completed" else None
            if payload.decision == "accept" and gpt is None:
                raise ConflictError("There is no GPT recommendation to accept. Keep the original result or set "
                                    "another answer.", code="no_recommendation")
            record = self.evaluations.get(appeal.evaluation_id)
            criterion = record.checklist.criterion(appeal.criterion_id)
            if criterion is None or record.final_score is None:
                raise ConflictError("The appealed evaluation is no longer scorable.", code="evaluation_not_completed")
            current = {r.criterion_id: r for r in apply_overrides(record.original_results, record.overrides)}
            previous = current.get(criterion.id)
            total_before, percent_before = record.final_score.total, record.final_score.percent
            explanation = payload.explanation.strip()
            reviewer = payload.reviewer.strip()
            now = now_iso()
            new_result: CriterionResult | None = None
            if payload.decision == "override":
                assert payload.override is not None
                new_result = self._manual_result(criterion, payload.override, explanation, previous)
            elif payload.decision == "accept" and gpt is not None and gpt.recommendation == "change":
                new_result = self._recommended_result(criterion, gpt, explanation)
            total_after, percent_after = total_before, percent_before
            if new_result is not None:
                overrides = [*record.overrides, Override(criterion_id=criterion.id, appeal_id=appeal.id,
                                                         result=new_result, reviewer=reviewer,
                                                         explanation=explanation, decided_at=now)]
                # The evaluation's own checklist snapshot: original weights, scales and N/A rules.
                final_score = compute_score(record.checklist, apply_overrides(record.original_results, overrides))
                total_after, percent_after = final_score.total, final_score.percent
                self.store.save_evaluation(record.model_copy(update={"overrides": overrides,
                                                                     "final_score": final_score, "updated_at": now}))
            final_result = new_result if new_result is not None else previous
            decided = appeal.model_copy(update={
                "status": "overridden" if new_result is not None else "confirmed", "updated_at": now,
                "decision": AppealDecision(
                    decision=payload.decision, explanation=explanation, reviewer=reviewer, decided_at=now,
                    previous_result=previous, new_result=new_result, total_before=total_before,
                    total_after=total_after, percent_before=percent_before, percent_after=percent_after,
                    reassessment_id=latest.id if latest else None,
                    gpt_recommendation=gpt.recommendation if gpt else None,
                    gpt_recommended_value=gpt.recommended_value if gpt else None,
                    gpt_recommended_is_na=gpt.recommended_is_na if gpt else False,
                    follows_gpt=self._matches(criterion, final_result, gpt) if gpt else None)})
            self.store.save_appeal(decided)
        verb = {"confirm": "kept", "accept": "accepted GPT's recommendation for",
                "override": "overrode"}[payload.decision]
        self.store.log("appeal.decided", f"{reviewer} {verb} '{criterion.name}' on {record.conversation_id}.",
                       actor=reviewer, conversation_id=record.conversation_id, evaluation_id=record.id,
                       checklist_id=record.checklist_id, appeal_id=appeal.id,
                       details={"decision": payload.decision, "explanation": explanation[:300],
                                "gpt_recommendation": gpt.recommendation if gpt else None,
                                "follows_gpt": decided.decision.follows_gpt if decided.decision else None,
                                "total_before": total_before, "total_after": total_after,
                                "percent_before": percent_before, "percent_after": percent_after})
        if new_result is not None:
            self.store.log("evaluation.final_recalculated",
                           f"Final score of {record.conversation_id} recalculated: {percent_before}% → "
                           f"{percent_after}%.", actor="scoring engine", conversation_id=record.conversation_id,
                           evaluation_id=record.id, checklist_id=record.checklist_id, appeal_id=appeal.id,
                           details={"total_before": total_before, "total_after": total_after,
                                    "percent_before": percent_before, "percent_after": percent_after})
        return decided

    # ---- review page --------------------------------------------------------------------------
    def _impact(self, record: EvaluationRecord, criterion: Criterion, gpt: Reassessment) -> RecommendationImpact:
        before = record.final_score
        assert before is not None
        after = before
        if gpt.recommendation == "change":
            try:
                hypothetical = self._recommended_result(criterion, gpt, gpt.rationale)
            except ValidationFailed:
                hypothetical = None
            if hypothetical is not None:
                overrides = [*record.overrides, Override(criterion_id=criterion.id, appeal_id="0" * 32,
                                                         result=hypothetical, reviewer="", explanation="",
                                                         decided_at="")]
                after = compute_score(record.checklist, apply_overrides(record.original_results, overrides))
        row = next((c for c in after.criteria if c.criterion_id == criterion.id), None)
        return RecommendationImpact(total_before=before.total, total_after=after.total,
                                    percent_before=before.percent, percent_after=after.percent,
                                    criterion_points_after=row.points if row else None,
                                    criterion_max_points_after=row.max_points if row else None)

    def detail(self, appeal_id: str) -> AppealDetail:
        appeal = self.get(appeal_id)
        record = self.evaluations.get(appeal.evaluation_id)
        criterion = appeal.criterion_config or record.checklist.criterion(appeal.criterion_id)
        if criterion is None:
            raise NotFoundError("The appealed criterion is missing from the evaluation.", code="criterion_not_found")
        current = {r.criterion_id: r for r in apply_overrides(record.original_results, record.overrides)}
        result = current.get(criterion.id)
        original = next((r for r in record.original_results if r.criterion_id == criterion.id), None)
        final_scores = {c.criterion_id: c for c in record.final_score.criteria} if record.final_score else {}
        original_scores = {c.criterion_id: c for c in record.original_score.criteria} if record.original_score else {}
        conversation = self.store.conversations.get(record.conversation_id)
        latest = appeal.reassessment
        impact = (self._impact(record, criterion, latest)
                  if appeal.status == "pending" and latest is not None and latest.status == "completed"
                  and record.final_score is not None else None)
        return AppealDetail(appeal=appeal, criterion=criterion, evaluation=self.evaluations.summary(record),
                            original_result=original, current_result=result,
                            current_score=final_scores.get(criterion.id),
                            original_score=original_scores.get(criterion.id),
                            context=self._context(conversation.messages if conversation else [],
                                                  appeal.disputed_result or result),
                            transcript=conversation.messages if conversation else [], impact=impact,
                            evaluation_stale=self.evaluations.is_stale(record),
                            audit=self.store.events(appeal_id=appeal.id, limit=50))

    @staticmethod
    def _context(messages: list[Message], result: CriterionResult | None) -> list[Message]:
        if not messages:
            return []
        wanted: set[int] = set()
        if result:
            for ref in result.evidence:
                wanted.update(range(ref.message_index - CONTEXT_RADIUS, ref.message_index + CONTEXT_RADIUS + 1))
            for span in result.inspected_spans:
                wanted.update(range(span.start_index, min(span.end_index, span.start_index + MAX_CONTEXT) + 1))
        if not wanted:
            wanted = set(range(min(len(messages), 12)))
        return [messages[i] for i in sorted(wanted) if 0 <= i < len(messages)][:MAX_CONTEXT]
