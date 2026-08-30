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

Design complete. Implementation not started — see `docs/PLAN.md` §4 for milestones.

## Development

_(pending M0 — scaffold, wrangler config, test harness)_

Stack: TypeScript · Hono · Cloudflare Workers + Queues + D1 · Drizzle · Vitest.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
