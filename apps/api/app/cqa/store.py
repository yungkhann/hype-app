"""CQA persistence: local JSON documents, the same approach as ATLAS findings (atomic writes, one lock).

Layout under ``settings.data_dir/cqa`` (git-ignored with the rest of data/workspaces)::

    conversations/<id>.<hash8>.json   one file per conversation (hash suffix: case-insensitive filesystems)
    checklists/<id>.json              a checklist with its full version history
    evaluations/<id>.json             evaluation record: snapshot of the checklist version, results, overrides
    appeals/<id>.json                 appeal and reviewer decision
    imports.json                      the last 200 import runs
    audit.jsonl                       append-only audit trail

Everything is loaded into memory at start-up and written through on every change. Corrupt files are skipped
with a log line, never silently rewritten.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.cqa.schemas import Appeal, AuditEvent, Checklist, ConversationRecord, EvaluationRecord, ImportRun
from app.storage.paths import check_id, new_id, safe_child
from app.storage.workspace import read_json, write_json

logger = logging.getLogger("atlas.cqa")
M = TypeVar("M", bound=BaseModel)
MAX_IMPORTS = 200


def _load_dir(directory: Path, model: type[M]) -> dict[str, M]:
    items: dict[str, M] = {}
    for path in sorted(directory.glob("*.json")):
        try:
            item = model.model_validate(read_json(path))
        except (OSError, json.JSONDecodeError, ValidationError) as error:
            logger.warning("Skipping unreadable CQA file %s: %s", path.name, type(error).__name__)
            continue
        items[item.id] = item  # type: ignore[attr-defined]
    return items



def now_iso() -> str:
    """UTC timestamp with microseconds. CQA orders evaluations and appeals by creation time, and two created in the
    same second (a quick re-evaluation) must still sort in the order they were made."""
    return datetime.now(UTC).isoformat(timespec="microseconds")

class CqaStore:
    def __init__(self, data_dir: Path) -> None:
        self.root = Path(data_dir) / "cqa"
        self.dirs = {name: self.root / name for name in ("conversations", "checklists", "evaluations", "appeals")}
        for directory in self.dirs.values():
            directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conversations = _load_dir(self.dirs["conversations"], ConversationRecord)
        self.checklists = _load_dir(self.dirs["checklists"], Checklist)
        self.evaluations = _load_dir(self.dirs["evaluations"], EvaluationRecord)
        self.appeals = _load_dir(self.dirs["appeals"], Appeal)
        self.imports = [ImportRun.model_validate(i) for i in read_json(self.root / "imports.json", [])]
        self.audit: list[AuditEvent] = []
        audit_path = self.root / "audit.jsonl"
        if audit_path.exists():
            for line in audit_path.read_text(encoding="utf-8").splitlines():
                try:
                    self.audit.append(AuditEvent.model_validate_json(line))
                except ValidationError:
                    logger.warning("Skipping unreadable audit line")

    # ---- paths --------------------------------------------------------------------------------
    def _conversation_path(self, conversation_id: str) -> Path:
        suffix = hashlib.sha1(conversation_id.encode("utf-8")).hexdigest()[:8]
        return safe_child(self.dirs["conversations"], f"{conversation_id}.{suffix}.json")

    def _id_path(self, kind: str, item_id: str) -> Path:
        return safe_child(self.dirs[kind], f"{check_id(item_id)}.json")

    # ---- writes -------------------------------------------------------------------------------
    def save_conversation(self, record: ConversationRecord) -> None:
        with self.lock:
            write_json(self._conversation_path(record.id), record.model_dump(mode="json"))
            self.conversations[record.id] = record

    def save_checklist(self, checklist: Checklist) -> None:
        with self.lock:
            write_json(self._id_path("checklists", checklist.id), checklist.model_dump(mode="json"))
            self.checklists[checklist.id] = checklist

    def delete_checklist(self, checklist_id: str) -> None:
        with self.lock:
            self._id_path("checklists", checklist_id).unlink(missing_ok=True)
            self.checklists.pop(checklist_id, None)

    def save_evaluation(self, record: EvaluationRecord) -> None:
        with self.lock:
            write_json(self._id_path("evaluations", record.id), record.model_dump(mode="json"))
            self.evaluations[record.id] = record

    def save_appeal(self, appeal: Appeal) -> None:
        with self.lock:
            write_json(self._id_path("appeals", appeal.id), appeal.model_dump(mode="json"))
            self.appeals[appeal.id] = appeal

    def add_import(self, run: ImportRun) -> None:
        with self.lock:
            self.imports.insert(0, run)
            del self.imports[MAX_IMPORTS:]
            write_json(self.root / "imports.json", [i.model_dump(mode="json") for i in self.imports])

    def log(self, type_: str, summary: str, *, actor: str = "system", conversation_id: str | None = None,
            evaluation_id: str | None = None, checklist_id: str | None = None, appeal_id: str | None = None,
            details: dict | None = None) -> AuditEvent:
        event = AuditEvent(id=new_id(), at=now_iso(), type=type_, actor=actor, summary=summary,
                           conversation_id=conversation_id, evaluation_id=evaluation_id, checklist_id=checklist_id,
                           appeal_id=appeal_id, details=details or {})
        with self.lock:
            path = self.root / "audit.jsonl"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(event.model_dump_json() + "\n")
            self.audit.append(event)
        return event

    def events(self, *, conversation_id: str | None = None, evaluation_id: str | None = None,
               checklist_id: str | None = None, appeal_id: str | None = None, limit: int = 200) -> list[AuditEvent]:
        def keep(event: AuditEvent) -> bool:
            return ((conversation_id is None or event.conversation_id == conversation_id)
                    and (evaluation_id is None or event.evaluation_id == evaluation_id)
                    and (checklist_id is None or event.checklist_id == checklist_id)
                    and (appeal_id is None or event.appeal_id == appeal_id))
        with self.lock:
            matched = [event for event in reversed(self.audit) if keep(event)]
        return matched[:limit]

