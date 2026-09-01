import { defineConfig } from "vitest/config";

// Pure-logic tests only: the relay is a single fetch handler with an injectable
// GitHub client and clock, so it runs under plain Node with no Workers runtime.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
