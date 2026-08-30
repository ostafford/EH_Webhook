import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFieldMap } from "../src/mapping/schema.js";
import { applyFieldMap, type ConnecteamUser } from "../src/mapping/apply.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";

const map = parseFieldMap(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../clients/_example/field-map.json", import.meta.url)), "utf8"),
  ),
);

const clone = (): ConnecteamUser => structuredClone(syntheticUser);

describe("parseFieldMap", () => {
  it("accepts the example map and fills identity defaults", () => {
    expect(map.identity.externalIdFrom).toBe("userId");
    expect(map.fields.length).toBeGreaterThan(15);
  });
  it("rejects an unknown transform with a path-prefixed message", () => {
    const bad = { ...map, fields: [{ eh: "firstName", from: { customFieldId: 1 }, transform: "nope" }] };
    expect(() => parseFieldMap(bad)).toThrow(/fields\.0\.transform/);
  });
  it("rejects unknown top-level keys", () => {
    expect(() => parseFieldMap({ ...map, surprise: true })).toThrow(/Invalid field-map/);
  });
});

describe("applyFieldMap - happy path", () => {
  const { payload, issues, externalId, emailFallback } = applyFieldMap(clone(), map);

  it("produces no issues for a complete, valid user", () => {
    expect(issues).toEqual([]);
  });
  it("uses the Connecteam userId as the Employment Hero externalId", () => {
    expect(externalId).toBe("17760356");
    expect(emailFallback).toBe("sam.rivera@example.com");
  });
  it("maps names from the Legal fields, not the display name", () => {
    expect(payload.firstName).toBe("Samuel");
    expect(payload.surname).toBe("Rivera");
  });
  it("converts dates to ISO", () => {
    expect(payload.dateOfBirth).toBe("1992-04-07");
    expect(payload.startDate).toBe("2026-09-01");
  });
  it("reads single-select dropdowns and applies the value map", () => {
    expect(payload.gender).toBe("Female");
    expect(payload.residentialState).toBe("VIC");
    expect(payload.employmentType).toBe("FullTime");
  });
  it("normalises phone to E.164 and email to lower-case", () => {
    expect(payload.mobileNumber).toBe("+61411000111");
    expect(payload.emailAddress).toBe("sam.rivera@example.com");
  });
  it("takes the street line from the location and pads the postcode", () => {
    expect(payload.residentialStreetAddress).toBe("12 Example Rd");
    expect(payload.residentialSuburb).toBe("Coburg");
    expect(payload.residentialPostcode).toBe("3058");
  });
  it("maps country via the lookup", () => {
    expect(payload.residentialCountry).toBe("AU");
  });
  it("keeps leading zeros on BSB and account number, strips separators from TFN", () => {
    expect(payload.taxFileNumber).toBe("123456782");
    expect(payload.bankAccount1_BSB).toBe("012345");
    expect(payload.bankAccount1_AccountNumber).toBe("00123456");
  });
});

describe("applyFieldMap - missing and bad values", () => {
  it("flags a missing required field as an issue, keyed to the EH + source field", () => {
    const u = clone();
    u.customFields = u.customFields.filter((f) => f.customFieldId !== 42920714); // drop Legal Surname
    const { issues, payload } = applyFieldMap(u, map);
    expect(payload.surname).toBeUndefined();
    expect(issues).toContainEqual({
      ehField: "surname",
      source: "customField 42920714 (not present)",
      reason: "required value is missing or blank",
    });
  });

  it("silently skips a missing optional field", () => {
    const u = clone();
    u.customFields = u.customFields.filter((f) => f.customFieldId !== 25145108); // drop Title
    const { issues, payload } = applyFieldMap(u, map);
    expect(payload.jobTitle).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it("reports a bad date rather than throwing", () => {
    const u = clone();
    u.customFields.find((f) => f.customFieldId === 25145118)!.value = "1992-04-07";
    const { issues } = applyFieldMap(u, map);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.ehField).toBe("dateOfBirth");
    expect(issues[0]!.reason).toMatch(/DD\/MM\/YYYY/);
  });

  it("reports an unmapped dropdown value against the allowed list", () => {
    const u = clone();
    u.customFields.find((f) => f.customFieldId === 42920839)!.value = [{ id: 9, value: "Contractor" }];
    const { issues } = applyFieldMap(u, map);
    expect(issues[0]!.ehField).toBe("employmentType");
    expect(issues[0]!.reason).toMatch(/FullTime, PartTime, Casual, LabourHire/);
  });

  it("falls back to the default when the source is blank", () => {
    const u = clone();
    u.customFields.find((f) => f.customFieldId === 42920716)!.value = null;
    const { payload, issues } = applyFieldMap(u, map);
    expect(issues).toEqual([]);
    expect(payload.residentialCountry).toBe("AU");
  });
});
