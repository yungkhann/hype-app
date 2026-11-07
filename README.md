# ATLAS — Data Intelligence Studio

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

- Port taken? Copy `.env.example` to `.env` and set `ATLAS_WEB_PORT` / `ATLAS_API_PORT`. `pnpm dev`
  checks both ports first and keeps the API URL and CORS allow-list in sync.
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
