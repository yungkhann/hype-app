# Conversation Quality Analytics (CQA)

CQA scores operator chats and calls against a versioned checklist. It also lets operators appeal a criterion score and reviewers decide the appeal. It is a self-contained area of ATLAS: its own API under `/api/v1/cqa`, its own pages under `/cqa`, and its own storage. It reuses ATLAS's FastAPI app, design system, components and conventions. The ATLAS studio is unchanged; its sidebar gains a "Quality analytics" link.

The AI evaluation model is **not part of this code**. It plugs in through an adapter, described in [cqa-model-contract.md](cqa-model-contract.md). Until then a clearly labelled development mock produces deterministic placeholder answers. It is not AI, and the UI says so wherever its numbers appear.

## Five-minute demo

1. `pnpm dev`, then open http://127.0.0.1:3000/cqa.
2. **Import.** Choose **Import from organizers' API** with `DEV`, which fetches 65 conversations; this needs `ATLAS_CQA_SOURCE_URL`, see below. Without network access, use **Load FIXTURE** instead: six synthetic conversations, labelled `FIXTURE`.
3. **Checklist.** Open **Checklists** and enter the official criteria, or choose **Add development sample** (placeholder criteria, labelled unofficial).
4. **Evaluate.** Choose **Evaluate with v1**, then **Queue evaluation**. Progress shows on **Evaluations**.
5. **Review a conversation.** Open a conversation. The transcript (client / operator / bot / system, original timestamps) sits next to the result: total, sections, per-criterion points, weight shares and N/A reasons. Clicking an evidence quote scrolls to that line and highlights the quoted text.
6. **Appeal.** As Operator, expand a criterion and choose **Appeal this score**.
7. **Decide.** Switch to Reviewer (top right) and choose **Review appeal**. Override with a mandatory explanation. The engine recalculates the total, and the original stays visible next to the final.
8. **Replace a criterion.** In **Checklists**, use **Replace** on a criterion. This creates v2, then choose **Evaluate with v2**. v1 results are kept.
9. **New group.** Import another group (e.g. `FIXTURE-CONTROL`, or a new organizers' group) and choose **Evaluate… → Not yet evaluated with this version**. Only the new conversations are queued; no redeploy is needed.

## Architecture

```
organizers' API ──GET ?group_id──▶ ingestion.py ─┐
labelled fixtures ───────────────▶ (parse, validate,├─▶ store.py (JSON under data/workspaces/cqa, audit.jsonl)
                                    stable msg ids) │
checklists.py (immutable versions) ─────────────────┤
                                                    │
evaluations.py ── thread pool ── contract.build_request ──▶ adapter (mock | http | team model)
      │                                                         │
      │◀── contract.validate_output (strict) ◀──── ModelOutput ─┘
      ▼
scoring.py (the only place scores are computed) ──▶ evaluation record: original results + original score
      ▲
appeals.py ── reviewer override ── recalculate ──▶ overrides + final score (original kept)
```

| Module (`apps/api/app/cqa/`) | Responsibility |
| --- | --- |
| `ingestion.py` | Organizers' payload format, per-record validation (rejected records reported with a reason; the rest import), MM:SS and ISO timestamps, speakers, stable message ids `m1…`, transcript hash, re-import revisions |
| `checklists.py` | Create, update (a new version only when the configuration changes; stale-version 409), duplicate, replace a criterion, import/export, archive, delete while unused |
| `scoring.py` | Deterministic engine on exact fractions: normalization per answer type, weights, N/A redistribution, section subtotals, severe-error policy, configured rounding, incomplete detection |
| `contract.py` | `cqa-eval/1` request/response models and strict validation (evidence must reference real messages and quotes must occur in them) |
| `adapters/` | `mock` (development only), `http` (loopback by default); any module dropped here registers itself |
| `evaluations.py` | `pending → running → completed / failed`, batches, `only_missing`, re-run, stale detection when a transcript changes |
| `appeals.py` | Appeals per criterion, confirm / override with a mandatory explanation, recalculation, audit trail |
| `audio.py` | Resolves a call's player page to its signed MP3, contacting only allow-listed https hosts |
| `store.py` | Atomic JSON documents and the append-only audit log, the same approach as ATLAS findings |
| `router.py` | HTTP layer. OpenAPI at `/docs`; frontend types are generated with `pnpm gen:api` |

How results stay reproducible:

- **Evaluations snapshot their inputs.** Each stores the checklist configuration snapshot, the version number and the transcript hash it was run with.
- **Versions are immutable.** Editing a checklist creates a new version, and old results keep pointing at theirs.
- **Overrides never rewrite results.** A reviewer override is stored next to the original results, and the final score is recomputed from original answers plus overrides. Both the original and the final total are shown.

Frontend (`apps/web`):

| Route | Page |
| --- | --- |
| `/cqa` | Overview: KPIs, score distribution, per-criterion results, imports, recent activity |
| `/cqa/conversations` | Search, filters (language, channel, evaluation status, score range, group), sorting, pagination |
| `/cqa/conversations/[id]` | Transcript and audio player beside the evaluation (history, sections, criteria, evidence, appeals, audit). The URL keeps `?evaluation=&criterion=&msg=` |
| `/cqa/evaluations` | All runs, batch progress, failures with every contract problem |
| `/cqa/checklists`, `/cqa/checklists/[id]` | Checklist list; editor (criteria, sections, scoring rules, versions, replace, duplicate, export) |
| `/cqa/appeals` | Pending and decided appeals; review panel with evidence and transcript context; reviewer decision form |
| `/cqa/embed/conversations/[id]` | The conversation workspace without the app shell, for embedding |

Code lives in `app/cqa/`, `components/cqa/`, `lib/cqa/` (`api.ts` TanStack Query hooks, `format.ts` pure helpers, `types.ts` aliases of the generated OpenAPI types) and `e2e/cqa*.spec.ts`.

**Demo roles.** The Operator / Reviewer switch only decides which actions the UI offers and the name recorded with them. It is not access control; there is no sign-in.

## Settings

Put these in the root `.env`, which is git-ignored. `pnpm dev` loads it for both servers. `pnpm dev:api` on its own does not, so either use `pnpm dev` or export the variables first.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATLAS_CQA_SOURCE_URL` | unset | The organizers' GET endpoint from the student guide, **without** `group_id`; ATLAS sets `group_id` per import. It carries a signed token: keep it in `.env` only and single-quote it. Errors never include it |
| `ATLAS_CQA_SOURCE_TIMEOUT_S` | `60` | Timeout for the organizers' API |
| `ATLAS_CQA_FIXTURES_ENABLED` | `true` | Offer the synthetic `FIXTURE*` groups |
| `ATLAS_CQA_EVALUATOR` | `mock` | Default evaluator: `mock`, `http`, or a registered adapter name |
| `ATLAS_CQA_EVALUATOR_URL` | unset | Model service endpoint for the `http` adapter |
| `ATLAS_CQA_EVALUATOR_TIMEOUT_S` | `180` | Per-conversation timeout for the model |
| `ATLAS_CQA_EVALUATOR_ALLOW_REMOTE` | `false` | Allow a non-loopback model URL, which means transcripts leave this machine. Only with approval |
| `ATLAS_CQA_EVALUATION_WORKERS` | `2` | Evaluations run in parallel |
| `ATLAS_CQA_AUDIO_HOSTS` | `["powerplatform.com","dynamics.com"]` | Host suffixes the API may contact to resolve recordings |
| `ATLAS_CQA_MAX_MESSAGES` / `ATLAS_CQA_MAX_MESSAGE_CHARS` | `3000` / `20000` | Per-conversation parsing limits |

## Data, privacy and security

- **Storage.** Conversations, checklists, evaluations, appeals and the audit log are stored under `data/workspaces/cqa/` (git-ignored).
- **Where data goes.** Nothing is sent to external AI services. The mock runs locally. The `http` adapter refuses non-loopback URLs unless `ATLAS_CQA_EVALUATOR_ALLOW_REMOTE=true`.
- **Fixtures.** The fixture conversations are synthetic and labelled `FIXTURE`. No data is invented when the organizers' API is unavailable: the import fails with the reason.
- **Signed URLs.** The source URL and the recording links are never logged or returned in errors. The audio resolver contacts only allow-listed https hosts.

## Embedding (Dynamics 365 HTML component)

`/cqa/embed/conversations/{conversation_id}` renders only the conversation workspace: transcript, audio and evaluation, with appeal actions. It accepts the same `?evaluation=&criterion=&msg=` parameters, so a Dynamics web resource or HTML component can show it in an iframe keyed by the conversation id. Every page talks to the API only, so the full `/cqa` area can be embedded the same way.

Dynamics serves pages over https. The ATLAS web app and API therefore need to be reachable over https from the browser, configured with:

- **`NEXT_PUBLIC_ATLAS_API`:** the API's public URL.
- **`ATLAS_CORS_ORIGINS`:** the web app's origin.
- **`ATLAS_ALLOWED_HOSTS`:** the API host name.
- **Framing policy:** a CSP `frame-ancestors` limited to the organization's Dynamics domain.

No deployment is included in this repository.

## Tests

| Suite | Covers |
| --- | --- |
| `apps/api/tests/test_cqa_scoring.py` | Weights, N/A redistribution, scale/options/binary, sections, severe policies, exact rounding, overrides, bad input |
| `apps/api/tests/test_cqa_contract.py` | The documented example passes; evidence, quotes, coverage, N/A, severe, strict types |
| `apps/api/tests/test_cqa_ingestion.py` | Payload parsing, three languages, speakers, chat/voice timestamps, bad records, source failures (no URL leak), re-import, filters and sorting |
| `apps/api/tests/test_cqa_checklists.py` | CRUD, versions, stale updates, duplicate, replace, import/export, archive/delete |
| `apps/api/tests/test_cqa_workflow.py` | Evaluation lifecycle and failures, batches, appeals, overrides and recalculation, audio resolver, full demo flow |
| `apps/web/tests/cqa.test.ts` | Frontend helpers (formatting, answers, spans, queries, checklist editing, import parsing) |
| `apps/web/e2e/cqa.spec.ts` | The demo above through the real UI and API, with fixtures and the mock |
| `apps/web/e2e/cqa-responsive.spec.ts` | Every CQA page at desktop and phone width: no horizontal scroll, no console errors |

The e2e servers force `ATLAS_CQA_SOURCE_URL=''` and `ATLAS_CQA_EVALUATOR=mock`, so tests never reach the organizers' API or a model, whatever `.env` says.

## Not included, on purpose

- **The AI model.** It is selected and built separately; see the contract.
- **The official eight-criterion checklist.** It is entered from the organizers' document in the checklist editor, or imported as JSON with origin "Official". ATLAS does not invent official rules. Its scoring settings (maximum score, rounding, severe-error policy) default to 100 / half-up to one decimal / flag only, and should be set to the official rules once they are known.
- **Authentication.** Roles are a demo switch.
