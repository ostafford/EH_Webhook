/**
 * The narrow D1 surface the sync consumer needs. Kept as an interface (not a
 * `D1Database`) so the consumer stays node-testable with a fake; the concrete
 * drizzle-backed implementation is {@link ../db/store.SyncStore}, compiled only
 * into the Worker.
 */
import type { CycleStore } from "./cycles.js";

/** One row of `employee_map`, as the consumer reads it. */
export interface EmployeeLink {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastSyncedTs: number | null;
  failureCycleCount: number;
  lastPayloadHash: string | null;
}

/** Values written back to `employee_map` after an attempt. */
export interface EmployeeLinkPatch {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastSyncedTs: number | null;
  /** Null on any non-clean outcome, so the next event always re-syncs. */
  lastPayloadHash: string | null;
}

/** Matches the `sync_log.outcome` enum in {@link ../db/schema}. */
export type SyncOutcomeLabel = "ok" | "correction" | "follow_up" | "retry" | "dead_letter";

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
}
