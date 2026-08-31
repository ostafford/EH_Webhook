# Deployment runbook — Connecteam → EH Payroll sync

One deployment serves **one client**. Everything client-specific is external config
(vars, secrets, and `clients/<slug>/field-map.json`) — **no code changes**. Follow
this document top to bottom for a fresh client.

Glossary terms (**custom publisher**, **alerts channel**, **Correction message**,
**Manual-follow-up notice**, **System alert**, **Onboarding pack**) are defined in
[`../CONTEXT.md`](../CONTEXT.md). Companion: [`PLAN.md`](./PLAN.md) §5.

> **Scripts.** `scripts/setup-wizard.sh` walks the whole of §1–§8 interactively —
> it opens each page, captures the values, provisions D1 + Queues, pushes the
> secrets and deploys. The steps below are the reference it follows. After
> go-live, `scripts/update.sh` pulls, re-tests, migrates and redeploys.
> _(A full rewrite of this runbook for the self-host model is tracked in #21.)_

---

## 0. Prerequisites (confirm with the client before starting)

- Employment Hero **Payroll** (AU) with API access, and a **single** employing entity.
- Connecteam with the **Onboarding** feature and an **approval step** in the pack.
- Employees enter APRA super (USI + member number). SMSF is handled by a
  Manual-follow-up notice, not synced.
- Awards / pay rates are already configured in Employment Hero — the sync does not set them.
- A Cloudflare account with Workers, Queues and D1.

---

## 1. Connecteam setup (client does this in the Connecteam UI + gives you the values)

The Worker cannot create these; the client creates them by hand and hands you the IDs.

### 1a. API key
Settings → API. Create a key with read access to users + onboarding and write
access to chat. This becomes the **`CT_API_KEY`** secret.

### 1b. Custom publisher — *the sender of every message*
Settings → Feed settings → create a custom publisher named e.g. **"EH Sync"**.
Note its **publisher ID**.

- **What it is:** a named non-human sender that the chat API posts as.
- **What it's for:** the sync sends three kinds of message — the **Correction
  message** to an employee, the **Manual-follow-up notice** and the **System
  alert** to the alerts channel — and *all three* are sent as this one publisher,
  so messages are clearly "from the payroll sync", not from a person.
- **Why this way:** the Connecteam chat API can only post as a real user or a
  custom publisher. A custom publisher means no staff member's name is attached
  to automated payroll messages, and the sender never leaves the company.

→ **`CT_CUSTOM_PUBLISHER_ID`** var.

### 1c. Alerts channel — *where admin-facing messages go*
Chat → create a channel named e.g. **"EH Sync Alerts"**. Add the payroll admins
who should action alerts. Get its conversation ID from
`GET /chat/v1/conversations`.

- **What it is:** a normal Connecteam chat channel.
- **What it's for:** it receives the **Manual-follow-up notice** (data synced but
  a payroll admin must finish something by hand — non-resident tax scale, SMSF
  super, INTERNATIONAL address) and the **System alert** (a sync that
  dead-lettered — EH outage, auth failure, a bug). The **Correction message**
  does *not* go here — it goes directly to the employee who entered the bad data
  (and, on the third failed attempt in a row, also to their direct manager).
- **Why a channel and not per-admin DMs:** admins are added to or removed from the
  channel in the Connecteam UI, with no config change and no redeploy. A DM list
  would have to live in config and be edited every time the payroll team changes.

→ **`ADMIN_CONNECTEAM_CHANNEL_ID`** var.

### 1d. Onboarding pack ID
`GET /onboarding/v1/packs` → the pack employees complete. → **`CT_ONBOARDING_PACK_ID`** var.

### 1e. Webhook secret
Generate a random string (e.g. `openssl rand -hex 32`). You will give this same
value to Connecteam when you register the webhook in step 8. → **`CT_WEBHOOK_SECRET`** secret.

> The webhook itself is registered **after** deploy (step 8) because it needs the
> Worker's live URL.

---

## 2. Employment Hero Payroll setup

1. Create an API key → **`EH_API_KEY`** secret.
2. **Disable the employee self-setup email** for the business (Payroll settings →
   employee onboarding). The sync creates and completes the employee record via
   the API; the setup email would confuse employees.
3. Record the structural IDs (step 4 fetches these for you):
   - `businessId` — `GET /api/v2/business` → **`EH_BUSINESS_ID`**
   - pay schedule ID — `GET /business/{id}/payschedule` → **`EH_PAY_SCHEDULE_ID`**
   - location ID — `GET /business/{id}/location` → **`EH_LOCATION_ID`**

---

## 3–5. Field map

### 3. Put both API keys in `.dev.vars`
```
CT_API_KEY=...
EH_API_KEY=...
```
(Optionally also `EH_BUSINESS_ID=` and `CT_ONBOARDING_PACK_ID=` to skip the pickers.)

### 4. Run the discovery helper
```
npm run discover -- --client <slug>
```
This reads the client's Connecteam custom-field **names** and Employment Hero
structural IDs and writes:
- `clients/<slug>/field-map.json` — a **draft** mapping (schema-checked).
- stdout — a **configuration checklist**: every var and secret with the
  discovered value or a `TODO` and where to find it.

It writes field **names** and IDs only — never an employee value.

### 5. Register the client and tune the field map
1. Add the client to [`../src/mapping/registry.ts`](../src/mapping/registry.ts):
   an `import` of `clients/<slug>/field-map.json` and one entry in `FIELD_MAPS`.
