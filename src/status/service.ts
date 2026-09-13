/**
 * Wires the pure roster/digest logic to Connecteam and D1 for `GET /status`,
 * `POST /status/digest`, and the weekly cron digest (issue #44).
 *
 * Honest limit (also documented in RUNBOOK.md): `ready` means EH accepted every
 * value we sent and reports the record payroll-ready - NOT that the values are
 * truthful. EH validates format only; it never rejects a bad TFN at the API, it
 * just stores it and marks the record Incomplete (see CONTEXT.md "Validation
 * failure"). Human correctness of the data stays a spot-check, not a per-record
 * guarantee this roster can make.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import type { StatusGateway } from "../sync/gateway.js";
import {
  deriveRosterEntry,
  summarizeRoster,
  type RosterCounts,
  type RosterEntry,
} from "./roster.js";
import { digestMessages, type DigestEmployee } from "./digest.js";

export interface StatusDeps {
  store: StatusGateway;
  ct: Pick<ConnecteamClient, "getUser" | "sendChannelMessage">;
  adminChannelId: string;
}

export interface StatusEmployee extends RosterEntry {
  /** Best-effort display name, fetched from Connecteam. Omitted for `ready` rows to avoid an unnecessary lookup. */
  name?: string;
}

export interface StatusRoster {
  generatedAt: string;
  counts: RosterCounts;
  employees: StatusEmployee[];
}

/**
 * One entry per person the sync has ever touched. Names are fetched from
 * Connecteam best-effort, and only for anyone not `ready` - a `ready` roster of
 * any real size would otherwise mean one Connecteam call per employee on every
 * request for a name nobody asked to see (the state + reasons + ids are enough
 * for a fully-synced person).
 */
export async function buildStatusRoster(deps: Pick<StatusDeps, "store" | "ct">): Promise<StatusRoster> {
  const rows = await deps.store.listRosterRows();
  const entries = rows.map(deriveRosterEntry);

  const employees: StatusEmployee[] = [];
  for (const entry of entries) {
    if (entry.state === "ready") {
      employees.push(entry);
      continue;
    }
    const name = await personName(deps.ct, entry.ctUserId);
    employees.push(name ? { ...entry, name } : entry);
  }

  return { generatedAt: new Date().toISOString(), counts: summarizeRoster(entries), employees };
}

/** Send the digest to the admin channel right now, unconditionally. */
export async function runStatusDigestNow(deps: StatusDeps): Promise<void> {
  const roster = await buildStatusRoster(deps);
  const messages = digestMessages(roster.employees as DigestEmployee[], roster.employees.length);
  for (const text of messages) {
    await deps.ct.sendChannelMessage(deps.adminChannelId, text);
  }
}

/** At least this long between two automatic digests, regardless of how often the cron ticks. */
export const STATUS_DIGEST_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;
const DEFAULT_DIGEST_DAY = 1; // Monday (UTC), matching most payroll admins' work week.

function isDigestDay(dayVar: string | undefined, now: Date): boolean {
  const n = Number(dayVar);
  const day = Number.isInteger(n) && n >= 0 && n <= 6 ? n : DEFAULT_DIGEST_DAY;
  return now.getUTCDay() === day;
}

/**
 * Called from the 1-minute cron (src/index.ts), same pattern as
 * `maybeRunRecheck` / `maybePushHealth`: no dedicated Cloudflare Cron Trigger,
 * just a day-of-week check plus a "last sent" marker in `sync_meta` so a
 * digest fires once on its configured day even though the cron ticks every
 * minute.
 */
export async function maybeRunStatusDigest(
  deps: StatusDeps & { digestDay?: string; now?: () => number },
): Promise<"sent" | "skipped"> {
  const now = deps.now ?? Date.now;
  if (!isDigestDay(deps.digestDay, new Date(now()))) return "skipped";

  const last = (await deps.store.readMeta(["last_status_digest_at"])).last_status_digest_at ?? 0;
  if (now() - last < STATUS_DIGEST_MIN_GAP_MS) return "skipped";

  await runStatusDigestNow(deps);
  await deps.store.setMarker("last_status_digest_at", now());
  return "sent";
}

async function personName(
  ct: Pick<ConnecteamClient, "getUser">,
  ctUserId: number,
): Promise<string | undefined> {
  try {
    const res = await ct.getUser(ctUserId);
    if (res.outcome === "ok" && res.data) {
      const name = [res.data.firstName, res.data.lastName].filter(Boolean).join(" ").trim();
      return name || undefined;
    }
  } catch {
    // best-effort - fall back to the id-only label
  }
  return undefined;
}
