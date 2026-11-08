"""Checklist configuration with immutable versions.

Every saved change to criteria, sections or scoring rules becomes a new version; earlier versions are never
modified, and each evaluation stores the exact version it used, so past results stay reproducible. Name,
description, origin and archive flag are metadata and are edited in place.

Every write that creates a version (create, import, duplicate, from template, edit, replace) must be
*complete*: the weights of the enabled criteria add up to exactly 100 (unweighted critical-error indicators
do not count). Versions saved before this rule existed are still read and used as they are.

Starter templates (``templates/*.json``) are read-only reference documents. One checklist is created at start-up:
"Freedom Broker — Official CQA Checklist", whose version 1 is the official template. It has a fixed id and is
created only when no checklist from that template exists, so restarts never duplicate it and never touch the
manager's later versions. A latest version that is still the pre-wording template (``OLD_OFFICIAL_CONFIG_HASH``)
is upgraded once to the current template. Everything else is created from a template only on request.
"""

from __future__ import annotations

import hashlib
import json
import logging
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.core.errors import ConflictError, NotFoundError, ValidationFailed
from app.cqa.schemas import (
    Checklist,
    ChecklistConfig,
    ChecklistCreate,
    ChecklistDuplicate,
    ChecklistFromTemplate,
    ChecklistImport,
    ChecklistSummary,
    ChecklistTemplate,
    ChecklistTemplateSummary,
    ChecklistUpdate,
    ChecklistValidation,
    ChecklistVersion,
    ChecklistVersionDetail,
    ChecklistVersionSummary,
    CriterionReplace,
    Replacement,
    ValidationIssue,
)
from app.cqa.store import CqaStore, now_iso
from app.storage.paths import check_id, new_id

logger = logging.getLogger("atlas.cqa")

DEV_CHECKLIST_PATH = Path(__file__).resolve().parent / "fixtures" / "dev_checklist.json"
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
EXPECTED_TOTAL = Fraction(100)
OFFICIAL_TEMPLATE_ID = "freedom-broker-official"
# The official checklist's id, fixed (uuid5 of "atlas:cqa:checklist:freedom-broker-official") so that two API
# processes starting at once write the same file instead of two checklists. Never change it.
OFFICIAL_CHECKLIST_ID = "0dfc4cc62904551aa3d34249dab95993"
# config_hash of the official template config at
# git show HEAD:apps/api/app/cqa/templates/freedom_broker_official.json
# before the checklist PDF wording was added. Only a latest version with this hash is upgraded.
OLD_OFFICIAL_CONFIG_HASH = "6908881461f8e828178e3cf853acb3e2db6a8d71d70de68ae4e4d11e3b96c421"
OFFICIAL_WORDING_NOTE = "Wording and sections from CQA_Chat_Quality_Checklist.pdf"


