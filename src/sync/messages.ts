/**
 * Composes the outbound message types (CONTEXT.md), all plain language and
 * clamped to 500 characters:
 *   1. Correction message      -> the employee, as a DM from the custom publisher
 *      (also the Direct manager on the 3rd consecutive failed cycle).
 *   2. Manual-follow-up notice  -> the admin channel.
 *   3. System alert             -> the admin channel.
 *   4. Success message          -> the employee, once on a first sync and once
 *      when a Correction is fixed (#71; per-client `messages.employeeSuccess`).
 *
 * Employment Hero's raw error text is NEVER placed in a message - it goes to the
 * audit log only. Each recognised field maps to a curated, actionable line;
 * anything unrecognised falls back to one generic-but-actionable instruction.
 */
import type { EhFieldError } from "../eh/errors.js";

const MAX_LEN = 500;

export const GENERIC_CORRECTION =
  "Some of the details you entered couldn't be saved to Employment Hero. Please review your personal, address, bank, tax and super details in Connecteam and correct anything that looks wrong.";

interface CuratedLine {
  match: RegExp;
  line: string;
  /** What the line is about, for the "that's fixed" message (#71). Several lines can share one. */
  topic: Topic;
}

/** A Correction topic as the employee would name it, with its verb number ("has" / "have"). */
interface Topic {
  name: string;
  plural: boolean;
}

const BANK: Topic = { name: "bank details", plural: true };
const ADDRESS: Topic = { name: "address", plural: false };

/**
 * First match wins, so order matters: most specific first. Matched against
 * `"<normalised field name> <lower-cased EH reason>"`, so a hit can come from
 * either the field EH named or the words in its message.
 */
const CURATED: CuratedLine[] = [
  { match: /bsb/, line: "Your bank BSB doesn't look right - check it's the 6-digit branch number for your account and re-enter it in Connecteam.", topic: BANK },
  { match: /accountnumber/, line: "Your bank account number doesn't look right - double-check it and re-enter it in Connecteam.", topic: BANK },
  { match: /accountname/, line: "The account-holder name on your bank account is missing - add it in Connecteam.", topic: BANK },
  { match: /bankaccount|bank details|bankdetails/, line: "Your bank account details couldn't be saved - check the BSB, account number and account-holder name in Connecteam.", topic: BANK },
  { match: /taxfilenumber|tax file number|\btfn\b/, line: "Your Tax File Number doesn't appear to be valid - re-check the 9 digits and re-enter it in Connecteam.", topic: { name: "tax file number", plural: false } },
  { match: /tax[-\s]?free|tax declaration|taxdeclaration|australianresident|non-resident|not an australian resident|helpdebt|stsldebt|tax details|taxdetails/, line: "Your tax declaration answers are missing or inconsistent - review the tax questions in Connecteam.", topic: { name: "tax declaration", plural: false } },
  { match: /startdate|start date/, line: "Your employment start date is missing or in the wrong format - re-enter it in Connecteam.", topic: { name: "start date", plural: false } },
  { match: /dateofbirth|date of birth|birthday|\bdob\b/, line: "Your date of birth is missing or in the wrong format - re-enter it in Connecteam.", topic: { name: "date of birth", plural: false } },
  { match: /employmenttype|employment type/, line: "Your employment type must be Full time, Part time, Casual or Labour hire - update it in Connecteam.", topic: { name: "employment type", plural: false } },
  { match: /gender/, line: "Your gender selection couldn't be saved - choose one of the listed options in Connecteam.", topic: { name: "gender", plural: false } },
  { match: /postcode|post code/, line: "Your postcode doesn't look right - check it's 4 digits and re-enter it in Connecteam.", topic: ADDRESS },
  { match: /residentialstate|\bstate\b/, line: "Your residential state couldn't be saved - pick your state from the list in Connecteam.", topic: ADDRESS },
  { match: /suburb|streetaddress|street address|\baddress\b/, line: "Your residential address looks incomplete - check the street address and suburb in Connecteam.", topic: ADDRESS },
  { match: /email/, line: "Your email address doesn't look valid - re-check it in Connecteam.", topic: { name: "email address", plural: false } },
  { match: /mobile|phone/, line: "Your mobile number doesn't look valid - enter it as +61... in Connecteam.", topic: { name: "mobile number", plural: false } },
  { match: /super|fund|membernumber|\busi\b/, line: "Your super fund details look incomplete - check the fund USI or name and your member number in Connecteam.", topic: { name: "super details", plural: true } },
  { match: /emergency/, line: "Your emergency contact details look incomplete - check the name, number and relationship in Connecteam.", topic: { name: "emergency contact details", plural: true } },
  { match: /firstname|first name|surname|lastname|last name|basic details|basicdetails|\bname\b/, line: "Your legal name looks incomplete - check your legal first name and surname in Connecteam.", topic: { name: "legal name", plural: false } },
];

function normField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function curated(err: EhFieldError): CuratedLine | undefined {
  const hay = `${normField(err.field)} ${err.reason.toLowerCase()}`;
  return CURATED.find((c) => c.match.test(hay));
}

