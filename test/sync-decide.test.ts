import { describe, it, expect } from "vitest";
import { decide, compareReadBack, auditDetail } from "../src/sync/decide.js";
import type { EhResult } from "../src/eh/client.js";
import type { EhWriteResult } from "../src/eh/types.js";

const okWrite = (over: Partial<EhWriteResult> = {}): EhResult<EhWriteResult> => ({
  outcome: "ok",
  data: { id: 1, status: "Complete", detailedStatus: null, operationType: "Update", created: false, ...over },
});

describe("decide", () => {
  it("a clean write with nothing outstanding is ok", () => {
    expect(decide({ write: okWrite(), followUps: [] })).toEqual({ kind: "ok" });
  });

  it("mapping issues short-circuit to a correction, before any write", () => {
    const d = decide({
      mappingIssues: [
        { ehField: "dateOfBirth", source: "customField 25145118 (Birthday)", reason: "expected DD/MM/YYYY" },
        { ehField: "surname", source: "customField 42920714 (not present)", reason: "required value is missing or blank" },
      ],
    });
    expect(d).toEqual({
      kind: "correction",
      fields: [
        { field: "dateOfBirth", reason: "expected DD/MM/YYYY" },
        { field: "surname", reason: "required value is missing or blank" },
      ],
    });
  });

  it("an EH 400 validation failure becomes a correction carrying the field errors", () => {
    const write: EhResult<EhWriteResult> = {
      outcome: "validation",
      status: 400,
      issues: [{ field: "BankAccount1", reason: "BSB must contain 6 digits only" }],
    };
    expect(decide({ write })).toEqual({
      kind: "correction",
      fields: [{ field: "BankAccount1", reason: "BSB must contain 6 digits only" }],
    });
  });

  it("a 2xx write whose record stays Incomplete becomes a correction, using detailedStatus as the hint", () => {
    const d = decide({ write: okWrite({ status: "Incomplete", detailedStatus: "Basic Details are incomplete: Tax File Number" }) });
    expect(d).toEqual({
      kind: "correction",
      fields: [{ field: "(incomplete)", reason: "Basic Details are incomplete: Tax File Number" }],
    });
  });

  it("Incomplete with no detail still produces a correction with a generic reason", () => {
    const d = decide({ write: okWrite({ status: "Incomplete", detailedStatus: null }) });
    expect(d.kind).toBe("correction");
    expect(d).toMatchObject({ fields: [{ field: "(incomplete)" }] });
  });

  it("a read-back mismatch on a clean-status write becomes a correction", () => {
    const d = decide({
      write: okWrite(),
      readBack: { matched: false, mismatches: [{ field: "residentialSuburb", reason: "value did not match after the write" }] },
    });
    expect(d).toEqual({
      kind: "correction",
      fields: [{ field: "residentialSuburb", reason: "value did not match after the write" }],
    });
  });

  it("follow-ups on an otherwise-clean write become a follow_up", () => {
    const d = decide({ write: okWrite(), followUps: ["Self-managed super fund - add it by hand."] });
    expect(d).toEqual({ kind: "follow_up", reasons: ["Self-managed super fund - add it by hand."] });
  });

  it("a correction outranks a follow-up when both apply", () => {
    const d = decide({
      write: okWrite({ status: "Incomplete", detailedStatus: "Tax Details are incomplete" }),
      followUps: ["Non-resident - set the tax scale by hand."],
    });
    expect(d.kind).toBe("correction");
  });

  it("a retryable EH result becomes a retry", () => {
    const write: EhResult<EhWriteResult> = { outcome: "retryable", status: 503, detail: "service unavailable" };
    expect(decide({ write })).toEqual({ kind: "retry", detail: "service unavailable" });
  });

  it("an unexpected client_error becomes a retry (not employee-fixable)", () => {
    const write: EhResult<EhWriteResult> = { outcome: "client_error", status: 401, detail: "unauthorized" };
    expect(decide({ write })).toEqual({ kind: "retry", detail: "EH 401: unauthorized" });
  });

  it("no write result at all is a retry rather than a throw", () => {
    expect(decide({})).toEqual({ kind: "retry", detail: "no write result to decide on" });
  });
});

describe("compareReadBack", () => {
  it("matches when every non-sensitive field agrees", () => {
    const r = compareReadBack(
      { firstName: "Sam", residentialPostCode: "3058", startDate: "2026-09-01" },
      { firstName: "Sam", residentialPostCode: "3058", startDate: "2026-09-01" },
    );
    expect(r).toEqual({ matched: true, mismatches: [] });
  });

  it("flags a changed field, normalising case and surrounding space", () => {
    const r = compareReadBack({ residentialState: "VIC" }, { residentialState: " vic " });
    expect(r.matched).toBe(true);
    const bad = compareReadBack({ residentialState: "VIC" }, { residentialState: "NSW" });
    expect(bad.matched).toBe(false);
    expect(bad.mismatches).toEqual([{ field: "residentialState", reason: "value did not match after the write" }]);
  });

  it("never compares TFN, bank or member-number fields", () => {
    const r = compareReadBack(
      { taxFileNumber: "123456782", bankAccount1_BSB: "012345", superFund1_MemberNumber: "M1", firstName: "Sam" },
      { taxFileNumber: "999", bankAccount1_BSB: "999999", superFund1_MemberNumber: "ZZ", firstName: "Sam" },
    );
    expect(r).toEqual({ matched: true, mismatches: [] });
  });

  it("treats a missing read-back value as a mismatch", () => {
    const r = compareReadBack({ jobTitle: "Barista" }, {});
    expect(r.matched).toBe(false);
  });

  it("can be restricted to an explicit safe field list", () => {
    const r = compareReadBack({ firstName: "Sam", surname: "Rivera" }, { firstName: "Sam", surname: "Jones" }, ["firstName"]);
    expect(r.matched).toBe(true);
  });
});

describe("auditDetail", () => {
  it("lists distinct field names for a correction, no values", () => {
    expect(
      auditDetail({
        kind: "correction",
        fields: [
          { field: "bankAccount1_BSB", reason: "BSB must contain 6 digits only" },
          { field: "bankAccount1_BSB", reason: "BSB is invalid" },
          { field: "taxFileNumber", reason: "invalid" },
        ],
      }),
    ).toBe("correction: bankAccount1_BSB, taxFileNumber");
  });

  it("summarises the other kinds", () => {
    expect(auditDetail({ kind: "ok" })).toBe("synced");
    expect(auditDetail({ kind: "retry", detail: "EH 503" })).toBe("retry: EH 503");
    expect(auditDetail({ kind: "follow_up", reasons: ["a", "b"] })).toBe("follow_up: a | b");
  });
});
