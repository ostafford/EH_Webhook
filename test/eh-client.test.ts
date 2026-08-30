import { describe, it, expect, vi } from "vitest";
import { EhPayrollClient } from "../src/eh/client.js";

/** A fake fetch: match on `${method} ${url-substring}`, return a Response (or throw). */
function fakeFetch(routes: Record<string, { status: number; body?: unknown } | "throw">) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    for (const [pattern, outcome] of Object.entries(routes)) {
      const [m, frag] = pattern.split(" ");
      if (m === method && u.includes(frag!)) {
        if (outcome === "throw") throw new Error("network down");
        return new Response(outcome.body === undefined ? "" : JSON.stringify(outcome.body), {
          status: outcome.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`unmatched ${method} ${u}`);
  }) as unknown as typeof fetch;
}

const cfg = (fetchImpl: typeof fetch) => ({
  apiKey: "test-key",
  businessId: "555455",
  baseUrl: "https://eh.test/api/v2",
  fetchImpl,
});

const EMP = { id: 987, externalId: "17760356", firstName: "Samuel", surname: "Rivera", status: "Active" };

describe("EhPayrollClient.getByExternalId", () => {
  it("returns the employee on 200", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/17760356": { status: 200, body: EMP } })));
    const r = await c.getByExternalId("17760356");
    expect(r).toEqual({ outcome: "ok", data: EMP });
  });

  it("returns data:null on 404 (no such external id)", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/nope": { status: 404, body: { message: "Not found" } } })));
    expect(await c.getByExternalId("nope")).toEqual({ outcome: "ok", data: null });
  });

  it("classifies 5xx as retryable", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/x": { status: 503, body: "upstream" } })));
    const r = await c.getByExternalId("x");
    expect(r.outcome).toBe("retryable");
    expect(r).toMatchObject({ status: 503 });
  });

  it("classifies a network failure as retryable with no status", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/x": "throw" })));
    const r = await c.getByExternalId("x");
    expect(r).toMatchObject({ outcome: "retryable", status: null });
  });

  it("sends HTTP Basic auth with the api key as username", async () => {
    const f = fakeFetch({ "GET /externalid/17760356": { status: 200, body: EMP } });
    await new EhPayrollClient(cfg(f)).getByExternalId("17760356");
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("test-key:")}`);
  });
});

describe("EhPayrollClient.upsertByExternalId", () => {
  it("POSTs a create when no record has the external id, injecting externalId", async () => {
    const f = fakeFetch({
      "GET /externalid/17760356": { status: 404 },
      "POST /employee/unstructured": { status: 200, body: { ...EMP } },
    });
    const c = new EhPayrollClient(cfg(f));
    const r = await c.upsertByExternalId("17760356", { firstName: "Samuel", surname: "Rivera" });
    expect(r).toEqual({ outcome: "ok", data: EMP });

    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [postUrl, postInit] = calls[1]!;
    expect(String(postUrl)).toMatch(/\/business\/555455\/employee\/unstructured$/);
    expect(JSON.parse(postInit.body as string)).toMatchObject({ externalId: "17760356", surname: "Rivera" });
  });

  it("PUTs an update to the existing employee id when the external id resolves", async () => {
    const f = fakeFetch({
      "GET /externalid/17760356": { status: 200, body: EMP },
      "PUT /employee/unstructured/987": { status: 200, body: { ...EMP, surname: "Rivera-Chen" } },
    });
    const c = new EhPayrollClient(cfg(f));
    const r = await c.upsertByExternalId("17760356", { surname: "Rivera-Chen" });
    expect(r).toMatchObject({ outcome: "ok", data: { surname: "Rivera-Chen" } });
  });

  it("surfaces a 422 as a parsed validation result and does not throw", async () => {
    const f = fakeFetch({
      "GET /externalid/17760356": { status: 404 },
      "POST /employee/unstructured": { status: 422, body: { BankAccounts: ["BSB must be 6 digits."] } },
    });
    const r = await new EhPayrollClient(cfg(f)).upsertByExternalId("17760356", { bankAccount1_BSB: "12345" });
    expect(r).toEqual({
      outcome: "validation",
      status: 422,
      issues: [{ field: "BankAccounts", reason: "BSB must be 6 digits." }],
    });
  });

  it("propagates a retryable lookup failure without attempting a write", async () => {
    const f = fakeFetch({ "GET /externalid/17760356": { status: 500, body: "boom" } });
    const r = await new EhPayrollClient(cfg(f)).upsertByExternalId("17760356", { surname: "X" });
    expect(r.outcome).toBe("retryable");
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
