# Windows PC setup and operations

For the person running the production PC. Allow about 30 minutes, most of it waiting for the first image download. Nothing here needs administrator rights except installing Docker Desktop and cloudflared, if they are not installed yet.

Everything lives in **`C:\hype-cqa`**:

| Folder / file | What it is |
| --- | --- |
| `hype.env` | Settings (copied from `deployment\.env.example`). The only file you normally edit. |
| `api.env` | Optional extra `ATLAS_*` settings for the API container (create it only if told to). |
| `scripts\` | The deploy agent and tools (`deploy.ps1`, `rollback.ps1`, `healthcheck.ps1`, `backup.ps1`, …) |
| `data\` | **The application's data.** Never delete. |
| `backups\` | Data snapshots (before every update, and every 6 hours) |
| `logs\` | `deploy-YYYYMMDD.log`, `backup-YYYYMMDD.log` (kept 14 days) |
| `state\` | What is deployed (`current.json`, `previous.json`, `history.jsonl`), failures, pin, heartbeat |
| `secrets\` | The two GitHub tokens, encrypted for your Windows user only |

## 1. Requirements

- **Windows 11, one Windows user account that stays signed in.** The deploy agent and Docker Desktop run in that user's session. Locking the screen is fine. **Signing out stops the site.**
- **Power:** Settings → System → Power: *Screen* can turn off, but set **Sleep: Never** (when plugged in).
- **After a reboot** (e.g. Windows Update) someone must sign in again before the site comes back. Windows can sign in automatically, but that weakens the PC's security. Decide this deliberately with the project owner.
- **Docker Desktop** (WSL 2 backend), version with Docker Compose 2.24 or newer. In Docker Desktop → Settings:
  - General: **Start Docker Desktop when you sign in to your computer**: on. **Use the WSL 2 based engine**: on.
  - General: **Expose daemon on tcp://localhost:2375 without TLS**: **off** (must stay off).
  - Resources: at least 4 GB memory for Docker.
- Ollama and the teammate's model adapter, if the AI model should be used. See [MODEL_INTEGRATION.md](MODEL_INTEGRATION.md).
- cloudflared, for the public site. See [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md).

## 2. Get the deployment files

You need the repository's `deployment` folder (`deployment\.env.example` and `deployment\windows\*`). Either:

- clone the repository (if your GitHub account has access), or
- get a ZIP of the repository from the project owner and extract it, e.g. to `C:\Users\<you>\Downloads\hype-app`.

You only need these files once. Afterwards the agent updates the application by itself.

## 3. Run the installer

Open **Windows PowerShell** (normal, not "Run as administrator") **as the user that stays signed in**:

```powershell
cd C:\Users\<you>\Downloads\hype-app\deployment\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

1. Checks Docker Desktop (engine running, Compose version, autostart setting).
2. Creates `C:\hype-cqa\…` and copies the scripts to `C:\hype-cqa\scripts`.
3. Creates `C:\hype-cqa\hype.env` and opens it in Notepad. Check at least:
   - `PUBLIC_HOSTNAME=lumvy.io`
   - `WEB_PORT=3000` (change only if port 3000 is taken; then also change the Cloudflare origin)
   - the model settings (leave `ATLAS_CQA_EVALUATOR=mock` until the model is set up)
   - `ATLAS_CQA_SOURCE_URL` stays empty unless the project owner gives you the value.

   Save and close Notepad to continue.
4. Asks for the **two tokens** from the project owner (input is hidden):
   - Token 1: GitHub API (fine-grained, Actions read-only)
   - Token 2: GHCR pull (classic, `read:packages`)

   They are stored encrypted with Windows DPAPI in `C:\hype-cqa\secrets`, and that folder is restricted to your user and SYSTEM. Do not save the tokens anywhere else.
5. Tests both tokens.
6. Registers two scheduled tasks and runs the first deployment, then the health check:
   - **HypeCQA-Deploy**: every minute and at sign-in
   - **HypeCQA-Backup**: every 6 hours
7. Checks that the scheduled task really runs on its own. It starts PowerShell without a window. If that launcher doesn't work on this PC, it switches to a hidden PowerShell window automatically.

If there is no successful release on GitHub yet, the first deployment simply waits. The agent deploys the first release as soon as it exists.

**Check:** open <http://127.0.0.1:3000> on the PC. The ATLAS CQA app should load.

## 4. Daily operations

All commands run in Windows PowerShell:

```powershell
cd C:\hype-cqa\scripts
.\healthcheck.ps1                         # full status: agent, release, containers, site, API, model, Ollama
Get-Content ..\logs\deploy-$(Get-Date -Format yyyyMMdd).log -Tail 50
```

