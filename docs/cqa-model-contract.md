# CQA evaluator contract (`cqa-eval/1`)

This is for whoever connects the AI evaluation model to ATLAS CQA. You don't need to change the frontend or the scoring engine for it.

| The model does | ATLAS does |
| --- | --- |
| Reads one conversation and one checklist version | Imports conversations, stores checklist versions |
| Answers every criterion: yes/no, a scale point or an option, or N/A | Validates the output strictly (below) |
| Cites the transcript lines behind each answer | Computes every score with the scoring engine (`apps/api/app/cqa/scoring.py`) |
| Explains each answer in a sentence or two | Shows results, evidence and N/A reasons; handles appeals and reviewer overrides |

**The model never produces the score.** ATLAS records a `raw_score` from the model for comparison but never uses it. Points, weights, N/A redistribution, section subtotals, severe-error policy and rounding all happen in the engine. That way, replacing the model changes answers, not arithmetic.

Files:

- [`docs/cqa-contract/example-request.json`](cqa-contract/example-request.json): a full request (fixture conversation `fx-ru-001`, development checklist).
- [`docs/cqa-contract/example-response.json`](cqa-contract/example-response.json): a valid answer to that request.
- [`docs/cqa-contract/schema.json`](cqa-contract/schema.json): JSON Schemas for both (`request_schema`, `output_schema`).
- Live versions: `GET /api/v1/cqa/contract` returns the schemas and examples. `GET /api/v1/cqa/evaluations/{id}/request` returns the exact request ATLAS built for a given evaluation.

`apps/api/.venv/bin/python scripts/cqa_contract_example.py` regenerates the three files. Before writing them, it checks the example response against the validator, so the documented example always passes.

## Connecting the model

There are two options. In both, ATLAS lists the evaluator in the **Evaluate** dialog, with its availability, and records its name and version on every evaluation.

### A. HTTP service (no ATLAS code)

Run the model as a service that accepts `POST` with an `EvaluationRequest` JSON body and answers `200` with a `ModelOutput` JSON body. Then set the following in the root `.env` and restart with `pnpm dev`:

```bash
ATLAS_CQA_EVALUATOR=http                                  # default evaluator for new runs
ATLAS_CQA_EVALUATOR_URL=http://127.0.0.1:9000/evaluate
# ATLAS_CQA_EVALUATOR_TIMEOUT_S=180                       # per conversation
# ATLAS_CQA_EVALUATION_WORKERS=2                          # concurrent requests ATLAS sends
# ATLAS_CQA_EVALUATOR_ALLOW_REMOTE=true                   # only for a host that is not this machine, and only if approved
```

- **Loopback only by default.** A URL that does not point at this machine is refused, so transcripts never leave it by accident. Allowing a remote host is an explicit, separate setting.
- **Errors.** Non-2xx responses, timeouts, responses over 8 MB and non-JSON bodies fail that evaluation with a readable error. Every other conversation in the batch still runs.

### B. In-process Python adapter

Add a module to `apps/api/app/cqa/adapters/`. Every module there is imported at start-up, and a broken module is logged without taking the API down.

```python
from app.cqa.adapters.base import EvaluatorAdapter, EvaluatorError, register_adapter
from app.cqa.contract import CONTRACT_VERSION, EvaluationRequest


@register_adapter("team-model")
class TeamModel(EvaluatorAdapter):
    label = "Team model"
    version = "0.1"
    is_mock = False

    def availability(self):
        return True, ""            # (ready, reason shown in the UI when not ready)

    def evaluate(self, request: EvaluationRequest) -> dict:
        ...                        # call the model; raise EvaluatorError("why") if it cannot answer
        return {
            "contract_version": CONTRACT_VERSION,
            "evaluation_id": request.evaluation_id,
            "conversation_id": request.conversation.conversation_id,
            "checklist_id": request.checklist.checklist_id,
            "checklist_version": request.checklist.version,
            "model": {"name": "team-model", "version": "0.1"},
            "results": [...],
        }
```

Select it with `ATLAS_CQA_EVALUATOR=team-model`, or per run in the Evaluate dialog. `evaluate` runs in a worker thread, one call per conversation.

## Request

```jsonc
{
  "contract_version": "cqa-eval/1",
  "evaluation_id": "0123…",                 // echo it back
  "conversation": {
    "conversation_id": "fx-ru-001",
    "language": "RU",                        // RU, KZ or EN
    "channel": "chat",                       // chat | voice | unknown (channel_raw: as received)
    "channel_raw": "agent chat",
    "audio_url": null,                       // player page for calls
    "messages": [
      { "id": "m1", "index": 0, "speaker": "client", "timestamp": "00:02", "offset_seconds": 2, "text": "…" }
    ]
  },
  "checklist": {
    "checklist_id": "fedc…", "version": 1, "name": "…",
    "sections": [ { "id": "opening", "name": "Opening", "description": "" } ],
    "criteria": [
      {
        "id": "greeting", "name": "…", "description": "what to check, verbatim from the checklist",
        "section_id": "opening", "weight": 10,
        "answer_type": "binary",             // binary | scale | options
        "scale": null,                       // {min, max, step, labels} for scale
        "options": null,                     // [{id, label, points}] for options
        "na_allowed": true, "na_rule": "when N/A applies",
        "severe_error_enabled": false, "severe_error_rule": ""
      }
    ],
    "scoring": { … }                         // for information only
  },
  "rules": { "evaluated_speaker": "operator", "context_speakers": ["client", "bot", "system"], … }
}
```

