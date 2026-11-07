# Team handoff

There are four people, each with one owner per area. Anyone may read anything. Changes to an area go
through its owner.

## Roles and ownership

| Role | Owns | Directories |
| --- | --- | --- |
| **Data lead / analyst** | Loading and cleaning, grain and definitions, descriptive findings | `data/private/` (local only), Datasets / Overview / Explorer / Prepare / Analysis Lab in the UI |
| **ML owner** | Target, validation strategy, baselines, leakage review, model exports | Model Lab; `apps/api/app/services/modeling/` (changes only if a model must be added) |
| **Extension / backend dev** | Case analyses and endpoints, generated types, tests, keeping `pnpm dev` working | `apps/api/app/challenge/`, `apps/api/app/extensions/`, `apps/web/app/(studio)/challenge/`, `apps/api/tests/`, `scripts/` |
| **Story & pitch owner** | The question as judged, findings wording, deck, report, final upload | Findings, `/present`, `/report`; `apps/api/app/challenge/router.py` `CASE_TITLE` (one line) |

Shared files need a heads-up before you edit them: `apps/web/app/globals.css`, `apps/web/lib/api/*`,
`apps/api/app/schemas/*`, `docs/openapi.json` (generated), `package.json` and `pnpm-lock.yaml`.

Each finding is written by the person who produced the evidence. The story owner edits for consistency but
does not change numbers.

## Run it

```bash
pnpm run bootstrap   # once per machine, and after dependency changes: venv, deps, samples, API types
pnpm dev             # API http://127.0.0.1:8000 (docs at /docs) + web http://127.0.0.1:3000; Ctrl+C stops both
pnpm dev:api         # API only (uvicorn --reload on apps/api/app)
pnpm dev:web         # web only
```

- Requirements: Python 3.11–3.14, Node ≥ 20.9, pnpm 10 (`corepack enable`).
- Ports and limits: `cp .env.example .env` and edit it. `.env` is git-ignored, and `scripts/dev.sh` loads it
  for both services.
  - `ATLAS_WEB_PORT` / `ATLAS_API_PORT`: `dev.sh` refuses to start if either port is taken, and derives
    `NEXT_PUBLIC_ATLAS_API` and `ATLAS_CORS_ORIGINS` from them.
  - `ATLAS_MAX_UPLOAD_MB`, `ATLAS_MAX_UNCOMPRESSED_MB`, `ATLAS_MAX_ROWS` and the other limits:
    `docs/api-contract.md`, "Limits and settings".
  - `ATLAS_ALLOWED_HOSTS` (a JSON list in single quotes, as in `.env.example`): only change it if you open the
    API under another host name.
- Each laptop has its own workspace (`data/workspaces/`). There is no sync. Share findings by exporting
  (`/findings` → JSON/Markdown) or by having one machine host the final deck.

## Git workflow

- **The repository has no commits yet.** Before the first commit, run `git status` and check that no data
  file is staged.
- Branch from `main`: `git switch -c <name>/<topic>` (for example `ml/churn-baseline`).
- Keep PRs small and focused: one analysis, one fix, or one doc. Rebase or merge `main` often. On the day,
  aim to merge within an hour.
- **No force-push, no history rewrites, and no `git reset --hard` on shared branches.**
- **Never commit datasets.** `.gitignore` covers `data/workspaces/`, `data/private/`, `.env` / `.env.*`
  (except `.env.example`), `*.pem`, `node_modules/`, `apps/api/.venv/`, `apps/web/.next/` and the test
  artifacts.
  - It does **not** ignore `*.csv` or `*.xlsx` elsewhere. Keep case files in `data/private/` only.
  - Check with `git status` before every commit.
  - `data/samples/` holds synthetic data and is committed on purpose.
- After changing any Pydantic schema, run `pnpm gen:api` and commit `docs/openapi.json` and
  `apps/web/lib/api/schema.d.ts` with the change.
- Nobody pushes to a remote or submits to the competition platform without the team agreeing first.

## Adding an analysis

1. Copy the template in `apps/api/app/challenge/analyses.py`:
   - A params model with `column_param(kinds=[...])` for column pickers.
   - A function decorated with `@register_analysis("<unique_id>", category="challenge", title=...,
     description=..., params=...)`.
   - Return `ctx.result(...)`, which carries summary, `ctx.table(...)` and `ctx.chart(...)`.
2. Raise `ValidationFailed("...", code="...")` for user-fixable input. Never return invented numbers.
3. Save the file; the dev API reloads. Reload the browser. The analysis appears on `/challenge` and in the
   Analysis Lab with a generated form.
4. Add a pytest next to `apps/api/tests/test_findings_and_extensions.py`. Check at least one number against
   a hand calculation.

`docs/architecture.md` has the full worked example (`value_concentration`).

## Checks

| Check | Command |
| --- | --- |
| API tests (pytest, 58 tests) | `pnpm test:api` (= `cd apps/api && .venv/bin/python -m pytest -q`) |
| Python lint (ruff) | `cd apps/api && .venv/bin/ruff check .` |
| Types (tsc) | `pnpm typecheck` |
| Lint (eslint) | `pnpm lint` |
| Web unit tests (vitest) | `pnpm test:web` |
| Everything above except ruff and E2E | `pnpm check` |
| Browser install, once | `pnpm --filter web e2e:install` (Chromium into `node_modules`, via `PLAYWRIGHT_BROWSERS_PATH=0`) |
| E2E (Playwright, 9 tests) | `pnpm e2e` (the script sets `PLAYWRIGHT_BROWSERS_PATH=0`) |

E2E details:

- It starts its own API on `127.0.0.1:8100`, with a throwaway workspace in `apps/web/e2e/.artifacts/`.
- It runs `next build` and serves the build on `127.0.0.1:3100`.
- **The build writes `apps/web/.next/`**, which the dev server also uses. Do not run `pnpm e2e` while
  someone relies on your running `pnpm dev`; restart the dev server afterwards if pages look stale.

Before merging, run `pnpm check`, plus `pnpm e2e` if the change touches UI flows.

## Design rules

- `DESIGN.md`: colors, typography, layout, components, do's and don'ts. Tokens live in
  `apps/web/app/globals.css`; chart colors in `apps/web/lib/palette.ts`.
- `PRODUCT.md`: users, principles, and constraints. In particular, every number shows its provenance, and
  ATLAS never manufactures conclusions.
