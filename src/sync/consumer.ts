/**
 * The end-to-end sync for one queued job (issue #6). Given a Connecteam user id
 * it: resolves the user, maps them, upserts the Employment Hero record, reads it
 * back, runs {@link decide}, drives the failure-cycle state machine, sends any
 * message, and records the link + audit row. Replaying an old or unchanged event
 * is a no-op.
 *
 * Everything it touches is injected ({@link SyncDeps}) so it runs unchanged in a
 * unit test with fakes or in the Worker with real clients and D1. It never
 * throws for an expected retryable fault - it returns `status: "retry"` and lets
 * the queue handler call `message.retry()`.
 */
import type { SyncJob } from "./job.js";
import type { FieldMap } from "../mapping/schema.js";
import { applyFieldMap, type ConnecteamUser as MappingUser } from "../mapping/apply.js";
import type { ConnecteamClient } from "../connecteam/client.js";
import type { PayRate } from "../connecteam/types.js";
import type { EhPayrollClient } from "../eh/client.js";
import { decide, compareReadBack, auditDetail, type SyncDecision, type ReadBackResult } from "./decide.js";
import {
  correctionMessage,
  managerEscalationMessage,
  followUpNoticeMessage,
  systemAlertMessage,
  type PersonRef,
} from "./messages.js";
import { advanceCycle, directManagerUserId } from "./cycles.js";
import { payloadHash } from "./canonical.js";
import { logEvent } from "../log.js";
import {
  noticeKey,
  shouldPostNotice,
  FOLLOW_UP_NOTICE_DEDUPE_MS,
  SYSTEM_ALERT_NOTICE_DEDUPE_MS,
} from "./notices.js";
import type { SyncGateway, SyncOutcomeLabel } from "./gateway.js";

export interface SyncDeps {
  ct: Pick<
    ConnecteamClient,
    "getUser" | "getPayRate" | "sendDirectMessage" | "sendChannelMessage"
  >;
  eh: Pick<EhPayrollClient, "upsertByExternalId" | "getByExternalId">;
  store: SyncGateway;
  fieldMap: FieldMap;
  /** Connecteam conversation id for the "EH Sync Alerts" channel. */
  adminChannelId: string;
  /** Overridable clock for the audit timestamp. */
  now?: () => number;
  /** Optional: also notify the integrator when a job dead-letters. Best-effort. */
  onSystemAlert?: (info: { ctUserId: number; reason: string }) => Promise<void>;
}

export type SyncJobStatus = "synced" | "correction" | "follow_up" | "skipped" | "retry";

export interface SyncJobOutcome {
  status: SyncJobStatus;
  /** Redaction-safe explanation: skip reason, retry reason, or the decision detail. */
  reason: string;
  ehEmployeeId?: string;
  managerNotified?: boolean;
  /** A follow-up decision whose channel notice was suppressed as a recent duplicate. */
  noticeSuppressed?: boolean;
}

