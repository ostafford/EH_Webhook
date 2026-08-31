# Deployment runbook — Connecteam → Employment Hero Payroll sync

This integration is **self-hosted**: the client runs it on **their own Cloudflare
account**, one deployment for their business. Everything client-specific is
external config (`wrangler.jsonc` vars, Cloudflare secrets, and
`clients/self/field-map.json`) — **no code changes**.

Glossary terms — **custom publisher**, **alerts channel**, **Correction message**,
**Manual-follow-up notice**, **System alert**, **Onboarding pack**, **Sync** — are
defined in [`../CONTEXT.md`](../CONTEXT.md).

---

## Who does what

| | |
|---|---|
| **Client's technical person** | Runs this document / the wizard. Owns the Cloudflare account and the deployment from then on. |
| **Integrator** | Joins a one-time ~1 hr onboarding call: helps create the Connecteam objects and API keys, watches the wizard run, confirms `/health`. Never holds the client's credentials or deploys for them. |
| **Client's HR / payroll admins** | No setup role. After go-live they action the three message types (see [Operations](#day-to-day-operations)). |

The whole of steps 1–7 is driven by **`scripts/setup-wizard.sh`** — it opens each
page, captures every value, provisions D1 + Queues, pushes the secrets and
deploys. The sections below are the reference the wizard follows; read them once,
then run the wizard.

---

## Prerequisites

**Accounts**

- **Employment Hero Payroll** (AU) with API access, and a **single** employing entity.
- **Connecteam** with the **Onboarding** feature and an **approval step** in the pack.
- A **Cloudflare account on the Workers Paid plan** (~$5/month). Cloudflare
  **Queues** — which the sync pipeline uses — is not available on the free plan.
  D1, Workers and Cron triggers are covered by the free allowances; Queues adds a
  small per-operation cost on top of the $5.

**Assumptions baked into v1**

- Employees enter **APRA** super (USI + member number). SMSF is surfaced as a
  Manual-follow-up notice, not synced.
- Awards / pay rates are already set up in Employment Hero — the sync never sets them.
- Onboarding-pack approval is a real step (the initial Sync fires when a pack
  first reaches `status: completed`).

**Local tools** (on the machine doing the deploy)

- Node 20+ and npm
- `git`, `curl`
- `npx wrangler` (installed automatically by `npm install`)

---

## 1. Get the code

```bash
git clone <this-repo> eh-webhook
cd eh-webhook
npm install
```

One clone = one client. The deployment loads `clients/self/field-map.json`
automatically; `FIELD_MAP_CLIENT` is left blank. (The `clients/` folder and
`src/mapping/registry.ts` only matter if you ever run several clients from one
deployment.)

---

## 2. Connecteam setup

The Worker cannot create these — a human makes them in the Connecteam UI and the
wizard captures the IDs. The integrator usually drives this part of the call.

### 2a. API key
Settings → API. Create a key with **read** on users + onboarding and **write** on
chat. → **`CT_API_KEY`** (Cloudflare secret).

### 2b. Custom publisher — *the sender of every message*
Settings → Feed settings → create a custom publisher named e.g. **"EH Sync"**.
Note its **publisher ID**.

- **What it is:** a named non-human sender that the Connecteam chat API can post as.
- **What it's for:** the sync sends three kinds of message — the **Correction
  message** to an employee, and the **Manual-follow-up notice** + **System alert**
  to the alerts channel — and *all three* are sent as this one publisher, so they
  read as "from the payroll sync", not from a colleague.
- **Why this way:** the chat API can only post as a real user or a custom
  publisher. A custom publisher means no staff member's name is attached to
  automated payroll messages, and the sender can't leave the company.

→ **`CT_CUSTOM_PUBLISHER_ID`** (`wrangler.jsonc` var).

### 2c. Alerts channel — *where admin-facing messages go*
Chat → create a channel named e.g. **"EH Sync Alerts"**. Add the payroll admins
who should action alerts. The wizard lists channels via `GET /chat/v1/conversations`
so you can pick its ID.

- **What it is:** a normal Connecteam chat channel.
- **What it's for:** it receives the **Manual-follow-up notice** (data synced but
  a payroll admin must finish something by hand — non-resident tax scale, SMSF
  super, `INTERNATIONAL` address) and the **System alert** (a Sync that
  dead-lettered — Employment Hero outage, auth failure, a bug). The **Correction
  message** does *not* come here — it goes straight to the employee who entered
  the bad data, and to their **Direct manager** on the third failed attempt in a row.
- **Why a channel, not per-admin DMs:** admins join or leave the channel in the
  Connecteam UI with no config change and no redeploy. A DM list would have to
  live in config and be edited every time the payroll team changes.

→ **`ADMIN_CONNECTEAM_CHANNEL_ID`** (`wrangler.jsonc` var).

### 2d. Onboarding pack
The pack employees complete. The wizard lists packs via `GET /onboarding/v1/packs`.
→ **`CT_ONBOARDING_PACK_ID`** (`wrangler.jsonc` var).

