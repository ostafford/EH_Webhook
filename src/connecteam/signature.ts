/**
 * Verifies that an inbound webhook really came from Connecteam, using the
 * `CT_WEBHOOK_SECRET` shared with the webhook registration.
 *
 * @todo #7 - Connecteam does not publish the header name or encoding. The
 * defaults below are the common convention (HMAC-SHA256 of the raw request
 * body, lowercase hex). Confirm against a real delivery in #7 and adjust
 * `DEFAULT_SCHEME` - nothing else needs to change.
 */
export interface SignatureScheme {
  /** Lower-cased HTTP header that carries the signature. */
  header: string;
  encoding: "hex" | "base64";
}

export const DEFAULT_SCHEME: SignatureScheme = {
  header: "x-connecteam-signature",
  encoding: "hex",
};

const enc = new TextEncoder();

export async function verifyWebhookSignature(
  rawBody: string,
  headerValue: string | null | undefined,
  secret: string,
  scheme: SignatureScheme = DEFAULT_SCHEME,
): Promise<boolean> {
  if (!headerValue || !secret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = scheme.encoding === "hex" ? toHex(mac) : toBase64(mac);
  return timingSafeEqual(expected, headerValue.trim());
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** Constant-time string compare. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