export async function runSyncJob(job: SyncJob, deps: SyncDeps): Promise<SyncJobOutcome> {
  const now = deps.now ?? Date.now;
  const { ctUserId, eventTimestamp } = job;

  // A `profile_update` job is the `user_updated` webhook firing - which fires on
  // every field save, including mid-onboarding, before a pack is ever Approved
  // (ADR-0002: the webhook only covers "ongoing edits AFTER approval"). Without
  // this gate, filling in one field at a time during onboarding would run a
  // full sync - and send a Correction/Manual-follow-up - on every keystroke's
  // worth of save, for data that was never meant to reach EH yet. `approval`
  // jobs are never gated here: the sweep only ever enqueues one the instant it
  // observes the completed transition, so it IS the approval signal.
  if (job.reason === "profile_update" && !(await deps.store.hasBeenApproved(ctUserId))) {
    return { status: "skipped", reason: "onboarding pack not yet approved" };
  }

  const link = await deps.store.getEmployeeLink(ctUserId);

  // Ordering / replay: last-write-wins on the Connecteam event time.
  if (link?.lastSyncedTs != null && eventTimestamp <= link.lastSyncedTs) {
    return { status: "skipped", reason: "stale or duplicate event" };
  }

  // Resolve the Connecteam user. A missing user is skipped, not a failure -
  // some onboarding assignments point at users that no longer exist.
  const userRes = await deps.ct.getUser(ctUserId);
  if (userRes.outcome === "retryable") return { status: "retry", reason: `connecteam unavailable: ${userRes.detail}` };
  if (userRes.outcome === "error") return { status: "retry", reason: `connecteam error ${userRes.status}` };
  if (userRes.data === null) return { status: "skipped", reason: "connecteam user no longer exists" };
  const user = userRes.data;

  // Per-employee pay rate (issue #42): only when the client opted in via
  // `employmentHero.perEmployeeRate`. `applyFieldMap` is pure, so the network
  // call happens here and the result is passed in.
  let payRate: PayRate | null | undefined;
  if (deps.fieldMap.employmentHero.perEmployeeRate) {
    // Ask for the rate effective on the event date. The API returns one
    // `payRate` per user for the window; a same-day window = "the rate that
    // applies now". (Widen this if the live API rejects start == end.)
    const day = new Date(eventTimestamp).toISOString().slice(0, 10);
    const rateRes = await deps.ct.getPayRate(ctUserId, { startDate: day, endDate: day });
    if (rateRes.outcome === "retryable") {
      return { status: "retry", reason: `connecteam pay-rates unavailable: ${rateRes.detail}` };
    }
    if (rateRes.outcome === "error") {
      return { status: "retry", reason: `connecteam pay-rates error ${rateRes.status}` };
    }
    payRate = rateRes.data;
    if (payRate && Array.isArray(payRate.resourcesRates) && payRate.resourcesRates.length > 0) {
      // Per-resource overrides don't map to EH's single `rate` - we use
      // `defaultRate` and just note that overrides exist (redact drops values).
      logEvent({
        evt: "payrate_resource_overrides",
        ctUserId,
        rateType: payRate.rateType,
        overrides: payRate.resourcesRates.length,
      });
    }
  }

  const mapped = applyFieldMap(user as unknown as MappingUser, deps.fieldMap, { payRate });
  const hash = await payloadHash(mapped.payload);

  // Identical to the state we last processed. Connecteam fires one webhook per
  // changed field, so a multi-field edit is a burst of deliveries that all
  // resolve to the same mapped payload; run it once. This also stops an
  // employee stuck in a correction loop from being re-messaged (and their
  // failure cycle re-bumped) once per delivery in the burst. `lastPayloadHash`
  // is now stored on every terminal outcome, not only clean ones.
  if (link?.lastPayloadHash && link.lastPayloadHash === hash) {
    return { status: "skipped", reason: "identical to the last processed state" };
  }

  let ehEmployeeId = link?.ehEmployeeId ?? undefined;
  let decision: SyncDecision;

  if (mapped.issues.length > 0) {
    // The payload never leaves the Worker - the employee must fix it first.
    decision = decide({ mappingIssues: mapped.issues });
  } else if (mapped.payRunIssues.length > 0) {
    // Pay-run set could not be completed (issue #42). EH 400s a partial set, so
    // nothing is sent; the reasons go to the admin channel as one follow-up.
    decision = decide({ payRunUnresolved: mapped.payRunIssues, followUps: mapped.followUps });
  } else {
    // Match order: stored link -> externalId (both handled by upsertByExternalId).
    // Email fallback for the very first match is deferred - it needs an EH
    // employee-search endpoint that issue #2 did not build/verify.
    const write = await deps.eh.upsertByExternalId(mapped.externalId, mapped.payload);
    if (write.outcome === "retryable") return { status: "retry", reason: `employment hero unavailable: ${write.detail}` };
    if (write.outcome === "client_error") return { status: "retry", reason: `employment hero error ${write.status}` };

    let readBack: ReadBackResult | undefined;
    if (write.outcome === "ok") {
      ehEmployeeId = String(write.data.id);
      const rb = await deps.eh.getByExternalId(mapped.externalId);
      if (rb.outcome === "ok" && rb.data) {
        readBack = compareReadBack(
          mapped.payload,
          rb.data as Record<string, unknown>,
          readBackFields(deps.fieldMap),
        );
      }
    }
    decision = decide({
      write,
      followUps: mapped.followUps,
      payRunDefaultsComplete: mapped.payRunDefaultsComplete,
      ...(readBack ? { readBack } : {}),
    });
  }

  if (decision.kind === "retry") return { status: "retry", reason: decision.detail };

  const cycle = await advanceCycle(deps.store, ctUserId, decision);

  const person = { ctUserId, firstName: user.firstName, lastName: user.lastName };

  let managerNotified = false;
  let noticeSuppressed = false;
  if (decision.kind === "correction") {
    await deps.ct.sendDirectMessage(ctUserId, correctionMessage(decision.fields));
    if (cycle.action === "correction" && cycle.notifyManager) {
      const managerId = directManagerUserId(user.customFields);
      if (managerId !== null) {
        await deps.ct.sendDirectMessage(managerId, managerEscalationMessage(decision.fields, person));
        managerNotified = true;
      }
    }
  } else if (decision.kind === "follow_up") {
    // The record synced (safe defaults); a payroll admin still has to finish it
    // by hand in EH. While that stays undone, every later profile edit lands
    // here again with the same reason - post it once per window, not per edit.
    const key = await noticeKey("follow_up", ctUserId, decision.reasons);
    if (await shouldPostNotice(deps.store, key, FOLLOW_UP_NOTICE_DEDUPE_MS, now())) {
      await deps.ct.sendChannelMessage(
        deps.adminChannelId,
        followUpNoticeMessage(decision.reasons, person),
      );
    } else {
      noticeSuppressed = true;
    }
  }

  // Store the hash on every terminal outcome so an identical re-delivery is
  // skipped above. A genuine later edit changes the mapped payload -> new hash
  // -> it is processed again. `lastOutcome` is what the daily recheck pass
  // (#43) uses to find every employee stuck on a Manual-follow-up without
  // scanning sync_log.
  const outcome = outcomeLabel(decision);
  await deps.store.saveEmployeeLink({
    ctUserId,
    ehEmployeeId: ehEmployeeId ?? null,
    lastSyncedTs: eventTimestamp,
    lastPayloadHash: hash,
    lastOutcome: outcome,
  });
  await deps.store.appendSyncLog({
    ctUserId,
    at: now(),
    outcome,
    detail: auditDetail(decision),
  });

  return {
    status: decision.kind === "ok" ? "synced" : decision.kind,
    reason: auditDetail(decision),
    ...(ehEmployeeId ? { ehEmployeeId } : {}),
    managerNotified,
    ...(noticeSuppressed ? { noticeSuppressed: true } : {}),
  };
}

