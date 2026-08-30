import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { handleWebhook, parseUserEdit } from "../src/webhook/inbound.js";

const SECRET = "webhook-secret-xyz";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

const NOW = 1_700_000_000_000;
const now = () => NOW;

describe("handleWebhook - accept path", () => {
  it("accepts a correctly-signed user_updated delivery and returns a profile_update job", async () => {
    const body = JSON.stringify({ eventType: "user_updated", data: { userId: 17760356, modifiedAt: 1_699_999_999_000 } });
    const out = await handleWebhook({ rawBody: body, signatureHeader: sign(body), secret: SECRET, now });

    expect(out.status).toBe(202);
    expect(out.body).toEqual({ ok: true });
    expect(out.job).toEqual({ reason: "profile_update", ctUserId: 17760356, eventTimestamp: 1_699_999_999_000 });
  });

  it("falls back to now() when the payload carries no timestamp", async () => {
    const body = JSON.stringify({ data: { userId: 42 } });
    const out = await handleWebhook({ rawBody: body, signatureHeader: sign(body), secret: SECRET, now });
    expect(out.job?.eventTimestamp).toBe(NOW);
  });

  it("normalises an epoch-seconds timestamp to millis", async () => {
    const body = JSON.stringify({ userId: 42, timestamp: 1_699_999_999 });
    const out = await handleWebhook({ rawBody: body, signatureHeader: sign(body), secret: SECRET, now });
    expect(out.job?.eventTimestamp).toBe(1_699_999_999_000);
  });
});

describe("handleWebhook - reject paths (nothing enqueued)", () => {
  const body = JSON.stringify({ data: { userId: 1 } });

  it("rejects a wrongly-signed payload with 401", async () => {
    const out = await handleWebhook({ rawBody: body, signatureHeader: sign(body, "wrong"), secret: SECRET, now });
    expect(out.status).toBe(401);
    expect(out.job).toBeUndefined();
  });

  it("rejects a missing signature header with 401", async () => {
    const out = await handleWebhook({ rawBody: body, signatureHeader: null, secret: SECRET, now });
    expect(out.status).toBe(401);
    expect(out.job).toBeUndefined();
  });

  it("rejects a tampered body with 401", async () => {
    const out = await handleWebhook({ rawBody: body + " ", signatureHeader: sign(body), secret: SECRET, now });
    expect(out.status).toBe(401);
  });

  it("rejects malformed JSON with 400", async () => {
    const raw = "{not json";
    const out = await handleWebhook({ rawBody: raw, signatureHeader: sign(raw), secret: SECRET, now });
    expect(out.status).toBe(400);
    expect(out.job).toBeUndefined();
  });

  it("rejects a signed payload with no user id with 400", async () => {
    const raw = JSON.stringify({ eventType: "user_updated", data: { name: "no id here" } });
    const out = await handleWebhook({ rawBody: raw, signatureHeader: sign(raw), secret: SECRET, now });
    expect(out.status).toBe(400);
    expect(out.job).toBeUndefined();
  });

  it("returns 500 when no webhook secret is configured", async () => {
    const out = await handleWebhook({ rawBody: body, signatureHeader: sign(body), secret: "", now });
    expect(out.status).toBe(500);
    expect(out.job).toBeUndefined();
  });
});

describe("parseUserEdit", () => {
  it("reads the id from several plausible shapes", () => {
    expect(parseUserEdit({ data: { userId: 5 } }, NOW)?.ctUserId).toBe(5);
    expect(parseUserEdit({ userId: 6 }, NOW)?.ctUserId).toBe(6);
    expect(parseUserEdit({ user: { id: 7 } }, NOW)?.ctUserId).toBe(7);
    expect(parseUserEdit({ data: { id: 8 } }, NOW)?.ctUserId).toBe(8);
    expect(parseUserEdit({ data: { userId: "9" } }, NOW)?.ctUserId).toBe(9);
  });

  it("returns null when there is no usable id", () => {
    expect(parseUserEdit({ data: {} }, NOW)).toBeNull();
    expect(parseUserEdit({ userId: 0 }, NOW)).toBeNull();
    expect(parseUserEdit("nope", NOW)).toBeNull();
    expect(parseUserEdit(null, NOW)).toBeNull();
  });
});
