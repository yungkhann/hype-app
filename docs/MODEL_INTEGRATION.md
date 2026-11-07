# Connecting the AI evaluation model in production

The model (Ollama + Llama) and the teammate's **model adapter** run on the Windows PC, outside Docker. ATLAS calls the adapter over HTTP. ATLAS never calls Ollama directly and never ships, downloads or modifies model weights.

```text
api container ── POST EvaluationRequest ──> http://host.docker.internal:<PORT>/<path>
                                              │  (= the Windows PC itself)
                                              ▼
                                   model adapter, listening on 127.0.0.1:<PORT>
                                              │
                                              ▼
                                   Ollama, 127.0.0.1:11434 ── Llama
```

The request/response format is the **`cqa-eval/1` contract**: [cqa-model-contract.md](cqa-model-contract.md), with JSON Schemas and a worked example in [`docs/cqa-contract/`](cqa-contract/). In short:

- ATLAS sends one conversation plus one checklist version. The model answers every criterion (yes/no, a scale point or an option, or N/A), with transcript evidence and a short explanation.
- **The model never computes the score.** ATLAS validates the answers strictly and computes all points, weights and penalties itself. A wrong or partial answer fails that one evaluation with a readable error; it never produces a silent score.

> The current frontend (`apps/web`) evaluates in the browser and does not call the API yet (see [DEPLOYMENT.md](DEPLOYMENT.md#architecture)). The model is used by evaluations started through the CQA API (`POST /api/v1/cqa/evaluations`). Those are what the steps below enable and test.

## Settings (`C:\hype-cqa\hype.env`)

| Setting | Value | Notes |
| --- | --- | --- |
| `ATLAS_CQA_EVALUATOR` | `http` | Default evaluator for new evaluations. `mock` = the development mock, which is not AI and is labelled as such in results. |
| `ATLAS_CQA_EVALUATOR_URL` | `http://host.docker.internal:<PORT>/<path>` | The adapter's evaluate endpoint, e.g. `http://host.docker.internal:9000/evaluate`. **The port is whatever the adapter uses; nothing is hard-coded.** Inside a container, `host.docker.internal` is the Windows PC. |
| `ATLAS_CQA_EVALUATOR_TIMEOUT_S` | `180` | Seconds per conversation. Raise it if long transcripts on this GPU take longer. The first request after Ollama loads the model is the slowest. |
| `ATLAS_CQA_EVALUATION_WORKERS` | `1` | Conversations evaluated in parallel. One GPU usually serves one request at a time; more workers only queue at Ollama and risk timeouts. |
| `MODEL_HEALTH_URL` | optional | A cheap URL `healthcheck.ps1` probes instead of the evaluate URL, e.g. `http://host.docker.internal:9000/health`. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Only for the informational Ollama line in `healthcheck.ps1`. |

The adapter URL must point at this PC. `host.docker.internal`, `localhost` and `127.0.0.1` are accepted. Any other host is refused unless `ATLAS_CQA_EVALUATOR_ALLOW_REMOTE=true` is set (in `C:\hype-cqa\api.env`), so transcripts never leave the PC by accident. Don't set that without the project owner's approval.

After changing `hype.env`, redeploy the current release so the API picks the settings up:

```powershell
cd C:\hype-cqa\scripts
.\deploy.ps1 -Sha (Get-Content ..\state\current.json | ConvertFrom-Json).sha -NoPin
```

## Network rules on the PC

- **Ollama stays on loopback.** Its default is `127.0.0.1:11434`. Do not set `OLLAMA_HOST=0.0.0.0`, which would expose Ollama to the local network without authentication.
- **The adapter listens on `127.0.0.1:<PORT>`**, not `0.0.0.0`.
- Docker Desktop forwards `host.docker.internal` connections from containers to services on the PC. This was verified with an adapter bound to `127.0.0.1` on Docker Desktop for **Mac**. **On Windows, confirm it:** run `healthcheck.ps1` and look at **"Model (from Docker)"**. "HTTP … (reachable)" means it works. Any HTTP status counts, because it shows something answered.
- If "Model (from Windows)" is reachable but "Model (from Docker)" is not, the adapter's address isn't reachable from Docker's virtual network. Talk to the project owner before changing anything. The fallback is to bind the adapter to `0.0.0.0` **and** allow its port only on the WSL/Docker virtual adapter. Windows Firewall blocks inbound connections from the LAN by default; don't click "Allow" for the adapter on private or public networks.

  ```powershell
  # run as administrator; replace 9000 with the adapter's port
  New-NetFirewallRule -DisplayName "ATLAS model adapter (Docker only)" -Direction Inbound -Protocol TCP -LocalPort 9000 `
      -InterfaceAlias "vEthernet (WSL*)" -Action Allow
  ```

- Never forward the adapter's or Ollama's port on the router, and never route them through Cloudflare.

## What happens when the model is down

| Situation | Result |
| --- | --- |
| Adapter not running / port closed | That evaluation fails with `evaluator_unreachable` ("the model service is not reachable"). The website and API stay healthy. |
| Adapter too slow | Fails with `evaluator_timeout` after `ATLAS_CQA_EVALUATOR_TIMEOUT_S`. |
| Adapter returns non-2xx | `evaluator_http_error` with the status code. |
| Adapter returns something that isn't JSON or breaks the contract | `evaluator_invalid_json` / a validation error naming the field. |
| `ATLAS_CQA_EVALUATOR=http` but no URL | `evaluator_not_configured`; the evaluator shows as unavailable in the API's evaluator list. |

Each conversation in a batch fails or succeeds on its own. Earlier results stay viewable. Re-running is a new evaluation, so nothing is overwritten. The deployment health checks deliberately **do not** include the model: a model outage never triggers a rollback or marks the site unhealthy.

## Test the connection

1. Adapter and Ollama running. `healthcheck.ps1` shows "Model (from Windows)" and "Model (from Docker)" as reachable, and Ollama's version.
2. Run one evaluation through the API from the PC. PowerShell:

   ```powershell
   $base = 'http://127.0.0.1:3000/api/v1/cqa'
   $conv = (Invoke-RestMethod "$base/conversations?page_size=1").items[0].id    # import FIXTURE data first if empty
   $checklist = (Invoke-RestMethod -Method Post "$base/checklists/dev-sample").id   # the development checklist
   $body = @{ conversation_ids = @($conv); checklist_id = $checklist; adapter = 'http' } | ConvertTo-Json
   $batch = Invoke-RestMethod -Method Post "$base/evaluations" -ContentType 'application/json' -Body $body
   $batch
   ```

   Then open the evaluation (`GET $base/evaluations/<id>`): `status` becomes `completed` with answers and a score, or `failed` with one of the errors above. `GET $base/evaluations/<id>/request` shows the exact request that was sent to the model. Field names follow [docs/openapi.json](openapi.json).
3. The teammate can test the adapter without ATLAS by posting `docs/cqa-contract/example-request.json` to it and comparing the answer with `docs/cqa-contract/schema.json` (`output_schema`). See "Testing a model against ATLAS" in [cqa-model-contract.md](cqa-model-contract.md#testing-a-model-against-atlas).

## Notes for the adapter

- Start it automatically with Windows, e.g. a Task Scheduler task at sign-in, like the deploy agent. It is the teammate's component; ATLAS does not start it.
- Keep Ollama's model loaded between requests (Ollama's keep-alive setting) to avoid a slow first request after idle periods.
- Answer quickly to a `GET` on a health path if possible, and set `MODEL_HEALTH_URL` to it.
