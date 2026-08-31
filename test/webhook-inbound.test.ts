import { describe, it, expect } from "vitest";
import { handleWebhook, parseUserEdit, describeShape } from "../src/webhook/inbound.js";

const SECRET = "webhook-secret-xyz";

const NOW = 1_700_000_000_000;
const now = () => NOW;

describe("handleWebhook - accept path", () => {
  it("accepts a delivery carrying the shared secret and returns a profile_update job", async () => {
    const body = JSON.stringify({ eventType: "user_updated", data: { userId: 17760356, modifiedAt: 1_699_999_999_000 } });
    const out = await handleWebhook({ rawBody: body, signatureHeader: SECRET, secret: SECRET, now });

    expect(out.status).toBe(202);
    expect(out.body).toEqual({ ok: true });
    expect(out.job).toEqual({ reason: "profile_update", ctUserId: 17760356, eventTimestamp: 1_699_999_999_000 });
  });

  it("unwraps Connecteam's array `data` envelope", async () => {
    // The real user_updated envelope: { requestId, company, eventType, eventTimestamp, data: [ {...} ] }
    const body = JSON.stringify({
      requestId: "abc",
      company: "co_1",
      eventType: "user_updated",
      eventTimestamp: 1_699_999_999,
      data: [{ userId: 14504723, firstName: "redacted" }],
    });
    const out = await handleWebhook({ rawBody: body, signatureHeader: SECRET, secret: SECRET, now });

    expect(out.status).toBe(202);
    expect(out.job).toEqual({ reason: "profile_update", ctUserId: 14504723, eventTimestamp: 1_699_999_999_000 });
  });

  it("falls back to now() when the payload carries no timestamp", async () => {
    const body = JSON.stringify({ data: { userId: 42 } });
    const out = await handleWebhook({ rawBody: body, signatureHeader: SECRET, secret: SECRET, now });
    expect(out.job?.eventTimestamp).toBe(NOW);
  });

  it("normalises an epoch-seconds timestamp to millis", async () => {
    const body = JSON.stringify({ userId: 42, timestamp: 1_699_999_999 });
    const out = await handleWebhook({ rawBody: body, signatureHeader: SECRET, secret: SECRET, now });
    expect(out.job?.eventTimestamp).toBe(1_699_999_999_000);
  });
});

describe("handleWebhook - reject paths (nothing enqueued)", () => {
  const body = JSON.stringify({ data: { userId: 1 } });

  it("rejects a wrong secret with 401", async () => {
    const out = await handleWebhook({ rawBody: body, signatureHeader: "wrong-secret", secret: SECRET, now });
    expect(out.status).toBe(401);
    expect(out.job).toBeUndefined();
  });

  it("rejects a missing secret header with 401", async () => {
    const out = await handleWebhook({ rawBody: body, signatureHeader: null, secret: SECRET, now });
    expect(out.status).toBe(401);
    expect(out.job).toBeUndefined();
  });

  it("rejects malformed JSON with 400", async () => {
    const raw = "{not json";
    const out = await handleWebhook({ rawBody: raw, signatureHeader: SECRET, secret: SECRET, now });
    expect(out.status).toBe(400);
    expect(out.job).toBeUndefined();
  });

  it("rejects a payload with no user id with 400", async () => {
    const raw = JSON.stringify({ eventType: "user_updated", data: { name: "no id here" } });
    const out = await handleWebhook({ rawBody: raw, signatureHeader: SECRET, secret: SECRET, now });
    expect(out.status).toBe(400);
    expect(out.job).toBeUndefined();
  });

  it("returns 500 when no webhook secret is configured", async () => {
    const out = await handleWebhook({ rawBody: body, signatureHeader: SECRET, secret: "", now });
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

  it("reads the id from an array-wrapped data envelope", () => {
    expect(parseUserEdit({ data: [{ userId: 123 }] }, NOW)?.ctUserId).toBe(123);
    expect(parseUserEdit({ data: [{ id: 456 }] }, NOW)?.ctUserId).toBe(456);
  });

  it("returns null when there is no usable id", () => {
    expect(parseUserEdit({ data: {} }, NOW)).toBeNull();
    expect(parseUserEdit({ data: [] }, NOW)).toBeNull();
    expect(parseUserEdit({ userId: 0 }, NOW)).toBeNull();
    expect(parseUserEdit("nope", NOW)).toBeNull();
    expect(parseUserEdit(null, NOW)).toBeNull();
  });
});

describe("describeShape", () => {
  it("sketches keys and container types without values", () => {
    expect(describeShape({ requestId: "x", data: [{ userId: 1, name: "secret" }] })).toBe(
      "{requestId:string,data:[{userId:number,name:string}]}",
    );
  });
});
