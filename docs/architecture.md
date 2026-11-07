# Architecture

ATLAS is two local processes, a Next.js web app and a FastAPI service. Both bind to `127.0.0.1`. The browser
talks to the API directly; there is no Next.js API route and no server-side proxy.

## Monorepo layout

```
atlas/
  package.json            root scripts (bootstrap, dev, test, check, gen:api, e2e)
  pnpm-workspace.yaml     pnpm workspace (apps/web)
  .env.example            port/limit overrides, copied to .env (git-ignored)
  README.md  PRODUCT.md  DESIGN.md
  apps/
    api/                  FastAPI service (Python, own .venv)
      app/
        main.py           create_app(): settings, lifespan services, middleware, routers
        core/             config.py (Settings), errors.py (envelope), security.py (OriginGuard)
        api/
          deps.py         service dependencies, CSV streaming, formula neutralization, attachment headers
          routes/         system · datasets · analysis · analyses · experiments · findings
        services/
          datasets.py     dataset lifecycle: stage → preview → import → profile; replace/cancel; samples
          ingestion/readers.py      format detection, preflight, CSV/XLSX/Parquet readers, error redaction
          profiling/profiler.py     schema, statistics, quality flags, correlation
          analytics/      query.py (filter/search/sort/page/aggregate), charts.py (server-side series)
          preprocessing/transforms.py   recipe steps + train/validation split
          modeling/       checks.py (readiness, leakage), pipelines.py (models), metrics.py, runner.py
          reporting/store.py        findings, pitch deck, saved views (JSON documents)
          filters.py      shared filter semantics
        extensions/       registry.py (@register_analysis), builtin.py (six built-in analyses)
        challenge/        analyses.py (case analyses), router.py (/api/v1/challenge)
        schemas/          Pydantic request/response models (source of docs/openapi.json)
        storage/          paths.py (id + path safety), workspace.py (files on disk, DataFrame cache)
        utils/frames.py
      tests/              pytest
      requirements*.txt  pyproject.toml (ruff config)
    web/                  Next.js 16 App Router (TypeScript)
      app/
        layout.tsx  globals.css
        (studio)/         layout.tsx (AppShell) + one folder per page
        present/  report/ full-screen pages outside the shell
      components/         analysis · charts · data · datasets · findings · shell · ui · providers.tsx · source-line.tsx
      lib/
        api/              client.ts · hooks.ts · types.ts · schema.d.ts (generated)
        active-dataset.ts chart-export.ts format.ts hooks.ts local-chart.ts palette.ts schema-form.ts utils.ts
      tests/              vitest (format.test.ts, rules.test.ts)
      e2e/                Playwright (workflows.spec.ts, responsive.spec.ts)
  data/
    samples/              synthetic practice data + catalog.json (committed)
    workspaces/           uploads, findings, experiments (git-ignored)
  docs/                   this file, api-contract.md, tomorrow-playbook.md, team-handoff.md, openapi.json
  scripts/                setup.sh, dev.sh, dev-api.sh, gen-api-types.sh, dump_openapi.py, generate_samples.py
```

## Request flow

```
page.tsx → *-view.tsx ("use client")
  → TanStack Query hook (lib/api/hooks.ts, e.g. useDatasets, useRunAnalysis)
    → api() in lib/api/client.ts  →  fetch(`${API_ORIGIN}/api/v1/...`)
      → FastAPI on http://127.0.0.1:8000/api/v1
        → middleware → route (app/api/routes) → service (app/services) → workspace (app/storage)
```

- `API_ORIGIN` comes from `NEXT_PUBLIC_ATLAS_API` (default `http://127.0.0.1:8000`). `scripts/dev.sh` sets it
  from `ATLAS_API_PORT` and sets `ATLAS_CORS_ORIGINS` from `ATLAS_WEB_PORT`, so the two stay in sync.
- Non-2xx responses are parsed from the error envelope into `ApiError(message, status, code, details)`
  (`lib/api/client.ts`).
- The query client (`components/providers.tsx`) uses `staleTime: 10_000`, `retry: 1` and no refetch on
  window focus. `useAnalyses` is cached with `staleTime: Infinity`, so reload the browser after registering a
  new analysis.
