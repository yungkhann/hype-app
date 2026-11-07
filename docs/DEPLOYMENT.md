# Deployment overview

ATLAS CQA runs in production on one Windows 11 PC (Docker Desktop with WSL2) and is published at **https://lumvy.io** through a Cloudflare Tunnel. Every push to `main` is tested and built by GitHub Actions. An agent on the PC picks up the new release within about a minute, switches to it, checks it, and rolls back on failure.

| Read this | When |
| --- | --- |
| [CI_CD.md](CI_CD.md) | How code becomes a deployable release (GitHub Actions, GHCR) |
| [WINDOWS_SETUP.md](WINDOWS_SETUP.md) | Setting up and operating the Windows PC (the deploy agent, backups, rollback) |
| [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) | Publishing the site at lumvy.io, and protecting it with Cloudflare Access |
| [MODEL_INTEGRATION.md](MODEL_INTEGRATION.md) | Connecting the AI evaluation model (Ollama + the model adapter) |

## Architecture

```text
 Developer ── push to main ──> GitHub Actions (GitHub-hosted runners)
                                 ci ─> publish web + api images ─> verify the pushed pair
                                 └─ ghcr.io/yungkhann/hype-app-web:<full commit sha>
                                    ghcr.io/yungkhann/hype-app-api:<full commit sha>
                                                     │
 Windows 11 PC (signed in, Docker Desktop)           │ pull (read-only token)
 ┌───────────────────────────────────────────────────┼───────────────────────────────┐
 │ Task Scheduler ── every minute ──> deploy.ps1 ────┘   asks GitHub: newest successful │
 │                                       │               "Release" run on main?         │
 │                                       ▼                                              │
 │ Docker Compose project "hype-cqa"                                                    │
 │  ┌──────────────────────────────┐  /api/v1/*   ┌──────────────────────────────┐      │
 │  │ web  (Node, static frontend) │ ───────────> │ api  (FastAPI, CQA engine)   │      │
 │  │ 127.0.0.1:3000 -> :3000      │  internal    │ not published (expose 8000)  │      │
 │  └──────────────▲───────────────┘   network    └───────┬──────────────┬───────┘      │
 │                 │                                       │ /data        │ host.docker.internal:<port>
 │                 │                          C:\hype-cqa\data            ▼              │
 │   cloudflared (Windows service)                         model adapter (teammate's) ──> Ollama
 │   origin http://127.0.0.1:3000                          127.0.0.1:<port>             127.0.0.1:11434
 └─────────────────▲────────────────────────────────────────────────────────────────────┘
                   │ outbound-only tunnel
 Visitor ── https://lumvy.io ── Cloudflare (TLS, optional Cloudflare Access login)
```

What runs where:

| Component | Where | Exposure |
| --- | --- | --- |
| `web`: the static frontend (`apps/web`: HTML/CSS/JS, no build step) served by a zero-dependency Node server (`apps/web-server/server.mjs`) that also forwards `/api/v1/*` to the API | Docker | `127.0.0.1:3000` on the PC only, which is the tunnel's origin |
| `api`: FastAPI with the CQA store, scoring engine, evaluation queue | Docker | Not published; reachable only from `web` on the Compose network |
| Ollama + Llama, the teammate's model adapter | Windows, outside Docker | Loopback only (`127.0.0.1`) |
| cloudflared | Windows service | Outbound connection to Cloudflare; no inbound ports |
| Deploy agent (`deploy.ps1`), backups (`backup.ps1`) | Task Scheduler, as the signed-in user | None |

> **Current state of the frontend (important).** The frontend in `apps/web` is self-contained today. It keeps conversations, evaluations and checklist edits in each visitor's browser (`localStorage`), scores in the browser (`js/scoring.js`), and its "Load API" button fetches the organizers' URL directly from the browser. It does **not call `/api/v1` yet**. The CQA API is deployed, tested and reachable at `https://lumvy.io/api/v1/cqa/…` for when the frontend is connected to it. Until then:
> - server-side backups protect the API's data, not work done in a browser;
> - each visitor sees only their own browser's data;
> - the AI model is used only by evaluations started through the API (see [MODEL_INTEGRATION.md](MODEL_INTEGRATION.md)).

