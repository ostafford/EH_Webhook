/**
 * Live checks against a real Employment Hero Payroll test business.
 * Skipped unless EH_API_KEY and EH_BUSINESS_ID are set (test/setup.env.ts loads
 * them from a git-ignored .dev.vars). Creates and then deletes one
 * ZZZTEST- employee. Never touches a pay run.
 *
 * Closes issue #2: real create -> get -> update -> validation -> delete flow,
 * and the field names / 422(400) shape these tests assert are what the rest of
 * the code is built against.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EhPayrollClient } from "../src/eh/client.js";

const apiKey = process.env.EH_API_KEY;
const businessId = process.env.EH_BUSINESS_ID;
const live = apiKey && businessId ? describe : describe.skip;

/** The live API rate-limits bursts; retry a transient "retryable" a few times. */
async function stable<T extends { outcome: string }>(call: () => Promise<T>): Promise<T> {
  let last!: T;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await call();
    if (last.outcome !== "retryable") return last;
    await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
  }
  return last;
}

live("EH Payroll client (live test business)", () => {
  const client = new EhPayrollClient({ apiKey: apiKey!, businessId: businessId! });
  const externalId = `ZZZTEST-${Date.now()}`;
  const minimal = {
    firstName: "Zztest",
    surname: "Alpha",
    startDate: "2026-09-01",
    employmentType: "Casual",
    taxFileNumber: "123456782", // valid check digit
  };
  let createdId: number | undefined;

  afterAll(async () => {
    if (createdId !== undefined) await client.deleteEmployee(createdId);
  });

  it("reports no employee for a fresh external id", async () => {
    expect(await stable(() => client.getByExternalId(externalId))).toEqual({ outcome: "ok", data: null });
  });

  it("creates an employee, linked by external id, in Incomplete status", async () => {
    const r = await stable(() => client.upsertByExternalId(externalId, minimal));
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") return;
    createdId = r.data.id;
    expect(r.data.created).toBe(true);
    expect(r.data.status).toBe("Incomplete");
    expect(r.data.detailedStatus ?? "").toMatch(/incomplete/i);
  });

  it("reads the employee back by external id with the fields we sent", async () => {
    const r = await stable(() => client.getByExternalId(externalId));
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok" || !r.data) throw new Error("expected the employee");
    expect(r.data).toMatchObject({
      externalId,
      firstName: "Zztest",
      surname: "Alpha",
      employmentType: "Casual",
      status: "Incomplete",
    });
  });

  it("updates an existing employee (created:false) and the change sticks", async () => {
    const upd = await stable(() =>
      client.upsertByExternalId(externalId, { ...minimal, gender: "Female", dateOfBirth: "1992-04-07" }),
    );
    expect(upd.outcome).toBe("ok");
    if (upd.outcome === "ok") expect(upd.data.created).toBe(false);

    const back = await stable(() => client.getByExternalId(externalId));
    if (back.outcome !== "ok" || !back.data) throw new Error("expected the employee");
    expect(back.data.gender).toBe("Female");
    expect(String(back.data.dateOfBirth)).toMatch(/^1992-04-07/);
  });

  it("returns a parsed validation result for a bad BSB", async () => {
    const r = await stable(() =>
      client.upsertByExternalId(externalId, {
        ...minimal,
        bankAccount1_BSB: "12345",
        bankAccount1_AccountNumber: "111111",
        bankAccount1_AccountName: "Zztest Alpha",
        bankAccount1_AllocatedPercentage: 100,
      }),
    );
    expect(r.outcome).toBe("validation");
    if (r.outcome !== "validation") return;
    expect(r.status).toBe(400);
    expect(r.issues.some((i) => /bsb/i.test(i.field) || /bsb/i.test(i.reason))).toBe(true);
  });
});
