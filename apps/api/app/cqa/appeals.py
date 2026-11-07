"""Appeals: a user disputes one criterion; a reviewer confirms or overrides it with a mandatory explanation.

An override is a new *answer* (never a score): the scoring engine recomputes the final total from the original
answers plus the overrides. The original result, the disputed result, the decision, and the totals before and
after are all kept, and every step is written to the audit trail.
"""

from __future__ import annotations

from app.core.errors import ConflictError, NotFoundError, ValidationFailed
from app.cqa.evaluations import EvaluationService
from app.cqa.schemas import (
    Appeal,
    AppealCreate,
    AppealDecision,
    AppealDecisionIn,
    AppealDetail,
    CriterionResult,
    Message,
    Override,
)
from app.cqa.scoring import AnswerError, answer_score, apply_overrides, compute_score
from app.cqa.store import CqaStore, now_iso
from app.storage.paths import check_id, new_id

CONTEXT_RADIUS = 2
MAX_CONTEXT = 40


class AppealService:
    def __init__(self, store: CqaStore, evaluations: EvaluationService) -> None:
        self.store = store
        self.evaluations = evaluations

    def get(self, appeal_id: str) -> Appeal:
        check_id(appeal_id)
        appeal = self.store.appeals.get(appeal_id)
        if appeal is None:
            raise NotFoundError(f"Appeal {appeal_id} does not exist.", code="appeal_not_found")
        return appeal

    def list(self, *, status: str | None = None, evaluation_id: str | None = None,
             conversation_id: str | None = None) -> list[Appeal]:
        items = [a for a in self.store.appeals.values()
                 if (status is None or a.status == status)
                 and (evaluation_id is None or a.evaluation_id == evaluation_id)
                 and (conversation_id is None or a.conversation_id == conversation_id)]
        return sorted(items, key=lambda a: a.created_at + a.id, reverse=True)

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
                            total_at_submission=record.final_score.total)
            self.store.save_appeal(appeal)
        self.store.log("appeal.submitted", f"{appeal.submitted_by} appealed '{criterion.name}' on "
                                           f"{record.conversation_id}.", actor=appeal.submitted_by,
                       conversation_id=record.conversation_id, evaluation_id=record.id,
                       checklist_id=record.checklist_id, appeal_id=appeal.id,
                       details={"criterion_id": criterion.id, "comment": appeal.comment[:300]})
        return appeal

    def decide(self, appeal_id: str, payload: AppealDecisionIn) -> Appeal:
        with self.store.lock:
            appeal = self.get(appeal_id)
            if appeal.status != "pending":
                raise ConflictError("This appeal has already been decided.", code="appeal_already_decided")
            record = self.evaluations.get(appeal.evaluation_id)
            criterion = record.checklist.criterion(appeal.criterion_id)
            if criterion is None or record.final_score is None:
                raise ConflictError("The appealed evaluation is no longer scorable.", code="evaluation_not_completed")
            current = {r.criterion_id: r for r in apply_overrides(record.original_results, record.overrides)}
            previous = current.get(criterion.id)
            total_before = record.final_score.total
            explanation = payload.explanation.strip()
            reviewer = payload.reviewer.strip()
            now = now_iso()
            new_result: CriterionResult | None = None
            total_after = total_before
            if payload.decision == "override":
                answer = payload.override
                assert answer is not None
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
                    raise ValidationFailed("Severe errors are not enabled for this criterion.",
                                           code="invalid_override")
                new_result = CriterionResult(
                    criterion_id=criterion.id, value=value, is_na=answer.is_na,
                    na_reason=(answer.na_reason or explanation).strip() if answer.is_na else None,
                    explanation=explanation, evidence=previous.evidence if previous else [],
                    inspected_spans=previous.inspected_spans if previous else [],
                    severe_error=answer.severe_error,
                    severe_error_reason=(answer.severe_error_reason or explanation).strip()
                    if answer.severe_error else None, source="reviewer")
                overrides = [*record.overrides, Override(criterion_id=criterion.id, appeal_id=appeal.id,
                                                         result=new_result, reviewer=reviewer,
                                                         explanation=explanation, decided_at=now)]
                final_score = compute_score(record.checklist, apply_overrides(record.original_results, overrides))
                total_after = final_score.total
                self.store.save_evaluation(record.model_copy(update={"overrides": overrides,
                                                                     "final_score": final_score, "updated_at": now}))
            decided = appeal.model_copy(update={
                "status": "overridden" if payload.decision == "override" else "confirmed", "updated_at": now,
                "decision": AppealDecision(decision=payload.decision, explanation=explanation, reviewer=reviewer,
                                           decided_at=now, previous_result=previous, new_result=new_result,
                                           total_before=total_before, total_after=total_after)})
            self.store.save_appeal(decided)
        verb = "overrode" if payload.decision == "override" else "confirmed"
        self.store.log("appeal.decided", f"{reviewer} {verb} '{criterion.name}' on {record.conversation_id}.",
                       actor=reviewer, conversation_id=record.conversation_id, evaluation_id=record.id,
                       checklist_id=record.checklist_id, appeal_id=appeal.id,
                       details={"decision": payload.decision, "explanation": explanation[:300],
                                "total_before": total_before, "total_after": total_after})
        if payload.decision == "override":
            self.store.log("evaluation.final_recalculated",
                           f"Final score of {record.conversation_id} recalculated: {total_before} → {total_after}.",
                           actor="scoring engine", conversation_id=record.conversation_id, evaluation_id=record.id,
                           checklist_id=record.checklist_id, appeal_id=appeal.id,
                           details={"total_before": total_before, "total_after": total_after})
        return decided

    def detail(self, appeal_id: str) -> AppealDetail:
        appeal = self.get(appeal_id)
        record = self.evaluations.get(appeal.evaluation_id)
        criterion = record.checklist.criterion(appeal.criterion_id)
        if criterion is None:
            raise NotFoundError("The appealed criterion is missing from the evaluation.", code="criterion_not_found")
        current = {r.criterion_id: r for r in apply_overrides(record.original_results, record.overrides)}
        result = current.get(criterion.id)
        final_scores = {c.criterion_id: c for c in record.final_score.criteria} if record.final_score else {}
        original_scores = {c.criterion_id: c for c in record.original_score.criteria} if record.original_score else {}
        conversation = self.store.conversations.get(record.conversation_id)
        return AppealDetail(appeal=appeal, criterion=criterion, evaluation=self.evaluations.summary(record),
                            current_result=result, current_score=final_scores.get(criterion.id),
                            original_score=original_scores.get(criterion.id),
                            context=self._context(conversation.messages if conversation else [],
                                                  appeal.disputed_result or result),
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
