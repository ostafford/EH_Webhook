# `clients/self/`

This deployment's field map. **One repo clone = one client**, so the map lives
here and the Worker loads it by default (no `FIELD_MAP_CLIENT` needed).

`field-map.json` ships as a **placeholder** (a copy of `clients/_example/`).
During onboarding, `npm run discover -- --client self` overwrites it with a draft
built from the client's real Connecteam fields and Employment Hero IDs. Tune that
draft, then `npm test` (the loader tests fail fast on an invalid map).

Running several clients from one deployment instead? Add each under
`clients/<slug>/`, register it in `src/mapping/registry.ts`, and set
`FIELD_MAP_CLIENT=<slug>`.
