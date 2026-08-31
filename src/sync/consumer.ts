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
import type { EhPayrollClient } from "../eh/client.js";
import { decide, compareReadBack, auditDetail, type SyncDecision, type ReadBackResult } from "./decide.js";
import {
  correctionMessage,
  managerEscalationMessage,
  followUpNoticeMessage,
  systemAlertMessage,
} from "./messages.js";
import { advanceCycle, directManagerUserId } from "./cycles.js";
import { payloadHash } from "./canonical.js";
import type { SyncGateway, SyncOutcomeLabel } from "./gateway.js";

export interface SyncDeps {
  ct: Pick<ConnecteamClient, "getUser" | "sendDirectMessage" | "sendChannelMessage">;
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
}

export async function runSyncJob(job: SyncJob, deps: SyncDeps): Promise<SyncJobOutcome> {
  const now = deps.now ?? Date.now;
  const { ctUserId, eventTimestamp } = job;

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

  const mapped = applyFieldMap(user as unknown as MappingUser, deps.fieldMap);
  const hash = await payloadHash(mapped.payload);

  // Unchanged since the last clean sync (hash is only stored after ok/follow_up).
  if (link?.lastPayloadHash && link.lastPayloadHash === hash && link.ehEmployeeId) {
    return { status: "skipped", reason: "unchanged since last sync" };
  }

  let ehEmployeeId = link?.ehEmployeeId ?? undefined;
  let decision: SyncDecision;

  if (mapped.issues.length > 0) {
    // The payload never leaves the Worker - the employee must fix it first.
    decision = decide({ mappingIssues: mapped.issues });
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
    decision = decide({ write, followUps: mapped.followUps, ...(readBack ? { readBack } : {}) });
  }

  if (decision.kind === "retry") return { status: "retry", reason: decision.detail };

  const cycle = await advanceCycle(deps.store, ctUserId, decision);

  let managerNotified = false;
  if (decision.kind === "correction") {
    await deps.ct.sendDirectMessage(ctUserId, correctionMessage(decision.fields));
    if (cycle.action === "correction" && cycle.notifyManager) {
      const managerId = directManagerUserId(user.customFields);
      if (managerId !== null) {
        await deps.ct.sendDirectMessage(managerId, managerEscalationMessage(decision.fields));
        managerNotified = true;
      }
    }
  } else if (decision.kind === "follow_up") {
    await deps.ct.sendChannelMessage(
      deps.adminChannelId,
      followUpNoticeMessage(decision.reasons, { ctUserId }),
    );
  }

  const clean = decision.kind === "ok" || decision.kind === "follow_up";
  await deps.store.saveEmployeeLink({
    ctUserId,
    ehEmployeeId: ehEmployeeId ?? null,
    lastSyncedTs: eventTimestamp,
    lastPayloadHash: clean ? hash : null,
  });
  await deps.store.appendSyncLog({
    ctUserId,
    at: now(),
    outcome: outcomeLabel(decision),
    detail: auditDetail(decision),
  });

  return {
    status: decision.kind === "ok" ? "synced" : decision.kind,
    reason: auditDetail(decision),
    ...(ehEmployeeId ? { ehEmployeeId } : {}),
    managerNotified,
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

  let acked = 0;
  for (const message of batch.messages) {
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
  await deps.ct.sendChannelMessage(
    deps.adminChannelId,
    systemAlertMessage(detail, { ctUserId: job.ctUserId }),
  );
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
