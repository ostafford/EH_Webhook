/**
 * Composes the weekly (or on-demand) admin-channel status digest (issue #44):
 * everyone NOT `ready`, grouped by state, one line each. Silent-but-for-a-line
 * when everyone is ready. Pure - no network, no D1.
 *
 * `ConnecteamClient.sendChannelMessage` clamps any single message to 500 chars
 * (see connecteam/client.ts), which would silently truncate a roster of any
 * real size mid-sentence. `digestMessages` returns an array instead of one
 * string - the caller sends each chunk as its own channel message - so a long
 * roster is never cut off, only split.
 */
import type { RosterEntry, RosterState } from "./roster.js";

export interface DigestEmployee extends RosterEntry {
  /** Best-effort display name; falls back to the id-only label when absent. */
  name?: string | null;
}

const STATE_ORDER: readonly Exclude<RosterState, "ready">[] = [
  "waiting_on_employee",
  "waiting_on_admin",
  "broken",
];

const STATE_LABEL: Record<Exclude<RosterState, "ready">, string> = {
  waiting_on_employee: "Waiting on employee",
  waiting_on_admin: "Waiting on admin",
  broken: "Broken",
};

const MAX_CHUNK = 480;

function who(e: DigestEmployee): string {
  const name = (e.name ?? "").trim();
  return name ? `${name} (${e.ctUserId})` : `Connecteam user ${e.ctUserId}`;
}

/** One or more admin-channel messages, each already within the 500-char clamp. */
export function digestMessages(employees: readonly DigestEmployee[], totalCount: number): string[] {
  const nonReady = employees.filter((e) => e.state !== "ready");
  if (nonReady.length === 0) {
    const singular = totalCount === 1;
    return [`All ${totalCount} employee${singular ? "" : "s"} ${singular ? "is" : "are"} Complete in Employment Hero - no follow-up needed.`];
  }

  const lines: string[] = [
    `Payroll sync status: ${nonReady.length} of ${totalCount} employees need attention.`,
  ];
  for (const state of STATE_ORDER) {
    const group = nonReady.filter((e) => e.state === state);
    if (group.length === 0) continue;
    lines.push("", `${STATE_LABEL[state]}:`);
    for (const e of group) {
      const reason = e.reasons.join("; ") || "see the audit log";
      lines.push(`- ${who(e)} — ${reason}`);
    }
  }
  return chunk(lines);
}

/** Pack lines into messages no longer than {@link MAX_CHUNK}, splitting on line boundaries only. */
function chunk(lines: readonly string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > MAX_CHUNK && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out.length > 1 ? out.map((c, i) => (i === 0 ? c : `(cont.) ${c}`)) : out;
}
