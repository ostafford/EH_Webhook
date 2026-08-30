import { describe, it, expect } from "vitest";
import { parseValidationBody } from "../src/eh/errors.js";

describe("parseValidationBody", () => {
  it("reads the live shape: { message: 'Field: reason\\nField: reason' }", () => {
    const body = { message: "BankAccount1: BSB must contain 6 digits only\nBankAccount1: BSB is invalid" };
    expect(parseValidationBody(body)).toEqual([
      { field: "BankAccount1", reason: "BSB must contain 6 digits only" },
      { field: "BankAccount1", reason: "BSB is invalid" },
    ]);
  });

  it("keeps an unprefixed message line as an (unknown)-field reason", () => {
    const body = { message: "The sum of the allocated percentage should total 100 for bank accounts" };
    expect(parseValidationBody(body)).toEqual([
      { field: "(unknown)", reason: "The sum of the allocated percentage should total 100 for bank accounts" },
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
});
