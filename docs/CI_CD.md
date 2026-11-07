# CI/CD

Two GitHub Actions workflows, GitHub-hosted runners only (`ubuntu-24.04`). There is no self-hosted runner, and GitHub never connects to the Windows PC. The PC pulls.

## Workflows

### `CI` (`.github/workflows/ci.yml`)

Runs on every pull request to `main`, can be started by hand (**Actions → CI → Run workflow**), and runs as the first stage of every release.

| Job | What it checks |
| --- | --- |
| **Backend** | `ruff check` and the full `pytest` suite in `apps/api` (scoring engine, evaluator contract, HTTP model adapter, persistence, workflow, data studio). Dependencies are installed with `-c requirements.lock`, the same versions as the production image. |
| **Web** | `node --test apps/web-server/server.test.mjs`: static serving, the `/api/v1` forwarder, range requests, streaming, path allowlist. Also a syntax check of every frontend module (`apps/web/js/*.js`). The frontend is plain HTML/CSS/JS with no build step, lint or type-check setup to run. |
| **End-to-end** (pull requests and manual runs) | Builds both images and scans them for secrets (`deployment/check-images.sh`). Starts them with `compose.prod.yml`, then runs `deployment/smoke_test.py`, which covers: frontend, health, import, conversation list and detail, checklist edit (new version), evaluation, appeal, reviewer decision, audit trail, and an evaluation with the model **offline** that fails cleanly while the API stays healthy. It runs the same flow as `Host: lumvy.io` over HTTPS headers, then checks the data survives an API restart and recreating the containers. |

No real model and no Ollama run in CI. Evaluations use the development mock, and the "model offline" case uses an HTTP adapter pointed at a closed port.

### `Release` (`.github/workflows/release.yml`)

Runs on every push to `main` (including merges of pull requests).

```text
ci (backend + web)  ──>  publish web  ─┐
                         publish api  ─┴─>  verify the published pair
```

1. **ci**: calls `ci.yml` (backend and web jobs; its end-to-end job is replaced by **verify** below).
2. **publish** (matrix web/api, `packages: write`): builds `linux/amd64` images and pushes them:
   - `ghcr.io/yungkhann/hype-app-web:<full 40-character commit SHA>`
   - `ghcr.io/yungkhann/hype-app-api:<full 40-character commit SHA>`

   Labels: `org.opencontainers.image.source` (links the package to the repository) and `org.opencontainers.image.revision` (the commit). The build argument `RELEASE_SHA` makes the running app report its commit (`/healthz`). No `latest` or other moving tag is pushed.
3. **verify** (`packages: read`): pulls both images **by that SHA** and checks their revision labels, scans them for secrets, runs them together with `compose.prod.yml` and the smoke test, restarts the API and checks persistence. It then writes a "Deployable release" summary on the run page.

**Definition of a deployable release:** a Release workflow run on `main`, triggered by `push`, with conclusion `success`. Such a run exists only if CI passed, both images were pushed under the same SHA, and the pushed pair worked together. The Windows agent queries exactly this (`GET /repos/yungkhann/hype-app/actions/workflows/release.yml/runs?branch=main&event=push&status=success`) and deploys the newest one. It also re-checks the event, branch, repository, workflow file and SHA format on its side, and never moves to an older run number on its own.

**Concurrency:** releases run one at a time (`release-refs/heads/main`, not cancelled). If several pushes arrive while one runs, GitHub keeps only the newest pending run. The skipped intermediate commits are simply never deployed. CI on pull requests cancels superseded runs of the same PR.

**Permissions:** the workflow default is `contents: read`. Only the publish job gets `packages: write`, using the per-run `GITHUB_TOKEN`; no personal tokens or other secrets are stored in the repository. Caches: pip (setup-python) and Docker layers (`type=gha`, per image).

## One-time GitHub setup (repository owner)

1. **Enable Actions:** repository **Settings → Actions → General**: allow actions (at least GitHub-authored and verified creators: `actions/*`, `docker/*`). **Workflow permissions:** "Read repository contents and packages permissions" is enough; the publish job requests `packages: write` itself.
2. **First release:** merge the branch containing these files into `main` (or push to `main`). The first Release run creates the two container packages under your account.
3. **Packages:** packages created by a workflow are **private** and linked to `yungkhann/hype-app`. Keep them private. Check **Your profile → Packages → hype-app-web / hype-app-api → Package settings**:
   - "Manage Actions access" lists `hype-app` (normally automatic for the repository that created the package).
   - The account whose token the PC uses can read the package (it is yours if you create the token).
4. **Branch protection (recommended):** **Settings → Branches → Add rule for `main`**: require a pull request and the status checks "Backend (ruff, pytest)", "Web (server tests, frontend syntax)" and "End-to-end (Docker images + Compose stack)". Then nothing untested reaches `main`, and every push to `main` already passed the full end-to-end test once.

## Tokens for the Windows PC

The PC needs two **read-only** tokens. GitHub Packages does not accept fine-grained tokens, which is why there are two.

| Token | Type | Scope | Used for |
| --- | --- | --- | --- |
| 1. GitHub API | Fine-grained personal access token | Repository access: **only `yungkhann/hype-app`**. Permissions: **Actions: Read-only** (Metadata: Read-only is added automatically). Nothing else. | Listing successful Release runs |
| 2. GHCR pull | Classic personal access token | **`read:packages` only** | `docker login ghcr.io` and pulling the two images |

Create both under the account that owns the packages (`yungkhann`), with an expiry such as 90 days, named e.g. "hype-cqa PC: actions read" / "hype-cqa PC: ghcr pull". A classic `read:packages` token can read every package that account can read. That is GitHub's smallest available scope for this, and another reason to keep it only on that PC.

Hand them to the person setting up the PC over a private channel. `install.ps1` asks for them with hidden input and stores them encrypted. They are never written to files in plain text, never passed on a command line and never logged. To rotate: create new tokens, run `install.ps1 -SetTokens` on the PC, then delete the old tokens on GitHub.

## Everyday use

| Want to | Do |
| --- | --- |
| Ship a change | Merge to `main`. Watch **Actions → Release**. About a minute after it turns green, the PC runs it (`healthcheck.ps1` shows the deployed SHA, and so does `https://lumvy.io/healthz`). |
| Not ship a commit | Don't merge it. Every successful Release on `main` is deployed automatically. |
| Re-run a flaky release | **Re-run failed jobs** on the run. A run that turns successful is picked up like any other. |
| Go back to an earlier version | On the PC, run `rollback.ps1` (previous release) or `rollback.ps1 -Sha <sha>`. This pauses automatic updates until `deploy.ps1 -Unpin`. Alternatively revert on `main`, and the revert becomes a new release. |
| Deploy a specific commit | On the PC, run `deploy.ps1 -Sha <full sha>`. It must be a successful Release run; `-Force` skips that check. It pins too. |
| See what is running | Run `healthcheck.ps1` on the PC, or open `https://lumvy.io/healthz` (`"release": "<sha>"`). |

## Running the checks locally

```bash
# backend
cd apps/api && .venv/bin/python -m pytest -q && .venv/bin/ruff check .
# web server + frontend syntax
node --test apps/web-server/server.test.mjs
for f in apps/web/js/*.js; do node --input-type=module --check < "$f"; done
# end-to-end: see "Running the production stack locally" in DEPLOYMENT.md
```

Updating Python dependencies: change `apps/api/requirements.txt`, install into a fresh Python 3.14 virtualenv, run the tests, then regenerate the lock with `pip freeze` (see the header of `apps/api/requirements.lock`).
