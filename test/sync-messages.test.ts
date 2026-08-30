import { describe, it, expect } from "vitest";
import {
  correctionMessage,
  managerEscalationMessage,
  followUpNoticeMessage,
  systemAlertMessage,
  friendlyLine,
  GENERIC_CORRECTION,
} from "../src/sync/messages.js";
import type { EhFieldError } from "../src/eh/errors.js";

describe("friendlyLine - curated EH-error -> plain language", () => {
  const cases: Array<[EhFieldError, RegExp]> = [
    [{ field: "BankAccount1", reason: "BSB must contain 6 digits only" }, /BSB/],
    [{ field: "bankAccount1_AccountNumber", reason: "is invalid" }, /account number/],
    [{ field: "taxFileNumber", reason: "The tax file number is invalid." }, /Tax File Number/],
    [{ field: "(incomplete)", reason: "Basic Details are incomplete" }, /legal name/],
    [{ field: "(incomplete)", reason: "Tax Details are incomplete" }, /tax declaration/],
    [{ field: "startDate", reason: "is required" }, /start date/],
    [{ field: "dateOfBirth", reason: "must be a valid date" }, /date of birth/],
    [{ field: "employmentType", reason: "is not valid" }, /employment type/],
    [{ field: "residentialPostCode", reason: "is invalid" }, /postcode/],
    [{ field: "superFund1_MemberNumber", reason: "is required" }, /super fund/],
  ];
  it.each(cases)("%o -> %s", (err, re) => {
    expect(friendlyLine(err)).toMatch(re);
  });

  it("never echoes the raw EH reason text", () => {
    const line = friendlyLine({ field: "bankAccount1_BSB", reason: "BSB 083-170 failed the mod-97 checksum" });
    expect(line).not.toContain("083-170");
    expect(line).not.toContain("mod-97");
  });

  it("falls back to the generic actionable line for an unknown field", () => {
    expect(friendlyLine({ field: "someBrandNewField", reason: "computer says no" })).toBe(GENERIC_CORRECTION);
  });
});

describe("correctionMessage", () => {
  it("names each distinct field once, in plain language, under 500 chars", () => {
    const msg = correctionMessage([
      { field: "bankAccount1_BSB", reason: "BSB must contain 6 digits only" },
      { field: "bankAccount1_BSB", reason: "BSB is invalid" },
      { field: "taxFileNumber", reason: "The tax file number is invalid." },
    ]);
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toMatchInlineSnapshot(`
      "Hi - a few of the details you entered for payroll need a quick fix:
      - Your bank BSB doesn't look right - check it's the 6-digit branch number for your account and re-enter it in Connecteam.
      - Your Tax File Number doesn't appear to be valid - re-check the 9 digits and re-enter it in Connecteam.
      Update them in Connecteam and we'll sync again automatically."
    `);
  });

  it("drops the generic catch-all once at least one specific line is present", () => {
    const msg = correctionMessage([
      { field: "startDate", reason: "is required" },
      { field: "mysteryField", reason: "nope" },
    ]);
    expect(msg).toContain("start date");
    expect(msg).not.toContain(GENERIC_CORRECTION);
  });

  it("uses the generic line alone when nothing is recognised", () => {
    const msg = correctionMessage([{ field: "mysteryField", reason: "nope" }]);
    expect(msg).toContain(GENERIC_CORRECTION);
  });
});

describe("managerEscalationMessage", () => {
  it("frames it for the manager and lists the stuck fields, under 500 chars", () => {
    const msg = managerEscalationMessage([{ field: "taxFileNumber", reason: "invalid" }]);
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toMatchInlineSnapshot(`
      "Heads up: an employee you manage has had their payroll details fail to sync three times in a row.
      They've been asked to correct:
      - Your Tax File Number doesn't appear to be valid - re-check the 9 digits and re-enter it in Connecteam.
      Please check in with them so payroll can be completed."
    `);
  });
});

describe("followUpNoticeMessage", () => {
  it("addresses the admin channel with the follow-up reasons and the user ref", () => {
    const msg = followUpNoticeMessage(
      [
        'Employee marked "not an Australian resident for tax" - set the foreign-resident or working-holiday-maker tax scale in Employment Hero.',
        "Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.",
      ],
      { ctUserId: 17760356 },
    );
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toContain("17760356");
    expect(msg).toMatchInlineSnapshot(`
      "Payroll follow-up needed for Connecteam user 17760356:
      - Employee marked "not an Australian resident for tax" - set the foreign-resident or working-holiday-maker tax scale in Employment Hero.
      - Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.
      The sync completed with safe defaults - finish this by hand in Employment Hero."
    `);
  });

  it("still says something useful when given no reasons", () => {
    const msg = followUpNoticeMessage([], { ctUserId: 42 });
    expect(msg).toContain("review this record");
  });
});

describe("systemAlertMessage", () => {
  it("names the user, includes the detail, and says no employee action is possible", () => {
    const msg = systemAlertMessage("EH 503: service unavailable", { ctUserId: 42 });
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toMatchInlineSnapshot(`
      "Payroll sync failed for Connecteam user 42 and could not be retried.
      Detail: EH 503: service unavailable
      No employee action is possible - check the Employment Hero API status and credentials."
    `);
  });

  it("copes with an empty detail", () => {
    expect(systemAlertMessage("", { ctUserId: 42 })).toContain("No further detail");
  });
});

describe("length clamping", () => {
  it("truncates an over-long correction with an ellipsis", () => {
    // One error in every curated bucket - the composed message runs well past 500.
    const many: EhFieldError[] = [
      { field: "bankAccount1_BSB", reason: "bad" },
      { field: "bankAccount1_AccountNumber", reason: "bad" },
      { field: "bankAccount1_AccountName", reason: "bad" },
      { field: "taxFileNumber", reason: "bad" },
      { field: "australianResident", reason: "bad" },
      { field: "startDate", reason: "bad" },
      { field: "dateOfBirth", reason: "bad" },
      { field: "employmentType", reason: "bad" },
      { field: "gender", reason: "bad" },
      { field: "residentialPostCode", reason: "bad" },
      { field: "residentialState", reason: "bad" },
      { field: "residentialStreetAddress", reason: "bad" },
      { field: "emailAddress", reason: "bad" },
      { field: "mobilePhone", reason: "bad" },
      { field: "superFund1_MemberNumber", reason: "bad" },
      { field: "emergencyContact1_Name", reason: "bad" },
      { field: "surname", reason: "bad" },
    ];
    const msg = correctionMessage(many);
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg.endsWith("…")).toBe(true);
  });
});
