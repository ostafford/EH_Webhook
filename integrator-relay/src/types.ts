/**
 * The telemetry bodies a client Worker POSTs here. Mirrors what
 * `src/integrator.ts` in the main repo sends. Everything is identifiers,
 * outcomes and counts - never an employee value.
 */

export interface SystemAlert {
  kind: "system_alert";
  /** Client slug (INTEGRATOR_CLIENT_ID). "" / missing -> "unknown-client". */
  client?: string;
  ctUserId: number;
  reason: string;
  /** ISO timestamp from the client. */
  at: string;
}

export interface HealthPush {
  kind: "health";
  client?: string;
  ok: boolean;
  d1?: string;
  fieldMap?: string;
  ops?: unknown;
  at: string;
}

export type Telemetry = SystemAlert | HealthPush;

/** Narrow an untrusted body to a Telemetry, or null if it isn't one. */
export function parseTelemetry(body: unknown): Telemetry | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (b.kind === "system_alert") {
    if (typeof b.ctUserId !== "number" || !Number.isFinite(b.ctUserId)) return null;
    return {
      kind: "system_alert",
      client: typeof b.client === "string" ? b.client : "",
      ctUserId: b.ctUserId,
      reason: typeof b.reason === "string" ? b.reason : "(no reason given)",
      at: typeof b.at === "string" ? b.at : new Date().toISOString(),
    };
  }

  if (b.kind === "health") {
    if (typeof b.ok !== "boolean") return null;
    return {
      kind: "health",
      client: typeof b.client === "string" ? b.client : "",
      ok: b.ok,
      ...(typeof b.d1 === "string" ? { d1: b.d1 } : {}),
      ...(typeof b.fieldMap === "string" ? { fieldMap: b.fieldMap } : {}),
      ...("ops" in b ? { ops: b.ops } : {}),
      at: typeof b.at === "string" ? b.at : new Date().toISOString(),
    };
  }

  return null;
}

/** "" / whitespace / missing -> a stable placeholder. */
export function clientSlug(client: string | undefined): string {
  const s = (client ?? "").trim();
  return s || "unknown-client";
}
