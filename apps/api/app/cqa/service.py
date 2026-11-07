"""CQA application service: one object on ``app.state.cqa`` that owns the store and the sub-services."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from typing import Any, Literal

from app.core.config import Settings
from app.core.errors import NotFoundError, ValidationFailed
from app.cqa.adapters import create_adapters
from app.cqa.appeals import AppealService
from app.cqa.audio import AudioResolver
from app.cqa.checklists import ChecklistService
from app.cqa.contract import CONTRACT_VERSION
from app.cqa.evaluations import EvaluationService
from app.cqa.ingestion import (
    FIXTURE_PREFIX,
    SourceError,
    fixture_groups,
    fixture_payload,
    http_get_json,
    parse_payload,
    source_url_for,
)
from app.cqa.schemas import (
    CONVERSATION_ID_PATTERN,
    GROUP_ID_PATTERN,
    AudioInfo,
    ConversationDetail,
    ConversationPage,
    ConversationRecord,
    ConversationSource,
    ConversationSummary,
    CqaInfo,
    CriterionStat,
    EvaluationRecord,
    Facet,
    ImportIssue,
    ImportRequest,
    ImportRun,
    Overview,
    ScoreBin,
)
from app.cqa.store import CqaStore, now_iso
from app.storage.paths import new_id

SortKey = Literal["id", "imported_at", "score", "messages", "duration", "language", "channel", "evaluated_at"]
StatusFilter = Literal["not_evaluated", "pending", "running", "completed", "failed", "appealed"]
ImportMethod = Literal["fetch", "paste"]


def _facets(values: list[str]) -> list[Facet]:
    return [Facet(value=value, count=count) for value, count in sorted(Counter(values).items())]


class CqaService:
    def __init__(self, settings: Settings, fetcher: Callable[[str, float], Any] = http_get_json) -> None:
        self.settings = settings
        self.fetcher = fetcher
        self.store = CqaStore(settings.data_dir)
        self.adapters = create_adapters(settings)
        self.checklists = ChecklistService(self.store)
        self.checklists.ensure_official_checklist()
        self.evaluations = EvaluationService(self.store, self.checklists, self.adapters, settings)
        self.appeals = AppealService(self.store, self.evaluations, self.adapters, settings)
        self.audio_resolver = AudioResolver(settings)

    def shutdown(self) -> None:
        self.evaluations.shutdown()
        self.appeals.shutdown()

    # ---- info ---------------------------------------------------------------------------------
    def info(self) -> CqaInfo:
        return CqaInfo(source_configured=bool(self.settings.cqa_source_url),
                       fixtures_enabled=self.settings.cqa_fixtures_enabled,
                       fixture_groups=fixture_groups() if self.settings.cqa_fixtures_enabled else [],
                       default_evaluator=self.settings.cqa_evaluator,
                       evaluators=[adapter.info() for adapter in self.adapters.values()],
                       contract_version=CONTRACT_VERSION)

    # ---- import -------------------------------------------------------------------------------
    def import_group(self, request: ImportRequest, actor: str = "User") -> ImportRun:
        started = now_iso()
        group_id = request.group_id
        if request.source == "fixture":
            if not self.settings.cqa_fixtures_enabled:
                raise ValidationFailed("Fixtures are disabled (ATLAS_CQA_FIXTURES_ENABLED=false).",
                                       code="fixtures_disabled")
            if not group_id.startswith(FIXTURE_PREFIX):
                raise ValidationFailed("Fixture group ids start with 'FIXTURE'.", code="unknown_fixture_group")
            payload = fixture_payload(group_id)
        else:
            if group_id.upper().startswith(FIXTURE_PREFIX):
                raise ValidationFailed("'FIXTURE…' groups are development fixtures; import them as fixtures.",
                                       code="fixture_group_via_api")
            if not self.settings.cqa_source_url:
                raise ValidationFailed("The organizers' API is not configured. Put its GET link in .env as "
                                       "ATLAS_CQA_SOURCE_URL and restart the API.", code="source_not_configured")
            try:
                payload = self.fetcher(source_url_for(self.settings.cqa_source_url, group_id),
                                       self.settings.cqa_source_timeout_s)
            except SourceError as error:
                self._record_failure(group_id, request.source, started, error.message)
                raise
        return self._ingest(payload, group_id, request.source, started, actor)

    def import_json(self, payload: Any, actor: str = "User") -> ImportRun:
        """Import an organizers' API response that a manager pasted. The group is the response's own
        ``data.dataset_group_id``; parsing, validation, de-duplication and storage are the same as ``import_group``."""
        started = now_iso()
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict) or not isinstance(data.get("records"), list):
            raise ValidationFailed("Paste the organizers' API response as is: a JSON object with "
                                   "data.dataset_group_id and a data.records array.", code="invalid_payload")
        reported = data.get("dataset_group_id")
        group_id = str(reported).strip() if isinstance(reported, (str, int)) and not isinstance(reported, bool) else ""
        if not group_id:
            raise ValidationFailed("The pasted JSON has no data.dataset_group_id, so its group is unknown.",
                                   code="missing_group_id")
        if not re.fullmatch(GROUP_ID_PATTERN, group_id):
            raise ValidationFailed("data.dataset_group_id may only contain letters, digits, '.', '_' and '-' "
                                   "(at most 64 characters).", code="invalid_group_id")
        if group_id.upper().startswith(FIXTURE_PREFIX):
            raise ValidationFailed("'FIXTURE…' groups are development fixtures; they cannot be pasted.",
                                   code="fixture_group_via_api")
        try:
            return self._ingest(payload, group_id, "organizer_api", started, actor, method="paste")
        except SourceError as error:  # a pasted document is user input: report it as such (422), not as a 502
            raise ValidationFailed(error.message, code=error.code) from None

    def _ingest(self, payload: Any, group_id: str, source: ConversationSource, started: str, actor: str,
                method: ImportMethod = "fetch") -> ImportRun:
        """Validate one organizers' response and store its conversations. Shared by every import method, so a
        conversation is the same record whichever way it arrived, and importing it again never duplicates it."""
        try:
            parsed = parse_payload(payload, group_id, source, started,
                                   max_messages=self.settings.cqa_max_messages,
                                   max_chars=self.settings.cqa_max_message_chars)
        except SourceError as error:
            self._record_failure(group_id, source, started, error.message, method)
            raise

        created = updated = unchanged = 0
        issues = list(parsed.issues)
        accepted: list[str] = []
        with self.store.lock:
            for record in parsed.records:
                existing = self.store.conversations.get(record.id)
                if existing is None:
                    self.store.save_conversation(record)
                    created += 1
                    accepted.append(record.id)
                    continue
                if existing.source != record.source:
                    issues.append(ImportIssue(severity="error", code="source_conflict", conversation_id=record.id,
                                              message="A conversation with this id was imported from another source; "
                                                      "it was not overwritten."))
                    continue
                groups = existing.group_ids if group_id in existing.group_ids else [*existing.group_ids, group_id]
                same = (existing.transcript_hash == record.transcript_hash and existing.channel == record.channel
                        and existing.language == record.language)
                if same:
                    if groups != existing.group_ids or existing.audio_url != record.audio_url:
                        self.store.save_conversation(existing.model_copy(update={
                            "group_ids": groups, "audio_url": record.audio_url, "updated_at": started}))
                    unchanged += 1
                else:
                    self.store.save_conversation(record.model_copy(update={
                        "group_ids": groups, "revision": existing.revision + 1, "imported_at": existing.imported_at,
                        "updated_at": started}))
                    updated += 1
                    issues.append(ImportIssue(severity="warning", code="transcript_changed", conversation_id=record.id,
                                              message="The transcript differs from the stored one; it was updated "
                                                      "and earlier evaluations are marked stale."))
                accepted.append(record.id)
        rejected = sum(1 for issue in issues if issue.severity == "error")
        status = "completed" if rejected == 0 else ("failed" if not accepted else "partial")
        run = ImportRun(id=new_id(), group_id=group_id, source=source, method=method, status=status,
                        started_at=started, finished_at=now_iso(), reported_total=parsed.reported_total,
                        received=parsed.received, created=created, updated=updated, unchanged=unchanged,
                        rejected=rejected, conversation_ids=accepted, issues=issues[:500])
        self.store.add_import(run)
        label = ("fixtures" if source == "fixture" else
                 "a pasted organizers' API response" if method == "paste" else "the organizers' API")
        self.store.log("conversations.imported",
                       f"Imported group {group_id} from {label}: {created} new, {updated} updated, {unchanged} "
                       f"unchanged, {rejected} rejected.", actor=actor,
                       details={"group_id": group_id, "source": source, "method": method, "import_id": run.id})
        return run

    def _record_failure(self, group_id: str, source: ConversationSource, started: str, message: str,
                        method: ImportMethod = "fetch") -> None:
        run = ImportRun(id=new_id(), group_id=group_id, source=source, method=method, status="failed",
                        started_at=started, finished_at=now_iso(), error=message)
        self.store.add_import(run)
        self.store.log("conversations.import_failed", f"Import of group {group_id} failed: {message}",
                       details={"group_id": group_id, "source": source, "method": method})

    def records(self, group_id: str | None = None) -> list[ConversationRecord]:
        """Stored conversations with full transcripts, exactly as persisted, ordered by conversation id."""
        with self.store.lock:
            items = list(self.store.conversations.values())
        return sorted((r for r in items if group_id is None or group_id in r.group_ids), key=lambda r: r.id)

    # ---- conversations ------------------------------------------------------------------------
    def conversation(self, conversation_id: str) -> ConversationRecord:
        if not re.fullmatch(CONVERSATION_ID_PATTERN, conversation_id or ""):
            raise NotFoundError("Unknown conversation.", code="conversation_not_found")
        record = self.store.conversations.get(conversation_id)
        if record is None:
            raise NotFoundError(f"Conversation {conversation_id} does not exist.", code="conversation_not_found")
        return record

    def _open_appeals(self) -> Counter:
        return Counter(a.conversation_id for a in self.store.appeals.values() if a.status == "pending")

    def summary(self, record: ConversationRecord, latest: EvaluationRecord | None,
                open_appeals: int) -> ConversationSummary:
        counts = Counter(m.speaker for m in record.messages)
        offsets = [m.offset_seconds for m in record.messages if m.offset_seconds is not None]
        first_client = next((m.text for m in record.messages if m.speaker == "client" and m.text.strip()),
                            record.messages[0].text if record.messages else "")
        return ConversationSummary(
            id=record.id, group_ids=record.group_ids, channel=record.channel, channel_raw=record.channel_raw,
            language=record.language, source=record.source, has_audio=bool(record.audio_url),
            message_count=len(record.messages), speaker_counts=dict(counts),
            duration_seconds=(max(offsets) - min(offsets)) if offsets else None,
            preview=first_client[:160], imported_at=record.imported_at, updated_at=record.updated_at,
            revision=record.revision, latest_evaluation=self.evaluations.brief(latest) if latest else None,
            open_appeals=open_appeals)

    def list_conversations(self, *, q: str | None = None, language: list[str] | None = None,
                           channel: list[str] | None = None, status: list[str] | None = None,
                           group_id: str | None = None, source: str | None = None, min_score: float | None = None,
                           max_score: float | None = None, checklist_id: str | None = None, sort: SortKey = "id",
                           desc: bool = False, page: int = 1, page_size: int = 25) -> ConversationPage:
        appeals = self._open_appeals()
        index = self.evaluations.index()
        rows: list[tuple[ConversationRecord, EvaluationRecord | None]] = [
            (record, self.evaluations.pick(index.get(record.id, []), checklist_id))
            for record in self.store.conversations.values()]
        facets = {
            "language": _facets([r.language for r, _ in rows]),
            "channel": _facets([r.channel for r, _ in rows]),
            "group": _facets([g for r, _ in rows for g in r.group_ids]),
            "source": _facets([r.source for r, _ in rows]),
            "status": _facets([e.status if e else "not_evaluated" for _, e in rows]),
        }
        needle = q.strip().casefold() if q and q.strip() else None

        def keep(record: ConversationRecord, latest: EvaluationRecord | None) -> bool:
            if language and record.language not in language:
                return False
            if channel and record.channel not in channel:
                return False
            if group_id and group_id not in record.group_ids:
                return False
            if source and record.source != source:
                return False
            if status:
                state = latest.status if latest else "not_evaluated"
                if not (state in status or ("appealed" in status and appeals.get(record.id))):
                    return False
            if min_score is not None or max_score is not None:
                total = latest.final_score.total if latest and latest.final_score else None
                if total is None:
                    return False
                if min_score is not None and total < min_score:
                    return False
                if max_score is not None and total > max_score:
                    return False
            if needle:
                return needle in record.id.casefold() or any(needle in m.text.casefold() for m in record.messages)
            return True

        matched = [(r, e) for r, e in rows if keep(r, e)]

        def sort_key(row: tuple[ConversationRecord, EvaluationRecord | None]):
            record, latest = row
            total = latest.final_score.total if latest and latest.final_score else None
            offsets = [m.offset_seconds for m in record.messages if m.offset_seconds is not None]
            missing_last = (total is None) if not desc else (total is not None)
            return {
                "id": (record.id,),
                "imported_at": (record.imported_at, record.id),
                "score": (missing_last, total or 0.0, record.id),
                "messages": (len(record.messages), record.id),
                "duration": ((max(offsets) - min(offsets)) if offsets else -1, record.id),
                "language": (record.language, record.id),
                "channel": (record.channel, record.id),
                "evaluated_at": ((latest.completed_at or latest.created_at) if latest else "", record.id),
            }[sort]

        matched.sort(key=sort_key, reverse=desc)
        start = (page - 1) * page_size
        items = [self.summary(r, e, appeals.get(r.id, 0)) for r, e in matched[start:start + page_size]]
        return ConversationPage(items=items, total=len(matched), page=page, page_size=page_size, facets=facets)

    def conversation_detail(self, conversation_id: str) -> ConversationDetail:
        record = self.conversation(conversation_id)
        evaluations = self.evaluations.for_conversation(record.id)
        summary = self.summary(record, evaluations[0] if evaluations else None, self._open_appeals().get(record.id, 0))
        return ConversationDetail(**summary.model_dump(), audio_url=record.audio_url, messages=record.messages,
                                  transcript_hash=record.transcript_hash, warnings=record.warnings,
                                  evaluations=[self.evaluations.brief(e) for e in evaluations])

    def audio(self, conversation_id: str) -> AudioInfo:
        return self.audio_resolver.resolve(self.conversation(conversation_id))

    # ---- overview -----------------------------------------------------------------------------
    def overview(self, checklist_id: str | None = None) -> Overview:
        conversations = list(self.store.conversations.values())
        completed = [e for e in self.store.evaluations.values() if e.status == "completed" and e.final_score]
        if checklist_id is None and completed:
            checklist_id = max(completed, key=lambda e: e.completed_at or "").checklist_id
        index = self.evaluations.index()
        focus: list[EvaluationRecord] = []
        for record in conversations:
            latest = self.evaluations.pick(index.get(record.id, []), checklist_id, True) if checklist_id else None
            if latest:
                focus.append(latest)
        checklist = self.store.checklists.get(checklist_id) if checklist_id else None
        scored = [e.final_score.total for e in focus if e.final_score and e.final_score.total is not None]
        max_score = focus[0].final_score.max_score if focus and focus[0].final_score else None
        bins: list[ScoreBin] = []
        if max_score:
            width = max_score / 10
            for i in range(10):
                low, high = i * width, (i + 1) * width
                count = sum(1 for s in scored if low <= s < high or (i == 9 and s == high))
                bins.append(ScoreBin(start=round(low, 6), end=round(high, 6), count=count))

        stats: dict[str, dict] = {}
        names: dict[str, str] = {}
        order: list[str] = []
        if checklist:
            order = [c.id for c in checklist.version().config.criteria]
            names = {c.id: c.name for c in checklist.version().config.criteria}
        for evaluation in focus:
            for criterion in evaluation.final_score.criteria:  # type: ignore[union-attr]
                names.setdefault(criterion.criterion_id, criterion.name)
                if criterion.criterion_id not in order:
                    order.append(criterion.criterion_id)
                entry = stats.setdefault(criterion.criterion_id, {"evaluated": 0, "scored": 0, "na": 0, "severe": 0,
                                                                  "sum": 0.0})
                entry["evaluated"] += 1
                if criterion.status == "scored" and criterion.normalized is not None:
                    entry["scored"] += 1
                    entry["sum"] += criterion.normalized
                elif criterion.status == "na":
                    entry["na"] += 1
                entry["severe"] += int(criterion.severe_error)
        criterion_stats = [CriterionStat(criterion_id=cid, name=names.get(cid, cid), evaluated=s["evaluated"],
                                         scored=s["scored"], na=s["na"], severe=s["severe"],
                                         mean_normalized=s["sum"] / s["scored"] if s["scored"] else None)
                           for cid in order if (s := stats.get(cid))]
        latest_any = [self.evaluations.pick(index.get(r.id, [])) for r in conversations]
        appeals = list(self.store.appeals.values())
        return Overview(
            conversations=len(conversations),
            by_language=_facets([r.language for r in conversations]),
            by_channel=_facets([r.channel for r in conversations]),
            by_group=_facets([g for r in conversations for g in r.group_ids]),
            by_source=_facets([r.source for r in conversations]),
            evaluated_conversations=len({e.conversation_id for e in completed}),
            evaluations_by_status=_facets([e.status for e in self.store.evaluations.values()]),
            mean_final_score=sum(scored) / len(scored) if scored else None, max_score=max_score, score_bins=bins,
            severe_error_conversations=sum(1 for e in focus if e.final_score and e.final_score.severe_errors),
            appeals_pending=sum(1 for a in appeals if a.status == "pending"),
            appeals_decided=sum(1 for a in appeals if a.status != "pending"),
            overridden_criteria=sum(len(e.overrides) for e in self.store.evaluations.values()),
            checklist_id=checklist.id if checklist else None, checklist_name=checklist.name if checklist else None,
            checklist_version=checklist.latest_version if checklist else None, criterion_stats=criterion_stats,
            mock_results=sum(1 for e in latest_any if e and e.evaluator.is_mock),
            recent_imports=self.store.imports[:5], recent_activity=self.store.events(limit=12))
