/**
 * Applies a validated {@link FieldMap} to one Connecteam user object, producing
 * the full field set for an Employment Hero Payroll unstructured-employee upsert,
 * a list of per-field issues, and the plain-language follow-ups a payroll admin
 * still has to action by hand. Pure - no network, no logging.
 */
import type { FieldMap, FieldRule, TransformName } from "./schema.js";
import * as t from "./transforms.js";
import { TransformError } from "./transforms.js";
import { applySuper, applyTaxDeclaration, FOLLOW_UP, type RuleOutput } from "./rules.js";

export type PayloadValue = string | number | boolean;

export interface ConnecteamCustomField {
  customFieldId: number;
  value: unknown;
  type: string;
  name: string;
}

export interface ConnecteamUser {
  userId: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  isArchived?: boolean;
  customFields: ConnecteamCustomField[];
}

export interface MappingIssue {
  ehField: string;
  source: string;
  reason: string;
}

export interface MappingResult {
  externalId: string;
  emailFallback: string | undefined;
  /** EH field name -> value. Ready to POST as the unstructured-employee body. */
  payload: Record<string, PayloadValue>;
  /** Per-field problems. A non-empty list means do not send the payload as-is. */
  issues: MappingIssue[];
  /** Valid data that still needs a human step in EH (non-resident, SMSF, ...). */
  followUps: string[];
  /**
   * True when `employmentHero.defaults` carried the complete pay-run set
   * (`paySchedule` + `primaryLocation` + `primaryPayCategory` + `rate` +
   * `rateUnit`) - EH's pay-run axis should be satisfied for this record, so a
   * later "pay run defaults incomplete" from EH is a field-map misconfiguration
   * (one fix for the whole business), not per-employee admin work (issue #26).
   */
  payRunDefaultsComplete: boolean;
}

/**
 * The pay-run fields EH validates all-or-nothing on the unstructured endpoint
 * (`docs/eh-pay-defaults.md`). Hours and award are optional extras.
 */
const PAY_RUN_REQUIRED = [
  "paySchedule",
  "primaryLocation",
  "primaryPayCategory",
  "rate",
  "rateUnit",
] as const;

const BASE: Record<TransformName, (v: unknown) => string> = {
  trimString: t.trimString,
  lowerTrim: t.lowerTrim,
  dateDmyToIso: t.dateDmyToIso,
  dropdownValue: t.dropdownValue,
  phoneAu: t.phoneAu,
  locationFull: (v) => t.locationField(v, "full"),
  locationStreetLine: (v) => t.locationField(v, "streetLine"),
  digits: t.digits,
  zeroPad4: (v) => t.zeroPad(v, 4),
  zeroPad6: (v) => t.zeroPad(v, 6),
};

function isBlank(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

function readSource(
  user: ConnecteamUser,
  rule: FieldRule,
): { value: unknown; label: string } {
  if ("userField" in rule.from) {
    return { value: user[rule.from.userField], label: `userField ${rule.from.userField}` };
  }
  const { customFieldId } = rule.from;
  const cf = user.customFields.find((f) => f.customFieldId === customFieldId);
  const label = cf
    ? `customField ${cf.customFieldId} (${cf.name})`
    : `customField ${customFieldId} (not present)`;
  return { value: cf?.value, label };
}

function applyFieldRules(user: ConnecteamUser, map: FieldMap): {
  payload: Record<string, PayloadValue>;
  issues: MappingIssue[];
} {
  const payload: Record<string, PayloadValue> = {};
  const issues: MappingIssue[] = [];

  for (const rule of map.fields) {
    const { value, label } = readSource(user, rule);

    if (isBlank(value)) {
      if (rule.default !== undefined) {
        payload[rule.eh] = rule.default;
      } else if (rule.required) {
        issues.push({ ehField: rule.eh, source: label, reason: "required value is missing or blank" });
      }
      continue;
    }

    try {
      let out = BASE[rule.transform](value);
      if (rule.map) out = t.mapEnum(out, rule.map);
      payload[rule.eh] = out;
    } catch (err) {
      const reason = err instanceof TransformError ? err.message : String(err);
      issues.push({ ehField: rule.eh, source: label, reason });
    }
  }

  return { payload, issues };
}

/**
 * Fold the opt-in `employmentHero.defaults` block (issues #26, #34) into the
 * payload. The schema key names already match the EH unstructured-employee
 * field names (`paySchedule`, `primaryLocation`, `primaryPayCategory`, `rate`,
 * `rateUnit`, `hoursPerWeek`, `hoursPerDay`, `awardId`) verified in
 * `docs/eh-pay-defaults.md`, so this is a verbatim copy - EH validates the
 * pay-run set all-or-nothing.
 */
function applyPayDefaults(
  payload: Record<string, PayloadValue>,
  defaults: FieldMap["employmentHero"]["defaults"],
): { complete: boolean } {
  if (!defaults) return { complete: false };
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined) payload[key] = value as PayloadValue;
  }
  const complete = PAY_RUN_REQUIRED.every((k) => {
    const v = defaults[k];
    return v !== undefined && v !== null && v !== "";
  });
  return { complete };
}

function mergeRuleOutput(
  target: { payload: Record<string, PayloadValue>; issues: MappingIssue[]; followUps: string[] },
  r: RuleOutput,
): void {
  Object.assign(target.payload, r.fields);
  target.issues.push(...r.issues);
  target.followUps.push(...r.followUps);
}

export function applyFieldMap(user: ConnecteamUser, map: FieldMap): MappingResult {
  const { payload, issues } = applyFieldRules(user, map);
  const acc = { payload, issues, followUps: [] as string[] };

  if (map.rules?.taxDeclaration) {
    mergeRuleOutput(acc, applyTaxDeclaration(user, map.rules.taxDeclaration));
  }
  if (map.rules?.super) {
    mergeRuleOutput(acc, applySuper(user, map.rules.super));
  }
  for (const [key, value] of Object.entries(map.rules?.constants ?? {})) {
    acc.payload[key] = value;
  }

  // Pay schedule / location / pay category etc. only apply when the client has
  // provided the COMPLETE pay-run set via `employmentHero.defaults` - EH's
  // unstructured endpoint validates that set all-or-nothing and ignores the
  // legacy `payScheduleId` / `locationId` keys entirely (issue #34).
  const { complete: payRunDefaultsComplete } = applyPayDefaults(
    acc.payload,
    map.employmentHero.defaults,
  );

  const externalId = String(user.userId);
  acc.payload.externalId = externalId;

  if (acc.payload.residentialState === "INTERNATIONAL") {
    acc.followUps.push(FOLLOW_UP.internationalAddress);
  }

  const emailFallback =
    typeof user.email === "string" && user.email.trim() !== ""
      ? user.email.trim().toLowerCase()
      : undefined;

  return {
    externalId,
    emailFallback,
    payload: acc.payload,
    issues: acc.issues,
    followUps: acc.followUps,
    payRunDefaultsComplete,
  };
}
