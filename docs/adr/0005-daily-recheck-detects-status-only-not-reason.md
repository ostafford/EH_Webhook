# The daily recheck detects the Incomplete->Complete transition, not a changed reason

## Status

accepted

## Context

Between the sweep enqueuing an approval and an employee's next Connecteam
profile edit, the integration never looks at an employee again (issue #43). A
record EH marks `Incomplete` for an admin-only reason (pay-run defaults,
award, ...) raises one Manual-follow-up notice and then goes quiet — even
after a payroll admin finishes the setup by hand in EH, nothing tells the
integration, `sync_log`, or the admin channel that it's done.

The natural read-only check is `GET
.../employee/unstructured/externalid/{id}` (`EhPayrollClient.getByExternalId`).
Confirmed against the live API (`docs/eh-complete-criteria.md`, issue #45):
this endpoint returns `status` (`"Complete"` / `"Incomplete"`) on the employee
record, but **not** `detailedStatus` — the short reason phrase
(`"Pay Run Defaults are incomplete"` etc.) only comes back on the **POST/PUT
write envelope**, never on a plain read. `decide.ts`'s follow_up-vs-correction
routing, and the "did the reason-set change" dedupe both key off
`detailedStatus`.

So a read-only recheck can tell **whether** a record is still Incomplete, but
not **why** — and the acceptance criteria are explicit that the recheck "makes
no EH writes". There is no read-only way to fetch a fresh reason phrase.

## Decision

`src/cron/recheck.ts` only acts on the `status` transition:

- `Incomplete -> anything else`: the follow-up resolved. Write a `resolved`
  `sync_log` row, flip `employee_map.last_outcome` off `follow_up` (so the row
  drops out of the next recheck), and post a one-line resolved notice to the
  admin channel.
- Still `Incomplete`: do nothing. No new notice, no state change. Detecting a
  *changed* admin reason (e.g. pay-run now fixed but award still missing)
  needs `detailedStatus`, which needs a write — that stays the job of the next
  real sync (a profile edit or a fresh approval), same as before this pass
  existed.

`employee_map` gains `last_outcome` (migration 0004, backfilled from the
latest `sync_log` row per employee) so the pass can list every follow-up
employee with one query instead of scanning `sync_log`. The pass runs once a
day (`RECHECK_INTERVAL_MS`, gated by a `sync_meta` marker, same pattern as the
existing integrator health push) from inside the 1-minute `scheduled` handler,
and only when that tick's approval sweep wasn't itself under Connecteam rate
pressure — the sweep's own budget takes priority.

## Considered options

- **Re-run `applyFieldMap` + `upsertByExternalId` to get a fresh
  `detailedStatus`**: rejected outright — the acceptance criteria require the
  recheck to make no EH writes, and re-sending a payload the employee hasn't
  touched risks re-triggering pay-run validation on data an admin is mid-way
  through fixing.
- **Cache the last `detailedStatus` on `employee_map` and diff status alone
  against it**: doesn't help — without a fresh read of the reason, a cached
  value can only ever go stale, never confirm whether the *same* admin gap is
  still open.
- **Have the recheck also re-post a follow-up when still Incomplete, on a time
  window**: rejected. The existing 12h notice dedupe (`notices.ts`) exists to
  stop an edit *burst* from spamming, not to gate a daily reminder — on a 24h
  recheck cadence the window always elapses, so this would repost an unchanged
  notice every day, which the issue explicitly asks the recheck to avoid.

## Consequences

- The recheck is a strict subset of what the issue sketched: it detects
  resolution, not a changed-but-still-incomplete reason. That gap is
  unavoidable given `getByExternalId`'s response shape, not a scope cut.
- `sync_log.outcome` and `employee_map.last_outcome` gain a `resolved` value.
  No `sync_meta` dedupe-marker cleanup is needed for this pass specifically —
  it never posts a follow-up notice itself, only a one-time resolved notice
  keyed by the state transition, not a reason hash.
- `RecheckGateway` (`src/sync/gateway.ts`) is a separate, narrower interface
  from `SyncGateway` rather than an addition to it, so `listFollowUpLinks`
  doesn't force every existing fake `SyncGateway` in the consumer tests to
  grow a new method.
