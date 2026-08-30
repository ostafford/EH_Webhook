import { Hono } from "hono";
import type { Env, SyncJob } from "./env.js";
import { buildHealth } from "./health.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const health = await buildHealth(c.env);
  return c.json(health, health.ok ? 200 : 503);
});

// Connecteam `user_updated` webhook. Implemented in M7.
app.post("/webhook", (c) => c.json({ error: "not implemented" }, 501));

app.notFound((c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,

  /** Sync queue consumer. Implemented in M5. */
  async queue(batch, _env): Promise<void> {
    for (const message of batch.messages) {
      message.ack();
    }
  },

  /** 1-minute cron: sweep the Connecteam onboarding API for approvals. Implemented in M6. */
  async scheduled(_controller, _env): Promise<void> {
    // no-op until M6
  },
} satisfies ExportedHandler<Env, SyncJob>;
