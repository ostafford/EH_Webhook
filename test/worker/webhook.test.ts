import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index.js";
import type { SyncJob } from "../../src/sync/job.js";

const SECRET = "worker-test-webhook-secret";

/** Swap SYNC_QUEUE for a capturing stub while a request runs. */
let sent: SyncJob[];
let realQueue: unknown;

const meta = (key: string) =>
  env.DB.prepare("SELECT num FROM sync_meta WHERE key = ?").bind(key).first<{ num: number }>();

beforeEach(async () => {
  sent = [];
  realQueue = (env as Record<string, unknown>).SYNC_QUEUE;
  (env as Record<string, unknown>).CT_WEBHOOK_SECRET = SECRET;
  (env as Record<string, unknown>).SYNC_QUEUE = {
    send: async (body: SyncJob) => {
      sent.push(body);
    },
    sendBatch: async () => {},
  };
  await env.DB.prepare("DELETE FROM sync_meta").run();
});

afterEach(() => {
  (env as Record<string, unknown>).SYNC_QUEUE = realQueue;
});

const post = async (body: string, headers: Record<string, string> = {}) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://worker.example/webhook", { method: "POST", body, headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
};

describe("POST /webhook (in workerd)", () => {
  it("accepts a delivery carrying the shared secret and enqueues a profile_update", async () => {
    // The route only checks the shared secret + JSON.parse + one queue.send - no
    // user fetch, no EH call - so it returns without waiting on the sync itself.
    const body = JSON.stringify({ eventType: "user_updated", data: { userId: 17760356 } });
    const res = await post(body, { "x-webhook-secret": SECRET });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toEqual([{ reason: "profile_update", ctUserId: 17760356, eventTimestamp: expect.any(Number) }]);
    // /health surfaces this so setup can confirm the webhook is live (issue #28).
    expect((await meta("webhook_202_total"))?.num).toBe(1);
    expect(await meta("webhook_401_total")).toBeNull();
  });

  it("rejects a delivery with no secret header with 401 and enqueues nothing", async () => {
    const res = await post(JSON.stringify({ data: { userId: 1 } }));
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
    expect((await meta("webhook_401_total"))?.num).toBe(1);
    expect(await meta("webhook_202_total")).toBeNull();
  });

  it("rejects a wrong secret with 401", async () => {
    const body = JSON.stringify({ data: { userId: 1 } });
    const res = await post(body, { "x-webhook-secret": "not-the-secret" });
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
    expect((await meta("webhook_401_total"))?.num).toBe(1);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post("{ not json", { "x-webhook-secret": SECRET });
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });
});
