"""The organizers' results file (Freedom Broker CQA results appendix, "Формат JSON 1.0") from stored evaluations.

One record per conversation of a dataset (an imported ``group_id``), made from the evaluation that the stored data
already holds: GPT's values, rationales and evidence, every accepted appeal decision (the final answer, never the
original one), and the final score the scoring engine computed. Nothing is evaluated, guessed or filled in here:

* ``status: "ok"``: the newest completed, non-mock evaluation with the chosen checklist (and version) whose
  transcript is unchanged. Its checklist snapshot must be compatible with the official eight criteria
  (``official_format_issues``); an incompatible one is reported, never mapped onto the official ids.
* ``status: "error"``: the conversation's newest evaluation failed and none completed. ``error`` is the stored reason.
* not exported (reported as missing): never evaluated, only development-mock results, only results for an older
  transcript, or still running. The file is ready only when no conversation is in these states.

``evidence_turns`` are 1-based positions in the original transcript (client, operator, bot and system lines alike):
message ``m{n}`` is the n-th line as received, so the turn is ``message_index + 1``.

The same module is a command line tool that reads the data directory directly (no API, no evaluation queue, no
network), so writing ``results/<set>/results.json`` can never start a paid model call::

    python -m app.cqa.results_export --set dev --group <group_id>         # write results/dev/results.json
    python -m app.cqa.results_export --set prod --group <group_id> --dry-run
    python -m app.cqa.results_export --set prod --check ../../results/prod/results.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from app.core.config import REPO_ROOT, Settings
from app.core.errors import NotFoundError, ValidationFailed
from app.cqa.checklists import OFFICIAL_CHECKLIST_ID, OFFICIAL_TEMPLATE_ID, ChecklistService, official_format_issues
from app.cqa.checklists import _templates as checklist_templates
from app.cqa.schemas import ConversationRecord, CriterionResult, EvaluationRecord
from app.cqa.scoring import apply_overrides, compute_score
from app.cqa.store import CqaStore
from app.storage.workspace import atomic_write_text

SCHEMA_VERSION = "1.0"
MODEL_MODES = ("local", "external_api", "hybrid")
# What kind of model each evaluator adapter runs. An adapter missing here (a teammate's "http" model) needs
# ATLAS_CQA_MODEL_MODE. Development mocks never reach the file.
ADAPTER_MODES = {"openai": "external_api", "gemma": "local"}
Target = Literal["dev", "prod"]
# The appendix: DEV is 60 chats and 5 calls; PROD is exactly 10 records (control chats), errors included.
TARGETS: dict[str, dict[str, Any]] = {"dev": {"total": 65, "channels": {"chat": 60, "voice": 5}},
                                      "prod": {"total": 10, "channels": None}}
RowState = Literal["ok", "error", "missing", "mock_only", "stale", "in_progress", "incompatible"]
NOT_EXPORTED = ("missing", "mock_only", "stale", "in_progress", "incompatible")


class ExportIssue(BaseModel):
    severity: Literal["error", "warning"]
    code: str
    message: str
    conversation_id: str | None = None


class ExportRow(BaseModel):
    conversation_id: str
    channel: str
    state: RowState
    evaluation_id: str | None = None
    checklist_version: int | None = None
    final_score: float | None = None
    critical_flag: bool | None = None
    accepted_appeals: int = 0
    detail: str | None = None


class ExportSummary(BaseModel):
    conversations: int
    chats: int
    calls: int
    exported: int
    ok: int
    error: int
    missing: int
    mock_only: int
    stale: int
    in_progress: int
    incompatible: int
    with_accepted_appeals: int


class ResultsExport(BaseModel):
    ready: bool
    target: Target | None
    group_id: str
    checklist_id: str
    checklist_name: str
    checklist_version: int | None
    checklist_compatible: bool
    versions_used: list[int]
    team_name: str
    summary: ExportSummary
    rows: list[ExportRow]
    issues: list[ExportIssue]
    document: dict


def _official():
    return checklist_templates()[OFFICIAL_TEMPLATE_ID].config


def official_ids() -> list[str]:
    return [c.id for c in _official().criteria]


def _plain(value: Any) -> Any:
    """The answer with its JSON type: true/false stay booleans, a whole-number score is an integer (15, not 15.0)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _turns(result: CriterionResult) -> list[int]:
    return sorted({ref.message_index + 1 for ref in result.evidence})