/** Minimal shape of a queue message / batch, so batch routing is runtime-agnostic. */
export interface QueueMessageLike<B> {
  body: B;
  ack(): void;
  retry(): void;
}
export interface QueueBatchLike<B> {
  queue: string;
  messages: readonly QueueMessageLike<B>[];
}

/**
 * Route one delivered batch. Messages off the dead-letter queue raise a System
 * alert and are always acked; sync messages ack on a terminal outcome and retry
 * on a retryable fault or an unexpected throw.
 */
export async function dispatchBatch(
  batch: QueueBatchLike<SyncJob>,
  deps: SyncDeps,
  dlqName: string,
): Promise<void> {
  if (batch.queue === dlqName) {
    for (const message of batch.messages) {
      try {
        await handleDeadLetter(message.body, deps);
      } catch {
        // Best effort - a failed alert must not loop the dead-letter queue.
      } finally {
        message.ack();
      }
    }
    await bump(deps, "dl_total", batch.messages.length);
    return;
  }

  // Connecteam fires one `user_updated` delivery per changed field, so a single
  // profile edit arrives as a burst of jobs for the same user in one batch.
  // Run only the newest per user; ack the rest without running a sync, a message
  // or a failure-cycle bump. They still count toward `acked_total` — every
  // enqueued message must land in `acked_total` or `dl_total` or the /health
  // `queueBacklog` gauge (enqueued - acked - dead-lettered) never returns to 0.
  // (A burst split across batches is still deduped by the stale-event guard in
  // runSyncJob once the first job has written `lastSyncedTs`.)
  let acked = 0;
  const newestPerUser = new Map<number, QueueMessageLike<SyncJob>>();
  for (const message of batch.messages) {
    const prev = newestPerUser.get(message.body.ctUserId);
    if (!prev || message.body.eventTimestamp > prev.body.eventTimestamp) {
      if (prev) {
        prev.ack();
        acked++;
      }
      newestPerUser.set(message.body.ctUserId, message);
    } else {
      message.ack();
      acked++;
    }
  }

  for (const message of newestPerUser.values()) {
    try {
      const outcome = await runSyncJob(message.body, deps);
      if (outcome.status === "retry") message.retry();
      else {
        message.ack();
        acked++;
      }
    } catch {
      message.retry();
    }
  }
  await bump(deps, "acked_total", acked);
}