/** The curated plain-language line for one EH field error (never its raw text). */
export function friendlyLine(err: EhFieldError): string {
  return curated(err)?.line ?? GENERIC_CORRECTION;
}

/**
 * The distinct topics behind a Correction's field errors, in the order asked
 * (#71). A field with no curated line has no topic, so an all-unknown
 * Correction yields `[]`.
 */
export function correctionTopics(fields: readonly EhFieldError[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const name = curated(f)?.topic.name;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Success message -> the employee, once, on their first successful sync (#71). */
export function firstSyncMessage(): string {
  return "Thanks, your details have now been received in Employment Hero.";
}

/**
 * Success message -> the employee, once, when a Correction is fixed (#71).
 * Names what the Correction asked them to fix. Like {@link firstSyncMessage},
 * it never says "Complete": a record EH holds Incomplete for an admin's
 * award choice is still a success from the employee's side.
 */
export function correctionFixedMessage(topics: readonly string[]): string {
  if (topics.length === 0) return "Thanks, that's fixed: your details have now been updated in Employment Hero.";
  const list = topics.length === 1 ? topics[0] : `${topics.slice(0, -1).join(", ")} and ${topics.at(-1)}`;
  const plural = topics.length > 1 || CURATED.some((c) => c.topic.name === topics[0] && c.topic.plural);
  return clamp(`Thanks, that's fixed: your ${list} ${plural ? "have" : "has"} now been updated in Employment Hero.`);
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
    "Hi - a few of the details you entered need a quick fix before they can be saved to Employment Hero:",
    ...friendlyLines(fields).map((l) => `- ${l}`),
    "Update them in Connecteam and we'll sync again automatically.",
  ].join("\n");
  return clamp(body);
}

/**
 * How an employee is referred to in an admin-facing message. The name makes the
 * channel scannable; the id stays for an unambiguous lookup. Falls back to
 * "Connecteam user <id>" when the name is not to hand (e.g. a dead-letter alert
 * raised without a fresh user fetch).
 */
export interface PersonRef {
  ctUserId: number;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
}

export function personLabel(ref: PersonRef): string {
  const name = [ref.firstName, ref.lastName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return name ? `${name} (${ref.ctUserId})` : `Connecteam user ${ref.ctUserId}`;
}

/** Correction message -> the Direct manager, on the 3rd failed cycle in a row. */
export function managerEscalationMessage(fields: EhFieldError[], ref?: PersonRef): string {
  const who = ref ? ` (${personLabel(ref)})` : "";
  const body = [
    `Heads up: an employee you manage${who} has had their details fail to sync to Employment Hero three times in a row.`,
    "They've been asked to correct:",
    ...friendlyLines(fields).map((l) => `- ${l}`),
    "Please check in with them so their Employment Hero record can be completed.",
  ].join("\n");
  return clamp(body);
}

/** Manual-follow-up notice -> the admin channel. */
export function followUpNoticeMessage(reasons: string[], ref: PersonRef): string {
  const items =
    reasons.length > 0 ? reasons : ["A payroll admin needs to review this record in Employment Hero."];
  const body = [
    `Employment Hero follow-up needed for ${personLabel(ref)}:`,
    ...items.map((r) => `- ${r}`),
    "The sync completed with safe defaults - finish this by hand in Employment Hero.",
  ].join("\n");
  return clamp(body);
}

/** Resolved notice -> the admin channel, when the daily recheck (#43) finds a follow-up now Complete in EH. */
export function resolvedNoticeMessage(ref: PersonRef, status: string): string {
  return clamp(`✅ ${personLabel(ref)} is now ${status} in Employment Hero - no more action needed.`);
}

/** System alert -> the admin channel, when a queue message dead-letters. */
export function systemAlertMessage(detail: string, ref: PersonRef): string {
  const body = [
    `Employment Hero sync failed for ${personLabel(ref)} and could not be retried.`,
    detail.trim() ? `Detail: ${detail.trim()}` : "No further detail was returned.",
    "No employee action is possible - check the Employment Hero API status and credentials.",
  ].join("\n");
  return clamp(body);
}

/**
 * System alert -> the admin channel, when a write lands on an EH employee id
 * already linked to a DIFFERENT Connecteam user. Employment Hero's
 * unstructured-employee endpoint matches/merges by TFN internally, so two
 * people who happen to share a TFN (a data-entry mistake, a placeholder value
 * never replaced) can get silently spliced into one EH record - see
 * `SyncGateway.findByEhEmployeeId`.
 */
export function collisionAlertMessage(ehEmployeeId: string, ref: PersonRef, otherCtUserId: number): string {
  const body = [
    `The sync for ${personLabel(ref)} landed on Employment Hero employee ${ehEmployeeId}, which is already linked to a different Connecteam user (id ${otherCtUserId}).`,
    "Employment Hero likely matched them by a duplicate value (e.g. the same Tax File Number) instead of creating a separate record.",
    "No employee action is possible - a payroll admin must check and separate these two records directly in Employment Hero.",
  ].join("\n");
  return clamp(body);
}

function clamp(text: string): string {
  const t = text.trim();
  return t.length <= MAX_LEN ? t : `${t.slice(0, MAX_LEN - 1)}…`;
}
