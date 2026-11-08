"""Deterministic scoring engine. The only place a CQA score is computed.

The evaluator (AI model or mock) supplies *answers* (yes/no, a scale point, an option); this module turns them
into points. A score the evaluator claims (``model_raw_score``) is recorded but never used here.

Rules (all configurable per checklist version, see ``ScoringRules``):

* **Only enabled criteria count.** Disabled criteria are skipped as if absent; a result for one is ignored.
* **Normalize.** binary: yes = 1, no = 0. numeric: value / highest allowed score; the value must be one of the
  allowed scores (dialogue = 7 of 0, 4, 7, 10 earns 0.7 of its weight). scale: (value − min) / (max − min);
  the value must be on the step grid. options: option points / best option points.
* **Weight and N/A.** Criteria answered N/A (and allowed to be N/A) drop out; their weight is redistributed
  proportionally over the applicable criteria: effective weight = weight / Σ applicable weights.
  Criterion points = normalized × effective weight × max_score; the total is their sum.
* **Sections.** A section subtotal is Σ(normalized × weight) / Σ weight over its applicable criteria, on the
  same 0–max_score scale. A section's contribution to the total is the sum of its criterion points.
* **Severe errors** are listed separately. With policy ``zero_total`` any severe error sets the total to 0;
  with ``flag_only`` the total is unchanged and the flag is reported next to it. An unweighted critical-error
  indicator (weight 0) must still be answered; it adds no points, and the answer ``true`` is its severe error.
* **Rounding** applies to the total and section values, at the configured digits and mode, on exact rational
  arithmetic, so 84.45 rounds half-up to 84.5 rather than to float noise.
* **Incomplete input** (a criterion without a result, an invalid answer, N/A where N/A is not allowed) gives
  status ``incomplete`` and no total. All criteria N/A gives ``not_applicable`` and no total.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal, localcontext
from fractions import Fraction

from app.cqa.schemas import (
    ChecklistConfig,
    Criterion,
    CriterionResult,
    CriterionScore,
    CriterionStatus,
    Override,
    RoundingRule,
    ScoreBreakdown,
    SectionScore,
)

_DECIMAL_MODES = {"half_up": ROUND_HALF_UP, "half_even": ROUND_HALF_EVEN, "floor": ROUND_FLOOR,
                  "ceil": ROUND_CEILING}
PERCENT_DIGITS = 2  # the percentage every evaluation reports (0–100), whatever the checklist's own max_score


class AnswerError(ValueError):
    """The answer does not fit the criterion's answer type or scale."""