def _newest_first(records: list[EvaluationRecord]) -> list[EvaluationRecord]:
    return sorted(records, key=lambda e: e.created_at + e.id, reverse=True)


def _error_text(record: EvaluationRecord) -> str:
    if record.error is None:
        return "The evaluation failed without a recorded reason."
    return record.error.message.strip() or record.error.code


def _ok_record(record: EvaluationRecord) -> tuple[dict | None, str | None]:
    """The JSON 1.0 record of a completed evaluation, or (None, reason) when its stored data cannot make one."""
    score = record.final_score
    if score is None or score.status != "scored" or score.percent is None:
        status = score.status if score else "missing"
        return None, f"The evaluation has no final score (score status: {status})."
    final = {r.criterion_id: r for r in apply_overrides(record.original_results, record.overrides)}
    criteria = []
    for criterion_id in official_ids():
        result = final.get(criterion_id)
        if result is None:
            return None, f"The evaluation has no result for criterion '{criterion_id}'."
        criteria.append({
            "criterion_id": criterion_id,
            "value": None if result.is_na else _plain(result.value),
            "rationale": (result.explanation or result.na_reason or "").strip(),
            "evidence_turns": _turns(result),
        })
    critical = final["critical"]
    return {"conversation_id": record.conversation_id, "status": "ok", "criteria": criteria,
            "score": {"final_score": score.percent, "critical_flag": critical.value is True}}, None


def _error_record(conversation_id: str, message: str) -> dict:
    return {"conversation_id": conversation_id, "status": "error", "criteria": [], "score": None, "error": message}


def _pick(records: list[EvaluationRecord],
          conversation: ConversationRecord) -> tuple[RowState, EvaluationRecord | None]:
    if not records:
        return "missing", None
    real = [e for e in records if not e.evaluator.is_mock]
    if not real:
        return "mock_only", records[0]
    fresh = [e for e in real if e.transcript_hash == conversation.transcript_hash]
    if not fresh:
        return "stale", real[0]
    if fresh[0].status in ("pending", "running"):
        return "in_progress", fresh[0]
    completed = next((e for e in fresh if e.status == "completed"), None)
    if completed is not None:
        return "ok", completed
    return "error", fresh[0]


def _model(scored: list[EvaluationRecord], failed: list[EvaluationRecord], store: CqaStore, settings: Settings,
           issues: list[ExportIssue]) -> dict[str, str]:
    """``model``: the models that produced the exported values (the provider-reported names) and their mode.
    Failed evaluations count only when nothing succeeded."""
    names: Counter[str] = Counter()
    adapters: set[str] = set()
    used = scored or failed
    for record in used:
        if record.parts:  # an evaluation mode: each provider answered its own criteria (Gemma local, GPT external)
            for part in record.parts:
                names[part.model or part.requested_model or part.provider] += 1
                adapters.add(part.provider)
        else:
            names[record.model_info.get("name") or record.evaluator.version or record.evaluator.name] += 1
            adapters.add(record.evaluator.name)
        for override in record.overrides:  # an accepted GPT recommendation is GPT's value too
            appeal = store.appeals.get(override.appeal_id)
            decision = appeal.decision if appeal else None
            if appeal is None or decision is None or decision.decision != "accept":
                continue
            reviewed = next((r for r in appeal.reassessments if r.id == decision.reassessment_id), None)
            if reviewed is not None:
                names[reviewed.model or reviewed.requested_model or reviewed.reassessor] += 1
                adapters.add(reviewed.reassessor)
    if not used:  # nothing exported yet: describe the configured evaluator, so the preview is still well-formed
        adapters.add(settings.cqa_evaluator)
        names[settings.cqa_openai_model if settings.cqa_evaluator == "openai" else settings.cqa_evaluator] += 1

    configured = settings.cqa_model_mode.strip()
    if configured:
        if configured not in MODEL_MODES:
            issues.append(ExportIssue(severity="error", code="invalid_model_mode",
                                      message=f"ATLAS_CQA_MODEL_MODE is '{configured}'; use local, external_api or "
                                              "hybrid."))
        mode = configured
    else:
        modes = {ADAPTER_MODES.get(name) for name in adapters}
        unknown = sorted(name for name in adapters if name not in ADAPTER_MODES)
        if unknown:
            issues.append(ExportIssue(severity="error", code="unknown_model_mode",
                                      message=f"The model mode of evaluator(s) {', '.join(unknown)} is unknown. Set "
                                              "ATLAS_CQA_MODEL_MODE to local, external_api or hybrid."))
            mode = "hybrid" if len(modes - {None}) > 1 else next(iter(modes - {None}), "")
        else:
            mode = modes.pop() if len(modes) == 1 else "hybrid"
    return {"mode": mode, "name": ", ".join(names)}  # in order of first use