2. Open `clients/<slug>/field-map.json` and check **every** mapped `customFieldId`
   against the client's real fields. Resolve any `TODO`. Confirm the enum `map`s
   (gender, `residentialState` INTERNATIONAL, `employmentType`) match the
   client's dropdown option text.
3. `npm test` — the field-map loader tests will fail fast on an invalid map.

---

## 6. Cloudflare setup

```bash
# D1
wrangler d1 create eh-webhook-<slug>
# → put the returned database_id into wrangler.jsonc d1_databases[0].database_id
wrangler d1 migrations apply eh-webhook-<slug> --remote

# Queues
wrangler queues create eh-webhook-sync
wrangler queues create eh-webhook-dlq

# Secrets
wrangler secret put CT_API_KEY
wrangler secret put EH_API_KEY
wrangler secret put CT_WEBHOOK_SECRET

# Vars: set these in wrangler.jsonc "vars"
#   FIELD_MAP_CLIENT, EH_BUSINESS_ID, EH_PAY_SCHEDULE_ID, EH_LOCATION_ID,
#   CT_ONBOARDING_PACK_ID, CT_CUSTOM_PUBLISHER_ID, ADMIN_CONNECTEAM_CHANNEL_ID
```

Set a route or custom domain for the Worker in `wrangler.jsonc`.

Verify the build before deploying:
```
npm run typecheck && npm test
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy --dry-run --outdir /tmp/x
```

---

## 7. Deploy

```
npm run deploy
curl https://<worker-domain>/health
```

`/health` must return `200` with `d1: "ok"` and `fieldMap: "ok"`. `config.fieldMapClient`
must be your `<slug>`. See §10 for the `ops` block.

---

## 8. Register the Connecteam webhook (needs the live URL)

Register a webhook for the **`users`** feature pointing at
`https://<worker-domain>/webhook`, with the **`CT_WEBHOOK_SECRET`** from step 1e,
either via `POST /settings/v1/webhooks` or the Connecteam UI.

> **First real delivery:** confirm the signature scheme. `src/connecteam/signature.ts`
> `DEFAULT_SCHEME` assumes a lowercase-hex HMAC-SHA256 of the raw body in the
> `x-connecteam-signature` header. If a real delivery is rejected, capture one
> delivery's headers + body and adjust `DEFAULT_SCHEME` — nothing else changes.

---

## 9. Verify & go live

1. **Approval path:** approve one test employee's Onboarding pack → within ~1
   minute they appear in Employment Hero (the cron sweep runs every minute).
2. **Edit path:** change that employee's Connecteam profile → their EH record updates.
3. **Correction path:** enter a deliberately bad BSB → the employee gets a
   Correction message from the custom publisher.
4. **Follow-up path:** set a test employee to non-resident → a Manual-follow-up
   notice appears in the alerts channel; the sync still completes.
5. **Go live:** existing approved employees flow in over the next few minutes via
   the sweep, throttled (~20 per minute). Watch `/health` and the alerts channel.

---

## 10. Day-to-day operations

### Monitoring — `GET /health`
| Field | Meaning | Watch for |
|---|---|---|
| `d1`, `fieldMap` | core config | anything other than `ok` |
| `ops.queueBacklog` | sync jobs sent but not yet acked or dead-lettered | a number that only grows |
| `ops.deadLettered` | jobs that exhausted their retries | anything `> 0` |
| `ops.lastSweepOkAt` | ISO time the approval sweep last completed cleanly | more than a few minutes stale |

Full request/queue/sweep detail is in Workers observability logs (one JSON line
per event; every line is passed through `src/redact.ts` first).

### The three message types — who acts
| Message | Recipient | Action |
|---|---|---|
| **Correction message** | the employee (DM); + direct manager on the 3rd failed attempt | the employee fixes the named field(s) in Connecteam; the next edit re-syncs automatically |
| **Manual-follow-up notice** | alerts channel | a payroll admin finishes the item in EH by hand (foreign/WHM tax scale, add SMSF, enter overseas address) |
| **System alert** | alerts channel | check EH API status / credentials; replay the dead-lettered job once the cause is fixed |

### Replaying a dead-lettered job
A job on `eh-webhook-dlq` has already raised a System alert. After fixing the
cause, re-drive it with `wrangler queues` (or re-trigger the source edit in
Connecteam). Nothing auto-retries a dead-lettered job.

### Rotating keys
`wrangler secret put CT_API_KEY` / `EH_API_KEY` / `CT_WEBHOOK_SECRET` with the new
value, then rotate the far side. `CT_WEBHOOK_SECRET` must be changed on the
Connecteam webhook registration at the same time.

---

## What is never stored or logged

No employee value — tax file number, bank BSB / account number / name, super
member number — is ever written to D1 or to a log:

| Sink | Holds |
|---|---|
| `employee_map` | Connecteam userId ↔ EH employee id, timestamps, failure-cycle count, a payload **hash** |
| `onboarding_state` | assignment id, userId, status, `isWaitingApproval`, seen-at |
| `sync_log` | userId, time, outcome, and a `detail` string of field **NAMES** + status only |
| `sync_meta` | counters and a "last sweep ok" timestamp |
| `console` logs | routed through `src/redact.ts`, which drops anything under a sensitive key |
