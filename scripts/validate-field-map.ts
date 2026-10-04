/**
 * `npm run validate-field-map -- --client <slug>`
 *
 * Checks clients/<slug>/field-map.json (default: self) against the schema the
 * Worker uses, and prints only its problems (issue #56). The wizard's
 * "Field map" stage loops on it while the human tunes the map; the full
 * `npm test` still runs once, later, as the final gate.
 *
 * Exit code: 0 = valid, 1 = invalid or unreadable.
 */
import { readFileSync } from "node:fs";
import { checkFieldMapText, renderFieldMapCheck } from "./lib/validate-field-map.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const path = `clients/${arg("client") || "self"}/field-map.json`;
let text: string;
try {
  text = readFileSync(path, "utf8");
} catch {
  console.log(`✗ ${path} not found.`);
  process.exit(1);
}
const check = checkFieldMapText(text);
console.log(renderFieldMapCheck(path, check));
if (!check.ok) process.exitCode = 1;
