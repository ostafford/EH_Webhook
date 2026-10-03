/**
 * `npm run provision-classification-field -- [--business <ehBusinessId>] [--field-id <ctCustomFieldId>] [--dry-run]`
 *
 * Also the wizard's "Award classifications" stage (issue #65).
 *
 * One-time (or occasionally re-run) setup for the award/classification path
 * (issue #39, `employmentHero.payRateTemplate`). EH is the source of truth for
 * an award's Pay Rate Templates (the per-employee classification, e.g.
 * "General Retail Casual L3 21yrs & over") - Connecteam has no idea these
 * exist. This script reads EH's list and creates (or extends) a Connecteam
 * dropdown custom field with them as options, so a payroll admin can pick the
 * right one per employee from a real dropdown instead of typing a name by hand.
 *
 * It never picks a value for anyone - the classification itself stays a human
 * payroll decision. It also never touches employee values: it only reads
 * template NAMES (never rate amounts, never anything employee-entered) and
 * writes custom-field STRUCTURE (the field + its options), not any employee's
 * answer.
 *
 * Modes (re-running is always safe - it never creates a second field):
 *   - The field doesn't exist yet: creates the Connecteam dropdown "EH Pay
 *     Rate Template" with every current EH template as an option. The wizard's
 *     pay-run picker (`npm run pay-defaults`) then maps it, together with the
 *     award as the rate source.
 *   - It exists (found by name, or `--field-id <id>`): diffs EH's current
 *     templates against its options and adds only the missing ones -
 *     already-assigned employee values are never touched. Use this after an
 *     Award review adds/renames templates in EH.
 *   - `--dry-run`: never POSTs anything; just prints what would change.
 *   - `--business` defaults to EH_BUSINESS_ID, else the key's only business.
 *
 * The field is created admin-only-editable (`isEditableForUsers: false`) -
 * an employee's award classification is not a self-serve profile field.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, EH_API_KEY.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// --- HTTP ------------------------------------------------------------------

async function ctGet(path: string): Promise<any> {
  const r = await fetch(`https://api.connecteam.com${path}`, {
    headers: { "X-API-KEY": process.env.CT_API_KEY!, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Connecteam GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function ctPost(path: string, body: unknown): Promise<any> {
  const r = await fetch(`https://api.connecteam.com${path}`, {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.CT_API_KEY!,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Connecteam POST ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function ehGet(path: string): Promise<any> {
  const r = await fetch(`https://api.yourpayroll.com.au/api/v2${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`${process.env.EH_API_KEY}:`).toString("base64")}`, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Employment Hero GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  loadDevVars();
  if (!process.env.CT_API_KEY || !process.env.EH_API_KEY) {
    throw new Error("CT_API_KEY and EH_API_KEY must be set (in .dev.vars or the shell)");
  }
  const businessId = arg("business") ?? process.env.EH_BUSINESS_ID ?? (await soleBusinessId());
  const dryRun = flag("dry-run");
  const fieldId = arg("field-id");
  const fieldName = arg("name") ?? AWARD_FIELD_NAME;
  const visibleToUsers = flag("visible-to-users");

  // EH is the source of truth for what classifications exist.
  // Deduplicated: two awards can share a template name (e.g. "Salaried"), and
  // a dropdown option is just the name EH is sent.
  const templates: string[] = [
    ...new Set<string>((await ehGet(`/business/${businessId}/payratetemplate`)).map((t: any) => String(t.name ?? "").trim())),
  ]
    .filter(Boolean)
    .sort();
  if (templates.length === 0) {
    throw new Error(
      `Employment Hero business ${businessId} has no Pay Rate Templates - install your award in Employment Hero first, then re-run this.`,
    );
  }
  console.log(`Employment Hero business ${businessId}: ${templates.length} award classifications (Pay Rate Templates) found.`);

  // Re-running never creates a second field: an explicit --field-id, or the
  // field already named `fieldName`, is extended instead.
  const fields = await listRawCustomFields(ctGet);
  const existing = fieldId ? fields.find((f: any) => String(f.id) === String(fieldId)) : findAwardField(fields, fieldName);
  if (fieldId && !existing) throw new Error(`no Connecteam custom field with id ${fieldId}`);

  if (existing) {
    // --- re-run mode: extend an existing field ---
    if (existing.type !== "dropdown") throw new Error(`field ${existing.id} ("${existing.name}") is type "${existing.type}", not "dropdown"`);

    const have = new Set<string>((existing.dropdownOptions ?? []).filter((o: any) => !o.isDeleted).map((o: any) => o.value));
    const missing = templates.filter((t) => !have.has(t));

    console.log(`Connecteam field ${existing.id} ("${existing.name}") already has ${have.size} options; ${missing.length} EH classifications are missing.`);
    if (missing.length === 0) {
      console.log("Nothing to do - it is up to date.");
      return;
    }
    if (dryRun) {
      console.log("--dry-run: would add:\n" + missing.map((m) => `  + ${m}`).join("\n"));
      return;
    }
    for (const value of missing) {
      await ctPost(`/users/v1/custom-fields/${existing.id}/options`, { value, isDisabled: false });
      console.log(`  + added "${value}"`);
    }
    console.log(`Done. Added ${missing.length} option(s) to field ${existing.id}. Employees' existing picks are unchanged.`);
    return;
  }

  // --- create mode: brand-new field ---
  const categories = (await ctGet("/users/v1/custom-field-categories")).data.categories as Array<{ id: number; name: string }>;
  const category = categories.find((c) => /payroll/i.test(c.name)) ?? categories[0];
  if (!category) throw new Error("no Connecteam custom-field category found to put the new field under");

  console.log(`Creating admin-only dropdown "${fieldName}" under category "${category.name}" with these options:`);
  console.log(templates.map((t) => `  - ${t}`).join("\n"));
  if (dryRun) {
    console.log("--dry-run: nothing created.");
    return;
  }

  const body = {
    customFields: [
      {
        name: fieldName,
        isRequired: false,
        categoryId: category.id,
        isVisibleToAllAdmins: true,
        isEditableForAllAdmins: true,
        isVisibleToUsers: visibleToUsers,
        // Admin-only: an employee's award classification is a payroll
        // decision, not a self-serve profile field (see CONTEXT.md's
        // "In-scope fields" - pay rate / award / classification is a manual
        // EH/admin task).
        isEditableForUsers: false,
        isMultiSelect: false,
        type: "dropdown",
        dropdownOptions: templates.map((value) => ({ value, isDisabled: false })),
      },
    ],
  };

  const created = await ctPost("/users/v1/custom-fields", body);
  const field = created.data.customFields[0];
  console.log(`\nCreated Connecteam custom field "${field.name}" - id ${field.id}, ${field.dropdownOptions.length} options.`);
  // The field-map rule is written by the pay-run picker, together with the
  // award as the rate source - never on its own (see lib/award-field.ts).
  console.log(
    `\nTo map it, choose "Award classification" in the wizard's Pay-run settings stage\n` +
      `(or run: npm run pay-defaults -- --client <client>).`,
  );
  console.log(
    `\nAfter an award review or a newly installed award, re-run this to add the new\n` +
      `classifications. Employees' existing picks are never changed.`,
  );
}

/** The API key's only EH business; ambiguous with several. */
async function soleBusinessId(): Promise<string> {
  const businesses = await ehGet("/business").then((b) => (Array.isArray(b) ? b : b?.businesses ?? []));
  if (businesses.length !== 1) {
    throw new Error(`the Employment Hero key reaches ${businesses.length} businesses - pass --business <id> (or set EH_BUSINESS_ID)`);
  }
  return String(businesses[0].id);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
