import { Hono } from "hono";
import type { Env, SyncJob } from "./env.js";
import { buildHealth } from "./health.js";
import { loadFieldMap } from "./mapping/loader.js";
import { EhPayrollClient } from "./eh/client.js";
import { ConnecteamClient } from "./connecteam/client.js";
import { SyncStore } from "./db/store.js";
import { dispatchBatch, type SyncDeps } from "./sync/consumer.js";
import { runSweep } from "./cron/sweep.js";
import { handleWebhook } from "./webhook/inbound.js";
import { DEFAULT_SCHEME } from "./connecteam/signature.js";
import { logEvent } from "./log.js";
import { postIntegrator, SYSTEM_ALERT_DEDUPE_MS, HEALTH_PUSH_INTERVAL_MS } from "./integrator.js";

/** Dead-letter queue name (see `dead_letter_queue` in wrangler.jsonc). */
const DLQ_NAME = "eh-webhook-dlq";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const health = await buildHealth(c.env);
  return c.json(health, health.ok ? 200 : 503);
});

/**
 * Connecteam `user_updated` webhook. Check the shared secret, answer
 * immediately, and enqueue a `profile_update` sync. The secret check + payload
 * parsing are in src/webhook/inbound.ts; this route only does the enqueue.
 */
app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const outcome = await handleWebhook({
    rawBody,
    signatureHeader: c.req.header(DEFAULT_SCHEME.header),
    secret: c.env.CT_WEBHOOK_SECRET,
  });
  const store = new SyncStore(c.env.DB);

  if (outcome.job) {
    try {
      await c.env.SYNC_QUEUE.send(outcome.job);
      await store.bumpCounter("enqueued_total", 1);
    } catch {
      logEvent({ evt: "webhook", status: 503, ctUserId: outcome.job.ctUserId, reason: "enqueue failed" });
      return c.json({ error: "could not enqueue" }, 503);
    }
  }

  // Delivery-outcome counters, surfaced by /health so setup (issue #28) and
  // ongoing ops can see the webhook is actually live: a 202 means Connecteam
  // delivered and the signature verified; a 401 means a delivery arrived but
  // its secretKey did not match CT_WEBHOOK_SECRET.
  if (outcome.status === 202) await store.bumpCounter("webhook_202_total", 1);
  else if (outcome.status === 401) await store.bumpCounter("webhook_401_total", 1);

  logEvent({
    evt: "webhook",
    status: outcome.status,
    ctUserId: outcome.job?.ctUserId ?? null,
    ...(outcome.shape ? { shape: outcome.shape } : {}),
  });
  return c.json(outcome.body, outcome.status as 200 | 202 | 400 | 401 | 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

function buildDeps(env: Env): SyncDeps {
  const store = new SyncStore(env.DB);
  return {
    ct: new ConnecteamClient({
      apiKey: env.CT_API_KEY,
      customPublisherId: Number(env.CT_CUSTOM_PUBLISHER_ID),
    }),
    eh: new EhPayrollClient({ apiKey: env.EH_API_KEY, businessId: env.EH_BUSINESS_ID }),
    store,
    fieldMap: loadFieldMap(env.FIELD_MAP_CLIENT),
    adminChannelId: env.ADMIN_CONNECTEAM_CHANNEL_ID,
    ...(env.INTEGRATOR_ALERT_URL
      ? {
          onSystemAlert: async ({ ctUserId, reason }: { ctUserId: number; reason: string }) => {
            // Dedupe per user within the window so a flapping client can't flood.
            const key = `integ_alert_${ctUserId}`;
            const last = (await store.readMeta([key]))[key] ?? 0;
            if (Date.now() - last < SYSTEM_ALERT_DEDUPE_MS) return;
            await store.setMarker(key, Date.now());
            await postIntegrator(env, {
              kind: "system_alert",
              client: env.INTEGRATOR_CLIENT_ID ?? "",
              ctUserId,
              reason,
              at: new Date().toISOString(),
            });
          },
        }
      : {}),
  };
}

/** Once a day, POST a redaction-safe /health summary to the integrator. */
async function maybePushHealth(env: Env, store: SyncStore): Promise<void> {
  if (!env.INTEGRATOR_ALERT_URL) return;
  const last = (await store.readMeta(["integ_health_at"])).integ_health_at ?? 0;
  if (Date.now() - last < HEALTH_PUSH_INTERVAL_MS) return;
  await store.setMarker("integ_health_at", Date.now());
  const h = await buildHealth(env);
  await postIntegrator(env, {
    kind: "health",
    client: env.INTEGRATOR_CLIENT_ID ?? "",
    ok: h.ok,
    d1: h.d1,
    fieldMap: h.fieldMap,
    ops: h.ops,
    at: h.time,
  });
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
    logEvent({ evt: "queue", queue: batch.queue, messages: batch.messages.length });
  },

  /** 1-minute cron: sweep the Connecteam onboarding API and enqueue new approvals. */
  async scheduled(_controller, env): Promise<void> {
    const ct = new ConnecteamClient({
      apiKey: env.CT_API_KEY,
      customPublisherId: Number(env.CT_CUSTOM_PUBLISHER_ID),
    });
    const store = new SyncStore(env.DB);

    const result = await runSweep({
      packId: Number(env.CT_ONBOARDING_PACK_ID),
      listAssignments: (packId) => ct.listAssignments(packId),
      rateLimit: () => ct.lastRateLimit,
      readState: () => store.readOnboardingState(),
      writeState: (assignments, seenAt) => store.writeOnboardingState(assignments, seenAt),
      enqueue: async (jobs) => {
        await env.SYNC_QUEUE.sendBatch(jobs.map((body) => ({ body })));
        await store.bumpCounter("enqueued_total", jobs.length);
      },
    });

    if (result.status !== "retry") {
      await store.setMarker("last_sweep_ok_at", Date.now());
    }
    logEvent({ evt: "sweep", ...result });

    await maybePushHealth(env, store);
  },
} satisfies ExportedHandler<Env, SyncJob>;
