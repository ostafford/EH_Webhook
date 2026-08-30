import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("worker test harness", () => {
  it("has a migrated D1 database", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='employee_map'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("employee_map");
  });

  it("has the last_payload_hash column from migration 0002", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(employee_map)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("last_payload_hash");
  });

  it("exposes the SYNC_QUEUE producer binding", () => {
    expect(env.SYNC_QUEUE).toBeDefined();
  });
});
