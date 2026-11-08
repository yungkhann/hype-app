# ATLAS — Conversation Quality Analytics

ATLAS scores Freedom Broker customer-service operators against an editable checklist. It imports a conversation, asks the selected model for an answer on every enabled criterion, cites the transcript lines behind each answer, and computes the score itself (weights, N/A redistribution, section totals, rounding, and the critical-error flag). A reviewer can appeal one criterion; GPT recommends, the reviewer decides, and the total is recalculated. The original score, the decision and the final score are all kept.

The interface is vanilla HTML, CSS and JavaScript in `apps/web`. The API is FastAPI in `apps/api`. The browser calls `/api/v1/cqa`.

## Run it

Python 3.12 and the API virtualenv (`apps/api/.venv`) are required. Create the venv with `uv venv apps/api/.venv --python 3.12` and install `apps/api/requirements.txt` plus `apps/api/requirements-dev.txt` if it is missing. Copy `.env.example` to `.env` and fill the empty secret values there. Do not commit `.env`.

### Docker

From the repository root, with an env file that does not contain secrets if you only want to check the compose file:

```bash
docker compose --env-file .env.example up --build -d
```

The web UI is published on `127.0.0.1:3000` and the API on `127.0.0.1:8000`. Mode 1 reaches Ollama on the host through the `ollama-forward` sidecar (`ATLAS_CQA_GEMMA_BASE_URL=http://localhost:11434/v1` inside the API container).

### Locally

Two processes. The API does not load `.env` unless you export the variables yourself (`scripts/dev-api.sh` sources `.env`; the command below does not):

```bash
cd apps/api
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```bash
python3 -m http.server 3000 --bind 127.0.0.1 --directory apps/web
```

Open `http://127.0.0.1:8000/api/v1/health` (the body has `"status": "ok"`) and `http://127.0.0.1:3000`. An empty `<meta name="cqa-api">` calls `/api/v1` on the page's own origin, which the Docker nginx proxy serves. For these two ports, set that tag to `http://127.0.0.1:8000/api/v1`. The API allows browser calls from port 3000 (`ATLAS_CORS_ORIGINS`).

## Import

**By group.** Set `ATLAS_CQA_SOURCE_URL` to the organizers' GET URL without `group_id` (the signed URL stays in `.env`). In the UI, Import → the API tab, enter the group id (`DEV` for the development set) and import. The API calls the organizers' endpoint and stores the records.

**By JSON.** Import → JSON, paste the organizers' response or drop the file. The same parser runs. Nothing is sent to the organizers' host.

`ATLAS_CQA_FIXTURES_ENABLED=true` (the default) also lists clearly labeled fixture groups. Set it to `false` on a demo or production host so those conversations are not mixed with the real set.

## Evaluation modes

The choice is on the conversation page and is stored in the browser. The server default when a request omits `mode_type` is `ATLAS_CQA_DEFAULT_MODE_TYPE` (1).

| Mode | Who answers |
| --- | --- |
| 1 Hybrid | The local model `ATLAS_CQA_GEMMA_MODEL` (default `qwen3:27b`, adapter id `gemma`, Ollama at `ATLAS_CQA_GEMMA_BASE_URL`) answers official criteria whose wording still matches the template. GPT (`ATLAS_CQA_OPENAI_MODEL`, default `gpt-4.1`) answers the rest. |
| 2 GPT only | GPT answers every criterion. Qwen is not called. |

Appeals are reassessed by GPT in both modes (`ATLAS_CQA_REASSESSOR=openai`). A failed provider fails the evaluation; nothing is filled in. Evaluate again on a failed part re-asks only that provider.

GPT needs `OPENAI_API_KEY` or `ATLAS_CQA_OPENAI_API_KEY`. Each conversation is tried up to `ATLAS_CQA_OPENAI_MAX_ATTEMPTS` times (default 2). `ATLAS_CQA_OPENAI_TIMEOUT_S` is the per-request limit (default 120). Qwen uses `ATLAS_CQA_GEMMA_TIMEOUT_S` (default 300) and no key.

On the checklist page, **Save checklist** stores a new version. **Apply to all conversations** picks a group from the overview, uses the mode selected in this browser, asks for confirmation, and evaluates conversations that have no result yet (`only_missing`) on the saved version.

## Appeals

On a criterion, write a comment and submit. The appeal is stored and GPT reassesses that criterion only. The reviewer confirms the original value, accepts GPT's recommendation, or overrides it. The score is recalculated from the checklist version that was evaluated. The card keeps the original score, the decision and the final score.

## Export

`results/dev/results.json` is the 65-record development set. `results/prod/results.json` is the 10-record control set. The exporter reads stored evaluations only. It refuses to write until `ATLAS_CQA_TEAM_NAME` is set (or you pass `--team`). `model.name` is the names the providers reported, not a label from the UI.

```bash
scripts/export-results.sh --set dev --group DEV --dry-run
scripts/export-results.sh --set dev --group DEV
scripts/export-results.sh --set prod --group <prod-group>
```

The script loads the root `.env`, then runs `python -m app.cqa.results_export`. The same module can be run directly:

