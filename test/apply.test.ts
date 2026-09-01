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

  it("accepts an optional employmentHero.defaults block (issue #26)", () => {
    const withDefaults = {
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: { awardId: "12345", classification: "Level 2", standardHoursPerWeek: 38 },
      },
    };
    expect(parseFieldMap(withDefaults).employmentHero.defaults).toEqual({
      awardId: "12345",
      classification: "Level 2",
      standardHoursPerWeek: 38,
    });
  });

  it("rejects an unknown key inside employmentHero.defaults", () => {
    const bad = {
      ...map,
      employmentHero: { ...map.employmentHero, defaults: { annualSalary: 90000 } },
    };
    expect(() => parseFieldMap(bad)).toThrow(/employmentHero\.defaults/);
  });
});

describe("applyFieldMap - employmentHero.defaults (issue #26)", () => {
  it("does nothing when the block is absent", () => {
    const { payload } = applyFieldMap(clone(), map);
    expect(payload.awardId).toBeUndefined();
    expect(payload.classification).toBeUndefined();
  });

  it("stamps each present default onto the payload, like payScheduleId", () => {
    const withDefaults = parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: { awardId: 12345, classification: "Level 2", payCategoryId: "67890", standardHoursPerWeek: 38 },
      },
    });
    const { payload, issues } = applyFieldMap(clone(), withDefaults);
    expect(issues).toEqual([]);
    expect(payload.awardId).toBe(12345);
    expect(payload.classification).toBe("Level 2");
    expect(payload.payCategoryId).toBe("67890");
    expect(payload.standardHoursPerWeek).toBe(38);
  });

  it("omits a default that is not set", () => {
    const withOne = parseFieldMap({
      ...map,
      employmentHero: { ...map.employmentHero, defaults: { awardId: "A1" } },
    });
    const { payload } = applyFieldMap(clone(), withOne);
    expect(payload.awardId).toBe("A1");
    expect(payload.standardHoursPerWeek).toBeUndefined();
    expect(payload.classification).toBeUndefined();
  });
});

describe("applyFieldMap - happy path", () => {
  const { payload, issues, externalId, emailFallback, followUps } = applyFieldMap(clone(), map);

  it("produces no issues and no follow-ups for a complete, valid user", () => {
    expect(issues).toEqual([]);
    expect(followUps).toEqual([]);
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
    expect(payload.mobilePhone).toBe("+61411000111");
    expect(payload.emailAddress).toBe("sam.rivera@example.com");
  });
  it("takes the street line from the location and pads the postcode", () => {
    expect(payload.residentialStreetAddress).toBe("12 Example Rd");
    expect(payload.residentialSuburb).toBe("Coburg");
    expect(payload.residentialPostCode).toBe("3058");
  });
  it("maps country via the lookup", () => {
    expect(payload.residentialCountry).toBe("AU");
  });

  it("resolves the tax file declaration to booleans", () => {
    expect(payload.claimTaxFreeThreshold).toBe(true);
    expect(payload.australianResident).toBe(true);
    expect(payload.helpDebt).toBe(false);
    expect(payload.stslDebt).toBe(false);
  });

  it("maps an APRA super fund (USI present)", () => {
    expect(payload.superFund1_ProductCode).toBe("HOS0100AU");
    expect(payload.superFund1_FundName).toBe("Hostplus");
    expect(payload.superFund1_MemberNumber).toBe("M123456");
    // EH rejects super details with no allocation; v1 is a single fund at 100%.
    expect(payload.superFund1_AllocatedPercentage).toBe(100);
  });

  it("folds in constants and the structural config", () => {
    expect(payload.bankAccount1_AllocatedPercentage).toBe(100);
    expect(payload.payScheduleId).toBe("32407");
    expect(payload.locationId).toBe("436590");
    expect(payload.externalId).toBe("17760356");
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

describe("applyFieldMap - rules engine", () => {
  const setField = (u: ConnecteamUser, id: number, value: unknown) => {
    u.customFields.find((f) => f.customFieldId === id)!.value = value;
  };
  const dropField = (u: ConnecteamUser, id: number) => {
    u.customFields = u.customFields.filter((f) => f.customFieldId !== id);
  };

  it("marks a non-resident and raises a follow-up", () => {
    const u = clone();
    setField(u, 42923315, [{ id: 1, value: "No" }]); // not an Australian resident
    setField(u, 42923276, [{ id: 1, value: "No" }]); // ...so, consistently, no tax-free threshold
    const { payload, followUps, issues } = applyFieldMap(u, map);
    expect(issues).toEqual([]);
    expect(payload.australianResident).toBe(false);
    expect(payload.isNonResident).toBeUndefined();
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatch(/foreign-resident or working-holiday-maker/);
  });

  it("raises a correction when a non-resident still claims the tax-free threshold", () => {
    const u = clone();
    setField(u, 42923315, [{ id: 1, value: "No" }]); // non-resident
    // 42923276 (claim tax-free threshold) stays "Yes" from the fixture - the conflict
    const { issues } = applyFieldMap(u, map);
    expect(issues).toContainEqual(
      expect.objectContaining({
        ehField: "claimTaxFreeThreshold",
        reason: expect.stringContaining("non-resident"),
      }),
    );
  });

  it("does not sync an SMSF, raises a follow-up instead", () => {
    const u = clone();
    setField(u, 42920803, ""); // clear USI
    const { payload, followUps } = applyFieldMap(u, map);
    expect(payload.superFund1_ProductCode).toBeUndefined();
    expect(payload.superFund1_MemberNumber).toBeUndefined();
    expect(payload.superFund1_AllocatedPercentage).toBeUndefined();
    expect(followUps).toContain(
      "Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.",
    );
  });

  it("flags an APRA fund with a missing member number", () => {
    const u = clone();
    setField(u, 42920804, "");
    const { issues } = applyFieldMap(u, map);
    expect(issues).toContainEqual({
      ehField: "superFund1_MemberNumber",
      source: "customField 42920804 (Member Number)",
      reason: "APRA super fund USI is set but the member number is missing",
    });
  });

  it("flags each missing tax-declaration answer", () => {
    const u = clone();
    dropField(u, 42923276);
    dropField(u, 42923315);
    const { issues } = applyFieldMap(u, map);
    const ehFields = issues.map((i) => i.ehField).sort();
    expect(ehFields).toEqual(["australianResident", "claimTaxFreeThreshold"]);
    expect(issues.every((i) => i.reason === "required Yes/No answer is missing")).toBe(true);
  });

  it("flags a tax-declaration answer that isn't Yes or No", () => {
    const u = clone();
    setField(u, 42923316, [{ id: 2, value: "Unsure" }]);
    const { issues } = applyFieldMap(u, map);
    expect(issues[0]!.ehField).toBe("helpDebt");
    expect(issues[0]!.reason).toMatch(/expected "Yes" or "No"/);
  });

  it("raises a follow-up for an INTERNATIONAL address", () => {
    const u = clone();
    setField(u, 42920838, [{ id: 9, value: "INTERNATIONAL" }]);
    const { payload, followUps } = applyFieldMap(u, map);
    expect(payload.residentialState).toBe("INTERNATIONAL");
    expect(followUps).toContain(
      "Address state is INTERNATIONAL - enter the overseas residential address in Employment Hero manually.",
    );
  });
});