def build_results(store: CqaStore, settings: Settings, *, group_id: str,
                  checklist_id: str = OFFICIAL_CHECKLIST_ID, checklist_version: int | None = None,
                  target: Target | None = None, team_name: str | None = None) -> ResultsExport:
    """The results file for one dataset with one checklist (one version, or ``None`` for the newest evaluation of
    any version), plus every reason it is not ready yet. Reads stored data only."""
    with store.lock:
        conversations = sorted((r for r in store.conversations.values() if group_id in r.group_ids),
                               key=lambda r: r.id)
    if not conversations:
        raise NotFoundError(f"No conversations are imported for dataset '{group_id}'.", code="group_not_found")
    checklist, version = ChecklistService(store).version(checklist_id, checklist_version)
    with store.lock:
        evaluations = [e for e in store.evaluations.values() if e.checklist_id == checklist.id
                       and (checklist_version is None or e.checklist_version == checklist_version)]

    issues: list[ExportIssue] = []
    format_issues = official_format_issues(version.config)
    if format_issues:
        issues.append(ExportIssue(
            severity="error", code="checklist_incompatible",
            message=f"'{checklist.name}' v{version.version} cannot be exported as JSON 1.0: {' '.join(format_issues)}"))
    if any(r.source == "fixture" for r in conversations):
        issues.append(ExportIssue(severity="error", code="fixture_data",
                                  message="This dataset holds development fixtures, not the organizers' data."))

    by_conversation: dict[str, list[EvaluationRecord]] = {}
    for record in evaluations:
        by_conversation.setdefault(record.conversation_id, []).append(record)

    rows: list[ExportRow] = []
    results: list[dict] = []
    scored: list[EvaluationRecord] = []
    failed: list[EvaluationRecord] = []
    lengths: dict[str, int] = {}
    for conversation in conversations:
        lengths[conversation.id] = len(conversation.messages)
        state, record = _pick(_newest_first(by_conversation.get(conversation.id, [])), conversation)
        row = ExportRow(conversation_id=conversation.id, channel=conversation.channel, state=state,
                        evaluation_id=record.id if record else None,
                        checklist_version=record.checklist_version if record else None)
        if state == "ok":
            assert record is not None
            problems = official_format_issues(record.checklist)
            if problems:
                row.state, row.detail = "incompatible", " ".join(problems)
            else:
                document, reason = _ok_record(record)
                if document is None:  # a completed evaluation whose stored result is unusable: a genuine failure
                    row.state, row.detail = "error", reason
                    results.append(_error_record(conversation.id, reason or "The evaluation is incomplete."))
                    failed.append(record)
                else:
                    row.final_score = document["score"]["final_score"]
                    row.critical_flag = document["score"]["critical_flag"]
                    results.append(document)
                    scored.append(record)
                row.accepted_appeals = len({o.appeal_id for o in record.overrides})
        elif state == "error":
            assert record is not None
            row.detail = _error_text(record)
            results.append(_error_record(conversation.id, row.detail))
            failed.append(record)
        else:
            row.detail = {
                "missing": "Not evaluated with this checklist yet.",
                "mock_only": "Only development-mock results exist; they are never exported.",
                "stale": "The transcript changed after the evaluation; evaluate it again.",
                "in_progress": "The evaluation is still running.",
            }.get(state)
        rows.append(row)

    team = (team_name if team_name is not None else settings.cqa_team_name).strip()
    if not team:
        issues.append(ExportIssue(severity="error", code="team_name_missing",
                                  message="The team name is not set. Enter it, or set ATLAS_CQA_TEAM_NAME in .env."))
    document = {"schema_version": SCHEMA_VERSION, "team_name": team,
                "model": _model(scored, failed, store, settings, issues), "results": results}

    count = Counter(row.state for row in rows)
    waiting = sum(count[state] for state in NOT_EXPORTED)
    if waiting:
        parts = [f"{count[s]} {label}" for s, label in (
            ("missing", "not evaluated"), ("mock_only", "with mock results only"),
            ("stale", "with a changed transcript"), ("in_progress", "still running"),
            ("incompatible", "evaluated with an incompatible checklist")) if count[s]]
        issues.append(ExportIssue(severity="error", code="results_incomplete",
                                  message=f"{waiting} of {len(rows)} conversations have no exportable result: "
                                          f"{', '.join(parts)}."))
    if count["error"]:
        issues.append(ExportIssue(severity="warning", code="failed_evaluations",
                                  message=f"{count['error']} conversation(s) are exported with status \"error\". "
                                          "Evaluate them again if time allows."))
    channels = Counter(r.channel for r in conversations)
    if target:
        expected = TARGETS[target]
        if len(conversations) != expected["total"]:
            issues.append(ExportIssue(severity="error", code="unexpected_count",
                                      message=f"{target.upper()} must have {expected['total']} conversations; "
                                              f"dataset '{group_id}' has {len(conversations)}."))
        elif expected["channels"] and dict(channels) != expected["channels"]:
            issues.append(ExportIssue(severity="warning", code="unexpected_channels",
                                      message=f"{target.upper()} is expected to hold {expected['channels']['chat']} "
                                              f"chats and {expected['channels']['voice']} calls; this dataset has "
                                              f"{channels['chat']} and {channels['voice']}."))
    issues.extend(validate_document(document, transcript_lengths=lengths))

    summary = ExportSummary(conversations=len(rows), chats=channels["chat"], calls=channels["voice"],
                            exported=len(results), ok=count["ok"], error=count["error"], missing=count["missing"],
                            mock_only=count["mock_only"], stale=count["stale"], in_progress=count["in_progress"],
                            incompatible=count["incompatible"],
                            with_accepted_appeals=sum(1 for r in rows if r.state == "ok" and r.accepted_appeals))
    return ResultsExport(
        ready=not any(i.severity == "error" for i in issues), target=target, group_id=group_id,
        checklist_id=checklist.id, checklist_name=checklist.name, checklist_version=checklist_version,
        checklist_compatible=not format_issues,
        versions_used=sorted({r.checklist_version for r in rows if r.checklist_version is not None
                              and r.state in ("ok", "error")}),
        team_name=team, summary=summary, rows=rows, issues=issues, document=document)


