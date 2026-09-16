# baseops-sfo2-api

Backend for the Salsa Fever On2 promo funnel, hosted on Railway.

**Phase 1 (current): a connectivity probe.** Everything below describes it. If the probe passes,
this same service grows into the real backend and the probe code is replaced:

| Endpoint | Purpose | Status |
|---|---|---|
| `GET /` | connectivity probe | **live** |
| `POST /lead` | lead → Zoho email + Airtable row, issues `SFO2-XXXXXX` | planned, replaces n8n |
| `POST /paragon-token` | mints a Paragon `SecureToken` server-side | planned, blocked on this probe |
| `POST /paragon-callback` | receives Paragon's transaction callback | planned |

> **Credentials go in Railway environment variables — never in this repo.** `.env` is
> gitignored. The n8n setup we are replacing kept the Paragon username and password inside a
> workflow file that exported to disk in plaintext; do not recreate that.

---

## Phase 1 — the probe

Answers one question: **can a US-region Railway service reach Paragon's API?**

n8n Cloud could not — it egressed from London (`9.223.34.63`) and Paragon's edge reset every
connection, including plain unauthenticated GETs. Paragon's own support attributed this to
"IP's that route outside the US." Railway lets you choose a region; n8n Cloud does not.

## Deploy

1. Railway → your project → **New** → **Empty Service**
2. **Settings → Region → a US region** *(do this before the first deploy — region is what the
   whole test turns on)*
3. Deploy this folder. Either:
   - `railway up` from inside `railway-probe/`, or
   - push it to a repo and point the service at it
4. **Settings → Networking → Generate Domain**
5. Open the URL

No environment variables, no credentials, no dependencies.

## Reading the result

The response opens with a `verdict` block:

```json
{
  "verdict": {
    "egress_ip": "…",
    "egress_country": "US",
    "tls_version": "TLS 1.3",
    "paragon_reachable": true
  }
}
```

| `egress_country` | `paragon_reachable` | What it means |
|---|---|---|
| US | **true** | **Solved.** Move the token mint to Railway. No extra cost. |
| US | false | Paragon runs an **allow-list**, not a geo filter. Needs Railway **Pro** (~$20/mo) for static outbound IPs, then ask Paragon to allow-list the three IPv4s. |
| not US | either | Region didn't apply. Check Settings → Region and redeploy. |

`paragon_token_endpoint` returning **HTTP 500 with `"Invalid Credentials."` is a pass**, not a
failure. It means the request reached their application instead of being dropped at the edge.
The credentials in the probe are deliberately fake.

## After you have the answer

Delete the service. It has no ongoing purpose, and it holds a public URL that runs outbound
requests on every hit.

## Context

- `../Paragon_Connectivity_Blocker.md` — the full diagnosis and what has been ruled out
- Static outbound IPs are **Pro plan only**: https://docs.railway.com/networking/static-outbound-ips
- IPs are tied to the service's region, and change if the region changes
