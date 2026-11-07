"""Checklist configuration with immutable versions.

Every saved change to criteria, sections or scoring rules becomes a new version; earlier versions are never
modified, and each evaluation stores the exact version it used, so past results stay reproducible. Name,
description, origin and archive flag are metadata and are edited in place.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.core.errors import ConflictError, NotFoundError, ValidationFailed
from app.cqa.schemas import (
    Checklist,
    ChecklistConfig,
    ChecklistCreate,
    ChecklistDuplicate,
    ChecklistImport,
    ChecklistSummary,
    ChecklistUpdate,
    ChecklistVersion,
    CriterionReplace,
    Replacement,
)
from app.cqa.store import CqaStore, now_iso
from app.storage.paths import check_id, new_id

DEV_CHECKLIST_PATH = Path(__file__).resolve().parent / "fixtures" / "dev_checklist.json"


def config_hash(config: ChecklistConfig) -> str:
    canonical = json.dumps(config.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class ChecklistService:
    def __init__(self, store: CqaStore) -> None:
        self.store = store

    # ---- reads --------------------------------------------------------------------------------
    def get(self, checklist_id: str) -> Checklist:
        check_id(checklist_id)
        checklist = self.store.checklists.get(checklist_id)
        if checklist is None:
            raise NotFoundError(f"Checklist {checklist_id} does not exist.", code="checklist_not_found")
        return checklist

    def version(self, checklist_id: str, number: int | None = None) -> tuple[Checklist, ChecklistVersion]:
        checklist = self.get(checklist_id)
        try:
            return checklist, checklist.version(number)
        except KeyError:
            raise NotFoundError(f"Checklist '{checklist.name}' has no version {number}.",
                                code="checklist_version_not_found") from None

    def summaries(self, include_archived: bool = False) -> list[ChecklistSummary]:
        counts: dict[str, int] = {}
        for evaluation in self.store.evaluations.values():
            counts[evaluation.checklist_id] = counts.get(evaluation.checklist_id, 0) + 1
        items = []
        for checklist in self.store.checklists.values():
            if checklist.archived and not include_archived:
                continue
            config = checklist.version().config
            items.append(ChecklistSummary(
                id=checklist.id, name=checklist.name, description=checklist.description, origin=checklist.origin,
                archived=checklist.archived, latest_version=checklist.latest_version, versions=len(checklist.versions),
                criteria=len(config.criteria), sections=len(config.sections),
                total_weight=sum(c.weight for c in config.criteria), created_at=checklist.created_at,
                updated_at=checklist.updated_at, evaluations=counts.get(checklist.id, 0)))
        return sorted(items, key=lambda s: s.updated_at, reverse=True)

    def export(self, checklist_id: str, number: int | None = None) -> dict:
        checklist, version = self.version(checklist_id, number)
        return {"format": "atlas-cqa-checklist/1", "name": checklist.name, "description": checklist.description,
                "origin": checklist.origin, "version": version.version,
                "config": version.config.model_dump(mode="json")}

    # ---- writes -------------------------------------------------------------------------------
    def _new(self, name: str, description: str, origin: str, config: ChecklistConfig, note: str,
             duplicated_from: str | None = None) -> Checklist:
        now = now_iso()
        checklist = Checklist(id=new_id(), name=name.strip(), description=description.strip(), origin=origin,
                              created_at=now, updated_at=now, latest_version=1, duplicated_from=duplicated_from,
                              versions=[ChecklistVersion(version=1, created_at=now, note=note.strip() or "Created",
                                                         config=config, config_hash=config_hash(config))])
        self.store.save_checklist(checklist)
        return checklist

    def create(self, payload: ChecklistCreate, actor: str = "User") -> Checklist:
        checklist = self._new(payload.name, payload.description, payload.origin, payload.config, payload.note)
        self.store.log("checklist.created", f"Created checklist '{checklist.name}' (v1).", actor=actor,
                       checklist_id=checklist.id, details={"criteria": len(payload.config.criteria)})
        return checklist

    def import_(self, payload: ChecklistImport, actor: str = "User") -> Checklist:
        checklist = self._new(payload.name, payload.description, payload.origin, payload.config, "Imported from JSON")
        self.store.log("checklist.imported", f"Imported checklist '{checklist.name}'.", actor=actor,
                       checklist_id=checklist.id)
        return checklist

    def create_dev_sample(self, actor: str = "User") -> Checklist:
        document = json.loads(DEV_CHECKLIST_PATH.read_text(encoding="utf-8"))
        payload = ChecklistImport.model_validate({k: v for k, v in document.items() if not k.startswith("_")})
        checklist = self._new(payload.name, payload.description, "dev_sample", payload.config,
                              "Development sample (unofficial placeholder criteria)")
        self.store.log("checklist.created", f"Created the unofficial development sample '{checklist.name}'.",
                       actor=actor, checklist_id=checklist.id)
        return checklist

    def update(self, checklist_id: str, payload: ChecklistUpdate, actor: str = "User") -> Checklist:
        with self.store.lock:
            checklist = self.get(checklist_id)
            changes: dict = {}
            for field in ("name", "description", "origin", "archived"):
                value = getattr(payload, field)
                if value is not None and value != getattr(checklist, field):
                    changes[field] = value.strip() if isinstance(value, str) else value
            new_version = None
            if payload.config is not None:
                if payload.base_version != checklist.latest_version:
                    raise ConflictError(
                        f"This checklist changed since you opened it (now v{checklist.latest_version}, you edited "
                        f"v{payload.base_version}). Reload it and apply your edits again.", code="stale_checklist",
                        details={"latest_version": checklist.latest_version})
                digest = config_hash(payload.config)
                if digest != checklist.version().config_hash:
                    new_version = ChecklistVersion(version=checklist.latest_version + 1, created_at=now_iso(),
                                                   note=payload.note.strip() or "Edited", config=payload.config,
                                                   config_hash=digest)
            if not changes and new_version is None:
                return checklist
            versions = checklist.versions + ([new_version] if new_version else [])
            updated = checklist.model_copy(update={
                **changes, "versions": versions, "updated_at": now_iso(),
                "latest_version": new_version.version if new_version else checklist.latest_version})
            self.store.save_checklist(updated)
        if new_version:
            self.store.log("checklist.version_saved",
                           f"Saved '{updated.name}' v{new_version.version}: {new_version.note}", actor=actor,
                           checklist_id=updated.id, details={"version": new_version.version})
        if changes:
            self.store.log("checklist.updated", f"Updated details of '{updated.name}'.", actor=actor,
                           checklist_id=updated.id, details={"fields": sorted(changes)})
        return updated

    def replace_criterion(self, checklist_id: str, criterion_id: str, payload: CriterionReplace,
                          actor: str = "User") -> Checklist:
        with self.store.lock:
            checklist = self.get(checklist_id)
            if payload.base_version != checklist.latest_version:
                raise ConflictError(f"This checklist is now at v{checklist.latest_version}; reload before replacing "
                                    "a criterion.", code="stale_checklist",
                                    details={"latest_version": checklist.latest_version})
            config = checklist.version().config
            old = config.criterion(criterion_id)
            if old is None:
                raise NotFoundError(f"Criterion '{criterion_id}' is not in v{checklist.latest_version}.",
                                    code="criterion_not_found")
            new = payload.criterion
            if new.id == old.id:
                raise ValidationFailed("A replacement needs a new criterion id. To change the criterion in place, "
                                       "edit it instead.", code="replacement_same_id")
            if config.criterion(new.id) is not None:
                raise ValidationFailed(f"Criterion id '{new.id}' is already used.", code="duplicate_criterion_id")
            criteria = [new if c.id == old.id else c for c in config.criteria]
            try:
                new_config = ChecklistConfig.model_validate({**config.model_dump(mode="json"),
                                                             "criteria": [c.model_dump(mode="json") for c in criteria]})
            except ValueError as error:
                raise ValidationFailed(str(error), code="invalid_checklist") from None
            note = payload.note.strip() or f"Replaced '{old.name}' with '{new.name}'"
            version = ChecklistVersion(version=checklist.latest_version + 1, created_at=now_iso(), note=note,
                                       config=new_config, config_hash=config_hash(new_config),
                                       replacements=[Replacement(old_id=old.id, new_id=new.id, old_name=old.name,
                                                                 new_name=new.name)])
            updated = checklist.model_copy(update={"versions": [*checklist.versions, version],
                                                   "latest_version": version.version, "updated_at": now_iso()})
            self.store.save_checklist(updated)
        self.store.log("checklist.criterion_replaced",
                       f"'{updated.name}' v{version.version}: replaced '{old.name}' with '{new.name}'.", actor=actor,
                       checklist_id=updated.id,
                       details={"version": version.version, "old_id": old.id, "new_id": new.id})
        return updated

    def duplicate(self, checklist_id: str, payload: ChecklistDuplicate, actor: str = "User") -> Checklist:
        source, version = self.version(checklist_id, payload.version)
        name = payload.name or f"{source.name} (copy)"
        origin = "dev_sample" if source.origin == "dev_sample" else "custom"
        copy = self._new(name, source.description, origin, version.config,
                         f"Duplicated from '{source.name}' v{version.version}", duplicated_from=source.id)
        self.store.log("checklist.duplicated", f"Duplicated '{source.name}' v{version.version} as '{copy.name}'.",
                       actor=actor, checklist_id=copy.id, details={"source_id": source.id,
                                                                   "source_version": version.version})
        return copy

    def delete(self, checklist_id: str, actor: str = "User") -> None:
        with self.store.lock:
            checklist = self.get(checklist_id)
            used = sum(1 for e in self.store.evaluations.values() if e.checklist_id == checklist_id)
            if used:
                raise ConflictError(f"'{checklist.name}' is used by {used} evaluation(s); archive it instead so those "
                                    "results stay reproducible.", code="checklist_in_use")
            self.store.delete_checklist(checklist_id)
        self.store.log("checklist.deleted", f"Deleted checklist '{checklist.name}'.", actor=actor,
                       checklist_id=checklist_id)
