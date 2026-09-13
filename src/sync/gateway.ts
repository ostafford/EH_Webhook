/**
 * The narrow D1 surface the sync consumer needs. Kept as an interface (not a
 * `D1Database`) so the consumer stays node-testable with a fake; the concrete
 * drizzle-backed implementation is {@link ../db/store.SyncStore}, compiled only
 * into the Worker.
 */
import type { CycleStore } from "./cycles.js";
import type { RosterRow } from "../status/roster.js";

/** Matches the `sync_log.outcome` enum in {@link ../db/schema}. */
export type SyncOutcomeLabel = "ok" | "correction" | "follow_up" | "retry" | "dead_letter" | "resolved";

/** One row of `employee_map`, as the consumer reads it. */
export interface EmployeeLink {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastSyncedTs: number | null;
  failureCycleCount: number;
  lastPayloadHash: string | null;
  /** The outcome of the most recent attempt, or undefined if not tracked by this store. */
  lastOutcome?: SyncOutcomeLabel | null;
}

/** Values written back to `employee_map` after an attempt. */
export interface EmployeeLinkPatch {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastSyncedTs: number | null;
  /**
   * The mapped-payload hash of this attempt, clean or not, so a byte-identical
   * re-delivery is skipped. A real later edit changes the payload and its hash.
   */
  lastPayloadHash: string | null;
  /** The outcome of this attempt (issue #43); optional so existing callers still compile. */
  lastOutcome?: SyncOutcomeLabel | null;
}

export interface SyncLogEntry {
  ctUserId: number;
  at: number;
  outcome: SyncOutcomeLabel;
  /** Redaction-safe: field NAMES + status hints only, never a value. */
  detail: string;
}

export interface SyncGateway extends CycleStore {
  getEmployeeLink(ctUserId: number): Promise<EmployeeLink | null>;
  saveEmployeeLink(patch: EmployeeLinkPatch): Promise<void>;
  appendSyncLog(entry: SyncLogEntry): Promise<void>;
  /** Add `delta` to an operational counter for /health (queue backlog etc.). */
  bumpCounter(key: string, delta: number): Promise<void>;
  /** Read named `sync_meta` counters/markers; missing keys come back as 0. */
  readMeta(keys: string[]): Promise<Record<string, number>>;
  /** Set a `sync_meta` marker to an absolute value (e.g. a "notice last sent" ms). */
  setMarker(key: string, value: number): Promise<void>;
}

/**
 * The narrow surface the daily recheck pass (issue #43) needs. A separate
 * interface (not folded into {@link SyncGateway}) so adding it doesn't force
 * every existing fake gateway in the sync-consumer tests to grow a new method.
 */
export interface RecheckGateway
  extends Pick<SyncGateway, "appendSyncLog" | "saveEmployeeLink" | "readMeta" | "setMarker"> {
  /** Every `employee_map` row whose last attempt ended in a Manual-follow-up. */
  listFollowUpLinks(): Promise<EmployeeLink[]>;
}

/**
 * The narrow surface the sync-status roster (issue #44) needs: every person we
 * have ever seen, joined with their latest `sync_log` row, plus the markers the
 * weekly digest schedules itself off. A separate interface for the same reason
 * as {@link RecheckGateway} - existing fake gateways in other tests don't need
 * to grow this method.
 */
export interface StatusGateway extends Pick<SyncGateway, "readMeta" | "setMarker"> {
  listRosterRows(): Promise<RosterRow[]>;
}
