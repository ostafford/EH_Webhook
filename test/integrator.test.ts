import { describe, it, expect, vi } from "vitest";
import { postIntegrator } from "../src/integrator.js";

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("postIntegrator", () => {
  it("does nothing when no URL is configured", async () => {
    const { fn, calls } = captureFetch();
    await postIntegrator({}, { kind: "system_alert", ctUserId: 1 }, fn);
    expect(calls).toHaveLength(0);
  });

  it("POSTs the body as JSON with the secret header when configured", async () => {
    const { fn, calls } = captureFetch();
    await postIntegrator(
      { INTEGRATOR_ALERT_URL: "https://relay.example/hook", INTEGRATOR_ALERT_SECRET: "s3cr3t" },
      { kind: "health", ok: true },
      fn,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example/hook");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-eh-sync-secret"]).toBe("s3cr3t");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ kind: "health", ok: true });
  });

  it("omits the secret header when no secret is set", async () => {
    const { fn, calls } = captureFetch();
    await postIntegrator({ INTEGRATOR_ALERT_URL: "https://relay.example/hook" }, { kind: "x" }, fn);
    expect((calls[0]!.init.headers as Record<string, string>)["x-eh-sync-secret"]).toBeUndefined();
  });

  it("redacts a sensitive key that somehow ends up in the body", async () => {
    const { fn, calls } = captureFetch();
    await postIntegrator(
      { INTEGRATOR_ALERT_URL: "https://relay.example/hook" },
      { kind: "system_alert", ctUserId: 1, taxFileNumber: "123456782" },
      fn,
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.taxFileNumber).toBe("[redacted]");
    expect(calls[0]!.init.body).not.toContain("123456782");
  });

  it("never throws when the relay call fails", async () => {
    const fn = vi.fn(async () => {
      throw new Error("relay down");
    }) as unknown as typeof fetch;
    await expect(
      postIntegrator({ INTEGRATOR_ALERT_URL: "https://relay.example/hook" }, { kind: "x" }, fn),
    ).resolves.toBeUndefined();
  });
});