- **Messages** keep the transcript's order and speakers: client, operator, bot, system, or unknown when the source sent something else. Only the operator is evaluated; the other speakers are context.
- **Message ids** (`m1`, `m2`, …) are stable for a transcript. Evidence must use them.
- **Timestamps** are the source text: `MM:SS` for chats, ISO 8601 for calls. `offset_seconds` is the position in the conversation when it can be derived.
- **Checklist rules.** The criteria carry the full rule text the model needs: `description`, `na_rule` and `severe_error_rule`, entered by the team from the official checklist.

## Response

```jsonc
{
  "contract_version": "cqa-eval/1",
  "evaluation_id": "0123…",               // must match the request
  "conversation_id": "fx-ru-001",         // must match
  "checklist_id": "fedc…",                // must match
  "checklist_version": 1,                 // must match
  "model": { "name": "team-model", "version": "0.1" },   // optional, shown on the result
  "results": [
    {
      "criterion_id": "greeting",
      "value": true,                       // see answer formats
      "is_na": false,
      "na_reason": null,                   // required when is_na is true
      "explanation": "The operator greets the client in their first message.",
      "evidence": [ { "message_id": "m5", "quote": "Добрый день!" } ],
      "inspected_spans": [],               // [{start_message_id, end_message_id, note}]
      "severe_error": false,
      "severe_error_reason": null,         // required when severe_error is true
      "raw_score": 1                       // optional; recorded, never used
    }
  ]
}
```

Answer formats (`value`):

| `answer_type` | `value` |
| --- | --- |
| `binary` | `true` (met) or `false` (not met). JSON booleans only: `1`, `"yes"` or `"true"` are rejected. |
| `scale` | A number with `min ≤ value ≤ max`, on the `step` grid (e.g. `0, 0.5, … 5`) |
| `options` | The `id` of one of the criterion's options |
| any, when N/A | `null`, with `is_na: true` and a `na_reason` |

Evidence:

- **Every answered criterion needs evidence:** at least one `evidence` entry, or at least one `inspected_spans` entry.
- **Use an inspected span when something is missing.** If the expected action never happens (e.g. no farewell), give the stretch of conversation you checked, from `start_message_id` to `end_message_id`.
- **`quote` is optional but recommended.** It must be verbatim text from that message; case and whitespace differences are tolerated, and trailing `…` is ignored. ATLAS takes the excerpt it shows from the transcript itself, never from the model, and highlights the quoted range.
- **Limits:** at most 20 evidence entries and 10 spans per criterion.

## Validation

The backend checks the whole output. If anything is wrong, the evaluation becomes `failed` with the full list of problems. Nothing partial is saved, and nothing is scored. The checks:

1. **Shape.** Valid JSON object. Unknown fields, wrong types and coerced values (`"4"` for `4`, `1` for `true`) are rejected.
2. **Identity.** `contract_version`, `evaluation_id`, `conversation_id`, `checklist_id` and `checklist_version` match the request.
3. **Coverage.** Every criterion of the requested version is answered exactly once; there are no unknown criterion ids.
4. **Answers.** Each `value` is valid for the criterion's answer type (above).
5. **N/A.** Only where `na_allowed`, always with `na_reason`, and with `value: null`.
6. **Severe errors.** Only where `severe_error_enabled`, always with `severe_error_reason`, and never on an N/A criterion.
7. **Evidence.** Every `message_id` exists in this conversation, every `quote` is found in its message, and span starts are not after their ends.
8. **Notice, not failure:** a `raw_score` that disagrees with the engine is kept as a warning on the result.

The failed evaluation shows each problem with its location, e.g. `results[3] (solution): evidence[0]: quote not found in m7.` on the Evaluations page and the conversation page. Fix the model and press **Re-run**.

## Lifecycle

`pending` (queued) → `running` (adapter called) → `completed` (validated and scored) or `failed` (unreachable, timed out, crashed, or broke the contract).

- **Scope.** Each evaluation is tied to one checklist version and to the transcript hash it was run on. A re-import with different text marks older results "Transcript changed".
- **Reruns.** Re-running never edits a past evaluation; it creates a new one. "Evaluate → Not yet evaluated with this version" queues only conversations without a result, which covers a newly imported group.
- **Appeals and overrides** act on ATLAS's stored results. They never call the model again.

## Testing a model against ATLAS

1. Start ATLAS (`pnpm dev`).
2. On **Conversations**, choose **Import… → Load FIXTURE** (synthetic, labelled), or import `DEV` once the source URL is configured.
3. On **Checklists**, add the development sample or enter the official criteria.
4. **Evaluate**, choosing your evaluator. Failures list every contract problem.

In Python, `app.cqa.contract.validate_output(request, payload, messages)` raises `ContractViolation` with `.issues` for an invalid payload. `apps/api/tests/test_cqa_contract.py` shows how it is used.

The development mock (`ATLAS_CQA_EVALUATOR=mock`, the default) is **not AI**. It answers from a hash of the conversation and criterion ids so that the screens and the appeal workflow can be exercised. Its results are flagged `is_mock` and labelled "Dev mock · not AI" wherever they appear.