**Why the frontend and API share one origin.** The browser only talks to `https://lumvy.io`. `/api/v1/*` is forwarded inside the PC, so the setup needs no CORS, no second hostname and no extra reverse proxy. The forwarder keeps the original `Host` header. The API's host check (`ATLAS_ALLOWED_HOSTS`, the DNS-rebinding guard) therefore accepts `lumvy.io` via `PUBLIC_HOSTNAME`, and its same-origin guard blocks cross-site writes.

**What is forwarded.** By default only `/api/v1/health` and `/api/v1/cqa/*` are forwarded (`API_ALLOWED_PREFIXES`). The data-studio part of the API (`/api/v1/datasets`, `/workspaces`, …) is not reachable from the internet. `API_READ_ONLY=true` additionally refuses every write through the website.

## Release flow

1. A push to `main` starts the **Release** workflow: CI, then building and pushing both images tagged with the full commit SHA, then a verification job. That job pulls exactly those two images, runs them with `compose.prod.yml` and runs the smoke test.
2. The agent on the PC asks GitHub for the newest **successful** Release run on `main`. A run is only successful when all three stages passed, so it is a complete, tested pair of images. In-progress, failed or cancelled runs are never deployed.
3. If that commit is newer than what is running, the agent:
   - pulls both images and checks their commit label;
   - extracts the commit's own `compose.prod.yml` from the API image;
   - stops the API cleanly, snapshots `C:\hype-cqa\data`;
   - runs `docker compose up --wait`;
   - checks the frontend, the API through the proxy and the CQA store at `http://127.0.0.1:3000`.
4. On success it records the release (`state\current.json`, `previous.json`, `history.jsonl`). On failure it starts the previous release again and counts the failure. A failing release is retried after 5 and 10 minutes, then skipped until a newer one appears.

Downtime per update is the API restart, typically 5 to 20 seconds. One PC with one API process cannot do zero-downtime switches. The CQA store keeps all data in one process's memory and must run as a single worker.

## Data