def exact(value: float | int) -> Fraction:
    """The decimal a person typed (0.1 → 1/10), not the binary float approximation."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AnswerError(f"{value!r} is not a finite number.")
    return Fraction(str(value))


def round_value(value: Fraction, rule: RoundingRule) -> float:
    if rule.mode == "none":
        return float(value)
    with localcontext() as ctx:
        ctx.prec = 80
        decimal = Decimal(value.numerator) / Decimal(value.denominator)
        quantum = Decimal(1).scaleb(-rule.digits)
        return float(decimal.quantize(quantum, rounding=_DECIMAL_MODES[rule.mode]))


def answer_score(criterion: Criterion, value: object) -> tuple[Fraction, Fraction, Fraction]:
    """(raw score, raw max, normalized 0–1) for a non-N/A answer. Raises AnswerError if it does not fit."""
    if criterion.answer_type == "binary":
        if not isinstance(value, bool):
            raise AnswerError("A yes/no criterion needs true or false.")
        raw = Fraction(1 if value else 0)
        return raw, Fraction(1), raw
    if criterion.answer_type == "numeric":
        allowed = [exact(s) for s in criterion.allowed_scores or []]
        listed = ", ".join(f"{s:g}" for s in criterion.allowed_scores or [])
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise AnswerError(f"A numeric criterion needs one of its allowed scores ({listed}).")
        v = exact(value)
        if v not in allowed:
            raise AnswerError(f"{value:g} is not an allowed score ({listed}).")
        best = max(allowed)
        return v, best, v / best
    if criterion.answer_type == "scale":
        scale = criterion.scale
        assert scale is not None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise AnswerError(f"A scale criterion needs a number from {scale.min:g} to {scale.max:g}.")
        v, low, high, step = exact(value), exact(scale.min), exact(scale.max), exact(scale.step)
        if v < low or v > high:
            raise AnswerError(f"{value:g} is outside the scale {scale.min:g}–{scale.max:g}.")
        if ((v - low) / step).denominator != 1:
            raise AnswerError(f"{value:g} is not a point on the scale (step {scale.step:g}).")
        return v, high, (v - low) / (high - low)
    options = criterion.options or []
    if not isinstance(value, str):
        raise AnswerError("An options criterion needs an option id.")
    option = next((o for o in options if o.id == value), None)
    if option is None:
        raise AnswerError(f"'{value}' is not one of the options ({', '.join(o.id for o in options)}).")
    best = max(exact(o.points) for o in options)
    points = exact(option.points)
    return points, best, points / best


def apply_overrides(original: Iterable[CriterionResult], overrides: Iterable[Override]) -> list[CriterionResult]:
    """Final answers: the latest reviewer override per criterion replaces the evaluator's answer."""
    latest = {}
    for override in overrides:
        latest[override.criterion_id] = override.result
    return [latest.get(result.criterion_id, result) for result in original]


