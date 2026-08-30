/**
 * Applies a validated {@link FieldMap} to one Connecteam user object, producing
 * the field set for an Employment Hero Payroll unstructured-employee upsert plus
 * a list of per-field issues. Pure - no network, no logging.
 */
import type { FieldMap, FieldRule, TransformName } from "./schema.js";
import * as t from "./transforms.js";
import { TransformError } from "./transforms.js";

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
  /** EH field name -> string value. Ready to fold into an upsert payload. */
  payload: Record<string, string>;
  issues: MappingIssue[];
}

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

export function applyFieldMap(user: ConnecteamUser, map: FieldMap): MappingResult {
  const payload: Record<string, string> = {};
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

  const externalId = String(user.userId);
  const emailFallback =
    typeof user.email === "string" && user.email.trim() !== "" ? user.email.trim().toLowerCase() : undefined;

  return { externalId, emailFallback, payload, issues };
}
