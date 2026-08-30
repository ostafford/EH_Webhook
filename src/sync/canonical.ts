/**
 * Deterministic serialisation + SHA-256, used to fingerprint a mapped payload so
 * the queue consumer can skip an edit that produces byte-for-byte the same sync.
 * Pure; `crypto.subtle` is a global in both the Workers runtime and Node 20+.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Convenience: canonical-serialise then hash. */
export function payloadHash(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}
