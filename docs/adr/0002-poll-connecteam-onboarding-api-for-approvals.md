# Poll the Connecteam Onboarding API for approvals; no webhook

## Status

accepted

## Context

The initial sync of a person into EH must fire when their Connecteam onboarding
pack is **Approved** by an admin. Connecteam's Users webhook (`user_created`,
`user_updated`) fires on profile-field changes but **not** on onboarding-pack
approval, and the Onboarding API has no webhook of any kind. The Onboarding API
exposes per-assignment `status` (`in_progress` / `completed`) and
`isWaitingApproval` (bool); an approved pack reads as `status: completed`.

## Decision

A Cloudflare Cron trigger (every 1 minute) calls
`GET /onboarding/v1/packs/{packId}/assignments`, diffs each assignment's status
against the last-seen value stored in D1, and enqueues an EH sync for any
assignment that has newly reached `status: completed`. Ongoing edits after
approval are handled separately by the `user_updated` webhook.

## Considered Options

- **Admin-set "Push to EH" toggle** (custom field or smart group) that fires
  `user_updated`: deterministic, but adds a manual step per employee — the double
  handling the project exists to remove.
- **Zapier / Connecteam automation** calling our endpoint on approval: adds a
  third-party dependency and another set of credentials to hand over.

## Consequences

- Initial-sync latency is bounded by the cron interval (~1 min), not instant.
- The Connecteam API rate limit (200/min, 20,000/day) is nowhere near threatened
  by one sweep per minute.
- We depend on the observed meaning of `status: completed` == approved. If
  Connecteam changes that, the trigger breaks silently — covered by an alert if
  the daily approved-count drops to zero unexpectedly.

## Update 2026-09-14

"Ongoing edits after approval are handled separately by the `user_updated`
webhook" (above) was the stated intent from day one, but nothing enforced the
"after" half of it — `runSyncJob` treated every `user_updated` delivery as
sync-worthy regardless of approval state. In practice, Connecteam fires
`user_updated` on every field save, including mid-onboarding, before a pack is
ever submitted for review. Filling out a pack one field at a time therefore ran
a full sync attempt per field — writing partial data to EH and sending a fresh
Correction or Manual-follow-up on nearly every save. Found live while
onboarding a real test employee (~messages per field, extrapolated to ~300
onboarding employees).

Fixed in `runSyncJob` (`src/sync/consumer.ts`): a `profile_update` job now
checks `onboarding_state` (`SyncGateway.hasBeenApproved`) and silently skips -
no EH write, no message, no audit row - unless this person's assignment has
reached `status: completed` at least once. `approval` jobs are never gated:
the sweep enqueuing one *is* the completed-transition signal, and gating it
too would race against the sweep's own `writeState` call for the same tick.