- The API stores everything as JSON files under `/data/cqa` in the container, which is `C:\hype-cqa\data\cqa` on the PC: conversations, checklist versions, evaluations, appeals, imports, audit log. Each file is written atomically (temporary file + rename).
- **Backups:** before every deployment (taken while the API is stopped), and every 6 hours (the API is paused for the copy). Both go to `C:\hype-cqa\backups`, and the last 20 of each kind are kept.
- **Rollback never restores data automatically.** The previous release starts with the current data. Restoring a snapshot is a deliberate manual step ([WINDOWS_SETUP.md](WINDOWS_SETUP.md#restore-data-from-a-backup)).
- Images contain no data, no `.env` files and no secrets. CI checks this on every build with `deployment/check-images.sh`.

## Health

| Check | Healthy means | Affects deploy/rollback |
| --- | --- | --- |
| `GET /healthz` (web) | Node server is up; reports the release SHA | Yes |
| `GET /api/v1/health` through the web server | API process up, proxy works | Yes |
| `GET /api/v1/cqa/conversations?page_size=1` | CQA store loaded | Yes |
| Public host name accepted (`Host: lumvy.io`) | `PUBLIC_HOSTNAME` correct | Warning only |
| Model service reachable | The teammate's adapter answers | **Never.** The site stays up while the model is offline, and evaluations then fail with a readable error. |

`C:\hype-cqa\scripts\healthcheck.ps1` prints all of these, plus the agent's last run, the deployed and previous release, any pin, and Ollama's status.

## Security boundaries

- No inbound ports are opened on the PC. The site is reached only through the outbound Cloudflare Tunnel. Docker publishes only `127.0.0.1:3000`, and the API, Ollama and the model adapter are not published at all.
- **The application has no login.** Anyone who can open lumvy.io can import conversations, edit checklists, run evaluations, file and decide appeals. Put **Cloudflare Access** in front of it ([CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md#protect-the-site-with-cloudflare-access)), or at least set `API_READ_ONLY=true`.
- Tokens on the PC are read-only (GitHub Actions read, GHCR package read). They are stored encrypted with Windows DPAPI in `C:\hype-cqa\secrets`, readable only by that Windows user and SYSTEM, and never written to logs or passed as command-line arguments.
- The organizers' signed source URL (`ATLAS_CQA_SOURCE_URL`) is a secret. It is empty by default on the PC; put it there only deliberately.
- Docker Desktop's "Expose daemon on tcp://localhost:2375 without TLS" must stay **off**.

## Files

| Path | Purpose |
| --- | --- |
| `.github/workflows/ci.yml`, `release.yml` | CI on pull requests; release pipeline on pushes to `main` |
| `Dockerfile.web`, `Dockerfile.api`, `.dockerignore` | Production images (non-root, allowlisted build context) |
| `compose.prod.yml` | The two-service production stack (also shipped inside the API image) |
| `apps/web-server/server.mjs` | Static file server + `/api/v1` forwarder (tests: `server.test.mjs`) |
| `apps/api/requirements.lock` | Exact Python versions used by CI and the image |
| `deployment/smoke_test.py` | End-to-end check used by CI and for manual verification |
| `deployment/check-images.sh` | Fails if an image contains secrets or private data |
| `deployment/.env.example` | Template for `C:\hype-cqa\hype.env` on the PC |
| `deployment/windows/*.ps1`, `HypeCqa.psm1` | Install, deploy agent, rollback, backup, health check, task registration |

## Backend image size and scikit-learn

The API image is about 1 GB unpacked on disk and about 220 MB compressed, which is what GHCR stores and the PC downloads. Its Python environment is 589 MB: pyarrow 155 MB, scipy 118 MB, pandas 86 MB, **scikit-learn 57 MB** (plus threadpoolctl), numpy 68 MB. The CQA part of the API uses none of these heavy libraries. They belong to the API's data-studio endpoints (`/api/v1/datasets`, `/workspaces`, modeling, extensions), which are mounted in the API but **not forwarded to the internet by default** (`API_ALLOWED_PREFIXES`).

**scikit-learn was evaluated for removal (November 2026) and kept.** It is used directly by features that are covered by tests (`tests/test_modeling.py`, `tests/test_findings_and_extensions.py`):

- model training (`app/services/modeling/`): random forest classifier/regressor with impurity-based importances, logistic regression with class weights, linear and ridge regression, dummy baselines, the preprocessing pipeline (imputation, one-hot encoding, scaling), stratified train/test splits, and 13 evaluation metrics (ROC AUC, average precision, confusion matrix, …);
- the stratified split transform (`app/services/preprocessing/transforms.py`);
- clustering (KMeans + silhouette score) and anomaly detection (IsolationForest) in `app/extensions/builtin.py`.

The metrics, splits, linear models and preprocessing could be rewritten exactly with numpy/scipy. The random forests, IsolationForest, KMeans and the logistic-regression solver could not, short of writing and maintaining our own ML algorithms. Those would train far slower and give different numbers than today. A partial rewrite would not remove the package, so it would save nothing. The saving at stake is about 59 MB of the image.

Options that need a product decision, not a technical one:

1. Keep it (current state).
2. Make scikit-learn optional, the way CatBoost already is (`requirements-optional.txt`, models hidden when missing), and leave it out of the production image. Production would then lose modeling, clustering and anomaly detection, which it does not expose by default anyway.
3. If the data studio is no longer part of the product (its frontend was replaced by the CQA frontend), remove the data-studio backend. That would also allow dropping pyarrow, openpyxl and probably pandas/scipy, which saves far more than scikit-learn alone.

## Running the production stack locally

```bash
docker build -f Dockerfile.api -t hype-app-api:local .
docker build -f Dockerfile.web -t hype-app-web:local .
mkdir -p /tmp/cqa-data && chmod 0777 /tmp/cqa-data
: > /tmp/empty.env    # keeps Compose from reading the repository's .env
WEB_IMAGE=hype-app-web:local API_IMAGE=hype-app-api:local HYPE_DATA_DIR=/tmp/cqa-data \
  docker compose -p hype-cqa-local --env-file /tmp/empty.env -f compose.prod.yml up -d --wait
python3 deployment/smoke_test.py --base-url http://127.0.0.1:3000
docker compose -p hype-cqa-local --env-file /tmp/empty.env -f compose.prod.yml down
```

Always pass `--env-file` to Compose in a checkout. Otherwise Compose reads the repository's git-ignored `.env`, which can contain the organizers' signed URL, and prints it in `docker compose config` output.
