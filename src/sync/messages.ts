/**
 * Composes the three outbound message types (CONTEXT.md), all plain language and
 * clamped to 500 characters:
 *   1. Correction message      -> the employee, as a DM from the custom publisher
 *      (also the Direct manager on the 3rd consecutive failed cycle).
 *   2. Manual-follow-up notice  -> the admin channel.
 *   3. System alert             -> the admin channel.
 *
 * Employment Hero's raw error text is NEVER placed in a message - it goes to the
 * audit log only. Each recognised field maps to a curated, actionable line;
 * anything unrecognised falls back to one generic-but-actionable instruction.
 */
import type { EhFieldError } from "../eh/errors.js";

const MAX_LEN = 500;

export const GENERIC_CORRECTION =
  "Some of the details you entered couldn't be saved to payroll. Please review your personal, address, bank, tax and super details in Connecteam and correct anything that looks wrong.";

interface CuratedLine {
  match: RegExp;
  line: string;
}

/**
 * First match wins, so order matters: most specific first. Matched against
 * `"<normalised field name> <lower-cased EH reason>"`, so a hit can come from
 * either the field EH named or the words in its message.
 */
const CURATED: CuratedLine[] = [
  { match: /bsb/, line: "Your bank BSB doesn't look right - check it's the 6-digit branch number for your account and re-enter it in Connecteam." },
  { match: /accountnumber/, line: "Your bank account number doesn't look right - double-check it and re-enter it in Connecteam." },
  { match: /accountname/, line: "The account-holder name on your bank account is missing - add it in Connecteam." },
  { match: /bankaccount|bank details|bankdetails/, line: "Your bank account details couldn't be saved - check the BSB, account number and account-holder name in Connecteam." },
  { match: /taxfilenumber|tax file number|\btfn\b/, line: "Your Tax File Number doesn't appear to be valid - re-check the 9 digits and re-enter it in Connecteam." },
  { match: /taxfree|tax declaration|taxdeclaration|australianresident|not an australian resident|helpdebt|stsldebt|tax details|taxdetails/, line: "Your tax declaration answers are missing or inconsistent - review the tax questions in Connecteam." },
  { match: /startdate|start date/, line: "Your employment start date is missing or in the wrong format - re-enter it in Connecteam." },
  { match: /dateofbirth|date of birth|birthday|\bdob\b/, line: "Your date of birth is missing or in the wrong format - re-enter it in Connecteam." },
  { match: /employmenttype|employment type/, line: "Your employment type must be Full time, Part time, Casual or Labour hire - update it in Connecteam." },
  { match: /gender/, line: "Your gender selection couldn't be saved - choose one of the listed options in Connecteam." },
  { match: /postcode|post code/, line: "Your postcode doesn't look right - check it's 4 digits and re-enter it in Connecteam." },
  { match: /residentialstate|\bstate\b/, line: "Your residential state couldn't be saved - pick your state from the list in Connecteam." },
  { match: /suburb|streetaddress|street address|\baddress\b/, line: "Your residential address looks incomplete - check the street address and suburb in Connecteam." },
  { match: /email/, line: "Your email address doesn't look valid - re-check it in Connecteam." },
  { match: /mobile|phone/, line: "Your mobile number doesn't look valid - enter it as +61... in Connecteam." },
  { match: /super|fund|membernumber|\busi\b/, line: "Your super fund details look incomplete - check the fund USI or name and your member number in Connecteam." },
  { match: /emergency/, line: "Your emergency contact details look incomplete - check the name, number and relationship in Connecteam." },
  { match: /firstname|first name|surname|lastname|last name|basic details|basicdetails|\bname\b/, line: "Your legal name looks incomplete - check your legal first name and surname in Connecteam." },
];

function normField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The curated plain-language line for one EH field error (never its raw text). */
export function friendlyLine(err: EhFieldError): string {
  const hay = `${normField(err.field)} ${err.reason.toLowerCase()}`;
  for (const c of CURATED) if (c.match.test(hay)) return c.line;
  return GENERIC_CORRECTION;
}

function friendlyLines(fields: EhFieldError[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const line = friendlyLine(f);
    if (!out.includes(line)) out.push(line);
  }
  if (out.length === 0) return [GENERIC_CORRECTION];
  // Drop the catch-all if we also have at least one specific line.
  return out.length > 1 ? out.filter((l) => l !== GENERIC_CORRECTION) : out;
}

/** Correction message -> the employee who entered the bad data. */
export function correctionMessage(fields: EhFieldError[]): string {
  const body = [
    "Hi - a few of the details you entered for payroll need a quick fix:",
    ...friendlyLines(fields).map((l) => `- ${l}`),
    "Update them in Connecteam and we'll sync again automatically.",
  ].join("\n");
  return clamp(body);
}

/** Correction message -> the Direct manager, on the 3rd failed cycle in a row. */
export function managerEscalationMessage(fields: EhFieldError[]): string {
  const body = [
    "Heads up: an employee you manage has had their payroll details fail to sync three times in a row.",
    "They've been asked to correct:",
    ...friendlyLines(fields).map((l) => `- ${l}`),
    "Please check in with them so payroll can be completed.",
  ].join("\n");
  return clamp(body);
}

/** Manual-follow-up notice -> the admin channel. */
export function followUpNoticeMessage(reasons: string[], ref: { ctUserId: number }): string {
  const items =
    reasons.length > 0 ? reasons : ["A payroll admin needs to review this record in Employment Hero."];
  const body = [
    `Payroll follow-up needed for Connecteam user ${ref.ctUserId}:`,
    ...items.map((r) => `- ${r}`),
    "The sync completed with safe defaults - finish this by hand in Employment Hero.",
  ].join("\n");
  return clamp(body);
}

/** System alert -> the admin channel, when a queue message dead-letters. */
export function systemAlertMessage(detail: string, ref: { ctUserId: number }): string {
  const body = [
    `Payroll sync failed for Connecteam user ${ref.ctUserId} and could not be retried.`,
    detail.trim() ? `Detail: ${detail.trim()}` : "No further detail was returned.",
    "No employee action is possible - check the Employment Hero API status and credentials.",
  ].join("\n");
  return clamp(body);
}

function clamp(text: string): string {
  const t = text.trim();
  return t.length <= MAX_LEN ? t : `${t.slice(0, MAX_LEN - 1)}…`;
}
