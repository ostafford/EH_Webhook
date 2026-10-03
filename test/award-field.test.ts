import { describe, it, expect } from "vitest";
import { findAwardField, withAwardRule, withoutAwardRule } from "../scripts/lib/award-field.js";

describe("findAwardField", () => {
  it("finds the award dropdown by name, ignoring case and spaces", () => {
    const raw = [
      { id: 1, name: "Title", type: "str" },
      { id: 43504863, name: " eh pay rate template ", type: "dropdown" },
    ];
    expect(findAwardField(raw)).toEqual({ id: 43504863, name: " eh pay rate template ", type: "dropdown" });
  });

  it("returns undefined when there is none", () => {
    expect(findAwardField([{ id: 1, name: "Title", type: "str" }])).toBeUndefined();
  });

  it("refuses a same-named field that is not a dropdown", () => {
    expect(() => findAwardField([{ id: 7, name: "EH Pay Rate Template", type: "str" }])).toThrow(/not a dropdown/);
  });
});

const map = (fields: object[]) => ({ client: "self", fields: [{ eh: "firstName", from: { customFieldId: 1 }, transform: "trimString" }, ...fields] });
const rule = (id: number) => ({ eh: "payRateTemplate", from: { customFieldId: id }, transform: "dropdownValue" });

describe("withAwardRule", () => {
  it("adds the award rule", () => {
    expect(withAwardRule(map([]), 43504863).fields).toEqual([map([]).fields[0], rule(43504863)]);
  });

  it("repoints an existing award rule instead of adding a second", () => {
    const out = withAwardRule(map([rule(111)]), 43504863);
    expect(out.fields.filter((f: any) => f.eh === "payRateTemplate")).toEqual([rule(43504863)]);
  });

  it("never changes the input map", () => {
    const m = map([rule(111)]);
    withAwardRule(m, 43504863);
    expect(m.fields[1]).toEqual(rule(111));
  });
});

describe("withoutAwardRule", () => {
  it("removes the award rule and keeps the rest", () => {
    expect(withoutAwardRule(map([rule(111)]))).toEqual(map([]));
  });
});