# ---- validation -----------------------------------------------------------------------------------------------


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_value(criterion, value: Any) -> str | None:
    if value is None:
        return None if criterion.na_allowed else "must not be null (N/A is not allowed)"
    if criterion.answer_type == "binary":
        return None if isinstance(value, bool) else "must be true or false"
    allowed = [_plain(s) for s in criterion.allowed_scores or []]
    if not _is_int(value) or value not in allowed:
        listed = ", ".join(str(s) for s in allowed) + (" or null" if criterion.na_allowed else "")
        return f"must be one of {listed}"
    return None


def validate_document(document: Any, *, expected_ids: list[str] | None = None,
                      transcript_lengths: dict[str, int] | None = None,
                      target: Target | None = None) -> list[ExportIssue]:
    """Check a results document against the appendix: field names, criterion ids and value types, 1-based evidence
    turns, one record per conversation, and a final score that the official weights reproduce."""
    issues: list[ExportIssue] = []

    def bad(message: str, cid: str | None = None, code: str = "invalid_document") -> None:
        issues.append(ExportIssue(severity="error", code=code, message=message, conversation_id=cid))

    if not isinstance(document, dict):
        bad("The document must be one JSON object.")
        return issues
    if set(document) != {"schema_version", "team_name", "model", "results"}:
        bad(f"Top-level fields must be schema_version, team_name, model and results; found {sorted(document)}.")
    if document.get("schema_version") != SCHEMA_VERSION:
        bad('schema_version must be "1.0".')
    if not isinstance(document.get("team_name"), str) or not document.get("team_name", "").strip():
        bad("team_name must be a non-empty string.", code="team_name_missing")
    model = document.get("model")
    if not isinstance(model, dict) or set(model) != {"mode", "name"}:
        bad("model must be {\"mode\": …, \"name\": …}.")
    else:
        if model.get("mode") not in MODEL_MODES:
            bad("model.mode must be local, external_api or hybrid.")
        if not isinstance(model.get("name"), str) or not model["name"].strip():
            bad("model.name must name the model actually used.")
    results = document.get("results")
    if not isinstance(results, list):
        bad("results must be an array.")
        return issues

    official = _official()
    order = [c.id for c in official.criteria]
    seen: Counter[str] = Counter()
    for position, item in enumerate(results):
        where = f"results[{position}]"
        if not isinstance(item, dict):
            bad(f"{where} must be an object.")
            continue
        cid = item.get("conversation_id")
        if not isinstance(cid, str) or not cid:
            bad(f"{where}.conversation_id must be the conversation's original id.")
            continue
        seen[cid] += 1
        status = item.get("status")
        if status == "error":
            if set(item) != {"conversation_id", "status", "criteria", "score", "error"}:
                bad(f"{cid}: an error record has exactly conversation_id, status, criteria, score and error.", cid)
            if item.get("criteria") != [] or item.get("score") is not None:
                bad(f"{cid}: an error record has \"criteria\": [] and \"score\": null.", cid)
            if not isinstance(item.get("error"), str) or not item["error"].strip():
                bad(f"{cid}: an error record needs the failure reason in \"error\".", cid)
            continue
        if status != "ok":
            bad(f"{cid}: status must be \"ok\" or \"error\".", cid)
            continue
        if set(item) != {"conversation_id", "status", "criteria", "score"}:
            bad(f"{cid}: an ok record has exactly conversation_id, status, criteria and score.", cid)
        criteria = item.get("criteria")
        if not isinstance(criteria, list):
            bad(f"{cid}: criteria must be an array.", cid)
            continue
        ids = [c.get("criterion_id") if isinstance(c, dict) else None for c in criteria]
        if sorted(map(str, ids)) != sorted(order):
            bad(f"{cid}: criteria must hold each of {', '.join(order)} exactly once; found {ids}.", cid)
            continue
        values: dict[str, Any] = {}
        limit = (transcript_lengths or {}).get(cid)
        for entry in criteria:
            criterion = official.criterion(entry["criterion_id"])
            label = f"{cid}: criterion '{criterion.id}'"
            if set(entry) != {"criterion_id", "value", "rationale", "evidence_turns"}:
                bad(f"{label} has exactly criterion_id, value, rationale and evidence_turns.", cid)
            problem = _check_value(criterion, entry.get("value"))
            if problem:
                bad(f"{label}: value {problem}.", cid)
            values[criterion.id] = entry.get("value")
            if not isinstance(entry.get("rationale"), str) or not entry["rationale"].strip():
                bad(f"{label}: rationale must be a non-empty string.", cid)
            turns = entry.get("evidence_turns")
            if not isinstance(turns, list) or not all(_is_int(t) and t >= 1 for t in turns):
                bad(f"{label}: evidence_turns must be 1-based turn numbers.", cid)
            elif limit is not None and any(t > limit for t in turns):
                bad(f"{label}: evidence_turns {sorted(t for t in turns if t > limit)} are beyond the transcript "
                    f"({limit} turns).", cid, code="invalid_evidence")
            elif len(set(turns)) != len(turns):
                bad(f"{label}: evidence_turns repeat a turn.", cid)
        score = item.get("score")
        if not isinstance(score, dict) or set(score) != {"final_score", "critical_flag"}:
            bad(f"{cid}: score must be {{\"final_score\": …, \"critical_flag\": …}}.", cid)
            continue
        final = score.get("final_score")
        if (isinstance(final, bool) or not isinstance(final, (int, float)) or not math.isfinite(final)
                or not 0 <= final <= 100 or Decimal(str(final)).as_tuple().exponent < -2):
            bad(f"{cid}: final_score must be a number from 0 to 100 with at most two decimals.", cid)
        elif not any(i.conversation_id == cid for i in issues):
            # The official weights, through the same scoring engine, must reproduce the exported score.
            results_in = [CriterionResult(criterion_id=k, value=v, is_na=v is None) for k, v in values.items()]
            expected = compute_score(official, results_in).percent
            if expected is None or abs(expected - final) > 0.011:
                bad(f"{cid}: final_score {final} does not match the official weights ({expected}).", cid,
                    code="score_mismatch")
            elif expected != final:
                issues.append(ExportIssue(severity="warning", code="score_rounding", conversation_id=cid,
                                          message=f"{cid}: final_score {final} differs from the official half-up "
                                                  f"rounding ({expected}) by one cent."))
        if score.get("critical_flag") is not values.get("critical"):
            bad(f"{cid}: critical_flag must equal the value of criterion 'critical'.", cid)

    duplicates = sorted(cid for cid, n in seen.items() if n > 1)
    if duplicates:
        bad(f"Conversation ids repeat: {', '.join(duplicates[:10])}.", code="duplicate_ids")
    if expected_ids is not None:
        missing = sorted(set(expected_ids) - set(seen))
        extra = sorted(set(seen) - set(expected_ids))
        if missing:
            bad(f"{len(missing)} conversation(s) have no record: {', '.join(missing[:10])}.", code="missing_ids")
        if extra:
            bad(f"{len(extra)} record(s) are not in the dataset: {', '.join(extra[:10])}.", code="unknown_ids")
    if target and len(results) != TARGETS[target]["total"]:
        bad(f"{target.upper()} needs {TARGETS[target]['total']} records; the file has {len(results)}.",
            code="unexpected_count")
    return issues