- The active dataset id is kept in `localStorage` (`atlas.activeDataset`, `lib/active-dataset.ts`) and shared
  by every page.
- Types: `pnpm gen:api` runs `scripts/dump_openapi.py` (writes `docs/openapi.json`) and then
  `openapi-typescript`, which writes `apps/web/lib/api/schema.d.ts`. `lib/api/types.ts` re-exports the names
  the UI uses.

## Backend layers

`create_app(settings)` (`app/main.py`) builds the app. Its lifespan stores four long-lived objects on
`app.state`: `settings`, `workspace` (`Workspace`), `datasets` (`DatasetService`), `experiments`
(`ExperimentManager`) and `reports` (`ReportStore`). Routes receive them through the `*Dep` aliases in
`app/api/deps.py`. Routers are mounted under `/api/v1` in this order: system, datasets, analysis, analyses,
experiments, findings, challenge.

Routes only validate input and pick status codes. The work happens in services:

| Concern | Module | Notes |
| --- | --- | --- |
| Upload staging | `services/datasets.py` `receive_upload`, `DatasetService.stage` | Streams to `tmp/` with a size check, then sha256, a sniffed head, and a move to `original.<ext>`. Runs `readers.preflight` then `readers.detect`. |
| Import | `DatasetService.import_dataset` | Runs `preflight` again, reads at most `max_rows + 1` rows, normalizes columns and values, saves `data.parquet`, and profiles the result. |
| Readers | `services/ingestion/readers.py` | `format_for` (extension and content must agree), `preflight`, `detect` (encoding, delimiter, sheets), `READERS[fmt]`, and `describe_error`. |
| Profiling | `services/profiling/profiler.py` | Computed on up to `profile_sample_rows` rows and cached as `profile.json`. Quality flags are marked `detected` (fact) or heuristic. |
| Query, aggregate, charts | `services/analytics/` | Paged rows (≤ 500), aggregations, and chart series built server-side and capped by `max_chart_points` / `max_series`. |
| Transforms | `services/preprocessing/transforms.py` | Recipe of ≤ 50 steps plus an optional split. Fitted steps record `fit_scope`. Saving always creates a new derived dataset with lineage. |
| Analysis registry | `extensions/registry.py` | `REGISTRY`, `register_analysis`, `run_analysis`, `AnalysisContext`. |
| Models | `services/modeling/` | `checks.py` (target/feature readiness, leakage), `pipelines.py` (`MODEL_OPTIONS`), `runner.py` (thread pool of `model_workers`, results on disk). |
| Findings, pitch, views | `services/reporting/store.py` | JSON documents with a lock. `findings_markdown` handles the Markdown export. |

### Where data lives

Everything is under `settings.data_dir` (default `data/workspaces/`, override with `ATLAS_DATA_DIR`). See the
docstring in `app/storage/workspace.py`:

```
datasets/<id>/manifest.json         metadata, status (staged | ready | failed), lineage
datasets/<id>/original.<ext>        the upload, byte for byte (sha256 in the manifest)
datasets/<id>/data.parquet          the canonical table every service reads
datasets/<id>/profile.json          cached profile
datasets/<id>/previous/             the prior version while a replacement is pending
experiments/<id>.json               experiment record
experiments/<id>.predictions.parquet
findings.json  pitch.json  views.json
tmp/                                in-flight uploads
```

Ids are 32-character hex (`ID_PATTERN` in `storage/paths.py`). User strings never become paths directly:
`check_id`, `sanitize_filename` and `safe_child` enforce this. Writes are atomic (temp file + `os.replace`).

## Security layer

The middleware is added in `main.py` as GZip, OriginGuard, CORS, TrustedHost. Starlette runs the last-added
middleware first, so a request passes through them in this order:

1. **TrustedHostMiddleware**: `allowed_hosts` (default `["127.0.0.1", "localhost"]`, ports ignored). Any
   other `Host` header gets Starlette's plain-text `400 Invalid host header`. This blocks DNS rebinding.
2. **CORSMiddleware**: `allow_origins = cors_origins`, `allow_credentials=False`, and `Content-Disposition`
   exposed so the browser can read download filenames.
