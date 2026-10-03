/**
 * Builds discover's DRAFT field map from Connecteam custom-field definitions,
 * matching each by name against the known Connecteam-name -> EH-field rules
 * (from docs/field-mapping.md).
 */
import type { CustomFieldDefinition } from "./connecteam-custom-fields.js";

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
  // Optional, per issue #42 - only used when the client also sets
  // employmentHero.perEmployeeRate. Harmless if the field doesn't exist.
  { match: /standard hours.*week|hours per week|weekly hours/i, eh: "hoursPerWeek", transform: "number" },
];

const TAX_DECLARATION: Array<{ match: RegExp; key: string }> = [
  { match: /tax-?free threshold/i, key: "claimTaxFreeThreshold" },
  { match: /australian resident/i, key: "australianResident" },
  { match: /help.*debt|stsl|study.*debt/i, key: "hasHelpOrStslDebt" },
];

const SUPER: Array<{ match: RegExp; key: string }> = [
  // Whole word only - a bare /usi/ also matches "Business".
  { match: /\busi\b|unique superannuation identifier/i, key: "usiField" },
  { match: /super.*abn/i, key: "abnField" },
  { match: /super fund name/i, key: "fundNameField" },
  { match: /member number/i, key: "memberNumberField" },
];

export interface DraftInput {
  client: string;
  packId: number;
  businessId: string;
  payScheduleId: string;
  locationId: string;
  fields: CustomFieldDefinition[];
}

export interface DraftResult {
  draft: {
    client: string;
    connecteam: { onboardingPackId: number };
    employmentHero: { businessId: string; payScheduleId: string; locationId: string };
    identity: { externalIdFrom: string; emailFallbackFrom: string };
    fields: Array<{ eh: string; from: Record<string, unknown>; transform: string; [k: string]: unknown }>;
    rules: {
      taxDeclaration: Record<string, { customFieldId: number }>;
      super: Record<string, number | "TODO">;
      constants: Record<string, unknown>;
    };
  };
  /** Fields mapped 1:1 to an EH field by name. */
  mappedCount: number;
  /** Fields fed into the tax-declaration / super rules. */
  ruleFedCount: number;
  /** Fields neither mapped nor fed into a rule - left for a human to review. */
  unmapped: Array<{ id: number; label: string }>;
}

export function buildFieldMapDraft(input: DraftInput): DraftResult {
  const { fields } = input;

  const mapped: DraftResult["draft"]["fields"] = [];
  const usedEh = new Set<string>();
  const notInFields: Array<{ id: number; label: string }> = [];
  for (const f of fields) {
    const k = KNOWN.find((x) => x.match.test(f.name));
    // Account-wide definitions can hold a second field with a matching name
    // (an old, renamed or unused one) - map each EH field once, review the rest.
    if (!k || usedEh.has(k.eh)) {
      notInFields.push({ id: f.customFieldId, label: `${f.customFieldId}  ${f.name} (${f.type})` });
      continue;
    }
    usedEh.add(k.eh);
    const rule: DraftResult["draft"]["fields"][number] = { eh: k.eh, from: { customFieldId: f.customFieldId }, transform: k.transform };
    if (k.required) rule.required = true;
    if (k.sensitive) rule.sensitive = true;
    if (k.map) rule.map = k.map;
    mapped.push(rule);
  }

  const ruleConsumed = new Set<number>();
  const taxDeclaration = Object.fromEntries(
    TAX_DECLARATION.flatMap(({ match, key }) => {
      const f = fields.find((x) => match.test(x.name));
      if (!f) return [];
      ruleConsumed.add(f.customFieldId);
      return [[key, { customFieldId: f.customFieldId }]];
    }),
  );

  const superFields = Object.fromEntries(
    SUPER.map(({ match, key }) => {
      const f = fields.find((x) => match.test(x.name));
      if (f) ruleConsumed.add(f.customFieldId);
      return [key, f ? f.customFieldId : ("TODO" as const)];
    }),
  );

  const draft: DraftResult["draft"] = {
    client: input.client,
    connecteam: { onboardingPackId: input.packId },
    employmentHero: {
      businessId: input.businessId || "TODO",
      payScheduleId: input.payScheduleId || "TODO",
      locationId: input.locationId || "TODO",
    },
    identity: { externalIdFrom: "userId", emailFallbackFrom: "email" },
    fields: [
      { eh: "emailAddress", from: { userField: "email" }, transform: "lowerTrim" },
      { eh: "mobilePhone", from: { userField: "phoneNumber" }, transform: "phoneAu" },
      ...mapped,
    ],
    rules: {
      taxDeclaration,
      super: superFields,
      constants: { bankAccount1_AllocatedPercentage: 100, bankAccount1: "Electronic" },
    },
  };

  return {
    draft,
    mappedCount: mapped.length,
    ruleFedCount: ruleConsumed.size,
    // Truly-unmapped = not in `fields` and not consumed by a rule.
    unmapped: notInFields.filter((f) => !ruleConsumed.has(f.id)),
  };
}