async function bump(deps: SyncDeps, key: string, delta: number): Promise<void> {
  if (delta > 0) await deps.store.bumpCounter(key, delta);
}

/** DLQ handler: a job that exhausted its retries. Raise a System alert. */
export async function handleDeadLetter(
  job: SyncJob,
  deps: Pick<SyncDeps, "ct" | "store" | "adminChannelId" | "now" | "onSystemAlert">,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const detail = `the sync exceeded its retry limit (trigger "${job.reason}")`;

  // A user whose job keeps dead-lettering (EH auth down, a mapping bug) would
  // otherwise post an identical alert on every retry-exhaustion. Post it once
  // per window; the audit row below is still written every time.
  const key = await noticeKey("system_alert", job.ctUserId, [detail]);
  if (await shouldPostNotice(deps.store, key, SYSTEM_ALERT_NOTICE_DEDUPE_MS, now())) {
    // Best effort: put the employee's name in the alert. The sync is already
    // failing, so a failed lookup just falls back to the id.
    let person: PersonRef = { ctUserId: job.ctUserId };
    try {
      const res = await deps.ct.getUser(job.ctUserId);
      if (res.outcome === "ok" && res.data) {
        person = { ctUserId: job.ctUserId, firstName: res.data.firstName, lastName: res.data.lastName };
      }
    } catch {
      // keep the id-only ref
    }
    await deps.ct.sendChannelMessage(deps.adminChannelId, systemAlertMessage(detail, person));
  }
  await deps.store.appendSyncLog({
    ctUserId: job.ctUserId,
    at: now(),
    outcome: "dead_letter",
    detail: "retries exhausted",
  });
  if (deps.onSystemAlert) {
    await deps.onSystemAlert({ ctUserId: job.ctUserId, reason: `retries exhausted (${job.reason})` });
  }
}

function outcomeLabel(decision: SyncDecision): SyncOutcomeLabel {
  switch (decision.kind) {
    case "ok":
      return "ok";
    case "correction":
      return "correction";
    case "follow_up":
      return "follow_up";
    case "retry":
      return "retry";
  }
}

/**
 * Fields safe to compare on read-back: plain string pass-throughs only. Dates,
 * zero-pads, phone, dropdowns and locations are skipped - EH may return them in
 * a different-but-equivalent format, which would read as a false mismatch. TFN
 * and bank values are never re-fetched.
 */
function readBackFields(map: FieldMap): string[] {
  return map.fields
    .filter((f) => !f.sensitive && !f.map && (f.transform === "trimString" || f.transform === "lowerTrim"))
    .map((f) => f.eh);
}
