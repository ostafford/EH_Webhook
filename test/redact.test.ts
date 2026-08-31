import { describe, it, expect, vi } from "vitest";
import { redact, isSensitiveKey } from "../src/redact.js";
import { logEvent } from "../src/log.js";

describe("isSensitiveKey", () => {
  const sensitive = [
    "taxFileNumber",
    "tax_file_number",
    "tfn",
    "bankAccount1_BSB",
    "bankAccount1_AccountNumber",
    "bankAccount1_AccountName",
    "superFund1_MemberNumber",
    "memberNumber",
    "BSB",
    "password",
    "apiKey",
    "api_key",
    "authorization",
    "Authorization",
    "secret",
    "CT_API_KEY",
  ];
  const safe = ["firstName", "surname", "residentialPostCode", "ctUserId", "status", "jobTitle", "employmentType"];

  it.each(sensitive)("flags %s", (k) => expect(isSensitiveKey(k)).toBe(true));
  it.each(safe)("allows %s", (k) => expect(isSensitiveKey(k)).toBe(false));
});

describe("redact", () => {
  it("replaces sensitive values anywhere in a nested structure", () => {
    const input = {
      ctUserId: 17760356,
      payload: {
        firstName: "Sam",
        taxFileNumber: "123456782",
        bankAccount1_BSB: "012345",
        bankAccount1_AccountNumber: "00123456",
        residentialPostCode: "3058",
      },
      errors: [{ field: "bankAccount1_BSB", value: "012345" }],
      headers: { authorization: "Basic abc123" },
    };

    expect(redact(input)).toEqual({
      ctUserId: 17760356,
      payload: {
        firstName: "Sam",
        taxFileNumber: "[redacted]",
        bankAccount1_BSB: "[redacted]",
        bankAccount1_AccountNumber: "[redacted]",
        residentialPostCode: "3058",
      },
      errors: [{ field: "bankAccount1_BSB", value: "012345" }], // `field`/`value` keys are not sensitive names
      headers: { authorization: "[redacted]" },
    });
  });

  it("passes primitives and short values straight through", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });

  it("does not mutate the input", () => {
    const input = { tfn: "123456782" };
    redact(input);
    expect(input.tfn).toBe("123456782");
  });
});

describe("logEvent", () => {
  it("emits a single redacted JSON line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logEvent({ evt: "sync", ctUserId: 1, payload: { taxFileNumber: "123456782", firstName: "Sam" } });
      expect(spy).toHaveBeenCalledOnce();
      const line = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(line).toMatchObject({ evt: "sync", ctUserId: 1, payload: { taxFileNumber: "[redacted]", firstName: "Sam" } });
      expect(typeof line.ts).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });
});
