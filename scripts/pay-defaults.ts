/**
 * `npm run pay-defaults -- --client <slug>`
 *
 * Interactive pay-run picker (issue #62). Lists the client's Employment Hero
 * pay schedules, locations and primary pay categories, lets them pick each by
 * number, asks how each employee's pay rate reaches EH, and writes the result
 * into `employmentHero` in clients/<slug>/field-map.json. No hand-typed IDs or
 * names: every choice comes from the client's live EH lists.
 *
 * Company-wide only - one value for every employee (see #75 for per-employee).
 *
 * Env (from .dev.vars or the shell): EH_API_KEY, and CT_API_KEY to find the
 * award dropdown (`npm run provision-classification-field`). EH_BUSINESS_ID if
 * the field map has none yet.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseFieldMap } from "../src/mapping/schema.js";
import { applyPayRunChoice, primaryPayCategoryOptions, rateSourceOptions } from "./lib/pay-run-choice.js";
import { listRawCustomFields } from "./lib/connecteam-custom-fields.js";
import { AWARD_FIELD_NAME, findAwardField } from "./lib/award-field.js";

// --- env -----------------------------------------------------------------

function loadDevVars(): void {
  try {
    const path = fileURLToPath(new URL("../.dev.vars", import.meta.url));
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/\r$/, "");
    }
  } catch {
    /* no .dev.vars - rely on the shell env */
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// --- HTTP --------------------------------------------------------------

async function ctGet(path: string): Promise<any> {
  const r = await fetch(`https://api.connecteam.com${path}`, {
    headers: { "X-API-KEY": process.env.CT_API_KEY!, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Connecteam GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function ehGet(path: string): Promise<any> {
  const r = await fetch(`https://api.yourpayroll.com.au/api/v2${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`${process.env.EH_API_KEY}:`).toString("base64")}`, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Employment Hero GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// --- prompts -------------------------------------------------------------

// Read lines through the async iterator: it buffers, so answers typed (or
// piped) ahead of a prompt aren't lost the way `rl.question` loses them.
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const next = await lines.next();
  if (next.done) throw new Error("input ended before every question was answered");
  return next.value;
}

/** Numbered pick; Enter keeps `current` when it is one of the options. */
async function choose<T>(title: string, options: T[], label: (o: T) => string, current?: number): Promise<T> {
  console.log(`\n${title}`);
  options.forEach((o, i) => console.log(`  ${String(i + 1).padStart(2)}) ${label(o)}${i === current ? "   (current)" : ""}`));
  for (;;) {
    const hint = current !== undefined ? ` [Enter = ${current + 1}]` : "";
    const answer = (await ask(`  Choose 1-${options.length}${hint}: `)).trim();
    if (!answer && current !== undefined) return options[current]!;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
    console.log("  Please enter one of the numbers above.");
  }
}

const indexOf = <T>(list: T[], match: (o: T) => boolean): number | undefined => {
  const i = list.findIndex(match);
  return i === -1 ? undefined : i;
};

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  loadDevVars();
  const client = arg("client");
  if (!client) throw new Error("usage: npm run pay-defaults -- --client <slug>");
  if (!process.env.EH_API_KEY) throw new Error("EH_API_KEY must be set (in .dev.vars or the shell)");

  const mapFile = join(dirname(fileURLToPath(import.meta.url)), "..", "clients", client, "field-map.json");
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  const businessId = [map.employmentHero?.businessId, process.env.EH_BUSINESS_ID].find((v) => v && v !== "TODO");
  if (!businessId) throw new Error("no EH business id - set employmentHero.businessId or EH_BUSINESS_ID");
  const current = map.employmentHero?.defaults ?? {};

  const [schedules, locations, categories] = await Promise.all([
    ehGet(`/business/${businessId}/payschedule`),
    ehGet(`/business/${businessId}/location`),
    ehGet(`/business/${businessId}/paycategory`),
  ]);
  if (!schedules.length) throw new Error("Employment Hero has no pay schedules - create one in EH first");
  if (!locations.length) throw new Error("Employment Hero has no locations - create one in EH first");

  console.log(`\nPay-run settings for Employment Hero business ${businessId}.`);
  console.log("These apply to EVERY employee the sync creates. Pick each from your EH lists.");

  const paySchedule = await choose("Pay schedule (how often employees are paid):", schedules, (s: any) => s.name,
    indexOf(schedules, (s: any) => s.name === current.paySchedule));
  const location = await choose("Primary location:", locations, (l: any) => l.fullyQualifiedName ?? l.name,
    indexOf(locations, (l: any) => l.name === current.primaryLocation));

  const primary = primaryPayCategoryOptions(categories);
  const showAll = { name: `Show all ${categories.length} pay categories`, note: undefined as string | undefined };
  let category = await choose("Primary pay category (the pay category ordinary hours are paid under):",
    [...primary, showAll], (c) => (c.note ? `${c.name}  (${c.note})` : c.name),
    indexOf(primary, (c) => c.name === current.primaryPayCategory));
  if (category === showAll) {
    const all = categories.map((c: any) => ({ name: String(c.name), note: c.awardName ?? undefined }));
    category = await choose("All pay categories:", all, (c: any) => (c.note ? `${c.name}  (${c.note})` : c.name));
  }

  // The award dropdown the wizard's award stage created, if any.
  const awardField = process.env.CT_API_KEY ? findAwardField(await listRawCustomFields(ctGet)) : undefined;
  const sources = rateSourceOptions(map, awardField?.id);
  if (!sources.some((s) => s.key === "award")) {
    console.log(
      `\n  (Award classification isn't offered: there is no "${AWARD_FIELD_NAME}" field in Connecteam - import it with\n` +
        `   npm run provision-classification-field, then re-run npm run pay-defaults -- --client ${client}.)`,
    );
  }
  const rateSource = await choose("How does each employee's pay rate reach Employment Hero?", sources, (s) => s.label);

  const updated = applyPayRunChoice(map, {
    paySchedule: { id: paySchedule.id, name: paySchedule.name },
    location: { id: location.id, name: location.name },
    primaryPayCategory: category.name,
    rateSource: rateSource.key,
    ...(awardField ? { awardFieldId: Number(awardField.id) } : {}),
  });
  if (rateSource.key === "skip") {
    console.log("\nSkipped - the field map is unchanged. Payroll sets pay settings in Employment Hero by hand.");
    return;
  }
  parseFieldMap(updated); // never write a map the Worker would reject
  writeFileSync(mapFile, JSON.stringify(updated, null, 2) + "\n");

  console.log(`\nSaved to ${mapFile}:`);
  console.log(`  Pay schedule       ${paySchedule.name}`);
  console.log(`  Primary location   ${location.name}`);
  console.log(`  Pay category       ${category.name}`);
  console.log(`  Pay rate from      ${rateSource.label}`);
}

main()
  .catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => rl.close());