### 2e. Webhook secret
The wizard generates a random 32-byte hex string. The same value is given to
Connecteam when the webhook is registered (step 5). → **`CT_WEBHOOK_SECRET`**
(Cloudflare secret).

---

## 3. Employment Hero Payroll setup

1. Create an API key → **`EH_API_KEY`** (Cloudflare secret).
2. **Disable the employee self-setup email** for the business (Payroll settings →
   employee onboarding). The sync creates and completes the record via the API;
   the setup email would confuse employees.
3. The structural IDs are discovered for you in the next step:
   - `businessId` — `GET /api/v2/business` → **`EH_BUSINESS_ID`**
   - pay schedule ID — `GET /business/{id}/payschedule` → **`EH_PAY_SCHEDULE_ID`**
   - location ID — `GET /business/{id}/location` → **`EH_LOCATION_ID`**

---

## 4. Field map

The wizard runs this; here is what it does.

```bash
npm run discover -- --client self
```

Reads the client's Connecteam custom-field **names** and the Employment Hero
structural IDs, then writes:

- **`clients/self/field-map.json`** — a schema-checked draft mapping (overwrites
  the placeholder that ships in the repo).
- **stdout** — a configuration checklist: every var and secret with the
  discovered value or a `TODO` and where to find it.

It writes field **names** and IDs only — never an employee value.

**Then tune the draft.** Open `clients/self/field-map.json` and:

- Check **every** mapped `customFieldId` against the client's real fields.
- Resolve any `TODO` (usually the super field IDs and `EH_*` IDs).
- Confirm the enum `map`s match the client's dropdown option text — `gender`,
  `residentialState` (incl. `INTERNATIONAL`), `employmentType`.

`npm test` fails fast on an invalid map.

---

## 5. Cloudflare deploy

The wizard does all of this. Manual equivalent:

```bash
# Log in to the CLIENT's account
npx wrangler login
npx wrangler whoami          # confirm it's the right account

# Provision (one D1 database, two queues)
npx wrangler d1 create eh-webhook
#   → put the returned database_id into wrangler.jsonc  d1_databases[0].database_id
npx wrangler d1 migrations apply eh-webhook --remote
npx wrangler queues create eh-webhook-sync
npx wrangler queues create eh-webhook-dlq

# Secrets
npx wrangler secret put CT_API_KEY
npx wrangler secret put EH_API_KEY
npx wrangler secret put CT_WEBHOOK_SECRET

# Vars — set in wrangler.jsonc "vars" (leave FIELD_MAP_CLIENT blank):
#   EH_BUSINESS_ID, EH_PAY_SCHEDULE_ID, EH_LOCATION_ID,
#   CT_ONBOARDING_PACK_ID, CT_CUSTOM_PUBLISHER_ID, ADMIN_CONNECTEAM_CHANNEL_ID

# Verify, then deploy
npm run typecheck && npm test
npx wrangler deploy
curl https://<worker>.workers.dev/health
```

The Worker's URL is a free `*.workers.dev` address by default — nothing to set
up. To serve it from the client's own domain instead, add a route / custom domain
in `wrangler.jsonc` (needs the domain on Cloudflare); the webhook URL in step 5
changes accordingly.

