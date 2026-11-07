"""Deterministic scoring engine: weights, normalization, N/A redistribution, sections, severe errors, rounding,
overrides and unsafe input. These numbers are the product's core claim, so each rule has a hand-checked case."""

from __future__ import annotations

import pytest

from app.cqa.schemas import AnswerOption, Override, ScaleConfig, Section
from app.cqa.scoring import apply_overrides, compute_score
from tests.cqa_helpers import answer, config, criterion, na


def binary3(**scoring):
    return config(criterion("a", 10, na_allowed=True), criterion("b", 30, na_allowed=True), criterion("c", 60),
                  **scoring)


def test_all_criteria_met_scores_max():
    score = compute_score(binary3(), [answer("a"), answer("b"), answer("c")])
    assert score.status == "scored"
    assert score.total == 100.0
    assert [c.points for c in score.criteria] == [10.0, 30.0, 60.0]


def test_weighted_total_uses_configured_weights():
    score = compute_score(binary3(), [answer("a"), answer("b", False), answer("c")])
    assert score.total == 70.0
    assert score.criteria[1].points == 0.0 and score.criteria[1].max_points == 30.0


def test_weights_are_relative_not_percentages():
    one = compute_score(config(criterion("a", 1), criterion("b", 3)), [answer("a"), answer("b", False)])
    many = compute_score(config(criterion("a", 25), criterion("b", 75)), [answer("a"), answer("b", False)])
    assert one.total == many.total == 25.0


def test_na_weight_is_redistributed_proportionally():
    score = compute_score(binary3(), [na("a"), answer("b", False), answer("c")])
    assert score.status == "scored"
    a, b, c = score.criteria
    assert a.status == "na" and a.effective_weight == 0 and a.points is None and a.max_points == 0
    assert b.effective_weight == pytest.approx(30 / 90)
    assert c.effective_weight == pytest.approx(60 / 90)
    assert score.total_unrounded == pytest.approx(66.6666666667)
    assert score.total == 66.7  # half-up, 1 digit (default rule)
    assert score.applicable_weight == 90 and score.total_weight == 100


def test_two_na_criteria_leave_the_remaining_one_at_full_weight():
    score = compute_score(binary3(), [na("a"), na("b"), answer("c")])
    assert score.criteria[2].effective_weight == 1
    assert score.total == 100.0


def test_effective_weights_sum_to_one_over_scored_criteria():
    score = compute_score(binary3(), [na("a"), answer("b"), answer("c", False)])
    assert sum(c.effective_weight for c in score.criteria) == pytest.approx(1)
    assert sum(c.max_points for c in score.criteria) == pytest.approx(100)


def test_na_where_not_allowed_makes_the_evaluation_incomplete():
    score = compute_score(binary3(), [answer("a"), answer("b"), na("c")])
    assert score.status == "incomplete"
    assert score.total is None
    assert score.criteria[2].status == "invalid"
    assert any("N/A is not allowed" in issue for issue in score.issues)


def test_all_na_gives_not_applicable_without_a_total():
    cfg = config(criterion("a", 10, na_allowed=True), criterion("b", 20, na_allowed=True))
    score = compute_score(cfg, [na("a"), na("b")])
    assert score.status == "not_applicable"
    assert score.total is None


def test_missing_result_is_incomplete_not_zero():
    score = compute_score(binary3(), [answer("a"), answer("b")])
    assert score.status == "incomplete"
    assert score.total is None
    assert score.criteria[2].status == "missing"


def test_unknown_and_duplicate_results_are_ignored_with_issues():
    score = compute_score(binary3(), [answer("a"), answer("a", False), answer("b"), answer("c"), answer("zzz")])
    assert score.total == 100.0
    assert any("Duplicate" in issue for issue in score.issues)
    assert any("unknown criterion" in issue for issue in score.issues)


def test_scale_is_normalized_between_min_and_max():
    cfg = config(criterion("s", 10, answer_type="scale", scale=ScaleConfig(min=1, max=5, step=1)))
    assert compute_score(cfg, [answer("s", 1)]).total == 0.0
    assert compute_score(cfg, [answer("s", 3)]).total == 50.0
    assert compute_score(cfg, [answer("s", 5)]).total == 100.0
    assert compute_score(cfg, [answer("s", 4.0)]).criteria[0].raw_score == 4.0


@pytest.mark.parametrize("value", [0, 6, 2.5, True, "4", None])
def test_scale_rejects_values_off_the_scale(value):
    cfg = config(criterion("s", 10, answer_type="scale", scale=ScaleConfig(min=1, max=5, step=1)))
    score = compute_score(cfg, [answer("s", value)])
    assert score.status == "incomplete" and score.criteria[0].status == "invalid"


def test_scale_with_half_steps_accepts_half_points():
    cfg = config(criterion("s", 10, answer_type="scale", scale=ScaleConfig(min=0, max=10, step=0.5)))
    assert compute_score(cfg, [answer("s", 7.5)]).total == 75.0


def test_options_score_by_points_relative_to_the_best_option():
    options = [AnswerOption(id="full", label="Full", points=2), AnswerOption(id="partial", label="Partial", points=1),
               AnswerOption(id="none", label="None", points=0)]
    cfg = config(criterion("o", 10, answer_type="options", options=options))
    assert compute_score(cfg, [answer("o", "partial")]).total == 50.0
    assert compute_score(cfg, [answer("o", "full")]).criteria[0].raw_score == 2
    assert compute_score(cfg, [answer("o", "other")]).status == "incomplete"


