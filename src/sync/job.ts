/**
 * The unit of sync work carried on the queue. Identifiers only - never PII.
 * Lives here (not in env.ts) so pure, node-tested modules can import it without
 * pulling in the Workers runtime types.
 */
export interface SyncJob {
  reason: "approval" | "profile_update";
  ctUserId: number;
  /** Connecteam event time (epoch ms) for last-write-wins ordering. */
  eventTimestamp: number;
}
