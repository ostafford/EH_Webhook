/**
 * Optional out-of-band telemetry to the integrator (the person who set the
 * client up), separate from the client's own **alerts channel**. If
 * `INTEGRATOR_ALERT_URL` is set, the Worker POSTs a small JSON body there:
 *   - `{ kind: "system_alert", client, ctUserId, reason, at }` when a sync
 *     dead-letters (deduped per user for an hour), and
 *   - `{ kind: "health", client, ok, d1, fieldMap, ops, at }` once every 24 h.
 *
 * `client` is `INTEGRATOR_CLIENT_ID` - the slug the shared relay
 * (`integrator-relay/`, issue #23) uses to keep one GitHub issue per client.
 *
 * Best-effort: it never blocks a request or throws. The body carries ids,
 * outcomes and counts only, and is passed through {@link redact} regardless.
 */
import { redact } from "./redact.js";

export interface IntegratorEnv {
  INTEGRATOR_ALERT_URL?: string;
  INTEGRATOR_ALERT_SECRET?: string;
}

export const SYSTEM_ALERT_DEDUPE_MS = 60 * 60 * 1000;
export const HEALTH_PUSH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function postIntegrator(
  env: IntegratorEnv,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.INTEGRATOR_ALERT_URL) return;
  try {
    await fetchImpl(env.INTEGRATOR_ALERT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.INTEGRATOR_ALERT_SECRET ? { "x-eh-sync-secret": env.INTEGRATOR_ALERT_SECRET } : {}),
      },
      body: JSON.stringify(redact(body)),
    });
  } catch {
    // telemetry must never affect the sync
  }
}
