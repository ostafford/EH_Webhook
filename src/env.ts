/** Worker bindings. Secrets come from `wrangler secret put`; the rest from wrangler.jsonc `vars`. */
export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncJob>;

  // secrets
  CT_API_KEY: string;
  EH_API_KEY: string;
  CT_WEBHOOK_SECRET: string;

  // vars
  FIELD_MAP_CLIENT: string;
  EH_BUSINESS_ID: string;
  EH_PAY_SCHEDULE_ID: string;
  EH_LOCATION_ID: string;
  CT_ONBOARDING_PACK_ID: string;
  CT_CUSTOM_PUBLISHER_ID: string;
  ADMIN_CONNECTEAM_CHANNEL_ID: string;
}

/** A unit of sync work on the queue. Carries identifiers only - never PII. */
export interface SyncJob {
  reason: "approval" | "profile_update";
  ctUserId: number;
  /** Connecteam event time (epoch ms) for last-write-wins ordering. */
  eventTimestamp: number;
}
