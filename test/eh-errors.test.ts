import { describe, it, expect } from "vitest";
import { parseValidationBody, fieldForColonlessReason } from "../src/eh/errors.js";

describe("parseValidationBody", () => {
  it("reads the live shape: { message: 'Field: reason\\nField: reason' }", () => {
    const body = { message: "BankAccount1: BSB must contain 6 digits only\nBankAccount1: BSB is invalid" };
    expect(parseValidationBody(body)).toEqual([
      { field: "BankAccount1", reason: "BSB must contain 6 digits only" },
      { field: "BankAccount1", reason: "BSB is invalid" },
    ]);
  });

  it("maps a known colon-less prose line back to an EH field (issue #29)", () => {
    const body = { message: "The sum of the allocated percentage should total 100 for bank accounts" };
    expect(parseValidationBody(body)).toEqual([
      { field: "bankAccountAllocation", reason: "The sum of the allocated percentage should total 100 for bank accounts" },
    ]);
  });

  it("keeps an unrecognised colon-less line as an (unknown)-field reason", () => {
    const body = { message: "Something we have never seen before went wrong" };
    expect(parseValidationBody(body)).toEqual([
      { field: "(unknown)", reason: "Something we have never seen before went wrong" },
    ]);
  });

  it("handles a dotted / indexed field name", () => {
    expect(parseValidationBody({ message: "BankAccounts[0].BSB: must be 6 digits" })).toEqual([
      { field: "BankAccounts[0].BSB", reason: "must be 6 digits" },
    ]);
  });

  it("falls back to a ModelState-style dictionary", () => {
    expect(parseValidationBody({ TaxFileNumber: ["The tax file number is invalid."] })).toEqual([
      { field: "TaxFileNumber", reason: "The tax file number is invalid." },
    ]);
  });

  it("falls back to an array of messages", () => {
    expect(parseValidationBody(["Start date is required.", "Surname is required."])).toEqual([
      { field: "(unknown)", reason: "Start date is required." },
      { field: "(unknown)", reason: "Surname is required." },
    ]);
  });

  it("reads a bare string with the same line rules", () => {
    expect(parseValidationBody("Surname: is required")).toEqual([{ field: "Surname", reason: "is required" }]);
  });

  it("falls back to a generic reason when the body is empty or unrecognised", () => {
    for (const body of [null, {}, [], "", 42]) {
      const [only] = parseValidationBody(body);
      expect(only!.field).toBe("(unknown)");
      expect(only!.reason).toMatch(/rejected the record/);
    }
  });

  it("maps colon-less lines inside a multi-line message, leaving prefixed lines alone", () => {
    const body = {
      message: "BankAccount1: BSB must contain 6 digits only\nTax File Number is invalid",
    };
    expect(parseValidationBody(body)).toEqual([
      { field: "BankAccount1", reason: "BSB must contain 6 digits only" },
      { field: "taxFileNumber", reason: "Tax File Number is invalid" },
    ]);
  });

  it("maps a known phrase in the array-of-messages shape too", () => {
    expect(parseValidationBody(["Tax free threshold can only be claimed for Australian residents"])).toEqual([
      { field: "taxFreeThreshold", reason: "Tax free threshold can only be claimed for Australian residents" },
    ]);
  });
});

describe("fieldForColonlessReason", () => {
  it.each([
    ["Tax File Number is invalid", "taxFileNumber"],
    ["The tax file number is invalid.", "taxFileNumber"],
    ["Tax free threshold can only be claimed for Australian residents", "taxFreeThreshold"],
    ["The sum of the allocated percentage should total 100 for bank accounts", "bankAccountAllocation"],
    ["The sum of the allocated percentage should total 100 for super funds", "superAllocation"],
  ])("%s -> %s", (reason, field) => {
    expect(fieldForColonlessReason(reason)).toBe(field);
  });

  it("returns (unknown) for a phrase not yet in the map", () => {
    expect(fieldForColonlessReason("Start date is required")).toBe("(unknown)");
  });
});
