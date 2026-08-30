# EH_Webhook

Syncs employee details entered in **Connecteam** into **Employment Hero Payroll**,
so staff enter their information once instead of twice.

A reusable, single-tenant integration template: deployed once per client, with every
client-specific value (API keys, IDs, field mapping) supplied as external config —
never code.

## How it works (short version)

1. An employee fills out their onboarding pack in Connecteam.
2. When an admin clicks **Approve Onboarding**, a scheduled check (every minute)
   notices and creates that person in Employment Hero Payroll.
3. Any later change to their Connecteam profile updates Employment Hero automatically.
4. If Employment Hero rejects something (e.g. an invalid bank BSB), the employee
   gets a Connecteam chat message telling them exactly what to fix.

One-way only. Employment Hero is never written back to Connecteam.

## Documentation

| Doc | What's in it |
|---|---|
| [`CONTEXT.md`](./CONTEXT.md) | Glossary — the precise meaning of every term used here |
| [`docs/PLAN.md`](./docs/PLAN.md) | Build plan: scope, architecture, milestones, risks |
| [`docs/field-mapping.md`](./docs/field-mapping.md) | Connecteam field → Employment Hero field, with transforms |
| [`docs/adr/`](./docs/adr/) | Architecture decision records (the "why" behind key choices) |
| `docs/RUNBOOK.md` | _(pending)_ How to deploy this for a new client |

## Status

Design complete. **M1 (field mapping) in progress** — pure transforms, the
`field-map.json` schema, and full Employment Hero payload assembly are done and
tested. Cloudflare wiring (M0) and the API clients (M2–M3) are next. See
`docs/PLAN.md` §4.

## Development

```sh
npm install
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

- `src/mapping/` — pure Connecteam → Employment Hero field mapping (no network).
- `clients/<slug>/field-map.json` — the per-client mapping artifact, validated by
  `src/mapping/schema.ts` at start-up. `clients/_example/` is a worked example.
- `test/fixtures/` — synthetic Connecteam data only; never real employee data.

Stack: TypeScript · Hono · Cloudflare Workers + Queues + D1 · Drizzle · Vitest.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
