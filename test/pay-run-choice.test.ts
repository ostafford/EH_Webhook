import { describe, it, expect } from "vitest";
import { applyPayRunChoice, primaryPayCategoryOptions, rateSourceOptions } from "../scripts/lib/pay-run-choice.js";
import { parseFieldMap } from "../src/mapping/schema.js";

const cat = (name: string, extra: object = {}) => ({
  name,
  isPrimary: true,
  parentId: null,
  payCategoryType: "Standard",
  rateUnit: "Hourly",
  awardName: null,
  ...extra,
});

describe("primaryPayCategoryOptions", () => {
  it("keeps top-level primary hourly/annual categories and drops allowances, leave and sub-categories", () => {
    const opts = primaryPayCategoryOptions([
      cat("Permanent Ordinary Hours"),
      cat("Salary", { rateUnit: "Annually" }),
      cat("First Aid Allowance", { rateUnit: "Fixed" }),
      cat("Annual Leave Taken", { isPrimary: false }),
      cat("Time in lieu taken"),
      cat("OT Clearing"),
      cat("Ordinary Hours", { parentId: 2006402 }),
      cat("Back Payment", { payCategoryType: "BackPayment" }),
    ]);
    expect(opts.map((o) => o.name)).toEqual(["Permanent Ordinary Hours", "Salary"]);
  });

  it("lists a name once, noting every award it comes from", () => {
    const opts = primaryPayCategoryOptions([
      cat("Permanent - Ordinary Hours", { awardName: "Retail (General) Industry Award 2020 [MA000004]" }),
      cat("Permanent - Ordinary Hours", { awardName: "Banking, Finance and Insurance Award 2020 [MA000019]" }),
    ]);
    expect(opts).toEqual([
      {
        name: "Permanent - Ordinary Hours",
        note: "Retail (General) Industry Award 2020 [MA000004]; Banking, Finance and Insurance Award 2020 [MA000019]",
      },
    ]);
  });
});

const baseMap = (extra: { employmentHero?: object; fields?: object[] } = {}) => ({
  client: "self",
  connecteam: { onboardingPackId: 5474 },
  employmentHero: { businessId: "555455", ...extra.employmentHero },
  identity: { externalIdFrom: "userId", emailFallbackFrom: "email" },
  fields: [{ eh: "firstName", from: { customFieldId: 1 }, transform: "trimString" }, ...(extra.fields ?? [])],
});

const awardField = { eh: "payRateTemplate", from: { customFieldId: 43504863 }, transform: "dropdownValue" };

const picks = {
  paySchedule: { id: 32407, name: "Weekly" },
  location: { id: 436590, name: "Connecteam" },
  primaryPayCategory: "Permanent Ordinary Hours",
};

describe("rateSourceOptions", () => {
  it("offers the award only once the award field is mapped", () => {
    expect(rateSourceOptions(baseMap()).map((o) => o.key)).toEqual(["connecteamPayRate", "skip"]);
    expect(rateSourceOptions(baseMap({ fields: [awardField] })).map((o) => o.key)).toEqual([
      "award",
      "connecteamPayRate",
      "skip",
    ]);
  });
});

describe("applyPayRunChoice", () => {
  it("award: writes the three names and turns on the award as the rate source", () => {
    const out: any = applyPayRunChoice(baseMap({ fields: [awardField], employmentHero: { perEmployeeRate: { source: "connecteamPayRate" } } }), {
      ...picks,
      rateSource: "award",
    });

    expect(out.employmentHero).toEqual({
      businessId: "555455",
      payScheduleId: "32407",
      locationId: "436590",
      defaults: { paySchedule: "Weekly", primaryLocation: "Connecteam", primaryPayCategory: "Permanent Ordinary Hours" },
      payRateTemplate: { source: "connecteamField" },
    });
    expect(() => parseFieldMap(out)).not.toThrow();
  });

  it("Connecteam pay rate: turns on perEmployeeRate and drops any flat rate", () => {
    const out: any = applyPayRunChoice(
      baseMap({ employmentHero: { defaults: { rate: 30, rateUnit: "Hourly", hoursPerWeek: 38 }, payRateTemplate: { source: "connecteamField" } } }),
      { ...picks, rateSource: "connecteamPayRate" },
    );

    expect(out.employmentHero.defaults).toEqual({
      paySchedule: "Weekly",
      primaryLocation: "Connecteam",
      primaryPayCategory: "Permanent Ordinary Hours",
      hoursPerWeek: 38,
    });
    expect(out.employmentHero.perEmployeeRate).toEqual({ source: "connecteamPayRate" });
    expect(out.employmentHero.payRateTemplate).toBeUndefined();
    expect(() => parseFieldMap(out)).not.toThrow();
  });

  it("skip: leaves the map exactly as it was", () => {
    const map = baseMap({ employmentHero: { defaults: { paySchedule: "Weekly" } } });
    expect(applyPayRunChoice(map, { ...picks, rateSource: "skip" })).toEqual(map);
  });

  it("never changes the input map", () => {
    const map = baseMap({ fields: [awardField] });
    const before = structuredClone(map);
    applyPayRunChoice(map, { ...picks, rateSource: "award" });
    expect(map).toEqual(before);
  });
});
