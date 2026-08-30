import { defineConfig } from "drizzle-kit";

// Drizzle is used for typed queries in the Worker. Migrations are the plain SQL
// files in ./migrations, applied by `wrangler d1 migrations apply`. Use
// `drizzle-kit generate` only to draft a new migration, then hand-review it.
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
