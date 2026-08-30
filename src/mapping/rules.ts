/**
 * The non-1:1 parts of the mapping: the tax file declaration and the
 * APRA-vs-SMSF super branch, plus the plain-language reasons a synced record
 * still needs a payroll admin to finish something by hand.
 *
 * Pure. EH field names here are marked @todo - verify them against the live
 * AuUnstructuredEmployeeModel during M2 before relying on them.
 */
import type { ConnecteamUser, MappingIssue, PayloadValue } from "./apply.js";
import { yesNo, trimString, TransformError } from "./transforms.js";
import type { Rules } from "./schema.js";

/** Confirmed against the live EH unstructured model in issue #2. */
export const EH_FIELD = {
  claimTaxFreeThreshold: "claimTaxFreeThreshold",
  australianResident: "australianResident",
  // EH has separate helpDebt / stslDebt flags; Connecteam asks one combined
  // Yes/No, so we set both (over-reporting is harmless - same repayment schedule;
  // under-reporting would under-withhold).
  helpDebt: "helpDebt",
  stslDebt: "stslDebt",
  superProductCode: "superFund1_ProductCode", // APRA fund USI / product code
  superFundName: "superFund1_FundName",
  superMemberNumber: "superFund1_MemberNumber",
} as const;

export const FOLLOW_UP = {
  nonResident:
    'Employee marked "not an Australian resident for tax" - set the foreign-resident or working-holiday-maker tax scale in Employment Hero.',
  smsfSuper:
    "Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.",
  internationalAddress:
    "Address state is INTERNATIONAL - enter the overseas residential address in Employment Hero manually.",
} as const;

export interface RuleOutput {
  fields: Record<string, PayloadValue>;
  followUps: string[];
  issues: MappingIssue[];
}

function read(user: ConnecteamUser, customFieldId: number): { value: unknown; label: string } {
  const cf = user.customFields.find((f) => f.customFieldId === customFieldId);
  return {
    value: cf?.value,
    label: cf ? `customField ${cf.customFieldId} (${cf.name})` : `customField ${customFieldId} (not present)`,
  };
}

function blank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

export function applyTaxDeclaration(
  user: ConnecteamUser,
  td: NonNullable<Rules>["taxDeclaration"],
): RuleOutput {
  const out: RuleOutput = { fields: {}, followUps: [], issues: [] };
  if (!td) return out;

  const readBool = (ehField: string, customFieldId: number): boolean | undefined => {
    const { value, label } = read(user, customFieldId);
    if (blank(value)) {
      out.issues.push({ ehField, source: label, reason: "required Yes/No answer is missing" });
      return undefined;
    }
    try {
      return yesNo(value);
    } catch (err) {
      out.issues.push({ ehField, source: label, reason: err instanceof TransformError ? err.message : String(err) });
      return undefined;
    }
  };

  const tft = readBool(EH_FIELD.claimTaxFreeThreshold, td.claimTaxFreeThreshold.customFieldId);
  if (tft !== undefined) out.fields[EH_FIELD.claimTaxFreeThreshold] = tft;

  const resident = readBool(EH_FIELD.australianResident, td.australianResident.customFieldId);
  if (resident !== undefined) {
    out.fields[EH_FIELD.australianResident] = resident;
    // EH has no isNonResident field - australianResident:false plus a manual
    // follow-up (tax scale / working-holiday-maker is a payroll decision).
    if (!resident) out.followUps.push(FOLLOW_UP.nonResident);
  }

  const help = readBool(EH_FIELD.helpDebt, td.hasHelpOrStslDebt.customFieldId);
  if (help !== undefined) {
    out.fields[EH_FIELD.helpDebt] = help;
    out.fields[EH_FIELD.stslDebt] = help;
  }

  return out;
}

export function applySuper(user: ConnecteamUser, sup: NonNullable<Rules>["super"]): RuleOutput {
  const out: RuleOutput = { fields: {}, followUps: [], issues: [] };
  if (!sup) return out;

  const usi = read(user, sup.usiField);
  const abn = read(user, sup.abnField);
  const fundName = read(user, sup.fundNameField);
  const memberNumber = read(user, sup.memberNumberField);

  const hasUsi = !blank(usi.value);
  const hasAbn = !blank(abn.value);

  if (hasUsi) {
    // APRA-regulated fund. EH calls the USI the "product code".
    try {
      out.fields[EH_FIELD.superProductCode] = trimString(usi.value);
    } catch (err) {
      out.issues.push({ ehField: EH_FIELD.superProductCode, source: usi.label, reason: err instanceof TransformError ? err.message : String(err) });
    }
    if (!blank(fundName.value)) out.fields[EH_FIELD.superFundName] = trimString(fundName.value);
    if (blank(memberNumber.value)) {
      out.issues.push({
        ehField: EH_FIELD.superMemberNumber,
        source: memberNumber.label,
        reason: "APRA super fund USI is set but the member number is missing",
      });
    } else {
      out.fields[EH_FIELD.superMemberNumber] = trimString(memberNumber.value);
    }
    return out;
  }

  if (hasAbn) {
    // Self-managed fund - not synced; payroll sets it up by hand.
    out.followUps.push(FOLLOW_UP.smsfSuper);
    return out;
  }

  // No super details at all - allowed (super is not required for a Complete record).
  return out;
}
