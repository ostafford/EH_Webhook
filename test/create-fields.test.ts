import { describe, it, expect } from "vitest";
import { planMissingFields } from "../scripts/lib/create-fields.js";
import { FIELD_SPEC } from "../scripts/lib/field-spec.js";
import { DEMO_CUSTOM_FIELDS } from "./fixtures/demo-custom-fields.js";

const CATEGORIES = [
  { id: 1, name: "Personal Details" },
  { id: 2, name: "Company Related Info" },
  { id: 3, name: "Super & TAX Information" },
  { id: 4, name: "Payroll Information" },
];

const creatable = FIELD_SPEC.filter((s) => s.create);

describe("planMissingFields", () => {
  it("finds nothing to create on the demo account", () => {
    const plan = planMissingFields(DEMO_CUSTOM_FIELDS, CATEGORIES);
    expect(plan.missing).toEqual([]);
    expect(plan.found).toHaveLength(creatable.length);
  });

  it("plans every field on an empty account, with the exact dropdown options", () => {
    const { missing } = planMissingFields([], CATEGORIES);
    expect(missing.map((m) => m.spec.name)).toEqual(creatable.map((s) => s.name));

    const options = (name: string) =>
      missing.find((m) => m.spec.name === name)!.body.dropdownOptions!.map((o) => o.value);
    expect(options("State")).toEqual(["QLD", "NSW", "VIC", "ACT", "TAS", "SA", "WA", "NT", "INTERNATIONAL"]);
    expect(options("Employee Status")).toEqual(["FullTime", "PartTime", "Casual", "LabourHire"]);
    expect(options("Gender")).toEqual(["Male", "Female", "Other"]);
  });

  it("builds the Connecteam create body for a dropdown and a plain field", () => {
    const { missing } = planMissingFields([], CATEGORIES);
    const body = (name: string) => missing.find((m) => m.spec.name === name)!.body;

    expect(body("Employee Status")).toEqual({
      name: "Employee Status",
      type: "dropdown",
      categoryId: 2,
      isRequired: false,
      isVisibleToAllAdmins: true,
      isEditableForAllAdmins: true,
      isVisibleToUsers: true,
      isEditableForUsers: false,
      isMultiSelect: false,
      dropdownOptions: [
        { value: "FullTime", isDisabled: false },
        { value: "PartTime", isDisabled: false },
        { value: "Casual", isDisabled: false },
        { value: "LabourHire", isDisabled: false },
      ],
    });
    expect(body("TFN")).toEqual({
      name: "TFN",
      type: "str",
      categoryId: 3,
      isRequired: false,
      isVisibleToAllAdmins: true,
      isEditableForAllAdmins: true,
      isVisibleToUsers: true,
      isEditableForUsers: true,
    });
  });

  it("matches a client's own field names, not just the demo's", () => {
    const { missing } = planMissingFields([{ customFieldId: 9, name: "Tax File Number", type: "str" }], CATEGORIES);
    expect(missing.map((m) => m.spec.name)).not.toContain("TFN");
  });

  it("files a field under the first category when its own doesn't exist, and says so", () => {
    const { missing } = planMissingFields([], [{ id: 77, name: "General" }]);
    const tfn = missing.find((m) => m.spec.name === "TFN")!;
    expect(tfn.body.categoryId).toBe(77);
    expect(tfn.categoryNote).toBe('no "Super & TAX Information" category - filed under "General"');
  });

  it("never plans a field marked create: false", () => {
    const { missing } = planMissingFields([], CATEGORIES);
    expect(missing.some((m) => m.spec.name === "Standard hours per week")).toBe(false);
  });
});