```bash
cd apps/api
ATLAS_CQA_TEAM_NAME='Your team' .venv/bin/python -m app.cqa.results_export --set dev --group DEV --dry-run
```

`--check results/dev/results.json` validates a file that is already written. Paid evaluation is not part of export. Run evaluations from the UI first. Those evaluation commands are paid and are not listed here.

## Production settings

- `ATLAS_CQA_FIXTURES_ENABLED=false` hides fixture conversations.
- `ATLAS_CQA_TEAM_NAME` is the name written into `results.json`.
- `ATLAS_CQA_MODEL_MODE` overrides the derived `model.mode` (`local`, `external_api` or `hybrid`). Leave it empty so the exporter uses the providers that actually answered.
- `ATLAS_CQA_EVALUATION_WORKERS` is how many evaluations run at once (default 2).
- `ATLAS_DATA_DIR` is where conversations, checklists and evaluations are stored.

## Dynamics 365

`apps/web` is a static site: `index.html` and `js/*.js`, no bundler. To use it as a Dynamics 365 HTML web resource, upload those files and set the API address on the page:

```html
<meta name="cqa-api" content="https://your-host/api/v1" />
```

An empty `cqa-api` calls `/api/v1` on the page's own origin. For a split-port local run, set it to `http://127.0.0.1:8000/api/v1`.

## Cost of one GPT-4.1 evaluation

Measured on the 65 DEV records in the local `invoke.json` (not stored in this repository) with `build_messages` and the official checklist. No model was called. Tokens are `tiktoken` `o200k_base` counts of the system and user messages.