def config_hash(config: ChecklistConfig) -> str:
    canonical = json.dumps(config.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def weight_total(config: ChecklistConfig) -> Fraction:
    """Exact sum of the enabled criteria's weights (as typed: 33.3 + 33.3 + 33.4 is exactly 100)."""
    return sum((Fraction(str(c.weight)) for c in config.active_criteria), Fraction(0))


def completeness_issues(config: ChecklistConfig) -> list[ValidationIssue]:
    """What keeps a structurally valid configuration from being saved as a version."""
    total = weight_total(config)
    if total == EXPECTED_TOTAL:
        return []
    return [ValidationIssue(
        code="invalid_weights",
        message=(f"The enabled criteria's weights add up to {float(total):g}%; they must add up to 100%. "
                 "Unweighted critical-error indicators are not counted."))]


@lru_cache(maxsize=1)
def _templates() -> dict[str, ChecklistTemplate]:
    templates: dict[str, ChecklistTemplate] = {}
    for path in sorted(TEMPLATES_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        config = ChecklistConfig.model_validate(document["config"])
        template = ChecklistTemplate(
            id=document["id"], name=document["name"], description=document.get("description", ""),
            origin=document.get("origin", "custom"), source=document.get("source", ""),
            notes=document.get("notes", []), criteria=len(config.criteria),
            total_weight=float(weight_total(config)), config=config)
        templates[template.id] = template
    return templates


def _values(criterion) -> str:
    if criterion.answer_type == "numeric":
        return ", ".join(f"{s:g}" for s in criterion.allowed_scores)
    return criterion.answer_type


def official_format_issues(config: ChecklistConfig) -> list[str]:
    """Why results under ``config`` could not be submitted in the organizers' JSON 1.0 format (empty: they can).

    The reference is the official template: the same eight criteria, all enabled, with the same ids, weights,
    answer types, allowed values and N/A settings (``critical`` stays the unweighted indicator), no other enabled
    criterion, and scores from 0 to 100 rounded to two decimals with critical errors reported, not zeroing the
    total. Titles, wording and order are free.
    """
    reference = _templates()[OFFICIAL_TEMPLATE_ID].config
    issues: list[str] = []
    for expected in reference.criteria:
        actual = config.criterion(expected.id)
        where = f"Criterion '{expected.id}'"
        if actual is None:
            issues.append(f"{where} is missing.")
            continue
        if not actual.enabled:
            issues.append(f"{where} is disabled.")
        if Fraction(str(actual.weight)) != Fraction(str(expected.weight)):
            issues.append(f"{where} has weight {actual.weight:g}; the official weight is {expected.weight:g}.")
        if actual.answer_type != expected.answer_type or (
                expected.answer_type == "numeric"
                and [Fraction(str(s)) for s in actual.allowed_scores] != [Fraction(str(s)) for s in
                                                                          expected.allowed_scores]):
            issues.append(f"{where} answers with {_values(actual)}; officially {_values(expected)}.")
        if actual.na_allowed != expected.na_allowed:
            issues.append(f"{where} {'allows' if actual.na_allowed else 'does not allow'} N/A; officially it "
                          f"{'does' if expected.na_allowed else 'does not'}.")
    extra = [c.id for c in config.active_criteria if reference.criterion(c.id) is None]
    if extra:
        issues.append(f"Criteria outside the official eight are enabled: {', '.join(extra)}.")
    scoring = config.scoring
    if scoring.max_score != reference.scoring.max_score:
        issues.append(f"The total runs to {scoring.max_score:g}; officially it runs from 0 to 100.")
    if scoring.rounding.mode == "none" or scoring.rounding.digits != 2:
        issues.append("The total must be rounded to two decimals.")
    if scoring.severe_error_policy != "flag_only":
        issues.append("A critical error sets the total to 0; officially it is reported separately and does not "
                      "zero the total.")
    return issues


def _issues_from(error: ValidationError, payload: Any) -> list[ValidationIssue]:
    criteria = payload.get("criteria") if isinstance(payload, dict) else None
    issues = []
    for item in error.errors()[:50]:
        loc = item.get("loc", ())
        criterion_id = None
        if len(loc) >= 2 and loc[0] == "criteria" and isinstance(loc[1], int) and isinstance(criteria, list) \
                and loc[1] < len(criteria) and isinstance(criteria[loc[1]], dict):
            criterion_id = criteria[loc[1]].get("id")
        message = str(item.get("msg", "invalid")).removeprefix("Value error, ")
        issues.append(ValidationIssue(code="invalid_config", message=message, criterion_id=criterion_id,
                                      location=".".join(str(part) for part in loc) or None))
    return issues


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
        """The checklist and one of its versions (default: the latest). Evaluations resolve versions here."""
        checklist = self.get(checklist_id)
        try:
            return checklist, checklist.version(number)
        except KeyError:
            raise NotFoundError(f"Checklist '{checklist.name}' has no version {number}.",
                                code="checklist_version_not_found") from None

    def version_detail(self, checklist_id: str, number: int | None = None) -> ChecklistVersionDetail:
        checklist, version = self.version(checklist_id, number)
        format_issues = official_format_issues(version.config)
        return ChecklistVersionDetail(
            checklist_id=checklist.id, checklist_name=checklist.name, origin=checklist.origin,
            version=version.version, is_latest=version.version == checklist.latest_version,
            created_at=version.created_at, note=version.note, config_hash=version.config_hash,
            replacements=version.replacements, config=version.config,
            active_criteria=[c.id for c in version.config.active_criteria],
            official_format_compatible=not format_issues, official_format_issues=format_issues)

    def versions(self, checklist_id: str) -> list[ChecklistVersionSummary]:
        """Every version of a checklist, newest first."""
        checklist = self.get(checklist_id)
        used: dict[int, int] = {}
        for evaluation in self.store.evaluations.values():
            if evaluation.checklist_id == checklist.id:
                used[evaluation.checklist_version] = used.get(evaluation.checklist_version, 0) + 1
        items = []
        for version in sorted(checklist.versions, key=lambda v: v.version, reverse=True):
            config = version.config
            items.append(ChecklistVersionSummary(
                version=version.version, created_at=version.created_at, note=version.note,
                config_hash=version.config_hash, is_latest=version.version == checklist.latest_version,
                criteria=len(config.criteria), enabled_criteria=len(config.active_criteria),
                total_weight=float(weight_total(config)), weights_valid=not completeness_issues(config),
                official_format_compatible=not official_format_issues(config),
                replacements=version.replacements, evaluations=used.get(version.version, 0)))
        return items

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
                criteria=len(config.criteria), enabled_criteria=len(config.active_criteria),
                sections=len(config.sections), total_weight=float(weight_total(config)),
                weights_valid=not completeness_issues(config),
                official_format_compatible=not official_format_issues(config), template_id=checklist.template_id,
                created_at=checklist.created_at, updated_at=checklist.updated_at,
                evaluations=counts.get(checklist.id, 0)))
        return sorted(items, key=lambda s: s.updated_at, reverse=True)

    def export(self, checklist_id: str, number: int | None = None) -> dict:
        checklist, version = self.version(checklist_id, number)
        return {"format": "atlas-cqa-checklist/1", "name": checklist.name, "description": checklist.description,
                "origin": checklist.origin, "version": version.version,
                "config": version.config.model_dump(mode="json")}

    def validate(self, payload: Any) -> ChecklistValidation:
        """Check a configuration without saving it: structure first, then the 100% weight rule."""
        try:
            config = ChecklistConfig.model_validate(payload)
        except ValidationError as error:
            return ChecklistValidation(valid=False, total_weight=None, issues=_issues_from(error, payload))
        issues = completeness_issues(config)
        return ChecklistValidation(
            valid=not issues, total_weight=float(weight_total(config)), criteria=len(config.criteria),
            enabled_criteria=len(config.active_criteria),
            indicators=[c.id for c in config.active_criteria if c.is_indicator], issues=issues)

    # ---- templates ------------------------------------------------------------------------------
    def templates(self) -> list[ChecklistTemplateSummary]:
        return [ChecklistTemplateSummary.model_validate(t.model_dump(exclude={"notes", "config"}))
                for t in _templates().values()]

    def template(self, template_id: str) -> ChecklistTemplate:
        template = _templates().get(template_id)
        if template is None:
            raise NotFoundError(f"Checklist template '{template_id}' does not exist.", code="template_not_found")
        return template.model_copy(deep=True)

    # ---- writes -------------------------------------------------------------------------------
    @staticmethod
    def _require_complete(config: ChecklistConfig, hint: str = "") -> None:
        issues = completeness_issues(config)
        if issues:
            message = " ".join(i.message for i in issues) + (f" {hint}" if hint else "")
            raise ValidationFailed(message, code="invalid_weights",
                                   details={"total_weight": float(weight_total(config)),
                                            "expected_total": float(EXPECTED_TOTAL),
                                            "issues": [i.model_dump() for i in issues]})

    def _new(self, name: str, description: str, origin: str, config: ChecklistConfig, note: str,
             duplicated_from: str | None = None, template_id: str | None = None,
             checklist_id: str | None = None) -> Checklist:
        self._require_complete(config)
        now = now_iso()
        checklist = Checklist(id=checklist_id or new_id(), name=name.strip(), description=description.strip(),
                              origin=origin,
                              created_at=now, updated_at=now, latest_version=1, duplicated_from=duplicated_from,
                              template_id=template_id,
                              versions=[ChecklistVersion(version=1, created_at=now, note=note.strip() or "Created",
                                                         config=config, config_hash=config_hash(config))])
        self.store.save_checklist(checklist)
        return checklist

    def create(self, payload: ChecklistCreate, actor: str = "User") -> Checklist:
        checklist = self._new(payload.name, payload.description, payload.origin, payload.config, payload.note)
        self.store.log("checklist.created", f"Created checklist '{checklist.name}' (v1).", actor=actor,
                       checklist_id=checklist.id, details={"criteria": len(payload.config.criteria)})
        return checklist

    def create_from_template(self, payload: ChecklistFromTemplate, actor: str = "User") -> Checklist:
        """A new, independent checklist (v1) with a copy of the template; the template itself never changes."""
        template = self.template(payload.template_id)
        description = template.description if payload.description is None else payload.description
        checklist = self._new(payload.name or template.name, description, template.origin, template.config,
                              f"Created from template '{template.name}'", template_id=template.id)
        self.store.log("checklist.created", f"Created checklist '{checklist.name}' (v1) from template "
                                            f"'{template.id}'.", actor=actor, checklist_id=checklist.id,
                       details={"template_id": template.id, "criteria": len(template.config.criteria)})
        return checklist

    def ensure_official_checklist(self) -> Checklist | None:
        """Create "Freedom Broker — Official CQA Checklist" (v1 = the official template) unless one exists.

        Runs at every start-up and is idempotent. An official checklist exists when its fixed id is in use (also
        archived, also as an unreadable file) or any checklist was created from the official template. A latest
        version whose config is still the pre-wording template gets one new version from the current template.
        Any other latest version, including a manager's edit, is left exactly as it is. Only when none is left
        (for example after the manager deleted it) is it created again. Returns the new checklist, or None.
        """
        template = self.template(OFFICIAL_TEMPLATE_ID)
        with self.store.lock:
            existing = self.store.checklists.get(OFFICIAL_CHECKLIST_ID) or next(
                (c for c in self.store.checklists.values() if c.template_id == OFFICIAL_TEMPLATE_ID), None)
            if existing is not None:
                if existing.id == OFFICIAL_CHECKLIST_ID:
                    self._upgrade_official_wording(existing, template.config)
                    existing = self.store.checklists.get(OFFICIAL_CHECKLIST_ID) or existing
                edited = existing.version().config_hash != config_hash(template.config)
                logger.info("Official checklist present: '%s' v%d (%s).", existing.name, existing.latest_version,
                            "edited since the official baseline" if edited else "the official baseline")
                return None
            if (self.store.dirs["checklists"] / f"{OFFICIAL_CHECKLIST_ID}.json").exists():
                logger.warning("The official checklist file is unreadable; it is left as it is and not re-created.")
                return None
            checklist = self._new(template.name, template.description, "official", template.config,
                                  OFFICIAL_WORDING_NOTE, template_id=template.id,
                                  checklist_id=OFFICIAL_CHECKLIST_ID)
        self.store.log("checklist.created", f"Created the official checklist '{checklist.name}' (v1).",
                       checklist_id=checklist.id,
                       details={"template_id": template.id, "criteria": len(template.config.criteria)})
        return checklist

    def _upgrade_official_wording(self, checklist: Checklist, config: ChecklistConfig) -> None:
        """Append the current official template when the latest version is still the pre-wording baseline."""
        latest = checklist.version()
        if latest.config_hash != OLD_OFFICIAL_CONFIG_HASH:
            return
        digest = config_hash(config)
        if digest == latest.config_hash:
            return
        version = ChecklistVersion(version=checklist.latest_version + 1, created_at=now_iso(),
                                   note=OFFICIAL_WORDING_NOTE, config=config, config_hash=digest)
        updated = checklist.model_copy(update={"versions": [*checklist.versions, version],
                                               "latest_version": version.version, "updated_at": now_iso()})
        self.store.save_checklist(updated)
        self.store.log("checklist.version_saved",
                       f"Saved '{updated.name}' v{version.version}: {version.note}",
                       checklist_id=updated.id, details={"version": version.version})

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
                    self._require_complete(payload.config)
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
            self._require_complete(new_config, hint=(
                f"'{old.name}' had weight {old.weight:g} and the replacement has {new.weight:g}; give it the same "
                "weight, or edit the checklist to rebalance." if new.weight != old.weight else ""))
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
