import { describe, it, expect, vi } from "vitest";
import { listCustomFieldDefinitions } from "../scripts/lib/connecteam-custom-fields.js";
import { buildFieldMapDraft } from "../scripts/lib/discover-draft.js";

const wrap = (customFields: unknown[]) => ({ requestId: "r1", data: { customFields } });

const def = (id: number, name: string, type = "str") => ({ id, name, type });

describe("listCustomFieldDefinitions", () => {
  it("pages through GET /users/v1/custom-fields until a short page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => def(1000 + i, `Field ${i}`));
    const page2 = [def(2000, "Tax file number")];
    const ctGet = vi.fn(async (path: string) => (path.includes("offset=0") ? wrap(page1) : wrap(page2)));

    const fields = await listCustomFieldDefinitions(ctGet);

    expect(ctGet.mock.calls.map((c) => c[0])).toEqual([
      "/users/v1/custom-fields?limit=50&offset=0",
      "/users/v1/custom-fields?limit=50&offset=50",
    ]);
    expect(fields).toHaveLength(51);
    expect(fields[50]).toEqual({ customFieldId: 2000, name: "Tax file number", type: "str" });
  });
});

describe("buildFieldMapDraft", () => {
  const base = { client: "acme", packId: 5474, businessId: "123", payScheduleId: "9", locationId: "8" };

  // The 7 fields created during the ADR-0006 rehearsal: defined and attached to
  // the pack, but answered by nobody - the case sampling a user's answers missed.
  const rehearsalFields = [
    def(43566219, "Claim the tax-free threshold?", "dropdown"),
    def(43566276, "Are you an Australian resident for tax purposes?", "dropdown"),
    def(43566277, "Do you have a HELP or STSL debt?", "dropdown"),
    def(43566278, "Super fund USI"),
    def(43566279, "Super fund ABN"),
    def(43566280, "Super fund name"),
    def(43566281, "Super member number"),
  ].map(({ id, name, type }) => ({ customFieldId: id, name, type }));

  it("maps field definitions nobody has answered yet into the rules", () => {
    const { draft } = buildFieldMapDraft({ ...base, fields: rehearsalFields });

    expect(draft.rules.taxDeclaration).toEqual({
      claimTaxFreeThreshold: { customFieldId: 43566219 },
      australianResident: { customFieldId: 43566276 },
      hasHelpOrStslDebt: { customFieldId: 43566277 },
    });
    expect(draft.rules.super).toEqual({
      usiField: 43566278,
      abnField: 43566279,
      fundNameField: 43566280,
      memberNumberField: 43566281,
    });
  });

  it("maps known names to EH fields with their transform and flags", () => {
    const { draft, mappedCount } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 1, name: "Tax file number", type: "str" },
        { customFieldId: 2, name: "Title", type: "str" },
      ],
    });

    expect(mappedCount).toBe(2);
    expect(draft.fields).toContainEqual({
      eh: "taxFileNumber",
      from: { customFieldId: 1 },
      transform: "digits",
      required: true,
      sensitive: true,
    });
    expect(draft.fields).toContainEqual({ eh: "jobTitle", from: { customFieldId: 2 }, transform: "trimString" });
  });

  it("maps each EH field once, leaving a second same-named field for review", () => {
    // Account-wide definitions can include an old field the pack no longer uses.
    const { draft, unmapped } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 10, name: "Tax file number", type: "str" },
        { customFieldId: 11, name: "TFN (old)", type: "str" },
      ],
    });

    expect(draft.fields.filter((f) => f.eh === "taxFileNumber")).toHaveLength(1);
    expect(unmapped.map((u) => u.id)).toEqual([11]);
  });

  it("does not take a field containing 'usi' (e.g. Business) as the super USI", () => {
    const { draft, unmapped } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 20, name: "Business name", type: "str" },
        { customFieldId: 21, name: "Super fund USI", type: "str" },
      ],
    });

    expect(draft.rules.super.usiField).toBe(21);
    expect(unmapped.map((u) => u.id)).toEqual([20]);
  });

  it("lists unrecognised fields for review", () => {
    const { unmapped } = buildFieldMapDraft({
      ...base,
      fields: [{ customFieldId: 99, name: "Direct manager", type: "str" }],
    });

    expect(unmapped).toEqual([{ id: 99, label: "99  Direct manager (str)" }]);
  });
});
