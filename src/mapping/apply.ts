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
   * Plain-language reasons the all-or-nothing pay-run set could not be completed
   * for this employee while `employmentHero.perEmployeeRate` is on (issue #42) -
   * e.g. no Connecteam pay rate on file, an unsupported `rateType`, or a missing
   * `defaults` name. Non-empty => no pay-run keys were put on the payload (never
   * send EH a partial set) and the sync raises one follow-up instead of writing.
   */
  payRunIssues: string[];
  /**
   * True when the complete pay-run set (`paySchedule` + `primaryLocation` +
   * `primaryPayCategory` + `rate` + `rateUnit`) resolved for this record -
   * whether from a flat `employmentHero.defaults` (issue #26) or, with
   * `perEmployeeRate` on, from `defaults` + the Connecteam pay-rates API
   * (issue #42). EH's pay-run axis should then be satisfied, so a later "pay run
   * defaults incomplete" from EH is a field-map misconfiguration, not
   * per-employee admin work.
   */
  payRunDefaultsComplete: boolean;
}

/** A pay rate resolved from the Connecteam pay-rates API, passed in by the
 * consumer so `applyFieldMap` stays pure. Shape mirrors `connecteam/types` `PayRate`. */
export interface PayRateInput {
  rateType: string;
  defaultRate: number;
  isDefaultRateEnabled: boolean;
}

export interface ApplyOptions {
  /** The employee's Connecteam pay rate, or `null` if none on file. Only read
   * when `employmentHero.perEmployeeRate` is configured. */
  payRate?: PayRateInput | null | undefined;
}

/** Connecteam `rateType` -> EH `rateUnit`. `monthly` is intentionally absent -
 * EH's accepted value for it is unconfirmed (issue #45). */
const RATE_UNIT_BY_TYPE: Record<string, string> = {
  hourly: "Hourly",
  yearly: "Annually",
};

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

/** Every pay-run key we might emit - stripped as a block when the set is incomplete. */
const PAY_RUN_ALL = [
  ...PAY_RUN_REQUIRED,
  "hoursPerWeek",
  "hoursPerDay",
  "awardId",
] as const;

const BASE: Record<TransformName, (v: unknown) => PayloadValue> = {
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
  number: t.decimalNumber,
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
      if (rule.map) out = t.mapEnum(String(out), rule.map);
      payload[rule.eh] = out;
    } catch (err) {
      const reason = err instanceof TransformError ? err.message : String(err);
      issues.push({ ehField: rule.eh, source: label, reason });
    }
  }

  return { payload, issues };
}

/**
 * Fold the pay-run set into the payload and report whether it is complete.
 *
 * Two modes:
 *  - default (issues #26, #34): the opt-in `employmentHero.defaults` block is
 *    copied verbatim - its schema key names already match the EH
 *    unstructured-employee field names, verified in `docs/eh-pay-defaults.md`.
 *    The set is "complete" only if `defaults` itself carried the whole of it.
 *  - `perEmployeeRate` on (issue #42): `rate` + `rateUnit` come from the
 *    employee's Connecteam pay rate; `paySchedule` / `primaryLocation` /
 *    `primaryPayCategory` still come from `defaults`. If ANY required field
 *    cannot be resolved, every pay-run key is stripped (EH 400s a partial set)
 *    and a plain-language issue is returned for the follow-up.
 */
function applyPayRun(
  payload: Record<string, PayloadValue>,
  eh: FieldMap["employmentHero"],
  payRate: PayRateInput | null | undefined,
): { complete: boolean; issues: string[] } {
  const { defaults } = eh;

  if (defaults) {
    for (const [key, value] of Object.entries(defaults)) {
      if (value !== undefined) payload[key] = value as PayloadValue;
    }
  }

  if (!eh.perEmployeeRate) {
    const complete =
      !!defaults &&
      PAY_RUN_REQUIRED.every((k) => {
        const v = defaults[k];
        return v !== undefined && v !== null && v !== "";
      });
    return { complete, issues: [] };
  }

  const issues: string[] = [];

  const rate = resolvePerEmployeeRate(payRate);
  if ("issue" in rate) {
    issues.push(rate.issue);
  } else {
    payload.rate = rate.rate;
    payload.rateUnit = rate.rateUnit;
  }

  for (const k of ["paySchedule", "primaryLocation", "primaryPayCategory"] as const) {
    if (isBlank(payload[k])) {
      issues.push(
        `Pay-run "${k}" is not configured in the field-map ` +
          `(employmentHero.defaults.${k}) - it is required for every employee ` +
          `once perEmployeeRate is enabled.`,
      );
    }
  }

  if (issues.length > 0) {
    // Never send EH a partial pay-run set - drop every pay-run key.
    for (const k of PAY_RUN_ALL) delete payload[k];
    return { complete: false, issues };
  }
  return { complete: true, issues: [] };
}

/**
 * Collapse one Connecteam pay rate to EH's single `rate` + `rateUnit`, or return
 * a plain-language reason it cannot be used. `resourcesRates[]` overrides are
 * ignored here (the consumer logs when they exist).
 */
function resolvePerEmployeeRate(
  payRate: PayRateInput | null | undefined,
): { rate: number; rateUnit: string } | { issue: string } {
  if (!payRate) {
    return {
      issue:
        "This employee has no pay rate set in Connecteam. Add one under " +
        "Connecteam → Pay Rates, or set the rate in Employment Hero by hand.",
    };
  }
  if (payRate.isDefaultRateEnabled === false) {
    return {
      issue:
        "This employee's default pay rate is turned off in Connecteam. Turn it " +
        "on, or set the rate in Employment Hero by hand.",
    };
  }
  const rateUnit = RATE_UNIT_BY_TYPE[String(payRate.rateType).trim().toLowerCase()];
  if (!rateUnit) {
    return {
      issue:
        `Connecteam has this employee on a "${payRate.rateType}" pay rate, which ` +
        "the sync cannot map to Employment Hero yet (only hourly and yearly are " +
        "confirmed - see issue #45). Set this employee's rate in Employment Hero " +
        "by hand for now.",
    };
  }
  const rate = Number(payRate.defaultRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      issue:
        "The pay rate on file for this employee in Connecteam is zero or missing. " +
        "Fix it in Connecteam, or set the rate in Employment Hero by hand.",
    };
  }
  return { rate, rateUnit };
}

function mergeRuleOutput(
  target: { payload: Record<string, PayloadValue>; issues: MappingIssue[]; followUps: string[] },
  r: RuleOutput,
): void {
  Object.assign(target.payload, r.fields);
  target.issues.push(...r.issues);
  target.followUps.push(...r.followUps);
}

export function applyFieldMap(
  user: ConnecteamUser,
  map: FieldMap,
  opts: ApplyOptions = {},
): MappingResult {
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

  // Pay-run set: from `employmentHero.defaults` alone, or (with `perEmployeeRate`
  // on) `defaults` + this employee's Connecteam pay rate. EH validates the set
  // all-or-nothing and ignores the legacy `payScheduleId` / `locationId` keys
  // entirely (issue #34), so a partial set is never emitted (issues #26, #42).
  const { complete: payRunDefaultsComplete, issues: payRunIssues } = applyPayRun(
    acc.payload,
    map.employmentHero,
    opts.payRate,
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
    payRunIssues,
    payRunDefaultsComplete,
  };
}
