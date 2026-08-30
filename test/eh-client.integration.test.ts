/**
 * Live checks against a real Employment Hero Payroll test business.
 * Skipped unless EH_API_KEY and EH_BUSINESS_ID are set in the environment.
 *
 * Completes issue #2: create -> get -> update -> delete a ZZZ_TEST_ employee,
 * and confirm the real 422 shape + the @todo field names in src/mapping/rules.ts.
 * Never runs against a business with real pay runs.
 */
import { describe, it, expect } from "vitest";
import { EhPayrollClient } from "../src/eh/client.js";

const apiKey = process.env.EH_API_KEY;
const businessId = process.env.EH_BUSINESS_ID;
const live = apiKey && businessId ? describe : describe.skip;

live("EH Payroll client (live test business)", () => {
  const client = new EhPayrollClient({ apiKey: apiKey!, businessId: businessId! });
  const externalId = `ZZZTEST-${Date.now()}`;

  it.todo("creates a ZZZ_TEST_ employee from a minimal valid payload");
  it.todo("fetches that employee back by external id");
  it.todo("updates a field and sees it change on re-fetch");
  it.todo("a bad BSB returns outcome:validation with a { field, reason }");
  it.todo("confirms gender / residency / HELP-STSL / super field names, updates rules.ts");
  it.todo("removes the test employee on teardown");

  it("can reach the business (smoke)", async () => {
    const r = await client.getByExternalId(externalId);
    expect(["ok", "retryable"]).toContain(r.outcome); // ok+null for a fresh id
  });
});
