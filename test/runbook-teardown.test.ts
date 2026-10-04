/**
 * Issue #61: deleting the Worker alone leaves its D1 database and queues
 * behind, and a wizard re-run then reuses the old database. The runbook's
 * teardown section must name every Cloudflare resource wrangler.jsonc
 * declares, so renaming or adding one can't leave the runbook out of date.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const wrangler = read("wrangler.jsonc");
const runbook = read("docs/RUNBOOK.md");

const workerName = /^\s*"name":\s*"([^"]+)"/m.exec(wrangler)?.[1];
const databases = [...wrangler.matchAll(/"database_name":\s*"([^"]+)"/g)].map((m) => m[1]!);
const queues = [...new Set([...wrangler.matchAll(/"queue":\s*"([^"]+)"/g)].map((m) => m[1]!))];

/** The "Tearing down" section: from its heading to the next top-level heading. */
const teardown = (() => {
  const start = runbook.search(/^## Tearing down/m);
  if (start < 0) return "";
  const rest = runbook.slice(start + 1);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
})();

describe("runbook teardown section (issue #61)", () => {
  it("exists", () => {
    expect(teardown).not.toBe("");
  });

  it("found the resources in wrangler.jsonc to check against", () => {
    expect(workerName).toBeTruthy();
    expect(databases.length).toBeGreaterThan(0);
    expect(queues.length).toBeGreaterThan(0);
  });

  it("names the Worker, every D1 database and every queue", () => {
    for (const name of [workerName!, ...databases, ...queues]) expect(teardown).toContain(name);
  });

  it("warns that deleting the Worker alone is not a reset", () => {
    expect(teardown).toMatch(/deleting the worker alone is not a reset/i);
  });

  it("disconnects every queue consumer before deleting the Worker", () => {
    // Cloudflare has refused to delete a Worker that is still a queue consumer:
    // "script still in use as a consumer for a queue [code: 10064]".
    const deleteWorker = teardown.search(new RegExp(`wrangler delete ${workerName}(?! --dry-run)`));
    expect(deleteWorker).toBeGreaterThan(-1);
    for (const queue of queues) {
      const remove = teardown.indexOf(`wrangler queues consumer remove ${queue} ${workerName}`);
      expect(remove, `consumer remove for ${queue}`).toBeGreaterThan(-1);
      expect(remove, `consumer remove for ${queue} comes first`).toBeLessThan(deleteWorker);
    }
  });

  it("covers the Connecteam webhook and the GitHub health watch", () => {
    expect(teardown).toMatch(/connecteam webhook/i);
    expect(teardown).toMatch(/health-watch/);
  });
});