3. **OriginGuard** (`core/security.py`):
   - GET, HEAD and OPTIONS always pass.
   - Other methods pass when there is no `Origin` header (curl, scripts, tests), when the origin is in
     `cors_origins`, or when it equals `http(s)://<Host>`.
   - Everything else gets `403` with code `forbidden_origin`. This stops a page on another origin from
     sending state-changing "simple" requests that CORS would not preflight.
4. **GZipMiddleware**: `minimum_size=2048`.

Other protections:

- **CSV formula neutralization** (`api/deps.py` `neutralize_formulas`, applied per 50 000-row chunk in
  `csv_stream`):
  - Text cells that start with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`.
  - Numeric-looking text such as `-5` is left alone.
  - It applies to `/download?format=csv`, `/export` and `predictions.csv`. Parquet and the original file stay
    exact.
  - CSV output is UTF-8 with a BOM.
- **Preflight** (`readers.preflight`), metadata only, before anything is parsed:
  - xlsx: the summed uncompressed sizes of the zip members are compared with `max_uncompressed_mb` (zip-bomb
    check), giving `413 file_too_large_uncompressed`. A file that is not a zip gives `unreadable_file`.
  - Parquet: the footer row and column counts are compared with `max_rows` / `max_columns`
    (`too_many_rows`, `too_many_columns`).
  - CSV and xlsx imports also stop after `max_rows + 1` rows.
- **Upload size**: `receive_upload` counts bytes as they stream and aborts above `max_upload_mb` with
  `413 payload_too_large`. Empty files are rejected.
- **Error redaction**: `describe_error` replaces absolute paths in library messages with `<file>` and
  truncates them to 300 characters. Unhandled exceptions return a generic `500 internal_error`.
- **Attachment headers**: `attachment(filename)` keeps only alphanumerics and `._- `. Everything else becomes
  `_`, so a dataset name cannot inject header content.

`tests/test_security.py` covers each of these.

## Frontend structure

- **Route groups:**
  - `app/(studio)/layout.tsx` wraps the studio pages in `AppShell` (`components/shell/app-shell.tsx`), which
    provides the sidebar navigation, the header with breadcrumb and `DatasetSwitcher`, the API status, and
    the command menu.
  - The studio pages are `/` (Datasets, `home-view.tsx`), `/overview`, `/explorer`, `/prepare`, `/analysis`,
    `/models`, `/findings` and `/challenge`.
  - `app/present/` and `app/report/` sit outside the group, so they render full-screen with no shell.
- **Page pattern:** each `page.tsx` is a server component that exports `metadata` and renders one
  `*-view.tsx` client component (`"use client"`), which holds all state and hooks. For example,
  `overview/page.tsx` renders `<OverviewView />`.
- **Tokens:**
  - Design tokens live in `app/globals.css` under `@theme` (Tailwind v4) and are dark-first: surfaces
    `canvas → sunken → panel → raised → hover`, ink `ink / ink-2 / ink-3`, one teal `accent`, status colors,
    and `series-1…8`.
  - `.theme-paper` re-maps the same token names to a light print palette. Only `/report` uses it
    (`report-view.tsx`).
- **Chart colors:**
  - Charts use hex values so exported SVG/PNG keep their colors. These are `CHART_DARK` and `CHART_LIGHT` in
    `lib/palette.ts`.
  - `components/charts/chart-theme.tsx` provides `ChartThemeProvider` / `useChartTheme`. The studio uses
    the dark theme by default; the report wraps its content in `<ChartThemeProvider theme="light">`.
- **Command menu:** `components/shell/command-menu.tsx`.
  - Opened with ⌘K / Ctrl+K, or with the "Jump to…" button.
  - It lists every nav page ("Go to") and every ready dataset ("Switch dataset"). Choosing a dataset sets it
    active and opens `/overview`.
  - Matching is word-wise over the label and keywords.
- **Hydration gate:** `useHydrated()` (`lib/hooks.ts`) returns `false` during SSR and the first client render.
  `home-view.tsx` and `components/datasets/upload.tsx` use it to avoid mismatches with browser-only state
  (`localStorage`, drag-and-drop).
- **Design rules:** see `DESIGN.md` (tokens, type, components, do's and don'ts) and `PRODUCT.md` (principles).

## Extension points

### Worked example: `value_concentration` (Pareto)

`apps/api/app/extensions/builtin.py` is the template. A registered analysis has three parts.

1. A Pydantic params model. `column_param(kinds=[...])` adds `x-widget: "column"` (or `"columns"` when
   `multiple=True`) and `x-kinds` to the JSON schema. Other fields become number, integer,
   boolean, select (`Literal`/enum) or text inputs (`lib/schema-form.ts`).

   ```python
   class ConcentrationParams(BaseModel):
       group: str = column_param(kinds=["categorical", "boolean", "text"], title="Group by",
                                 description="Entities to rank, e.g. customer, merchant, region.")
       value: str | None = column_param(kinds=["numeric"], default=None, title="Value",
                                        description="Quantity to sum. Leave empty to count rows.")
       threshold: float = Field(default=0.8, ge=0.1, le=0.99, title="Share threshold")
   ```

2. The decorated function. It receives an `AnalysisContext` whose `frame` is already filtered (`full_frame`
   is the unfiltered table) and the validated params.

   ```python
   @register_analysis("value_concentration", title="Value concentration (Pareto)",
                      description="How concentrated a total is across groups: ...",
                      params=ConcentrationParams)
   def value_concentration(ctx: AnalysisContext, p: ConcentrationParams) -> AnalysisResult:
       ctx.require(p.group)                           # 422 unknown_column if missing
       if p.value:
           ctx.require(p.value, kinds={"numeric"})    # 422 invalid_param if the wrong kind
       ...
       return ctx.result("value_concentration", "Value concentration",
                         summary=[LabelValue(label="Groups", value=f"{n:,}"), ...],
                         table=ctx.table(table), chart=ctx.chart(ChartSpec(type="bar", ...), rows, series=["value"]),
                         aggregation=f"{measure} by {p.group}",
                         notes=["Groups with zero or negative totals are excluded from shares."])
   ```

   - `ctx.result`, `ctx.table` and `ctx.chart` attach a `SourceMeta`: dataset, rows used of total, filters,
     sampling and aggregation. That is the provenance line the UI shows.
   - Tables are capped at 500 rows, with a note when truncated.
   - Raise `ValidationFailed(..., code="...")` for user-fixable problems.

3. Registration happens on import: `app/extensions/__init__.py` imports `builtin`, and `main.py` imports
   `app.challenge`, which imports `challenge/analyses.py`.

What follows automatically:

- `GET /api/v1/analyses` lists the analysis with `params_schema`.
- The Analysis Lab (`app/(studio)/analysis/analysis-view.tsx`) groups analyses by `category`.
  `AnalysisRunner` turns the schema into a form via `lib/schema-form.ts` (`fieldsFromSchema`; column pickers
  are filtered by `x-kinds` against the dataset's columns).
- The runner posts to `/datasets/{id}/analyses/{analysis_id}` with the current filters. It renders the summary
  figures, the table and the chart, and the result can be saved as a finding.
- No frontend change is needed.

### Adding a case analysis

1. In `apps/api/app/challenge/analyses.py`, copy `segment_kpis` (registered as
   `challenge_template_segment_kpis`). Give it a new id and `category="challenge"`, then implement the logic.
2. Set `CASE_TITLE` in `apps/api/app/challenge/router.py`. `GET /api/v1/challenge/info` then reports
   `"case revealed"`, and the Challenge page uses the title as its heading.
3. The dev API reloads on save (`uvicorn --reload --reload-dir app`). Reload the browser: the analysis appears
   on `/challenge` and in the Analysis Lab under "Challenge".
4. If summary + table + chart is not enough, add a route to `challenge/router.py`, which is mounted at
   `/api/v1/challenge`. Keep the computation in a function, not in the route. Then run `pnpm gen:api` and
   build UI in `apps/web/app/(studio)/challenge/`.
5. Add a pytest in `apps/api/tests/`. `test_findings_and_extensions.py` has the existing extension tests.
