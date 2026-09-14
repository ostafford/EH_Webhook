/**
 * `npm run provision-classification-field -- --business <ehBusinessId> [--field-id <ctCustomFieldId>] [--dry-run]`
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
 * Modes:
 *   - No `--field-id`: creates a brand-new Connecteam dropdown field with every
 *     current EH template as an option. Prints the new customFieldId - put
 *     that in `clients/<client>/field-map.json` as the `payRateTemplate` rule's
 *     `from.customFieldId`.
 *   - `--field-id <id>`: re-run mode. Diffs EH's current templates against the
 *     field's existing options and adds only the missing ones (idempotent -
 *     already-assigned employee values are never touched). Use this after an
 *     Award review adds/renames templates in EH.
 *   - `--dry-run`: never POSTs anything; just prints what would change.
 *
 * The field is created admin-only-editable (`isEditableForUsers: false`) -
 * an employee's award classification is not a self-serve profile field.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, EH_API_KEY.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/**
 * `GET /users/v1/custom-fields` is paginated (default page size 10, no
 * single-field-by-id endpoint exists) - page through it so `--field-id` mode
 * can find a field regardless of how many others exist before it.
 */
async function ctAllCustomFields(): Promise<any[]> {
  const PAGE = 50;
  let offset = 0;
  const all: any[] = [];
  for (;;) {
    const page = (await ctGet(`/users/v1/custom-fields?limit=${PAGE}&offset=${offset}`)).data.customFields;
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// --- main --------------------------------------------------------------

const DEFAULT_FIELD_NAME = "EH Pay Rate Template";

async function main(): Promise<void> {
  loadDevVars();
  const businessId = arg("business") ?? process.env.EH_BUSINESS_ID;
  if (!businessId) throw new Error("usage: --business <ehBusinessId> (or set EH_BUSINESS_ID)");
  if (!process.env.CT_API_KEY || !process.env.EH_API_KEY) {
    throw new Error("CT_API_KEY and EH_API_KEY must be set (in .dev.vars or the shell)");
  }
  const dryRun = flag("dry-run");
  const fieldId = arg("field-id");
  const fieldName = arg("name") ?? DEFAULT_FIELD_NAME;
  const visibleToUsers = flag("visible-to-users");

  // EH is the source of truth for what classifications exist.
  const templates: string[] = (await ehGet(`/business/${businessId}/payratetemplate`))
    .map((t: any) => String(t.name ?? "").trim())
    .filter(Boolean)
    .sort();
  if (templates.length === 0) throw new Error(`business ${businessId} has no Pay Rate Templates - install an Award first`);
  console.log(`Employment Hero business ${businessId}: ${templates.length} Pay Rate Templates found.`);

  if (fieldId) {
    // --- re-run mode: extend an existing field ---
    const existing = (await ctAllCustomFields()).find((f: any) => String(f.id) === String(fieldId));
    if (!existing) throw new Error(`no Connecteam custom field with id ${fieldId}`);
    if (existing.type !== "dropdown") throw new Error(`field ${fieldId} ("${existing.name}") is type "${existing.type}", not "dropdown"`);

    const have = new Set<string>((existing.dropdownOptions ?? []).filter((o: any) => !o.isDeleted).map((o: any) => o.value));
    const missing = templates.filter((t) => !have.has(t));

    console.log(`Field ${fieldId} ("${existing.name}") already has ${have.size} options; ${missing.length} EH templates are missing.`);
    if (missing.length === 0) {
      console.log("Nothing to do.");
      return;
    }
    if (dryRun) {
      console.log("--dry-run: would add:\n" + missing.map((m) => `  + ${m}`).join("\n"));
      return;
    }
    for (const value of missing) {
      await ctPost(`/users/v1/custom-fields/${fieldId}/options`, { value, isDisabled: false });
      console.log(`  + added "${value}"`);
    }
    console.log(`Done. Added ${missing.length} option(s) to field ${fieldId}.`);
    return;
  }

  // --- create mode: brand-new field ---
  const categories = (await ctGet("/users/v1/custom-field-categories")).data.categories as Array<{ id: number; name: string }>;
  const category = categories.find((c) => /payroll/i.test(c.name)) ?? categories[0];
  if (!category) throw new Error("no Connecteam custom-field category found to put the new field under");

  console.log(`Creating dropdown field "${fieldName}" under category "${category.name}" with ${templates.length} options...`);
  if (dryRun) {
    console.log("--dry-run: would create with options:\n" + templates.map((t) => `  - ${t}`).join("\n"));
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
  console.log("\nAdd this to clients/<client>/field-map.json:");
  console.log(
    JSON.stringify(
      {
        eh: "payRateTemplate",
        from: { customFieldId: field.id },
        transform: "trimString",
      },
      null,
      2,
    ),
  );
  console.log('\n...and turn on the source in `employmentHero`:');
  console.log(JSON.stringify({ payRateTemplate: { source: "connecteamField" } }, null, 2));
  console.log(
    `\nTo add newly-installed EH templates later without disturbing existing employee picks, re-run:\n` +
      `  npm run provision-classification-field -- --business ${businessId} --field-id ${field.id}`,
  );
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