| | Tokens |
| --- | --- |
| Input, one attempt (65 dialogs: min 2,903, median 3,040, mean 3,367, max 8,712) | 3,040 median |
| Output, one attempt (the appendix example's eight rationales, tokenized) | 319 |

Prices from OpenAI's model page for `gpt-4.1`, checked 8 Nov 2026: **$2 per million input tokens** and **$8 per million output tokens** ([developers.openai.com/api/docs/models/gpt-4.1](https://developers.openai.com/api/docs/models/gpt-4.1)).

A first-try mode 2 evaluation at the median prompt is about **$0.009** (3,040 × $2 / 1,000,000 + 319 × $8 / 1,000,000). `ATLAS_CQA_OPENAI_MAX_ATTEMPTS` is 2, so a rejected answer is sent back once. On the median dialog that second prompt is 3,400 tokens (the original prompt, the rejected answer and the short feedback). Two attempts are about **$0.018**.

Mode 1 on the untouched official checklist sends every criterion to local Qwen, so the GPT cost of that evaluation is $0. GPT is billed only for criteria whose definition no longer matches the template, and for every appeal. The figures above are the mode 2 (all criteria, GPT) estimate.

| Set | Evaluations | Estimate, mode 2, first try | Estimate if every dialog is retried once |
| --- | --- | --- | --- |
| DEV | 65 | about $0.56 | about $1.17 |
| PROD | 10 | about $0.09 | about $0.18 |

These are estimates. Real bills depend on rationale length, retries and how many criteria mode 1 still sends to GPT.

## Older data studio

The sections below describe the earlier Next.js data studio (datasets, charts, models). That frontend is no longer in `apps/web`. They are kept as notes for that older workbench.

A local-first workbench for taking an unfamiliar dataset from upload to a defensible, presentable result:
**upload → understand → explore → prepare → analyze → validate → explain → present.**

Built for a four-person team at **Data Challenge: Doomsday** (Nazarbayev University, 7–8 Nov 2026, Freedom
case). The case is unknown in advance, so ATLAS assumes nothing about it. Every page works on any CSV, Excel
or Parquet file, and the case-specific work plugs into a documented extension area (`/challenge`).

- **Every number carries its provenance.** Charts, KPIs, metrics and findings show a source line:
  dataset · rows used of total · filters · sampling · aggregation.
- **No manufactured conclusions.** ATLAS computes and discloses. Interpretations are written by the team.
- **Local and private.** Both servers bind to `127.0.0.1`. No external AI, no analytics, no telemetry
  (Next.js telemetry is disabled in every script).
- **Dark-first, keyboard-friendly UI.** Press ⌘K / Ctrl+K anywhere in the studio to jump to a page or switch
  the active dataset. The printable report uses a light paper theme.

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| macOS or Linux | — | Scripts are bash. |
| Python | 3.11 – 3.14 | `setup.sh` picks the newest of 3.13 / 3.12 / 3.14 / 3.11 it finds; override with `PYTHON=python3.12`. |
| Node.js | ≥ 20.9 | Tested with Node 26. |
| pnpm | 10 | `corepack enable` provides it. |

## Start (exact commands)

```bash
cd atlas
pnpm run bootstrap   # once: venv + Python deps, web deps, synthetic samples, generated API types
pnpm dev             # API on http://127.0.0.1:8000 and web on http://127.0.0.1:3000, Ctrl+C stops both
```

Open **http://127.0.0.1:3000**. On the Datasets page, either drop a file or click **Load** on a synthetic sample.

- Port taken? The older `pnpm dev` expected ports 3000 and 8000 to be free. The publish ports live in
  `docker-compose.yml`, not in the API settings.
- Other settings in `.env`: upload and parse limits (`ATLAS_MAX_UPLOAD_MB`, `ATLAS_MAX_UNCOMPRESSED_MB` for
  the size an .xlsx may expand to, `ATLAS_MAX_ROWS`) and `ATLAS_ALLOWED_HOSTS`, the Host headers the API
  accepts (default `["127.0.0.1","localhost"]`). The full list is in
  [docs/api-contract.md](docs/api-contract.md#limits-and-settings).
- API docs (OpenAPI): http://127.0.0.1:8000/docs
- One service only: `pnpm dev:api` or `pnpm dev:web`.

## Pages

| Route | Purpose |
| --- | --- |
| `/` Datasets | Upload (drag and drop, progress, cancel), import review (encoding, delimiter, sheet, header row), samples, rename, replace (with undo), delete, download original/CSV/Parquet |
| `/overview` | Schema, statistics, quality flags split into **Detected** (facts) and **Heuristic** (suspicions), missingness, per-column detail, correlation |
| `/explorer` | Server-side table (search, sort, paging, column visibility, filters), group & aggregate, chart builder, saved views, filtered CSV export |
| `/prepare` | Reproducible transform recipes with an optional train/validation split; fitted steps learn from train rows only. Preview first; saving creates a derived dataset |
| `/analysis` | Registered analyses with generated parameter forms (Pareto concentration, group comparison, association ranking, k-means, anomalies, time trend) |
| `/models` | Optional: classification/regression baselines vs a dummy baseline on a held-out split, readiness and leakage checks, background training, exports |
| `/findings` | Evidence you chose to keep, with chart snapshots and source lines. Interpretation is written by you. Markdown/JSON export |
| `/present` | Full-screen pitch deck: ←/→ Home/End, `E` edit, `N` notes, `F` full screen. Placeholders stay visibly marked until edited |
| `/report` | Printable report (print / save as PDF) |
| `/challenge` | The case-specific extension area and the case-reveal checklist |

## Checks

```bash
pnpm test:api        # pytest: 58 tests (ingestion, security, profiling, queries, charts, transforms, models, findings, extensions)
pnpm test:web        # vitest: unit tests for formatting, provenance, filters, chart rules, schema forms, recipes
pnpm typecheck && pnpm lint
pnpm --filter web e2e:install   # once: Chromium into node_modules (no global install)
pnpm e2e             # Playwright, 9 tests: workflows W1–W6, the ⌘K command menu, desktop/phone layout checks
```

E2E tests start their **own** API (127.0.0.1:8100) and web build (127.0.0.1:3100) on a throwaway workspace in
`apps/web/e2e/.artifacts/`. They never touch your datasets or the dev servers, but the build writes
`apps/web/.next/`, so restart `pnpm dev` afterwards if pages look stale.

## Where things live

```
apps/api/            FastAPI backend (Python)
  app/api/routes/    HTTP layer only (validation, status codes)
  app/services/      ingestion · profiling · analytics · preprocessing · modeling · reporting
  app/extensions/    analysis registry + built-in analyses (the extension pattern)
  app/challenge/     ← case-specific analyses and endpoints go here
  tests/             pytest
apps/web/            Next.js 16 App Router frontend (TypeScript)
  app/(studio)/      the studio pages (one folder per route)
  app/present, app/report   full-screen pages outside the app shell
  components/        ui · charts · data · shell · findings · datasets · analysis
  lib/api/           typed client, TanStack Query hooks, generated schema types
data/samples/        synthetic practice datasets (safe to commit)
data/workspaces/     your uploads, findings, experiments (git-ignored; never commit)
docs/                architecture · API contract · tomorrow playbook · team handoff
```

After changing backend schemas, run `pnpm gen:api` to regenerate `docs/openapi.json` and the frontend types.

## Documentation

- [docs/tomorrow-playbook.md](docs/tomorrow-playbook.md): what to do in the first hour after the case reveal, plus scenarios A–F.
- [docs/team-handoff.md](docs/team-handoff.md): four roles, file ownership, git workflow.
- [docs/architecture.md](docs/architecture.md): layout, request flow, backend layers, security, frontend structure, and how to add an analysis (worked example).
- [docs/api-contract.md](docs/api-contract.md): endpoints, error envelope and codes, limits and `ATLAS_*` settings, downloads, replace/cancel.
- [PRODUCT.md](PRODUCT.md) · [DESIGN.md](DESIGN.md): product principles and the design system.

## Data and privacy

- Uploads are stored under `data/workspaces/` (git-ignored). The original file is kept byte for byte and its
  sha256 is shown. Every transformation creates a new derived dataset with its step log.
- Nothing leaves the machine. The only network use is installing dependencies (`pnpm run bootstrap`) and the
  optional one-time Chromium download for E2E tests.
- The sample datasets are synthetic (see `data/samples/README.md`). No real customer data is included.