def render(document: dict) -> str:
    """UTF-8 JSON as the appendix asks: no comments, no trailing commas, Cyrillic kept readable."""
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


# ---- command line ------------------------------------------------------------------------------------------------


def _print_report(report: ResultsExport) -> None:
    s = report.summary
    version = f"v{report.checklist_version}" if report.checklist_version else "any version"
    print(f"Dataset {report.group_id}: {s.conversations} conversations ({s.chats} chats, {s.calls} calls); "
          f"checklist '{report.checklist_name}' ({version}).")
    print(f"Exported {s.exported}: {s.ok} ok, {s.error} error. Not exportable: {s.missing} not evaluated, "
          f"{s.mock_only} mock only, {s.stale} stale, {s.in_progress} running, {s.incompatible} incompatible. "
          f"Accepted appeals in {s.with_accepted_appeals}.")
    print(f"Model: {report.document['model']}. Team: {report.team_name or '(not set)'}.")
    for issue in report.issues:
        print(f"  [{issue.severity}] {issue.message}")
    print("READY" if report.ready else "NOT READY")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cqa.results_export",
                                     description="Write or check the organizers' results.json (JSON 1.0).")
    parser.add_argument("--set", dest="target", choices=sorted(TARGETS), required=True,
                        help="dev or prod: the expected record count and the default output folder.")
    parser.add_argument("--group", help="The imported dataset (group_id) to export.")
    parser.add_argument("--checklist", default=OFFICIAL_CHECKLIST_ID,
                        help="Checklist id (default: the official Freedom Broker checklist).")
    parser.add_argument("--version", type=int, default=None,
                        help="Checklist version. Default: the newest evaluation of any version.")
    parser.add_argument("--team", default=None, help="Team name (default: ATLAS_CQA_TEAM_NAME).")
    parser.add_argument("--data-dir", type=Path, default=None, help="ATLAS data directory (default: ATLAS_DATA_DIR).")
    parser.add_argument("--out", type=Path, default=None, help="Output file (default: results/<set>/results.json).")
    parser.add_argument("--dry-run", action="store_true", help="Report only; write nothing.")
    parser.add_argument("--allow-incomplete", action="store_true",
                        help="Write the available records even when the file is not ready (not a submission).")
    parser.add_argument("--check", type=Path, default=None, help="Validate an existing results.json instead.")
    args = parser.parse_args(argv)

    if args.check:
        try:
            document = json.loads(args.check.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            print(f"Cannot read {args.check}: {error}")
            return 1
        issues = validate_document(document, target=args.target)
        for issue in issues:
            print(f"  [{issue.severity}] {issue.message}")
        valid = not any(i.severity == "error" for i in issues)
        print(f"{args.check}: {len(document.get('results', [])) if isinstance(document, dict) else 0} records, "
              f"{'VALID' if valid else 'INVALID'} JSON 1.0.")
        return 0 if valid else 1
    if not args.group:
        parser.error("--group is required unless --check is given.")

    settings = Settings(**({"data_dir": args.data_dir} if args.data_dir else {}))
    try:
        report = build_results(CqaStore(settings.data_dir), settings, group_id=args.group,
                               checklist_id=args.checklist, checklist_version=args.version, target=args.target,
                               team_name=args.team)
    except (NotFoundError, ValidationFailed) as error:
        print(error.message)
        return 1
    _print_report(report)
    if args.dry_run:
        return 0 if report.ready else 1
    if not report.ready and not args.allow_incomplete:
        print("Nothing written. Fix the errors above, or pass --allow-incomplete for a partial, non-submission file.")
        return 1
    out = args.out or REPO_ROOT / "results" / args.target / "results.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(out, render(report.document))
    print(f"Wrote {out} ({len(report.document['results'])} records{'' if report.ready else ', INCOMPLETE'}).")
    return 0 if report.ready else 1


if __name__ == "__main__":
    sys.exit(main())
