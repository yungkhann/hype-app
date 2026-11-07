"""Findings, the pitch deck, and saved explorer views, persisted as local JSON documents."""

from __future__ import annotations

import threading

from app.core.errors import NotFoundError, ValidationFailed
from app.schemas.findings import (
    Finding,
    FindingIn,
    FindingPatch,
    PitchDeck,
    PitchSlide,
    SavedView,
    SavedViewIn,
)
from app.storage.paths import new_id
from app.storage.workspace import Workspace
from app.utils.frames import now_iso

DEFAULT_SLIDES = [
    ("title", "", "Team name · Data Challenge: Doomsday · 2026"),
    ("problem", "Problem statement", "Write the business problem in one or two sentences."),
    ("observations", "Key data observations", "Attach the findings that describe the data."),
    ("solution", "Proposed solution", "What the team built and the decision it supports."),
    ("methodology", "Methodology", "Data used, preparation, validation strategy, and baselines."),
    ("results", "Validated results", "Attach model or analysis findings with their evidence."),
    ("impact", "Business impact and limitations", "Expected impact, assumptions, and what is not proven."),
]


class ReportStore:
    def __init__(self, workspace: Workspace) -> None:
        self.ws = workspace
        self._lock = threading.Lock()

    # ---- findings ------------------------------------------------------------------
    def findings(self) -> list[Finding]:
        return [Finding.model_validate(f) for f in self.ws.read_doc("findings", [])]

    def _save_findings(self, findings: list[Finding]) -> None:
        self.ws.write_doc("findings", [f.model_dump(mode="json") for f in findings])

    def create_finding(self, payload: FindingIn) -> Finding:
        with self._lock:
            findings = self.findings()
            timestamp = now_iso()
            finding = Finding(id=new_id(), created_at=timestamp, updated_at=timestamp, **payload.model_dump())
            findings.append(finding)
            self._save_findings(findings)
            return finding

    def get_finding(self, finding_id: str) -> Finding:
        for finding in self.findings():
            if finding.id == finding_id:
                return finding
        raise NotFoundError(f"Finding {finding_id} does not exist.", code="finding_not_found")

    def update_finding(self, finding_id: str, patch: FindingPatch) -> Finding:
        with self._lock:
            findings = self.findings()
            for index, finding in enumerate(findings):
                if finding.id == finding_id:
                    updated = finding.model_copy(update={**patch.model_dump(exclude_unset=True),
                                                         "updated_at": now_iso()})
                    findings[index] = Finding.model_validate(updated.model_dump())
                    self._save_findings(findings)
                    return findings[index]
        raise NotFoundError(f"Finding {finding_id} does not exist.", code="finding_not_found")

    def delete_finding(self, finding_id: str) -> None:
        with self._lock:
            findings = self.findings()
            remaining = [f for f in findings if f.id != finding_id]
            if len(remaining) == len(findings):
                raise NotFoundError(f"Finding {finding_id} does not exist.", code="finding_not_found")
            self._save_findings(remaining)
            deck = self.pitch()
            for slide in deck.slides:
                slide.finding_ids = [i for i in slide.finding_ids if i != finding_id]
            self.save_pitch(deck)

    def reorder(self, ids: list[str]) -> list[Finding]:
        with self._lock:
            findings = {f.id: f for f in self.findings()}
            if set(ids) != set(findings) or len(ids) != len(findings):
                raise ValidationFailed("Reorder must list every finding exactly once.", code="invalid_order")
            ordered = [findings[i] for i in ids]
            self._save_findings(ordered)
            return ordered

    # ---- pitch -------------------------------------------------------------------
    def pitch(self) -> PitchDeck:
        stored = self.ws.read_doc("pitch", None)
        if stored:
            return PitchDeck.model_validate(stored)
        return PitchDeck(title="Untitled solution", subtitle="Data Challenge: Doomsday", team="",
                         slides=[PitchSlide(id=f"s{i}", section=section, title=title, body=body)
                                 for i, (section, title, body) in enumerate(DEFAULT_SLIDES, start=1)])

    def save_pitch(self, deck: PitchDeck) -> PitchDeck:
        known = {f.id for f in self.findings()}
        for slide in deck.slides:
            slide.finding_ids = [i for i in slide.finding_ids if i in known]
        if len({s.id for s in deck.slides}) != len(deck.slides):
            raise ValidationFailed("Slide ids must be unique.", code="invalid_pitch")
        deck = deck.model_copy(update={"updated_at": now_iso()})
        self.ws.write_doc("pitch", deck.model_dump(mode="json"))
        return deck

    # ---- saved views --------------------------------------------------------------
    def views(self, dataset_id: str | None = None) -> list[SavedView]:
        views = [SavedView.model_validate(v) for v in self.ws.read_doc("views", [])]
        return [v for v in views if dataset_id is None or v.dataset_id == dataset_id]

    def create_view(self, payload: SavedViewIn) -> SavedView:
        with self._lock:
            views = self.views()
            view = SavedView(id=new_id(), created_at=now_iso(), **payload.model_dump())
            views.insert(0, view)
            self.ws.write_doc("views", [v.model_dump(mode="json") for v in views])
            return view

    def delete_view(self, view_id: str) -> None:
        with self._lock:
            views = self.views()
            remaining = [v for v in views if v.id != view_id]
            if len(remaining) == len(views):
                raise NotFoundError(f"View {view_id} does not exist.", code="view_not_found")
            self.ws.write_doc("views", [v.model_dump(mode="json") for v in remaining])


def findings_markdown(findings: list[Finding], deck: PitchDeck) -> str:
    """A plain-text report: every finding with its evidence, method, and limitations."""
    lines = [f"# {deck.title or 'Findings report'}", ""]
    if deck.subtitle:
        lines += [deck.subtitle, ""]
    if deck.team:
        lines += [f"Team: {deck.team}", ""]
    lines += ["Generated by ATLAS. Charts are summarized by their source line; open the app for visuals.", ""]
    for index, finding in enumerate(findings, start=1):
        lines += [f"## {index}. {finding.title}", ""]
        if finding.description:
            lines += [finding.description, ""]
        if finding.evidence:
            lines += ["**Evidence**", ""] + [f"- {e.label}: {e.value}" for e in finding.evidence] + [""]
        if finding.chart:
            meta = finding.chart.meta
            source = (f"Source: {meta.dataset_name} · n = {meta.n_rows_used:,} of {meta.n_rows_total:,} rows"
                      f"{' · ' + meta.aggregation if meta.aggregation else ''}"
                      f"{' · sampled ' + format(meta.sample_size, ',') if meta.sampled and meta.sample_size else ''}")
            lines += [f"*Chart: {finding.chart.spec.type}. {source}*", ""]
        for heading, body in (("Methodology", finding.methodology), ("Interpretation", finding.interpretation),
                              ("Business implication", finding.implication),
                              ("Assumptions and limitations", finding.limitations)):
            if body:
                lines += [f"**{heading}**", "", body, ""]
    return "\n".join(lines)
