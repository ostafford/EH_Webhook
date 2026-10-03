/**
 * Builds discover's DRAFT field map from Connecteam custom-field definitions,
 * matching each by name against the shared field spec (./field-spec.ts).
 */
import type { CustomFieldDefinition } from "./connecteam-custom-fields.js";
import { FIELD_SPEC, type Target } from "./field-spec.js";

type FieldTarget = Extract<Target, { kind: "field" }>;

const KNOWN = FIELD_SPEC.flatMap((s) => (s.target.kind === "field" ? [{ match: s.match, ...s.target }] : []));
const TAX_DECLARATION = FIELD_SPEC.flatMap((s) => (s.target.kind === "taxDeclaration" ? [{ match: s.match, key: s.target.key }] : []));
const SUPER = FIELD_SPEC.flatMap((s) => (s.target.kind === "super" ? [{ match: s.match, key: s.target.key }] : []));

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
    const t: FieldTarget = k;
    if (t.required) rule.required = true;
    if (t.sensitive) rule.sensitive = true;
    if (t.map) rule.map = t.map;
    if (t.default !== undefined) rule.default = t.default;
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
