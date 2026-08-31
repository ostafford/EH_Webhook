/**
 * Last line of defence for logging. `redact` deep-copies a value and replaces
 * anything held under a sensitive key with `"[redacted]"`, so a mapped payload
 * or an error object that slips into a log line never carries a tax file number,
 * bank detail or credential.
 *
 * The audit trail (`sync_log`) does not rely on this - it only ever stores field
 * NAMES and outcomes (see auditDetail in src/sync/decide.ts). This guard is for
 * `console` output.
 */
const SENSITIVE_KEY =
  /(^|_)(tfn|tax_?file_?number|bsb|account_?number|account_?name|bank_?account|member_?number|routing|iban|sort_?code|password|secret|api_?key|apikey|authorization|auth_?token|token|bearer|cookie)($|_|[0-9])/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(v, depth + 1);
  }
  return out as T;
}
