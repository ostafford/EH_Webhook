import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index.js";
import type { SyncJob } from "../../src/sync/job.js";

const SECRET = "worker-test-webhook-secret";

/** Swap SYNC_QUEUE for a capturing stub while a request runs. */
let sent: SyncJob[];
let realQueue: unknown;

beforeEach(() => {
  sent = [];
  realQueue = (env as Record<string, unknown>).SYNC_QUEUE;
  (env as Record<string, unknown>).CT_WEBHOOK_SECRET = SECRET;
  (env as Record<string, unknown>).SYNC_QUEUE = {
    send: async (body: SyncJob) => {
      sent.push(body);
    },
    sendBatch: async () => {},
  };
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
  });

  it("rejects a delivery with no secret header with 401 and enqueues nothing", async () => {
    const res = await post(JSON.stringify({ data: { userId: 1 } }));
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("rejects a wrong secret with 401", async () => {
    const body = JSON.stringify({ data: { userId: 1 } });
    const res = await post(body, { "x-webhook-secret": "not-the-secret" });
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post("{ not json", { "x-webhook-secret": SECRET });
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });
});
