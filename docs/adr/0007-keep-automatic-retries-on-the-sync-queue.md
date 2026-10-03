# Keep automatic retries on the sync queue: every write is idempotent or claimed

## Status

accepted

## Context

`wrangler.jsonc` gives the `eh-webhook-sync` consumer `max_retries: 5`, with a
dead-letter queue that raises a **System alert**. The integration playbook
(`../CLAUDE.md`, "Never auto-retry a non-idempotent write") says a consumer that
writes third-party data should use `max_retries: 0` and tell a human instead:
a queue retry re-runs the whole message, so after a partial failure it can
write the same records twice.

A Sync job is retried in two ways:

1. **It asks for one.** `runSyncJob` returns `status: "retry"` when Connecteam
   or Employment Hero is unavailable or returns an unexpected error. Every such
   return happens before any message is sent or any state is saved. The only
   earlier side effect is the EH write itself (row 1 below).
2. **It crashes partway**, from an unexpected throw or the Worker being evicted
   before the ack. The queue redelivers the message and the whole job runs
   again from the start. This is the case the playbook warns about.

The rule applies only if a re-run can repeat something. So every side effect
of `runSyncJob` and the dead-letter handler (`src/sync/consumer.ts`) is listed
below, with what a full re-run does to it.

| # | Side effect | How it is written | On a re-run of the same job | Verdict |
|---|---|---|---|---|
| 1 | **Employment Hero employee record** | `upsertByExternalId`: `GET …/externalid/{id}`, then `POST` if absent or `PUT` if present | If EH applied a write we never saw the answer to (e.g. a timeout), the re-run's `GET` finds it and `PUT`s the same payload. No second employee. | Idempotent |
| 2 | Read-back of the record | `GET` | Read only | — |
| 3 | **Correction message** to the employee, plus their **Direct manager** on cycle 3+ | Claim a `sync_meta` key (user + mapped-payload hash, 1 h) **before** sending, then bump the cycle, then send | The claim is found, so no second message and no second cycle bump (#58) | At most once |
| 4 | Failure-cycle count | `advanceCycle` | Correction: inside the claim (row 3). OK / Manual follow-up: set to 0, which can repeat | Idempotent |
| 5 | **Manual-follow-up notice** to the alerts channel | Claim (user + reasons, 12 h) before sending | Not re-sent | At most once |
| 6 | **Collision alert** to the alerts channel | Claim (1 h) before sending | Not re-sent | At most once |
| 7 | `employee_map` link (`lastSyncedTs`, `lastPayloadHash`, `lastOutcome`) | Upsert of one row | Same values. Once saved, the stale-event guard and the payload hash skip any later redelivery of this job before step 1 | Idempotent |
| 8 | `sync_log` audit row | `INSERT`, written last | Normally skipped by row 7's guard. **Exception:** the collision path doesn't save a link, so a redelivery appends a second identical `collision` row | Audit only; can repeat on collisions |
| 9 | `acked_total` counter | Bumped once per batch, after the acks | A crash between an ack and the bump under-counts. The `/health` `queueBacklog` gauge can then stay above 0 | Gauge drift only |
| 10 | Dead-letter queue: **System alert**, `dead_letter` audit row, integrator alert | Alert claimed (1 h); row `INSERT`; integrator alert de-duplicated per user (1 h, `src/index.ts`); DLQ messages are always acked | No repeated alerts; the row can repeat if the DLQ itself redelivers | At most once / audit |

Nothing a person or Employment Hero sees can be duplicated by a re-run. The
only repeatable writes are an audit row on the collision path and a health
counter.

## Decision

**Keep `max_retries: 5` on `eh-webhook-sync`.** This is a documented exception
to the playbook's "never auto-retry" rule. The rule exists to prevent
duplicated third-party writes, and this consumer has none:

- **The one third-party write is an upsert** keyed by the Connecteam user id
  (EH `externalId`). Re-running it converges on the same record.
- **Every human-facing message is claimed before it is sent**, so a re-run
  skips it. Messages are at-most-once.
- **Everything else** is an idempotent upsert, an audit row, or a gauge.

The other half of the rule, surfacing failure to a human, is already met:
after the last retry the job dead-letters and the alerts channel gets a System
alert (row 10).

`max_retries: 0` would make things worse here. Almost every real failure is
transient: Connecteam or Employment Hero rate-limiting, a 5xx, a timeout. With
no retries, each blip would dead-letter the job, post a System alert, and
need someone to re-sync the employee by hand, where a retry seconds later
would have succeeded.

## Considered options

- **`max_retries: 0` + DLQ → System alert (the playbook default):** rejected for
  this consumer. It guards against duplication that can't happen here (see the
  table) and turns every transient fault into manual work.
- **Keep retries but make the remaining non-idempotent rows idempotent** (row 8's
  collision audit row, row 9's counter): not needed for this decision. They
  affect an audit trail and a gauge, never a person or EH.

## Consequences

- **An invariant for future changes:** any new side effect in `runSyncJob` must
  be idempotent, or claimed before it happens, like rows 3, 5 and 6. Otherwise
  this decision must be revisited. `src/sync/consumer.ts` points here.
  (`wrangler.jsonc` deliberately has no comment: the live deploy folder keeps
  its settings as uncommitted edits to that file, and upstream changes to it
  would block updating that folder.)
- **At-most-once has a cost:** a message can be **lost**. Each claim is stamped
  before the send, and the send's result isn't checked. So if a Connecteam send
  fails, or the Worker crashes between the claim and the send, that Correction
  message or notice never goes out and nothing says so. The re-run sees the
  claim and skips it, and the saved link stops later redeliveries. The
  employee only hears again after their next edit. This is a separate gap from
  retries; tracked in #89.
- **No retry delay is configured** (`retry_delay` on the consumer, or a delay on
  `message.retry()`). The five retries can therefore be used up quickly during
  an Employment Hero outage of a few minutes, sending the job to the
  dead-letter queue sooner than needed. Tracked in #90: set a delay so the
  retries span a realistic outage.
- **The playbook rule still holds as the default** for other integrations under
  `../` (e.g. a write-per-record importer with no upsert key). This ADR is the
  record of why this consumer is the exception. A client's IT person asking
  "why does it retry?" can be pointed here.
