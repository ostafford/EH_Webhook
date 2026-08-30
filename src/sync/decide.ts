/**
 * Turns the outcome of one sync attempt into a single decision: synced cleanly,
 * the employee must fix a value, a payroll admin must finish something by hand,
 * or the attempt should be retried. Pure - no network, no logging, no D1.
 *
 * What triggers a correction (issue #5, decisions locked during design):
 *   - `applyFieldMap` produced field issues, so the payload was never sent, OR
 *   - EH rejected the write with an HTTP 400 validation body, OR
 *   - the write succeeded (2xx) but the record is still `Incomplete` - this is
 *     where a bad TFN surfaces: EH accepts it (200) and marks the record
 *     Incomplete, it is never a 400, so the hint comes from `detailedStatus`, OR
 *   - a post-write read-back of non-sensitive fields disagrees with what we sent.
 *
 * `retry` covers only faults the employee cannot fix (EH outage, auth failure,
 * unexpected 4xx). The queue retries those and, once exhausted, they become a
 * System alert to the admin channel.
 */
import type { EhResult } from "../eh/client.js";
import type { EhFieldError } from "../eh/errors.js";
import type { EhWriteResult } from "../eh/types.js";
import type { MappingIssue, PayloadValue } from "../mapping/apply.js";

export type SyncDecision =
  | { kind: "ok" }
  | { kind: "correction"; fields: EhFieldError[] }
  | { kind: "follow_up"; reasons: string[] }
  | { kind: "retry"; detail: string };

/** Result of comparing what we sent against a post-write read-back. */
export interface ReadBackResult {
  matched: boolean;
  mismatches: EhFieldError[];
}

export interface DecideInput {
  /** Field problems from `applyFieldMap`. Non-empty => the payload was NOT sent. */
  mappingIssues?: MappingIssue[];
  /** The EH upsert result. Absent when `mappingIssues` stopped the send. */
  write?: EhResult<EhWriteResult>;
  /** Plain-language admin follow-ups from `applyFieldMap`. */
  followUps?: string[];
  /** Optional post-write read-back comparison (non-sensitive fields only). */
  readBack?: ReadBackResult;
}

const INCOMPLETE = "incomplete";

export function decide(input: DecideInput): SyncDecision {
  const mappingIssues = input.mappingIssues ?? [];
  if (mappingIssues.length > 0) {
    return { kind: "correction", fields: mappingIssues.map(issueToFieldError) };
  }

  const { write } = input;
  if (!write) return { kind: "retry", detail: "no write result to decide on" };

  switch (write.outcome) {
    case "validation":
      return { kind: "correction", fields: write.issues };
    case "retryable":
      return { kind: "retry", detail: write.detail };
    case "client_error":
      // 401 / 403 / 404 / an unhandled 4xx: not something the employee can fix.
      // Let the queue retry and, on exhaustion, dead-letter it to a System alert.
      return { kind: "retry", detail: `EH ${write.status}: ${write.detail}` };
    case "ok": {
      const { status, detailedStatus } = write.data;
      if ((status ?? "").toLowerCase().includes(INCOMPLETE)) {
        return { kind: "correction", fields: [incompleteFieldError(detailedStatus)] };
      }
      if (input.readBack && !input.readBack.matched) {
        return { kind: "correction", fields: input.readBack.mismatches };
      }
      const followUps = input.followUps ?? [];
      if (followUps.length > 0) return { kind: "follow_up", reasons: followUps };
      return { kind: "ok" };
    }
  }
}

/**
 * Compare a sent payload against a read-back record, non-sensitive fields only.
 * TFN, bank and super member values are never compared (never re-fetched).
 * Pass `fields` to restrict the comparison to a known-safe subset.
 */
const SENSITIVE = /taxfilenumber|tfn|bankaccount|membernumber/i;

export function compareReadBack(
  sent: Record<string, PayloadValue>,
  fetched: Record<string, unknown>,
  fields?: string[],
): ReadBackResult {
  const keys = (fields ?? Object.keys(sent)).filter((k) => !SENSITIVE.test(k));
  const mismatches: EhFieldError[] = [];
  for (const key of keys) {
    if (!(key in sent)) continue;
    if (norm(sent[key]) !== norm(fetched[key])) {
      mismatches.push({ field: key, reason: "value did not match after the write" });
    }
  }
  return { matched: mismatches.length === 0, mismatches };
}

/** A redaction-safe one-line audit string: field NAMES and status hints only. */
export function auditDetail(decision: SyncDecision): string {
  switch (decision.kind) {
    case "ok":
      return "synced";
    case "retry":
      return `retry: ${decision.detail}`;
    case "follow_up":
      return `follow_up: ${decision.reasons.join(" | ")}`;
    case "correction": {
      const names = [...new Set(decision.fields.map((f) => f.field))];
      return `correction: ${names.join(", ")}`;
    }
  }
}

function issueToFieldError(i: MappingIssue): EhFieldError {
  return { field: i.ehField, reason: i.reason };
}

function incompleteFieldError(detailedStatus: string | null): EhFieldError {
  const reason =
    detailedStatus && detailedStatus.trim() !== ""
      ? detailedStatus.trim()
      : "Employment Hero marked the record incomplete.";
  return { field: "(incomplete)", reason };
}

function norm(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim().toLowerCase();
}
