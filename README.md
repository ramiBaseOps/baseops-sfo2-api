# baseops-sfo2-api

Backend for the Salsa Fever On2 promo funnel. Runs on Railway (project `energetic-comfort`,
service `baseops-sfo2-api`, US East). Pushing to `main` redeploys it.

It replaced n8n Cloud, which could not reach Paragon from its London egress. See
`../Paragon_Connectivity_Blocker.md` for that history.

> **Credentials go in Railway environment variables, never in this repo.** `.env` is
> gitignored. `.env.example` lists every variable with notes.

---

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /lead` | Landing-page form. Validates, issues `SFO2-XXXXXX`, writes the Airtable row, emails the studio and the student, mints a Paragon token and returns `payment_url` |
| `POST /resume` | Resumes a registration from `?ref=` in the student's email link, reusing the existing row |
| `POST /paragon-callback` | Paragon transaction callback. Basic auth via `CALLBACK_USER` / `CALLBACK_PASS`. Marks the row paid, sends the welcome email and SMS, notifies the studio |
| `GET /` or `/healthz` | Which settings are present (names only, never values), pricing, next class |
| `GET /selftest` | Live check of Resend, Airtable and Twilio. Read-only: sends nothing, writes nothing |
| `GET /probe` | Paragon connectivity probe (egress IP and country, TLS, token endpoint) |
| `GET /preview/registration-email`, `/preview/welcome-email` | Renders a student email with sample data. Add `?format=text` for the plain-text version |

## Email

All mail goes out through **Resend's HTTP API** from `MAIL_FROM`
(`Salsa Fever On2 <info@baseops.tech>`). `baseops.tech` is verified in Resend, so the
`info@` mailbox does not need to exist.

| Email | To |
|---|---|
| New lead notification | each address in `LEAD_TO`, one message per address |
| Registration email ("one step left") | the student |
| Welcome email on payment | the student |
| Payment notification | each address in `LEAD_TO` |

Student replies go to `STUDIO_REPLY_TO`.

There is **no SMTP path**. Railway blocks outbound 465 and 587, and the `baseops.tech`
mailboxes moved from Zoho to Google Workspace in September 2026. The SMTP code and the
nodemailer dependency were removed on 2026-09-29. `SMTP_USER` and `SMTP_PASS` in Railway are
no longer read.

Sending does not depend on the mailbox host. It relies on these DNS records staying in place
when DNS is edited:

- `resend._domainkey.baseops.tech` — Resend's DKIM key
- `send.baseops.tech` — Resend's sending subdomain (SPF and bounce handling)
- `_dmarc.baseops.tech` — currently `p=none`

## Operating notes

- **`CHARGE_PRICE`** makes the card charge differ from the advertised `OFFER_PRICE`. It is only
  for trialling the production payment path. While it differs, startup logs, `/healthz` and
  every payment notification flag it.
- **Paragon stage amounts are response triggers, not prices.** See
  `../Paragon_HPP_Integration_Notes.md` §7.
- `CLASS_SCHEDULE`, studio phone numbers and links live in environment variables, so they can be
  changed without a deploy.

## Deploy

Push to `main`. Railway builds with Node 20 and runs `npm start`. After a deploy, check the
startup line in the logs:

```
email=resend from=Salsa Fever On2 <info@baseops.tech> recipients=2 airtable=configured
```
