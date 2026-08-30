import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/connecteam/signature.js";

const SECRET = "s3cr3t-webhook-key";
const BODY = JSON.stringify({ eventType: "user_updated", data: { userId: 123 } });
const hexSig = createHmac("sha256", SECRET).update(BODY).digest("hex");
const b64Sig = createHmac("sha256", SECRET).update(BODY).digest("base64");

describe("verifyWebhookSignature", () => {
  it("accepts a correct HMAC-SHA256 hex signature", async () => {
    expect(await verifyWebhookSignature(BODY, hexSig, SECRET)).toBe(true);
  });

  it("accepts a correct base64 signature when the scheme says so", async () => {
    expect(
      await verifyWebhookSignature(BODY, b64Sig, SECRET, { header: "x-sig", encoding: "base64" }),
    ).toBe(true);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const bad = createHmac("sha256", "not-the-secret").update(BODY).digest("hex");
    expect(await verifyWebhookSignature(BODY, bad, SECRET)).toBe(false);
  });

  it("rejects when the body has been tampered with", async () => {
    expect(await verifyWebhookSignature(BODY + " ", hexSig, SECRET)).toBe(false);
  });

  it("rejects a missing or empty signature header", async () => {
    expect(await verifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(await verifyWebhookSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects when no secret is configured", async () => {
    expect(await verifyWebhookSignature(BODY, hexSig, "")).toBe(false);
  });
});
