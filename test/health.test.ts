import { describe, it, expect, beforeEach } from "vitest";
import { buildHealth, type HealthEnv } from "../src/health.js";
import { resetFieldMapCache } from "../src/mapping/loader.js";

beforeEach(resetFieldMapCache);

const baseEnv = (over: Partial<HealthEnv> = {}): HealthEnv => ({
  DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
  FIELD_MAP_CLIENT: "_example",
  EH_BUSINESS_ID: "",
  EH_PAY_SCHEDULE_ID: "",
  EH_LOCATION_ID: "",
  ...over,
});

describe("buildHealth", () => {
  it("is ok when D1 responds and the field-map loads", async () => {
    const h = await buildHealth(baseEnv());
    expect(h).toMatchObject({
      ok: true,
      service: "eh-webhook",
      d1: "ok",
      fieldMap: "ok",
      config: { fieldMapClient: "_example", businessConfigured: false },
    });
    expect(typeof h.time).toBe("string");
  });

  it("is not ok and reports d1:error when the D1 query throws", async () => {
    const h = await buildHealth(
      baseEnv({ DB: { prepare: () => ({ first: async () => { throw new Error("no db"); } }) } }),
    );
    expect(h.d1).toBe("error");
    expect(h.ok).toBe(false);
  });

  it("is not ok and explains why when the field-map client is unknown", async () => {
    const h = await buildHealth(baseEnv({ FIELD_MAP_CLIENT: "missing" }));
    expect(h.ok).toBe(false);
    expect(h.fieldMap).toContain("No field-map bundled");
    expect(h.config.fieldMapClient).toBe("missing");
  });

  it("reports businessConfigured once all three EH ids are set", async () => {
    const h = await buildHealth(
      baseEnv({ EH_BUSINESS_ID: "555455", EH_PAY_SCHEDULE_ID: "32407", EH_LOCATION_ID: "436590" }),
    );
    expect(h.config.businessConfigured).toBe(true);
  });
});