@pytest.mark.parametrize("value", [1, 0, "yes", None])
def test_binary_accepts_only_booleans(value):
    score = compute_score(config(criterion("b", 10)), [answer("b", value)])
    assert score.status == "incomplete"


def test_sections_get_subtotals_and_their_points_add_up_to_the_total():
    cfg = config(criterion("a", 10, section_id="open", na_allowed=True), criterion("b", 30, section_id="open"),
                 criterion("c", 60, section_id="solve"),
                 sections=[Section(id="open", name="Opening"), Section(id="solve", name="Solving"),
                           Section(id="empty", name="Unused")])
    score = compute_score(cfg, [answer("a"), answer("b", False), answer("c")])
    opening, solving, empty = score.sections
    assert opening.score == 25.0 and opening.points == 10.0 and opening.max_points == 40.0
    assert solving.score == 100.0 and solving.points == 60.0
    assert empty.status == "na" and empty.score is None
    assert opening.points + solving.points == score.total == 70.0


def test_section_with_only_na_criteria_is_na_and_others_absorb_its_weight():
    cfg = config(criterion("a", 50, section_id="x", na_allowed=True), criterion("b", 50, section_id="y"),
                 sections=[Section(id="x", name="X"), Section(id="y", name="Y")])
    score = compute_score(cfg, [na("a"), answer("b")])
    assert score.sections[0].status == "na"
    assert score.sections[1].effective_weight == 1
    assert score.total == 100.0


def severe_config(policy="flag_only"):
    return config(criterion("a", 50), criterion("b", 50, severe_error_enabled=True), severe_error_policy=policy)


def test_severe_error_flag_only_keeps_the_total_and_reports_the_error():
    score = compute_score(severe_config(), [answer("a"), answer("b", False, severe_error=True)])
    assert score.total == 50.0
    assert score.severe_errors == ["b"] and not score.severe_error_applied


def test_severe_error_zero_total_policy_zeroes_the_total_but_keeps_the_original():
    score = compute_score(severe_config("zero_total"), [answer("a"), answer("b", False, severe_error=True)])
    assert score.total == 0.0 and score.total_before_severe_policy == 50.0
    assert score.severe_error_applied


def test_severe_flag_on_a_criterion_without_severe_errors_is_ignored():
    score = compute_score(severe_config("zero_total"), [answer("a", severe_error=True), answer("b")])
    assert score.severe_errors == [] and score.total == 100.0
    assert any("not enabled" in issue for issue in score.issues)


def ratio_config(points: float, best: float, **scoring):
    """One options criterion whose normalized score is exactly points / best."""
    options = [AnswerOption(id="x", label="X", points=points), AnswerOption(id="best", label="Best", points=best)]
    return config(criterion("o", 1, answer_type="options", options=options), **scoring)


@pytest.mark.parametrize(("mode", "expected"), [("half_up", 2.68), ("half_even", 2.68), ("floor", 2.67),
                                                ("ceil", 2.68), ("none", 2.675)])
def test_rounding_is_exact_decimal_not_float(mode, expected):
    # 107/400 × 10 = 2.675 exactly. As a float 2.675 is 2.67499999…, so naive round(2.675, 2) gives 2.67.
    cfg = ratio_config(107, 400, max_score=10, rounding={"mode": mode, "digits": 2})
    assert compute_score(cfg, [answer("o", "x")]).total == expected


def test_half_even_and_half_up_differ_on_a_tie():
    # 169/200 × 100 = 84.5 exactly.
    assert compute_score(ratio_config(169, 200, rounding={"mode": "half_up", "digits": 0}),
                         [answer("o", "x")]).total == 85.0
    assert compute_score(ratio_config(169, 200, rounding={"mode": "half_even", "digits": 0}),
                         [answer("o", "x")]).total == 84.0


def test_scale_with_more_than_101_points_is_rejected():
    with pytest.raises(ValueError, match="at most 101 points"):
        ScaleConfig(min=0, max=10, step=0.005)


def test_max_score_scales_points():
    score = compute_score(binary3(max_score=5), [answer("a"), answer("b", False), answer("c")])
    assert score.total == 3.5 and score.max_score == 5


def test_reviewer_override_replaces_only_that_criterion_and_the_latest_wins():
    cfg = binary3()
    original = [answer("a"), answer("b", False), answer("c")]
    first = Override(criterion_id="b", appeal_id="1" * 32, result=answer("b", True, source="reviewer"),
                     reviewer="R", explanation="ok", decided_at="t")
    second = Override(criterion_id="b", appeal_id="2" * 32, result=na("b"), reviewer="R", explanation="na",
                      decided_at="t")
    assert compute_score(cfg, original).total == 70.0
    assert compute_score(cfg, apply_overrides(original, [first])).total == 100.0
    final = apply_overrides(original, [first, second])
    assert final[1].is_na and compute_score(cfg, final).total == 100.0  # b N/A: a + c carry everything
    assert original[1].value is False  # the original answers are never mutated


def test_same_input_gives_identical_output():
    cfg = binary3()
    results = [na("a"), answer("b", False), answer("c")]
    assert compute_score(cfg, results).model_dump() == compute_score(cfg, results).model_dump()
