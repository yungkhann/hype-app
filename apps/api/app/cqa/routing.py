"""Evaluation modes: the one place that decides which model answers which criterion.

``mode_type`` 1, hybrid: an official criterion whose definition still matches the official baseline is answered
by the local model (ATLAS_CQA_LOCAL_EVALUATOR: "qwen", the team's checklist evaluator, or "gemma"); every other
criterion (a manager-created one, or an official one whose wording, title,
answer type, scale, N/A rule or critical-error rule was changed) is answered by GPT.
``mode_type`` 2, GPT only: GPT answers every criterion; Gemma is never called.
Appeals are reassessed by GPT in both modes (appeals.py, ``ATLAS_CQA_REASSESSOR``; Gemma cannot reassess).

The baseline is the official template (``templates/freedom_broker_official.json``), compared on the definition
each model is actually given (``criterion_payload``, the prompt's view of a criterion) with whitespace normalized.
Weight and section are left out: they change how the score is weighted, not what the model judges, and the scoring
engine applies them. When the official wording PDF arrives, put it in the template so the baseline carries it.

Each provider receives only its own criteria; evaluations.py validates each answer, merges the results in the
checklist's order and scores them once with the scoring engine.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from app.cqa.adapters.openai_gpt import criterion_payload
from app.cqa.checklists import OFFICIAL_TEMPLATE_ID
from app.cqa.checklists import _templates as checklist_templates
from app.cqa.schemas import ChecklistConfig, Criterion

MODE_HYBRID = 1
MODE_GPT_ONLY = 2
MODE_LABELS = {MODE_HYBRID: "Hybrid (local model + GPT)", MODE_GPT_ONLY: "GPT only"}
GEMMA = "gemma"
GPT = "openai"
_NOT_DEFINITION = ("weight", "section")


def _normalized(value: Any) -> Any:
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, list):
        return [_normalized(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalized(v) for k, v in value.items()}
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def definition(criterion: Criterion) -> dict[str, Any]:
    """What a model is told about the criterion, minus how it is weighted."""
    payload = criterion_payload(criterion, {})
    return _normalized({k: v for k, v in payload.items() if k not in _NOT_DEFINITION})


@lru_cache(maxsize=1)
def _baseline() -> dict[str, dict[str, Any]]:
    return {c.id: definition(c) for c in checklist_templates()[OFFICIAL_TEMPLATE_ID].config.criteria}


def matches_official(criterion: Criterion) -> bool:
    """An official criterion (by id) whose definition is unchanged from the official baseline."""
    expected = _baseline().get(criterion.id)
    return expected is not None and definition(criterion) == expected


def plan(config: ChecklistConfig, mode_type: int, local: str = GEMMA) -> list[tuple[str, list[str], bool]]:
    """[(provider, criterion ids, official baseline)] covering every enabled criterion exactly once, in order.
    ``local`` is the adapter for the unchanged official criteria in hybrid mode (ATLAS_CQA_LOCAL_EVALUATOR)."""
    ids = [c.id for c in config.active_criteria]
    if mode_type == MODE_GPT_ONLY:
        return [(GPT, ids, False)]
    if mode_type != MODE_HYBRID:
        raise ValueError(f"Unknown mode_type {mode_type}.")
    official = [c.id for c in config.active_criteria if matches_official(c)]
    other = [cid for cid in ids if cid not in official]
    return [(provider, group, baseline) for provider, group, baseline in
            ((local, official, True), (GPT, other, False)) if group]


def subset(config: ChecklistConfig, criterion_ids: list[str]) -> ChecklistConfig:
    """The checklist version restricted to one provider's criteria (sections and scoring rules kept)."""
    keep = set(criterion_ids)
    return config.model_copy(update={"criteria": [c for c in config.criteria if c.id in keep]})
