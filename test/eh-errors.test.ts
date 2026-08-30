import { describe, it, expect } from "vitest";
import { parseValidationBody } from "../src/eh/errors.js";

describe("parseValidationBody", () => {
  it("reads a ModelState-style field dictionary", () => {
    const body = {
      TaxFileNumber: ["The tax file number is invalid."],
      "BankAccounts[0].BSB": ["BSB must be 6 digits."],
    };
    expect(parseValidationBody(body)).toEqual([
      { field: "TaxFileNumber", reason: "The tax file number is invalid." },
      { field: "BankAccounts[0].BSB", reason: "BSB must be 6 digits." },
    ]);
  });

  it("reads an array of messages", () => {
    expect(parseValidationBody(["Start date is required.", "Surname is required."])).toEqual([
      { field: "(unknown)", reason: "Start date is required." },
      { field: "(unknown)", reason: "Surname is required." },
    ]);
  });

  it("reads a { message } envelope", () => {
    expect(parseValidationBody({ message: "Employee could not be saved." })).toEqual([
      { field: "(unknown)", reason: "Employee could not be saved." },
    ]);
  });

  it("reads a bare string", () => {
    expect(parseValidationBody("Something was wrong.")).toEqual([
      { field: "(unknown)", reason: "Something was wrong." },
    ]);
  });

  it("falls back to a generic reason when the body is empty or unrecognised", () => {
    for (const body of [null, {}, [], "", 42]) {
      const [only] = parseValidationBody(body);
      expect(only!.field).toBe("(unknown)");
      expect(only!.reason).toMatch(/rejected the record/);
    }
  });
});
