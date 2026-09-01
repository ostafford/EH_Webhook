/**
 * Handover checks (issue #9): the config layer is client-agnostic (nothing is
 * wired to `_example`), and no employee value can reach the audit trail.
 */
import { describe, it, expect } from "vitest";
import { parseFieldMap } from "../src/mapping/schema.js";
import { applyFieldMap, type ConnecteamUser } from "../src/mapping/apply.js";
import { auditDetail, type SyncDecision } from "../src/sync/decide.js";
import { redact } from "../src/redact.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";

// A second, deliberately-different client config - different pack, business,
// pay schedule, location, and a different custom-field id for the first name.
const throwaway = parseFieldMap({
  client: "throwaway-co",
  connecteam: { onboardingPackId: 9999 },
  employmentHero: { businessId: "111222", payScheduleId: "77777", locationId: "88888" },
  identity: { externalIdFrom: "userId", emailFallbackFrom: "email" },
  fields: [
    { eh: "firstName", from: { customFieldId: 42920713 }, transform: "trimString", required: true },
    { eh: "surname", from: { customFieldId: 42920714 }, transform: "trimString", required: true },
    { eh: "startDate", from: { customFieldId: 25145109 }, transform: "dateDmyToIso", required: true },
    { eh: "dateOfBirth", from: { customFieldId: 25145118 }, transform: "dateDmyToIso", required: true },
    { eh: "employmentType", from: { customFieldId: 42920839 }, transform: "dropdownValue" },
    { eh: "taxFileNumber", from: { customFieldId: 42923222 }, transform: "digits", required: true, sensitive: true },
  ],
});

const clone = (): ConnecteamUser => structuredClone(syntheticUser);

describe("a second throwaway client configuration", () => {
  it("drives applyFieldMap with its own field ids, not the example's", () => {
    const { payload, issues } = applyFieldMap(clone(), throwaway);
    expect(issues).toEqual([]);
    expect(payload.firstName).toBe("Samuel");
    expect(payload.externalId).toBe("17760356");
    // payScheduleId / locationId are config-only now, never in the payload (#34)
    expect(payload.payScheduleId).toBeUndefined();
  });

  it("the example map still loads unchanged alongside it", async () => {
    const { loadFieldMap } = await import("../src/mapping/loader.js");
    expect(loadFieldMap("_example").client).toBe("example");
  });
});

describe("no employee value reaches the audit trail", () => {
  const decisions: SyncDecision[] = [
    { kind: "ok" },
    { kind: "correction", fields: [
      { field: "taxFileNumber", reason: "The tax file number 123456782 is invalid." },
      { field: "bankAccount1_BSB", reason: "BSB 012-345 must be 6 digits" },
    ] },
    { kind: "follow_up", reasons: ["Self-managed super fund - add it by hand."] },
    { kind: "retry", detail: "EH 503" },
  ];

  it("auditDetail emits field names + status words only, never a value", () => {
    for (const d of decisions) {
      const detail = auditDetail(d);
      expect(detail).not.toMatch(/123456782/); // a TFN
      expect(detail).not.toMatch(/012-?345/); // a BSB
    }
    expect(auditDetail(decisions[1]!)).toBe("correction: taxFileNumber, bankAccount1_BSB");
  });

  it("redact scrubs a mapped payload before it could be logged", () => {
    const { payload } = applyFieldMap(clone(), throwaway);
    const safe = redact({ evt: "sync", payload }) as { payload: Record<string, unknown> };
    expect(safe.payload.taxFileNumber).toBe("[redacted]");
    expect(safe.payload.firstName).toBe("Samuel");
    expect(JSON.stringify(safe)).not.toContain("123456782");
  });
});
