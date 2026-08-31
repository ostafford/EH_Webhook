/**
 * The one place the Worker writes to `console`. Every event goes through
 * {@link redact} first, and is emitted as a single JSON line so Workers
 * observability can index it. Call it with identifiers and outcomes only.
 */
import { redact } from "./redact.js";

export type LogEvent = Record<string, unknown> & { evt: string };

export function logEvent(event: LogEvent): void {
  const line = redact({ ts: new Date().toISOString(), ...event });
  console.log(JSON.stringify(line));
}