| Situation | What happens / what to do |
| --- | --- |
| New release on GitHub | Deployed automatically within about a minute. The site is briefly unavailable (5 to 20 s) while the API restarts. |
| New release is broken | The agent detects the failed health check, starts the previous release again and logs why. It retries after 5 and 10 minutes, then waits for a newer release. Nothing to do; tell the project owner. |
| PC rebooted | Sign in. Docker Desktop starts and the containers come back on their own. The agent also restarts them if needed. |
| GitHub or the internet is down | The site keeps running the current release. The agent logs the problem once per 30 minutes and retries every minute. |
| Model / Ollama is down | The site stays up. Evaluations fail with a clear message until the model is back. |
| Docker Desktop not running | The agent starts it. If it does not come up, start Docker Desktop yourself. |

### Roll back to the previous version

```powershell
.\rollback.ps1                     # back to the previous release
.\rollback.ps1 -Sha <full sha>     # or to a specific earlier release (see ..\state\history.jsonl)
```

This changes only the application version. The data stays as it is. Automatic updates are then **paused** (pinned) so the agent doesn't immediately reinstall the newer version, and the release you left is marked as bad. To resume:

```powershell
.\deploy.ps1 -Unpin                # the agent deploys the newest release again (if it is not the bad one)
```

### Deploy one exact version

```powershell
.\deploy.ps1 -Sha 0123456789abcdef0123456789abcdef01234567    # must be a successful Release run on main
.\deploy.ps1 -Sha <sha> -Force                                 # skip that check (only if the project owner asks)
.\deploy.ps1 -Unpin                                            # resume automatic updates later
```

### Pause / resume automatic updates without changing anything

```powershell
Disable-ScheduledTask -TaskName HypeCQA-Deploy
Enable-ScheduledTask  -TaskName HypeCQA-Deploy
```

### Backups

- Taken automatically before every update and every 6 hours. The last 20 of each kind are kept in `C:\hype-cqa\backups\<date>-<time>-<predeploy|periodic>-<release>`.
- Take one by hand: `.\backup.ps1`
- Copy `C:\hype-cqa\backups` (or `data`) to another disk now and then. A backup on the same disk does not survive a disk failure.

### Restore data from a backup

Only when the project owner asks, e.g. after data was damaged. This replaces the current data, which is kept aside, not deleted.

```powershell
Disable-ScheduledTask -TaskName HypeCQA-Deploy
docker stop hype-cqa-api-1
Rename-Item C:\hype-cqa\data ("data-before-restore-" + (Get-Date -Format yyyyMMdd-HHmmss))
robocopy C:\hype-cqa\backups\<snapshot folder> C:\hype-cqa\data /E
docker start hype-cqa-api-1
Enable-ScheduledTask -TaskName HypeCQA-Deploy
.\healthcheck.ps1
```

A `predeploy-<release>` snapshot contains the data exactly as release `<release>` left it. If an older application version cannot read data written by a newer one (its health check fails after a rollback), restore the `predeploy` snapshot named after that older release, i.e. the one taken just before the newer release was installed.

### Replace expired tokens

```powershell
cd C:\Users\<you>\Downloads\hype-app\deployment\windows      # or C:\hype-cqa\scripts
powershell -ExecutionPolicy Bypass -File .\install.ps1 -SetTokens
```

### Change settings

Edit `C:\hype-cqa\hype.env`. Settings take effect at the next deployment. To apply them now, redeploy the current release:

```powershell
.\deploy.ps1 -Sha (Get-Content ..\state\current.json | ConvertFrom-Json).sha -NoPin
```

### Uninstall

```powershell
.\register-task.ps1 -Unregister
docker rm -f hype-cqa-web-1 hype-cqa-api-1     # stops and removes the containers; C:\hype-cqa\data stays
docker network rm hype-cqa_default
```

Delete `C:\hype-cqa` only after the data has been copied somewhere safe.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `healthcheck.ps1`: "Agent last ran … ago" is old | Task Scheduler → Task Scheduler Library → HypeCQA-Deploy → History / Last Run Result. Run `.\register-task.ps1` again. |
| "Missing secret" in the log | Run `install.ps1 -SetTokens`. The tokens are bound to the Windows user that ran the installer, so run it as the same user that the tasks run as. |
| "docker login … failed" | Token 2 expired or lacks `read:packages`, or `GHCR_USERNAME` is wrong. |
| "GitHub API request failed (401/403/404)" | Token 1 expired, or it does not have Actions: Read-only on `yungkhann/hype-app`. |
| Site works on the PC but lumvy.io shows a Cloudflare error | See [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md#troubleshooting). |
| Pages load but every action fails with "Host not allowed" / 400 | `PUBLIC_HOSTNAME` in `hype.env` must be the exact public host (`lumvy.io`); then redeploy (see *Change settings*). |
| A release keeps failing | `healthcheck.ps1` lists it under "Failed release". The log contains the container logs of the failed attempt. |
| Disk full | `docker system df`. Old release images are removed automatically (current, previous and the last 3 are kept). Old backups: delete the oldest folders in `C:\hype-cqa\backups`, never `data`. |
