import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two projects:
 *  - "node":   the pure-logic unit tests (fast, `fetch` stubbed, no runtime).
 *  - "worker": end-to-end consumer tests inside workerd, with a real local D1
 *              (migrations applied in test/worker/apply-migrations.ts) and queue.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    test: {
      projects: [
        {
          test: {
            name: "node",
            include: ["test/**/*.test.ts"],
            exclude: ["test/worker/**"],
            environment: "node",
            setupFiles: ["./test/setup.env.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Test-only binding so the setup file can apply migrations.
                bindings: { TEST_MIGRATIONS: migrations },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/apply-migrations.ts"],
          },
        },
      ],
    },
  };
});
