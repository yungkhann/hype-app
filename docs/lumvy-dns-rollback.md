# lumvy.io — DNS backup and rollback

Saved 2026-11-07, before pointing lumvy.io at the hype-app Cloudflare Tunnel.

## What lumvy.io served before

- Site: Next.js app titled **"Lumvy — put your crew in the clip"** (`x-powered-by: Next.js`).
- Origin server: **136.71.142.236**, proxied through Cloudflare.

## DNS records as they were (zone `lumvy.io`, 11 records)

| Type | Name | Content | Proxy | TTL |
| --- | --- | --- | --- | --- |
| A | `lumvy.io` | `136.71.142.236` | Proxied | Auto |
| CNAME | `www` | `lumvy.io` | Proxied | Auto |
| CNAME | `rsend` | `rsend.forge.rmta.net` | DNS only | 1 hr |
| CNAME | `send` | `send.forge.rmta.net` | DNS only | 1 hr |
| MX | `lumvy.io` | `route3.mx.cloudflare.net` (priority 29) | DNS only | Auto |
| MX | `lumvy.io` | `route2.mx.cloudflare.net` (priority 15) | DNS only | Auto |
| MX | `lumvy.io` | `route1.mx.cloudflare.net` (priority 86) | DNS only | Auto |
| TXT | `cf2024-1._domainkey` | `v=DKIM1; h=sha256; k=rsa; p=…` (Email Routing DKIM) | DNS only | Auto |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | DNS only | Auto |
| TXT | `lumvy.io` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | DNS only | Auto |
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ…` (Resend DKIM) | DNS only | 1 hr |

Only the first record (the `A` for `lumvy.io`) is touched by the switch. Email (MX, SPF, DKIM, DMARC), the
`send`/`rsend` records and `www` stay as they are.

## What the switch changed (done 2026-11-07)

1. Deleted the `A lumvy.io → 136.71.142.236` record.
2. Added `CNAME lumvy.io → bb903b5c-e349-4fea-86c7-87f7a0015273.cfargotunnel.com` (Proxied). The dashboard
   lists it as type **Tunnel → lumvy**.
3. Tunnel **lumvy** (ID `bb903b5c-e349-4fea-86c7-87f7a0015273`) has two routes, both to `http://web:80`:
   `lumvy.io` and `www.lumvy.io`.
4. The `www` DNS record was not touched. It is still `CNAME www → lumvy.io`, so it now reaches the tunnel too.

## Roll back to the old Lumvy site

1. Cloudflare dashboard → **lumvy.io → DNS → Records**.
2. Delete the `lumvy.io` record of type **Tunnel** (content `lumvy`).
3. **Add record**: Type `A`, Name `@` (lumvy.io), IPv4 `136.71.142.236`, Proxy **on** (orange cloud), TTL Auto. Save.
4. Optional: **Networking → Tunnels → lumvy → Routes**, delete the `lumvy.io` and `www.lumvy.io` routes (or
   add one for a subdomain such as `app.lumvy.io` so hype-app stays reachable).
5. Optional: stop the tunnel locally:
   ```bash
   docker compose --profile public stop tunnel
   ```

Check: `https://lumvy.io` shows the "Lumvy — put your crew in the clip" page again (allow a minute for DNS).

The old server at 136.71.142.236 is not touched by any of this. It must still be running for the rollback to work.
