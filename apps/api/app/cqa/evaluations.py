"""Evaluation lifecycle: pending → running → completed | failed.

``queue`` snapshots the checklist version and the transcript hash, then a small thread pool runs each
evaluation: build the contract request, call the adapter, validate the output strictly, score it with the
deterministic engine, save. The original result never changes afterwards; reviewer overrides (appeals.py) only
add to ``overrides`` and recompute ``final_score``.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor

from app.core.config import Settings
from app.core.errors import NotFoundError, ValidationFailed
from app.cqa.adapters import EvaluatorAdapter, EvaluatorError
from app.cqa.checklists import ChecklistService
from app.cqa.contract import ContractViolation, EvaluationRequest, build_request, validate_output
from app.cqa.schemas import (
    Appeal,
    BatchStatus,
    ConversationRecord,
    CriterionView,
    EvaluateRequest,
    EvaluateResponse,
    EvaluationBrief,
    EvaluationDetail,
    EvaluationError,
    EvaluationPage,
    EvaluationRecord,
    EvaluationSummary,
)
from app.cqa.scoring import apply_overrides, compute_score
from app.cqa.store import CqaStore, now_iso
from app.storage.paths import check_id, new_id

logger = logging.getLogger("atlas.cqa")
MAX_RAW_OUTPUT_CHARS = 2_000_000


def _jsonable(output: object) -> dict | None:
    try:
        data = output.model_dump(mode="json") if hasattr(output, "model_dump") else output  # type: ignore[union-attr]
        text = json.dumps(data, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return {"unserializable": type(output).__name__}
    if len(text) > MAX_RAW_OUTPUT_CHARS:
        return {"truncated": True, "size_chars": len(text)}
    return json.loads(text) if isinstance(data, dict) else {"value": json.loads(text)}


class EvaluationService:
    def __init__(self, store: CqaStore, checklists: ChecklistService, adapters: dict[str, EvaluatorAdapter],
                 settings: Settings) -> None:
        self.store = store
        self.checklists = checklists
        self.adapters = adapters
        self.settings = settings
        self.pool = ThreadPoolExecutor(max_workers=max(1, settings.cqa_evaluation_workers),
                                       thread_name_prefix="cqa-eval")
        self._recover()

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)

    def _recover(self) -> None:
        """After a restart: re-queue pending evaluations, fail the ones that were mid-run."""
        for record in list(self.store.evaluations.values()):
            if record.status == "running":
                self._fail(record.id, "interrupted", "The API restarted while this evaluation was running. Run it "
                                                     "again.")
            elif record.status == "pending":
                self.pool.submit(self._run, record.id)

    # ---- adapters -----------------------------------------------------------------------------
    def adapter(self, name: str | None) -> EvaluatorAdapter:
        key = name or self.settings.cqa_evaluator
        adapter = self.adapters.get(key)
        if adapter is None:
            raise ValidationFailed(f"Unknown evaluator '{key}'. Available: {', '.join(sorted(self.adapters))}.",
                                   code="unknown_evaluator")
        return adapter

    # ---- queueing -----------------------------------------------------------------------------
    def queue(self, request: EvaluateRequest, actor: str = "User") -> EvaluateResponse:
        checklist, version = self.checklists.version(request.checklist_id, request.checklist_version)
        adapter = self.adapter(request.adapter)
        ready, reason = adapter.availability()
        if not ready:
            raise ValidationFailed(f"Evaluator '{adapter.label}' cannot run: {reason}", code="evaluator_unavailable")
        conversations = self.store.conversations
        if request.conversation_ids is not None:
            unknown = [cid for cid in request.conversation_ids if cid not in conversations]
            if unknown:
                raise NotFoundError(f"Unknown conversation(s): {', '.join(unknown[:5])}.",
                                    code="conversation_not_found", details={"conversation_ids": unknown})
            targets = list(request.conversation_ids)
        else:
            targets = sorted(cid for cid, record in conversations.items()
                             if request.group_id is None or request.group_id in record.group_ids)
        if not targets:
            raise ValidationFailed("No conversations match. Import conversations first.", code="nothing_to_evaluate")
        skipped = 0
        if request.only_missing:
            covered = {e.conversation_id for e in self.store.evaluations.values()
                       if e.checklist_id == checklist.id and e.checklist_version == version.version
                       and e.status in ("pending", "running", "completed")}
            before = len(targets)
            targets = [cid for cid in targets if cid not in covered]
            skipped = before - len(targets)

        batch_id = new_id()
        info = adapter.info()
        created: list[EvaluationRecord] = []
        now = now_iso()
        for cid in targets:
            record = EvaluationRecord(
                id=new_id(), conversation_id=cid, checklist_id=checklist.id, checklist_name=checklist.name,
                checklist_version=version.version, checklist=version.config,
                transcript_hash=conversations[cid].transcript_hash, evaluator=info, status="pending",
                batch_id=batch_id, created_at=now, updated_at=now)
            self.store.save_evaluation(record)
            created.append(record)
        self.store.log("evaluation.queued",
                       f"Queued {len(created)} evaluation(s) with '{checklist.name}' v{version.version} "
                       f"({info.label}).", actor=actor, checklist_id=checklist.id,
                       conversation_id=created[0].conversation_id if len(created) == 1 else None,
                       evaluation_id=created[0].id if len(created) == 1 else None,
                       details={"batch_id": batch_id, "count": len(created), "skipped": skipped,
                                "evaluator": info.name})
        for record in created:
            self.pool.submit(self._run, record.id)
        return EvaluateResponse(batch_id=batch_id, queued=len(created), skipped=skipped,
                                evaluations=[self.brief(r) for r in created])

    def rerun(self, evaluation_id: str, actor: str = "User") -> EvaluateResponse:
        record = self.get(evaluation_id)
        return self.queue(EvaluateRequest(checklist_id=record.checklist_id, checklist_version=record.checklist_version,
                                          conversation_ids=[record.conversation_id], adapter=record.evaluator.name),
                          actor=actor)

    # ---- running ------------------------------------------------------------------------------
    def request_for(self, record: EvaluationRecord, conversation: ConversationRecord) -> EvaluationRequest:
        return build_request(record.id, conversation, record.checklist_id, record.checklist_name,
                             record.checklist_version, record.checklist)

    def _fail(self, evaluation_id: str, code: str, message: str, issues: list[str] | None = None,
              raw_output: dict | None = None) -> None:
        with self.store.lock:
            record = self.store.evaluations[evaluation_id]
            now = now_iso()
            failed = record.model_copy(update={
                "status": "failed", "updated_at": now, "completed_at": now, "raw_output": raw_output,
                "error": EvaluationError(code=code, message=message, issues=(issues or [])[:100])})
            self.store.save_evaluation(failed)
        self.store.log("evaluation.failed", f"Evaluation of {record.conversation_id} failed: {message}",
                       conversation_id=record.conversation_id, evaluation_id=record.id,
                       checklist_id=record.checklist_id, details={"code": code, "issues": (issues or [])[:10]})

    def _run(self, evaluation_id: str) -> None:
        with self.store.lock:
            record = self.store.evaluations.get(evaluation_id)
            if record is None or record.status != "pending":
                return
            record = record.model_copy(update={"status": "running", "started_at": now_iso(), "updated_at": now_iso()})
            self.store.save_evaluation(record)
        conversation = self.store.conversations.get(record.conversation_id)
        if conversation is None:
            self._fail(record.id, "conversation_missing", "The conversation no longer exists.")
            return
        if conversation.transcript_hash != record.transcript_hash:
            self._fail(record.id, "transcript_changed", "The transcript changed after this evaluation was queued.")
            return
        adapter = self.adapters.get(record.evaluator.name)
        if adapter is None:
            self._fail(record.id, "unknown_evaluator", f"Evaluator '{record.evaluator.name}' is no longer available.")
            return
        output: object = None
        try:
            request = self.request_for(record, conversation)
            output = adapter.evaluate(request)
            validated = validate_output(request, output, conversation.messages)
        except ContractViolation as violation:
            self._fail(record.id, "invalid_output", "The evaluator's output broke the integration contract.",
                       violation.issues, _jsonable(output))
            return
        except EvaluatorError as error:
            self._fail(record.id, error.code, error.message)
            return
        except Exception as error:  # the adapter is third-party code: contain anything it raises
            logger.exception("CQA evaluator '%s' crashed", record.evaluator.name)
            self._fail(record.id, "evaluator_crashed", f"The evaluator raised {type(error).__name__}.")
            return

        score = compute_score(record.checklist, validated.results)
        warnings = [*validated.warnings, *score.issues]
        now = now_iso()
        with self.store.lock:
            done = self.store.evaluations[record.id].model_copy(update={
                "status": "completed", "updated_at": now, "completed_at": now,
                "original_results": validated.results, "original_score": score, "final_score": score,
                "warnings": warnings, "model_info": validated.model_info, "raw_output": _jsonable(output)})
            self.store.save_evaluation(done)
        total = "no total" if score.total is None else f"{score.total:g} / {score.max_score:g}"
        self.store.log("evaluation.completed",
                       f"Evaluated {record.conversation_id} with '{record.checklist_name}' v{record.checklist_version}"
                       f": {total}{' (development mock)' if record.evaluator.is_mock else ''}.",
                       actor=record.evaluator.label, conversation_id=record.conversation_id, evaluation_id=record.id,
                       checklist_id=record.checklist_id,
                       details={"total": score.total, "status": score.status, "severe_errors": score.severe_errors})

    # ---- reads --------------------------------------------------------------------------------
    def get(self, evaluation_id: str) -> EvaluationRecord:
        check_id(evaluation_id)
        record = self.store.evaluations.get(evaluation_id)
        if record is None:
            raise NotFoundError(f"Evaluation {evaluation_id} does not exist.", code="evaluation_not_found")
        return record

    def is_stale(self, record: EvaluationRecord) -> bool:
        conversation = self.store.conversations.get(record.conversation_id)
        return conversation is None or conversation.transcript_hash != record.transcript_hash

    def brief(self, record: EvaluationRecord) -> EvaluationBrief:
        original, final = record.original_score, record.final_score
        return EvaluationBrief(
            id=record.id, conversation_id=record.conversation_id, status=record.status,
            checklist_id=record.checklist_id, checklist_name=record.checklist_name,
            checklist_version=record.checklist_version, evaluator=record.evaluator.label,
            is_mock=record.evaluator.is_mock, original_total=original.total if original else None,
            final_total=final.total if final else None, max_score=final.max_score if final else None,
            score_status=final.status if final else None, severe_errors=len(final.severe_errors) if final else 0,
            overridden=bool(record.overrides), created_at=record.created_at, completed_at=record.completed_at,
            stale=self.is_stale(record))

    def summary(self, record: EvaluationRecord) -> EvaluationSummary:
        conversation = self.store.conversations.get(record.conversation_id)
        return EvaluationSummary(**self.brief(record).model_dump(),
                                 conversation_language=conversation.language if conversation else None,
                                 conversation_channel=conversation.channel if conversation else None,
                                 batch_id=record.batch_id, error=record.error, started_at=record.started_at)

    def for_conversation(self, conversation_id: str) -> list[EvaluationRecord]:
        return sorted((e for e in self.store.evaluations.values() if e.conversation_id == conversation_id),
                      key=lambda e: e.created_at + e.id, reverse=True)

    def index(self) -> dict[str, list[EvaluationRecord]]:
        """Evaluations per conversation, newest first (one pass, for list and overview queries)."""
        grouped: dict[str, list[EvaluationRecord]] = {}
        for record in self.store.evaluations.values():
            grouped.setdefault(record.conversation_id, []).append(record)
        for records in grouped.values():
            records.sort(key=lambda e: e.created_at + e.id, reverse=True)
        return grouped

    @staticmethod
    def pick(records: list[EvaluationRecord], checklist_id: str | None = None,
             completed_only: bool = False) -> EvaluationRecord | None:
        for record in records:
            if checklist_id and record.checklist_id != checklist_id:
                continue
            if completed_only and record.status != "completed":
                continue
            return record
        return None

    def latest(self, conversation_id: str, checklist_id: str | None = None,
               completed_only: bool = False) -> EvaluationRecord | None:
        return self.pick(self.for_conversation(conversation_id), checklist_id, completed_only)

    def page(self, *, conversation_id: str | None = None, checklist_id: str | None = None, status: str | None = None,
             batch_id: str | None = None, mock: bool | None = None, page: int = 1,
             page_size: int = 50) -> EvaluationPage:
        items = [e for e in self.store.evaluations.values()
                 if (conversation_id is None or e.conversation_id == conversation_id)
                 and (checklist_id is None or e.checklist_id == checklist_id)
                 and (status is None or e.status == status)
                 and (batch_id is None or e.batch_id == batch_id)
                 and (mock is None or e.evaluator.is_mock == mock)]
        items.sort(key=lambda e: e.created_at + e.id, reverse=True)
        start = (page - 1) * page_size
        return EvaluationPage(items=[self.summary(e) for e in items[start:start + page_size]], total=len(items),
                              page=page, page_size=page_size)

    def batch(self, batch_id: str) -> BatchStatus:
        check_id(batch_id)
        records = [e for e in self.store.evaluations.values() if e.batch_id == batch_id]
        if not records:
            raise NotFoundError(f"Batch {batch_id} does not exist.", code="batch_not_found")
        count = {s: sum(1 for r in records if r.status == s) for s in ("pending", "running", "completed", "failed")}
        return BatchStatus(batch_id=batch_id, total=len(records), done=count["pending"] + count["running"] == 0,
                           evaluation_ids=[r.id for r in records], **count)

    def detail(self, evaluation_id: str, appeals: list[Appeal]) -> EvaluationDetail:
        record = self.get(evaluation_id)
        final_results = apply_overrides(record.original_results, record.overrides)
        original = {r.criterion_id: r for r in record.original_results}
        final = {r.criterion_id: r for r in final_results}
        original_scores = {c.criterion_id: c for c in record.original_score.criteria} if record.original_score else {}
        final_scores = {c.criterion_id: c for c in record.final_score.criteria} if record.final_score else {}
        overridden = {o.criterion_id for o in record.overrides}
        views = [CriterionView(criterion=criterion, original=original.get(criterion.id), final=final.get(criterion.id),
                               original_score=original_scores.get(criterion.id),
                               final_score=final_scores.get(criterion.id), overridden=criterion.id in overridden,
                               appeals=[a.id for a in appeals if a.criterion_id == criterion.id])
                 for criterion in record.checklist.criteria]
        return EvaluationDetail(evaluation=record, criteria=views, final_results=final_results,
                                stale=self.is_stale(record), appeals=appeals,
                                audit=self.store.events(evaluation_id=record.id, limit=100))
