/**
 * `npm run discover -- --client <slug>`
 *
 * Talks to a prospective client's Connecteam and Employment Hero accounts with
 * the two API keys, and writes:
 *   - clients/<slug>/field-map.json   — a DRAFT mapping (every mapped field is a
 *                                        best-effort name match; TODOs elsewhere)
 *   - stdout                          — a configuration checklist (every var and
 *                                        secret, with the discovered value or a TODO)
 *
 * It never writes employee values anywhere - it reads custom-field NAMES and
 * types, and the account's structural ids.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, EH_API_KEY.
 * Optional: EH_BUSINESS_ID, CT_ONBOARDING_PACK_ID (skip the pickers).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFieldMap } from "../src/mapping/schema.js";

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

// --- known Connecteam-name -> EH-field rules (from docs/field-mapping.md) ---

interface Known {
  match: RegExp;
  eh: string;
  transform: string;
  required?: boolean;
  sensitive?: boolean;
  map?: Record<string, string>;
}

const KNOWN: Known[] = [
  { match: /legal first name/i, eh: "firstName", transform: "trimString", required: true },
  { match: /legal surname/i, eh: "surname", transform: "trimString", required: true },
  { match: /birthday|date of birth/i, eh: "dateOfBirth", transform: "dateDmyToIso", required: true },
  { match: /^gender/i, eh: "gender", transform: "dropdownValue", map: { Male: "Male", Female: "Female", Other: "Indeterminate" } },
  { match: /street address/i, eh: "residentialStreetAddress", transform: "locationStreetLine" },
  { match: /suburb/i, eh: "residentialSuburb", transform: "trimString" },
  { match: /^state/i, eh: "residentialState", transform: "dropdownValue" },
  { match: /postcode|post code/i, eh: "residentialPostCode", transform: "zeroPad4" },
  { match: /country/i, eh: "residentialCountry", transform: "locationFull", map: { Australia: "AU" } },
  { match: /emergency contact name/i, eh: "emergencyContact1_Name", transform: "trimString" },
  { match: /emergency contact (number|phone)/i, eh: "emergencyContact1_ContactNumber", transform: "trimString" },
  { match: /emergency contact relationship/i, eh: "emergencyContact1_Relationship", transform: "trimString" },
  { match: /employment start date|start date/i, eh: "startDate", transform: "dateDmyToIso", required: true },
  { match: /^title/i, eh: "jobTitle", transform: "trimString" },
  { match: /employee status/i, eh: "employmentType", transform: "dropdownValue", map: { FullTime: "FullTime", PartTime: "PartTime", Casual: "Casual", LabourHire: "LabourHire" } },
  { match: /^tfn|tax file number/i, eh: "taxFileNumber", transform: "digits", required: true, sensitive: true },
  { match: /name on bank account/i, eh: "bankAccount1_AccountName", transform: "trimString", sensitive: true },
  { match: /^bsb/i, eh: "bankAccount1_BSB", transform: "zeroPad6", sensitive: true },
  { match: /account number/i, eh: "bankAccount1_AccountNumber", transform: "digits", sensitive: true },
];

const TAX_DECLARATION: Array<{ match: RegExp; key: string }> = [
  { match: /tax-?free threshold/i, key: "claimTaxFreeThreshold" },
  { match: /australian resident/i, key: "australianResident" },
  { match: /help.*debt|stsl|study.*debt/i, key: "hasHelpOrStslDebt" },
];

const SUPER: Array<{ match: RegExp; key: string }> = [
  { match: /super.*usi|usi/i, key: "usiField" },
  { match: /super.*abn/i, key: "abnField" },
  { match: /super fund name/i, key: "fundNameField" },
  { match: /member number/i, key: "memberNumberField" },
];

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  loadDevVars();
  const client = arg("client");
  if (!client) throw new Error("usage: npm run discover -- --client <slug>");
  if (!process.env.CT_API_KEY || !process.env.EH_API_KEY) {
    throw new Error("CT_API_KEY and EH_API_KEY must be set (in .dev.vars or the shell)");
  }

  // Connecteam: pack + one user's custom-field metadata
  let packId = Number(process.env.CT_ONBOARDING_PACK_ID) || undefined;
  const packs = await ctGet("/onboarding/v1/packs").then((b) => b?.data?.packs ?? b?.data ?? []);
  if (!packId && packs.length) packId = packs[0].id ?? packs[0].packId;
  if (!packId) throw new Error("no onboarding pack found - set CT_ONBOARDING_PACK_ID");

  const assignments = await ctGet(`/onboarding/v1/packs/${packId}/assignments`).then((b) => b?.data?.assignments ?? []);
  if (!assignments.length) throw new Error(`pack ${packId} has no assignments to sample custom fields from`);

  // Some assignments point at users that no longer exist or have no custom
  // fields populated - scan until we find one with a real field set.
  let fields: Array<{ customFieldId: number; name: string; type: string }> = [];
  for (const a of assignments.slice(0, 15)) {
    const user = await ctGet(`/users/v1/users?userIds=${a.userId}&limit=1&offset=0`).then(
      (b) => (b?.data?.users ?? []).find((u: any) => u.userId === a.userId),
    );
    const cf = user?.customFields ?? [];
    if (cf.length > fields.length) {
      fields = cf.map((f: any) => ({
        customFieldId: f.customFieldId,
        name: String(f.name ?? ""),
        type: String(f.type ?? ""),
      }));
    }
    if (fields.length >= 15) break;
  }
  if (!fields.length) throw new Error(`no user in pack ${packId} had readable custom fields`);

  // Employment Hero: structural ids
  const businesses = await ehGet("/business").then((b) => (Array.isArray(b) ? b : b?.businesses ?? []));
  const businessId = process.env.EH_BUSINESS_ID || String(businesses[0]?.id ?? "");
  const paySchedules = businessId ? await ehGet(`/business/${businessId}/payschedule`).catch(() => []) : [];
  const locations = businessId ? await ehGet(`/business/${businessId}/location`).catch(() => []) : [];

  // Build the field-map draft
  const rules: any[] = [];
  const notInFields: Array<{ id: number; label: string }> = [];
  for (const f of fields) {
    const k = KNOWN.find((x) => x.match.test(f.name));
    if (!k) {
      notInFields.push({ id: f.customFieldId, label: `${f.customFieldId}  ${f.name} (${f.type})` });
      continue;
    }
    const rule: any = { eh: k.eh, from: { customFieldId: f.customFieldId }, transform: k.transform };
    if (k.required) rule.required = true;
    if (k.sensitive) rule.sensitive = true;
    if (k.map) rule.map = k.map;
    rules.push(rule);
  }

  const ruleConsumed = new Set<number>();
  const pick = (list: typeof TAX_DECLARATION) =>
    Object.fromEntries(
      list
        .map(({ match, key }) => {
          const f = fields.find((x) => match.test(x.name));
          if (f) ruleConsumed.add(f.customFieldId);
          return f ? [key, { customFieldId: f.customFieldId }] : null;
        })
        .filter(Boolean) as [string, unknown][],
    );

  const superPick = SUPER.map(({ match, key }) => {
    const f = fields.find((x) => match.test(x.name));
    if (f) ruleConsumed.add(f.customFieldId);
    return f ? [key, f.customFieldId] : [key, "TODO"];
  });

  const draft = {
    client,
    connecteam: { onboardingPackId: packId },
    employmentHero: {
      businessId: businessId || "TODO",
      payScheduleId: String(paySchedules[0]?.id ?? "TODO"),
      locationId: String(locations[0]?.id ?? "TODO"),
    },
    identity: { externalIdFrom: "userId", emailFallbackFrom: "email" },
    fields: [
      { eh: "emailAddress", from: { userField: "email" }, transform: "lowerTrim" },
      { eh: "mobilePhone", from: { userField: "phoneNumber" }, transform: "phoneAu" },
      ...rules,
    ],
    rules: {
      taxDeclaration: pick(TAX_DECLARATION),
      super: Object.fromEntries(superPick),
      constants: { bankAccount1_AllocatedPercentage: 100, bankAccount1: "Electronic" },
    },
  };

  const outDir = arg("out") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "clients", client);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "field-map.json");
  writeFileSync(outFile, JSON.stringify(draft, null, 2) + "\n");

  let schema = "valid against the field-map schema";
  try {
    parseFieldMap(draft);
  } catch (err) {
    schema = `NOT yet schema-valid - ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }

  // Truly-unmapped = not in `fields` and not consumed by a rule.
  const unmapped = notInFields.filter((f) => !ruleConsumed.has(f.id));

  const line = (k: string, v: string) => `  ${k.padEnd(28)} ${v}`;
  console.log(`\nWrote DRAFT ${outFile}  (${schema})`);
  console.log(`  ${rules.length} fields mapped by name; ${ruleConsumed.size} fields fed into rules; ${unmapped.length} left for review.`);
  if (unmapped.length) {
    console.log("  Connecteam custom fields not in the draft (expected: Direct manager, Pay Type, Employee Type, Payment Method):");
    console.log(unmapped.map((u) => "    " + u.label).join("\n"));
  }

  console.log("\nConfiguration checklist (wrangler.jsonc vars + secrets):");
  console.log(line("FIELD_MAP_CLIENT", client));
  console.log(line("EH_BUSINESS_ID", businessId || "TODO  (GET /api/v2/business)"));
  console.log(line("EH_PAY_SCHEDULE_ID", String(paySchedules[0]?.id ?? "TODO  (GET /business/{id}/payschedule)")));
  console.log(line("EH_LOCATION_ID", String(locations[0]?.id ?? "TODO  (GET /business/{id}/location)")));
  console.log(line("CT_ONBOARDING_PACK_ID", String(packId)));
  console.log(line("CT_CUSTOM_PUBLISHER_ID", "TODO  (Connecteam > Settings > Feed settings)"));
  console.log(line("ADMIN_CONNECTEAM_CHANNEL_ID", "TODO  (GET /chat/v1/conversations, the 'EH Sync Alerts' channel)"));
  console.log("\n  secrets (wrangler secret put):");
  console.log(line("CT_API_KEY", "have"));
  console.log(line("EH_API_KEY", "have"));
  console.log(line("CT_WEBHOOK_SECRET", "TODO  (generate a random string; used when registering the webhook)"));
  console.log("\nNext: register this client in src/mapping/registry.ts, then tune the draft field-map (see docs/RUNBOOK.md step 5).\n");
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
