import { Hono } from "hono";
import type { Env, SyncJob } from "./env.js";
import { buildHealth } from "./health.js";
import { loadFieldMap } from "./mapping/loader.js";
import { EhPayrollClient } from "./eh/client.js";
import { ConnecteamClient } from "./connecteam/client.js";
import { SyncStore } from "./db/store.js";
import { dispatchBatch, type SyncDeps } from "./sync/consumer.js";
import { runSweep } from "./cron/sweep.js";

/** Dead-letter queue name (see `dead_letter_queue` in wrangler.jsonc). */
const DLQ_NAME = "eh-webhook-dlq";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const health = await buildHealth(c.env);
  return c.json(health, health.ok ? 200 : 503);
});

// Connecteam `user_updated` webhook. Implemented in M7.
app.post("/webhook", (c) => c.json({ error: "not implemented" }, 501));

app.notFound((c) => c.json({ error: "not found" }, 404));

function buildDeps(env: Env): SyncDeps {
  return {
    ct: new ConnecteamClient({
      apiKey: env.CT_API_KEY,
      customPublisherId: Number(env.CT_CUSTOM_PUBLISHER_ID),
    }),
    eh: new EhPayrollClient({ apiKey: env.EH_API_KEY, businessId: env.EH_BUSINESS_ID }),
    store: new SyncStore(env.DB),
    fieldMap: loadFieldMap(env.FIELD_MAP_CLIENT),
    adminChannelId: env.ADMIN_CONNECTEAM_CHANNEL_ID,
  };
}

export default {
  fetch: app.fetch,

  /**
   * Sync queue consumer. One message = one Connecteam user to (re)sync.
   * Retryable faults call `message.retry()`; everything else acks. The
   * dead-letter queue raises a System alert.
   */
  async queue(batch, env): Promise<void> {
    await dispatchBatch(batch, buildDeps(env), DLQ_NAME);
  },

  /** 1-minute cron: sweep the Connecteam onboarding API and enqueue new approvals. */
  async scheduled(_controller, env): Promise<void> {
    const ct = new ConnecteamClient({
      apiKey: env.CT_API_KEY,
      customPublisherId: Number(env.CT_CUSTOM_PUBLISHER_ID),
    });
    const store = new SyncStore(env.DB);

    await runSweep({
      packId: Number(env.CT_ONBOARDING_PACK_ID),
      listAssignments: (packId) => ct.listAssignments(packId),
      rateLimit: () => ct.lastRateLimit,
      readState: () => store.readOnboardingState(),
      writeState: (assignments, seenAt) => store.writeOnboardingState(assignments, seenAt),
      enqueue: async (jobs) => {
        await env.SYNC_QUEUE.sendBatch(jobs.map((body) => ({ body })));
      },
    });
  },
} satisfies ExportedHandler<Env, SyncJob>;