def compute_score(config: ChecklistConfig, results: Iterable[CriterionResult]) -> ScoreBreakdown:
    issues: list[str] = []
    by_id: dict[str, CriterionResult] = {}
    active = config.active_criteria
    active_ids = {c.id for c in active}
    for result in results:
        if config.criterion(result.criterion_id) is None:
            issues.append(f"Result for unknown criterion '{result.criterion_id}' ignored.")
        elif result.criterion_id not in active_ids:
            issues.append(f"Result for disabled criterion '{result.criterion_id}' ignored.")
        elif result.criterion_id in by_id:
            issues.append(f"Duplicate result for '{result.criterion_id}'; the first one is used.")
        else:
            by_id[result.criterion_id] = result

    rows: list[dict] = []
    for criterion in active:
        result = by_id.get(criterion.id)
        status: CriterionStatus
        raw = raw_max = normalized = None
        issue = None
        if result is None:
            status, issue = "missing", "No result for this criterion."
        elif result.is_na:
            if criterion.na_allowed:
                status = "na"
            else:
                status, issue = "invalid", "N/A is not allowed for this criterion."
        else:
            try:
                raw, raw_max, normalized = answer_score(criterion, result.value)
                status = "scored"
            except AnswerError as error:
                status, issue = "invalid", str(error)
        severe = False
        if criterion.is_indicator:
            severe = status == "scored" and result is not None and result.value is True
            if result is not None and result.severe_error and not severe:
                issues.append(f"Severe-error flag on '{criterion.id}' ignored: for an unweighted critical-error "
                              "indicator the answer is the flag (true = critical error).")
        elif result is not None and result.severe_error:
            if not criterion.severe_error_enabled:
                issues.append(f"Severe-error flag on '{criterion.id}' ignored: not enabled for this criterion.")
            elif status == "scored":
                severe = True
            else:
                issues.append(f"Severe-error flag on '{criterion.id}' ignored: the criterion is not scored.")
        if issue:
            issues.append(f"{criterion.name}: {issue}")
        rows.append({"criterion": criterion, "status": status, "raw": raw, "raw_max": raw_max,
                     "normalized": normalized, "severe": severe, "issue": issue, "weight": exact(criterion.weight)})

    rules = config.scoring
    max_score = exact(rules.max_score)
    total_weight = sum((row["weight"] for row in rows), Fraction(0))
    applicable_weight = sum((row["weight"] for row in rows if row["status"] == "scored"), Fraction(0))
    for row in rows:
        if row["status"] == "scored" and applicable_weight > 0:
            row["effective"] = row["weight"] / applicable_weight
            row["points"] = row["normalized"] * row["effective"] * max_score
        else:
            row["effective"] = Fraction(0)
            row["points"] = None

    incomplete = any(row["status"] in ("missing", "invalid") for row in rows)
    severe_errors = [row["criterion"].id for row in rows if row["severe"]]
    total = total_unrounded = total_before = percent = None
    applied = False
    if incomplete:
        status = "incomplete"
    elif applicable_weight == 0:
        status = "not_applicable"
    else:
        status = "scored"
        exact_total = sum((row["points"] for row in rows if row["points"] is not None), Fraction(0))
        total_unrounded = float(exact_total)
        total_before = round_value(exact_total, rules.rounding)
        total = total_before
        if severe_errors and rules.severe_error_policy == "zero_total":
            total, applied = 0.0, True
            exact_total = Fraction(0)
        # The same total on a 0–100 scale, from the exact value (rounded once, never re-scaled from a rounded total).
        percent = round_value(exact_total / max_score * 100, RoundingRule(
            mode="half_up" if rules.rounding.mode == "none" else rules.rounding.mode, digits=PERCENT_DIGITS))

    sections: list[SectionScore] = []
    for section in config.sections:
        members = [row for row in rows if row["criterion"].section_id == section.id]
        scored = [row for row in members if row["status"] == "scored"]
        weight = sum((row["weight"] for row in members), Fraction(0))
        if any(row["status"] in ("missing", "invalid") for row in members):
            section_status, score, score_raw, points = "incomplete", None, None, None
        else:
            scored_weight = sum((row["weight"] for row in scored), Fraction(0))
            # The unweighted critical-error indicator is "scored" but adds no points. A section that contains
            # only that indicator (its weighted criteria are N/A) has no subtotal.
            if scored_weight == 0:
                section_status, score, score_raw, points = "na", None, None, None
            else:
                section_status = "scored"
                value = sum((row["normalized"] * row["weight"] for row in scored), Fraction(0)) / scored_weight * max_score
                score_raw, score = float(value), round_value(value, rules.rounding)
                points = round_value(sum((row["points"] for row in scored), Fraction(0)), rules.rounding)
        effective = sum((row["effective"] for row in members), Fraction(0))
        sections.append(SectionScore(
            section_id=section.id, name=section.name, status=section_status, score=score, score_unrounded=score_raw,
            points=points, max_points=float(effective * max_score), weight=float(weight),
            effective_weight=float(effective), criteria_ids=[row["criterion"].id for row in members],
            severe_errors=[row["criterion"].id for row in members if row["severe"]]))

    criteria = [
        CriterionScore(
            criterion_id=row["criterion"].id, name=row["criterion"].name, section_id=row["criterion"].section_id,
            answer_type=row["criterion"].answer_type, status=row["status"],
            raw_score=None if row["raw"] is None else float(row["raw"]),
            raw_max=None if row["raw_max"] is None else float(row["raw_max"]),
            normalized=None if row["normalized"] is None else float(row["normalized"]),
            weight=float(row["weight"]), effective_weight=float(row["effective"]),
            points=None if row["points"] is None else float(row["points"]),
            max_points=float(row["effective"] * max_score), severe_error=row["severe"], issue=row["issue"])
        for row in rows
    ]
    return ScoreBreakdown(
        status=status, total=total, percent=percent, total_unrounded=total_unrounded,
        total_before_severe_policy=total_before,
        max_score=float(max_score), rounding=rules.rounding, severe_error_policy=rules.severe_error_policy,
        severe_errors=severe_errors, severe_error_applied=applied, applicable_weight=float(applicable_weight),
        total_weight=float(total_weight), criteria=criteria, sections=sections, issues=issues)
