#!/usr/bin/env bash
# Creates the milestone issues M0-M8 in the GitHub repo from docs/PLAN.md.
#
# Prereq: GitHub CLI installed and authenticated:
#   brew install gh && gh auth login
#
# Run once:
#   ./scripts/create-issues.sh
#
# Safe to re-run: it skips any milestone whose issue title already exists.

set -euo pipefail
REPO="ostafford/EH_Webhook"

command -v gh >/dev/null || { echo "gh not found - run: brew install gh && gh auth login"; exit 1; }

ensure_label () {
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" 2>/dev/null || true
}
ensure_label "milestone"      "1D76DB" "A build milestone from docs/PLAN.md"
ensure_label "mapping"        "5319E7" "Field mapping / transforms"
ensure_label "integration"    "0E8A16" "Talks to Connecteam or Employment Hero"
ensure_label "infra"          "B60205" "Cloudflare / wrangler / CI"
ensure_label "handover"       "FBCA04" "Client-facing docs & packaging"

existing () { gh issue list --repo "$REPO" --state all --search "in:title \"$1\"" --json title --jq '.[].title' | grep -qxF "$1"; }

make () {
  local title="$1"; shift
  local labels="$1"; shift
  local body="$1"; shift
  if existing "$title"; then echo "skip  $title (exists)"; return; fi
  gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body" >/dev/null
  echo "created  $title"
}

make "M0: Skeleton & CI" "milestone,infra" \
"**Goal:** deployable skeleton with a test harness and CI.

**Tasks**
- Wrangler project; D1 binding + first migration; Queue (producer + consumer); cron entry; \`GET /health\`.
- Vitest with \`@cloudflare/vitest-pool-workers\`.
- CI: run unit tests on every push.

**Exit:** \`wrangler dev\` serves \`/health\`; test suite green in CI.

Ref: docs/PLAN.md §4."

make "M1: Field mapping (pure, no network)" "milestone,mapping" \
"**Goal:** a validated field-map + one Connecteam user -> an Employment Hero payload, with per-field issues.

**Tasks**
- [x] field-map JSON schema + fail-fast loader.
- [x] transforms: DD/MM/YYYY->ISO, phone->E.164, dropdown read, location street-line, zero-pad BSB(6)/postcode(4), TFN digits (keep leading zeros).
- [x] \`applyFieldMap\`: payload + issues, no throws.
- [ ] tax-declaration rules (tax-free threshold / residency / HELP-STSL) -> EH tax fields.
- [ ] APRA-vs-SMSF super branch (USI present -> APRA; ABN only -> SMSF -> skip + manual-follow-up).
- [ ] manual-follow-up detection (non-resident, WHM, SMSF, INTERNATIONAL address).
- [ ] assemble the full unstructured-employee payload incl. \`payScheduleId\` / \`locationId\` / allocation / postal-same-as-residential.

**Tests:** table-driven with synthetic PII (check-digit-valid fake TFNs/BSBs); golden EH payloads; unverified EH enums behind constants.

**Exit:** realistic CT user -> correct EH payload; bad/missing fields -> typed issues.

Ref: docs/PLAN.md §4. Partially done on \`feat/scaffold-and-field-mapping\`."

make "M2: Employment Hero Payroll client" "milestone,integration" \
"**Goal:** typed client for the EH Payroll unstructured-employee API, tested against the real test business.

**Tasks**
- \`upsert\` (POST unstructured), \`getByExternalId\`, read-back compare (non-sensitive fields + status only).
- Classify responses: 200 ok / 422 -> parsed \`{field, reason}\` / 5xx-network -> retryable.

**Tests:** integration tests create/update/fetch a \`ZZZ_TEST_*\` employee in the test business, delete in teardown. Never touch pay runs.

**Exit:** create a synthetic employee end-to-end; a bad BSB comes back as parsed \`{field, reason}\`.

Ref: docs/PLAN.md §4. Needs production/test EH API key."

make "M3: Connecteam client" "milestone,integration" \
"**Goal:** typed client for the Connecteam APIs we use.

**Tasks**
- \`getUser\`, \`listOnboardingAssignments\`, \`sendCustomPublisherDM\`, \`sendChannelMessage\`.
- Inbound webhook signature verification (\`secretKey\` HMAC - confirm scheme).

**Tests:** recorded-fixture contract tests; one live read-only smoke test + a DM to self.

**Exit:** read an assignment list, resolve a user, post a chat message as the custom publisher.

Ref: docs/PLAN.md §4. Needs production Connecteam API key."

make "M4: Sync decision, messages & failure cycles" "milestone,mapping" \
"**Goal:** turn a sync result into the right message to the right recipient.

**Tasks**
- \`decide\`: result -> \`ok | correction(field[]) | follow_up(reason) | retry\`.
- Curated EH-error -> plain-language map + generic fallback; 3 message templates.
- Failure-cycle counter (D1): 1-2 -> employee, 3 -> + Direct manager; reset on success.
- Manual-follow-up triggers: non-resident, WHM, SMSF, INTERNATIONAL address.

**Tests:** state-machine unit tests; message snapshots.

**Exit:** each result class -> correct message + recipient.

Ref: docs/PLAN.md §4."

make "M5: Queue consumer wiring" "milestone,infra" \
"**Goal:** the end-to-end sync worker.

**Tasks**
- Consumer: load map -> resolve externalId (D1 -> EH by-externalId -> email) -> apply -> upsert -> read-back -> decide -> act -> update D1 (\`last_synced_ts\`, audit).
- Retry/backoff config; DLQ handler -> System alert.
- Idempotency guard (skip unchanged; drop stale \`eventTimestamp\`).

**Tests:** consumer integration tests with a fake queue; replay / out-of-order / duplicate.

**Exit:** enqueue a CT user -> EH employee appears; re-enqueue same -> no-op.

Ref: docs/PLAN.md §4."

make "M6: Cron approval sweep" "milestone,integration" \
"**Goal:** detect newly-approved onboarding packs and enqueue them.

**Tasks**
- Poll assignments, diff \`status\` vs D1, enqueue new \`completed\`, persist state.
- Back off on Connecteam \`x-ratelimit-*\`.
- First-run picks up all currently-\`completed\` packs, throttled.

**Tests:** diff logic - new approval, re-approval, un-approve->re-approve, no change.

**Exit:** approving a pack in the account -> EH create within ~1 min.

Ref: docs/PLAN.md §4 and ADR-0002."

make "M7: Inbound webhook path" "milestone,integration" \
"**Goal:** accept Connecteam \`user_updated\` and enqueue it.

**Tasks**
- \`POST /webhook\`: verify signature -> 200 fast -> enqueue. Reject unsigned/malformed.

**Tests:** signature pass/fail; malformed payload; response < 50 ms.

**Exit:** editing an approved user's profile in Connecteam updates EH.

Ref: docs/PLAN.md §4."

make "M8: Hardening & handover" "milestone,handover" \
"**Goal:** a clean deploy from the runbook alone, no code edits.

**Tasks**
- \`redact.ts\` enforced on all logging; audit log = field names + status only.
- \`/health\` shows queue depth, DLQ depth, last successful sweep.
- Productise \`npm run discover\`.
- Write \`docs/RUNBOOK.md\`; dry-run a fresh deployment against a second throwaway config.

**Exit:** fresh deploy from runbook only.

Ref: docs/PLAN.md §4 and §5."

echo "done."
