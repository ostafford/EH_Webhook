import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature, type SignatureScheme } from "../src/connecteam/signature.js";

const SECRET = "s3cr3t-webhook-key";
const BODY = JSON.stringify({ eventType: "user_updated", data: { userId: 123 } });

describe("verifyWebhookSignature - shared_secret (Connecteam v1, the default)", () => {
  it("accepts the secret sent verbatim in the header", async () => {
    expect(await verifyWebhookSignature(BODY, SECRET, SECRET)).toBe(true);
  });

  it("tolerates surrounding whitespace on the header value", async () => {
    expect(await verifyWebhookSignature(BODY, `  ${SECRET}\n`, SECRET)).toBe(true);
  });

  it("does not care about the body (no signing)", async () => {
    expect(await verifyWebhookSignature(BODY + " tampered", SECRET, SECRET)).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    expect(await verifyWebhookSignature(BODY, "nope", SECRET)).toBe(false);
  });

  it("rejects a missing or empty header", async () => {
    expect(await verifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(await verifyWebhookSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects when no secret is configured", async () => {
    expect(await verifyWebhookSignature(BODY, SECRET, "")).toBe(false);
  });
});

describe("verifyWebhookSignature - hmac mode (kept for a future signed version)", () => {
  const hexScheme: SignatureScheme = { mode: "hmac", header: "x-sig", encoding: "hex" };
  const b64Scheme: SignatureScheme = { mode: "hmac", header: "x-sig", encoding: "base64" };
  const hexSig = createHmac("sha256", SECRET).update(BODY).digest("hex");
  const b64Sig = createHmac("sha256", SECRET).update(BODY).digest("base64");

  it("accepts a correct HMAC-SHA256 hex signature", async () => {
    expect(await verifyWebhookSignature(BODY, hexSig, SECRET, hexScheme)).toBe(true);
  });

  it("defaults to hex encoding when the scheme omits it", async () => {
    expect(await verifyWebhookSignature(BODY, hexSig, SECRET, { mode: "hmac", header: "x-sig" })).toBe(true);
  });

  it("accepts a correct base64 signature when the scheme says so", async () => {
    expect(await verifyWebhookSignature(BODY, b64Sig, SECRET, b64Scheme)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const bad = createHmac("sha256", "not-the-secret").update(BODY).digest("hex");
    expect(await verifyWebhookSignature(BODY, bad, SECRET, hexScheme)).toBe(false);
  });

  it("rejects when the body has been tampered with", async () => {
    expect(await verifyWebhookSignature(BODY + " ", hexSig, SECRET, hexScheme)).toBe(false);
  });
});