`/health` must return **`200`** with `d1: "ok"` and `fieldMap: "ok"`.
`config.fieldMapClient` should read `"self"`. The `ops` block is explained in
[Operations](#day-to-day-operations).

---

## 6. Register the Connecteam webhook

Needs the deployed URL, so it comes after deploy. Register a webhook for the
**`users`** feature pointing at `https://<worker>.workers.dev/webhook`, with the
**`CT_WEBHOOK_SECRET`** from step 2e — via the Connecteam UI or
`POST /settings/v1/webhooks`.

> **First real delivery — confirm the signature scheme.**
> `src/connecteam/signature.ts` `DEFAULT_SCHEME` assumes a lowercase-hex
> HMAC-SHA256 of the raw body in the `x-connecteam-signature` header. If the first
> real delivery is rejected (`401`), capture that delivery's headers + body and
> adjust `DEFAULT_SCHEME` — the verify logic and the route don't change.

---

## 7. Verify & go live

| Path | Test | Expected |
|---|---|---|
| Approval | Approve a test employee's Onboarding pack | They appear in Employment Hero within ~1 min (the sweep runs every minute) |
| Edit | Change that employee's Connecteam profile | Their EH record updates |
| Correction | Enter a deliberately bad BSB | The employee gets a **Correction message** from the custom publisher |
| Follow-up | Set a test employee to non-resident | A **Manual-follow-up notice** appears in the **alerts channel**; the Sync still completes |

**Go live:** existing approved employees flow in over the next few minutes via the
sweep, throttled (~20/minute). Watch `/health` and the alerts channel.

---

## 8. Grant the integrator scoped Cloudflare access (recommended)

So the integrator can diagnose and fix problems on the client's deployment
without a screen-share every time.

1. Cloudflare dashboard → **Manage Account → Members → Invite**.
2. Invite the integrator's Cloudflare email.
3. Role: **Workers Admin** (or a custom role limited to Workers Scripts, D1,
   Queues and Logs — nothing account-wide).
4. The client can change the role or **remove the member** at any time from the
   same page. It is the client's grant, not the integrator's ownership.

Without this, the only support routes are a screen-share or the client running
`scripts/update.sh` under instruction.

---

## 9. Optional: integrator telemetry

Off by default. When set, the Worker also sends the integrator a copy of each
**System alert** (deduped to once per employee per hour) and a once-a-day
`/health` summary, so the integrator learns about a problem before the client emails.

- `INTEGRATOR_ALERT_URL` (`wrangler.jsonc` var) — a URL the integrator controls
  (a relay that opens a GitHub issue / sends an email / posts to a channel).
- `INTEGRATOR_ALERT_SECRET` (Cloudflare secret) — sent as `x-eh-sync-secret` so
  the relay can reject anything else.

The payload is **ids, outcomes and counts only** — `{ kind: "system_alert",
ctUserId, reason, at }` or `{ kind: "health", ok, d1, fieldMap, ops, at }` — and
is passed through `src/redact.ts` regardless. Leave both blank to disable.

---

## Day-to-day operations

### Monitoring — `GET /health`

| Field | Meaning | Watch for |
|---|---|---|
| `d1`, `fieldMap` | core config | anything other than `ok` |
| `ops.queueBacklog` | Sync jobs sent but not yet acked or dead-lettered | a number that only grows |
| `ops.deadLettered` | jobs that exhausted their retries | anything `> 0` |
| `ops.lastSweepOkAt` | ISO time the approval sweep last completed cleanly | more than a few minutes stale |

Full request / queue / sweep detail is in the Cloudflare **Workers Logs** for the
Worker — one JSON line per event, every line passed through `src/redact.ts` first.

### The three message types — who acts

| Message | Recipient | Action |
|---|---|---|
| **Correction message** | the employee (DM); + Direct manager on the 3rd failed attempt in a row | the employee fixes the named field(s) in Connecteam; their next edit re-syncs automatically |
| **Manual-follow-up notice** | alerts channel | a payroll admin finishes the item in EH by hand — foreign / working-holiday-maker tax scale, add the SMSF, enter the overseas address |
| **System alert** | alerts channel | check Employment Hero API status / credentials; once fixed, replay the dead-lettered job |

### Replaying a dead-lettered job
A message on `eh-webhook-dlq` has already raised a System alert. After fixing the
cause, re-drive it with `wrangler queues`, or just re-trigger the source edit in
Connecteam (approve/re-approve the pack, or edit the profile). Nothing
auto-retries a dead-lettered job.

### Rotating keys
`npx wrangler secret put CT_API_KEY` / `EH_API_KEY` / `CT_WEBHOOK_SECRET` with the
new value, then rotate the far side. `CT_WEBHOOK_SECRET` must be updated on the
Connecteam webhook registration at the same time.

---

## Updating the deployment

```bash
./scripts/update.sh
```

`git pull` → `npm ci` → `npm test` → `wrangler d1 migrations apply --remote` →
`wrangler deploy` → `/health` check. Fails loudly on any step. Run by the client's
IT, or by the integrator on a support call. A non-technical owner should not run
this unaided.

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
| integrator telemetry | ids, outcomes, counts only (see §9); redacted regardless |

---

## Appendix A — Porting to a non-Cloudflare host

v1 is Cloudflare-only. The Worker binds directly to four Cloudflare primitives; a
port replaces each:

| Cloudflare primitive | Used for | Port target needs |
|---|---|---|
| **Workers** | the HTTP handler + `queue()` + `scheduled()` handlers | any serverless runtime with an HTTP entrypoint, a queue consumer hook, and a cron hook |
| **D1** (SQLite) | `employee_map`, `onboarding_state`, `sync_log`, `sync_meta` | any SQL database; rewrite `src/db/store.ts` (drizzle) and the `migrations/` runner |
| **Queues** | the Sync pipeline: retry, backoff, dead-letter → System alert | a managed queue (SQS, QStash, Pub/Sub) with a DLQ, or the "D1 job table drained by cron" pattern discussed during design |
| **Cron Triggers** (`* * * * *`) | the 1-minute approval sweep | any 1-minute scheduler |

`src/sync/consumer.ts` (`runSyncJob`, `handleDeadLetter`), `src/sync/*`,
`src/mapping/*`, `src/eh/*`, `src/connecteam/*` and `src/webhook/*` are
platform-agnostic and carry over unchanged — only `src/index.ts`, `src/db/store.ts`,
`wrangler.jsonc` and the test harness are Cloudflare-shaped. Estimate a
multi-week effort; there is no client demand for it yet.
