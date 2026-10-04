/**
 * The wizard's field-map check (issue #56): validates a client's
 * field-map.json against the schema and lists only its problems, so the
 * human can loop "tune -> check -> tune" without the full test suite's output.
 */
import { fieldMapIssues } from "../../src/mapping/schema.js";

export type FieldMapCheck = { ok: true } | { ok: false; problems: string[] };

export function checkFieldMapText(text: string): FieldMapCheck {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, problems: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const problems = fieldMapIssues(json);
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export function renderFieldMapCheck(path: string, check: FieldMapCheck): string {
  if (check.ok) return `✓ ${path} is valid.`;
  const n = check.problems.length;
  return [`✗ ${path} has ${n} problem${n === 1 ? "" : "s"}:`, ...check.problems.map((p) => `    ${p}`)].join("\n");
}
