import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the bundled registry with a deliberately broken entry.
vi.mock("../src/mapping/registry.js", () => ({
  FIELD_MAPS: { broken: { client: "", fields: [] } },
}));

const { loadFieldMap, resetFieldMapCache, FieldMapError } = await import("../src/mapping/loader.js");

beforeEach(resetFieldMapCache);

describe("loadFieldMap with an invalid map", () => {
  it("wraps the schema failure in a FieldMapError naming the client", () => {
    try {
      loadFieldMap("broken");
      throw new Error("expected loadFieldMap to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FieldMapError);
      expect((err as Error).message).toContain('Field-map for "broken" is invalid');
      expect((err as Error).message).toMatch(/Invalid field-map/);
    }
  });
});
