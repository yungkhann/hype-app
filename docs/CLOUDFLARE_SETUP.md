# Publishing at lumvy.io with Cloudflare Tunnel

The PC opens an **outbound** connection to Cloudflare (cloudflared), and Cloudflare serves `https://lumvy.io` through it. No router port forwarding, no inbound firewall rule, and no public IP are needed. TLS is handled by Cloudflare.

```text
Browser ──HTTPS──> Cloudflare edge (lumvy.io) ──tunnel──> cloudflared on the PC ──HTTP──> 127.0.0.1:3000 (web container)
```

Only the web container is the origin. The API, Ollama and the model adapter are never routed through the tunnel.

> These steps change the project's Cloudflare account and DNS. Whoever owns the Cloudflare account (the project owner) does them or approves them. Nothing in this repository changes Cloudflare automatically.

## Before you start

- The domain **lumvy.io must be an active zone in the Cloudflare account** (nameservers pointing to Cloudflare).
- **Check existing DNS records first:** Cloudflare dashboard → lumvy.io → DNS → Records. If `lumvy.io` (the apex, shown as `@`/`lumvy.io`) already has an A, AAAA or CNAME record, that record serves something today, maybe another website. Creating the tunnel route will fail or would replace it. **Do not delete it without the owner deciding to.** If the apex must stay as it is, publish the app on a subdomain instead (e.g. `cqa.lumvy.io`). In that case use that name everywhere below and set `PUBLIC_HOSTNAME=cqa.lumvy.io` in `C:\hype-cqa\hype.env`.
- The site already works on the PC: `http://127.0.0.1:3000` opens the app. See [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

## 1. Create the tunnel (Cloudflare dashboard)

1. Go to **Cloudflare One / Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, and name it e.g. `hype-cqa-pc`.
2. On "Install and run a connector", choose **Windows**. Cloudflare shows an install command containing a **tunnel token**. That token lets anyone run your tunnel: treat it like a password, and don't paste it into chats, tickets or files.

## 2. Install cloudflared on the PC

1. Download the official cloudflared Windows installer from the link on that page (Cloudflare's own download, `cloudflared-windows-amd64.msi`) and install it.
2. Open **Command Prompt as administrator** and run the command from the dashboard:

   ```bat
   cloudflared.exe service install <TOKEN FROM THE DASHBOARD>
   ```

   This installs cloudflared as a Windows **service**. It starts with Windows (no sign-in needed for the tunnel itself) and reconnects by itself.
3. Back in the dashboard, the connector shows as **Healthy** within a few seconds.

## 3. Route lumvy.io to the PC

In the tunnel → **Public Hostname** (named **Published application routes** in newer dashboards) → **Add**:

| Field | Value |
| --- | --- |
| Subdomain | *(empty)* for `lumvy.io`, or e.g. `cqa` |
| Domain | `lumvy.io` |
| Path | *(empty)* |
| Service type | `HTTP` |
| URL | **`127.0.0.1:3000`**. Use the IP, not `localhost`: on Windows `localhost` may resolve to IPv6 `::1`, and Docker publishes only on `127.0.0.1`. If you changed `WEB_PORT` in `hype.env`, use that port. |

Save. Cloudflare creates a proxied DNS record `lumvy.io → <tunnel id>.cfargotunnel.com`.

Leave the "Additional application settings" at their defaults. In particular, leave the HTTP Host Header empty: the app checks that the Host is the public name.

## 4. Check

- `https://lumvy.io` opens the app; `https://lumvy.io/healthz` shows `{"status":"ok","service":"web","release":"<sha>"}`.
- On the PC, `C:\hype-cqa\scripts\healthcheck.ps1` shows "Public host name … accepted by the API" and "Through Cloudflare … ok". If Access is enabled, it shows the Access login status instead.

## Protect the site with Cloudflare Access

**The application has no login of its own.** Without protection, anyone on the internet who finds lumvy.io can:

- read every conversation imported through the API (call transcripts: customer personal data);
- import conversations, create and change checklist versions, file appeals and decide them (the audit log records what happened, not who did it);
- start evaluations, which run the AI model on the PC's GPU and can keep the PC busy (denial of service);
- use the "Load API" feature of the frontend in their own browser.

Strongly recommended: put **Cloudflare Access** (free for up to 50 users) in front of the whole site, so only listed people get in.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Application name `ATLAS CQA`. Domain: `lumvy.io` (or your subdomain), path empty, so the whole site including `/api/v1/*` is covered.
3. Session duration: e.g. 24 hours.
4. Policy: **Action: Allow**. Include: **Emails**, listing the team members' email addresses (or **Emails ending in** `@yourcompany.com`).
5. Login method: **One-time PIN** (an email code, which needs no identity provider) or a configured provider such as Google or GitHub.
6. Save. Visiting lumvy.io now shows a Cloudflare login page first.

The API is served on the same origin as the pages, so the Access session cookie also covers API calls made from the site. No app changes are needed.

Additional, optional hardening:

- `API_READ_ONLY=true` in `hype.env` makes the website refuse all API writes (only reading works). Use it for a public demo without Access.
- A **rate limiting rule** for `/api/v1/` (Security → WAF → Rate limiting rules).
- Keep **Always Use HTTPS** on (SSL/TLS → Edge Certificates).

## Cloudflare limits that matter here

| Limit (Free plan) | Effect |
| --- | --- |
| Request body ≤ 100 MB | Uploads larger than that are rejected by Cloudflare. CQA requests are small. |
| Origin must start answering within 100 s (else HTTP 524) | Evaluations run in the background (the API answers `202` immediately), so they are not affected. An import from the organizers' API waits up to 60 s for the source (`ATLAS_CQA_SOURCE_TIMEOUT_S`), which stays within the limit. |
| Caching | The web server sends `Cache-Control: no-cache` with ETags, so browsers and Cloudflare revalidate and a new release is visible immediately. Don't add "Cache Everything" rules. |

Leave **Rocket Loader** off: it rewrites script loading, and the frontend uses ES modules.

## Troubleshooting

| Error at lumvy.io | Meaning / fix |
| --- | --- |
| **1033** (Argo Tunnel error) | cloudflared is not connected. On the PC: Services → "Cloudflared agent" → Running? Is the PC on and online? |
| **502 Bad Gateway** | The tunnel works but nothing answers at the origin. Is `http://127.0.0.1:3000` working on the PC? Is the route URL exactly `127.0.0.1:3000` with type HTTP? |
| **400 "Host not allowed"** on actions, while pages load | `PUBLIC_HOSTNAME` in `hype.env` doesn't match the public host name. Fix it, then redeploy ([WINDOWS_SETUP.md](WINDOWS_SETUP.md#change-settings)). |
| **403 "forbidden_origin"** | A cross-site request was blocked by the API's same-origin guard. Requests must come from pages served by the site itself. |
| **524** | The origin took longer than 100 s. Report which action caused it. |

## Removing the tunnel

Dashboard → Networks → Tunnels → `hype-cqa-pc` → Delete (this also offers to remove the DNS record). On the PC, in Command Prompt as administrator: `cloudflared.exe service uninstall`.
