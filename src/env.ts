import type { SyncJob } from "./sync/job.js";

export type { SyncJob };

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
