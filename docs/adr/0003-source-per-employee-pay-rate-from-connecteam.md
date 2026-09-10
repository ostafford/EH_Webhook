# Source the per-employee pay rate from the Connecteam pay-rates API

## Status

accepted

## Context

Every synced employee lands in Employment Hero as `status: Incomplete — "Pay Run
Defaults are incomplete"`. EH validates the pay-run set
(`paySchedule`, `primaryLocation`, `primaryPayCategory`, `rate`, `rateUnit`)
**all-or-nothing** on the unstructured endpoint — a partial set is a 400
(`docs/eh-pay-defaults.md`).

`employmentHero.defaults` (issue #26) can stamp a single flat `rate` company-wide,
but `rate` is genuinely per-person for any workforce not on one flat rate, so the
record still needs per-employee entry. Connecteam already owns each employee's pay
rate as a first-class feature: `GET /pay-rates/v1/pay-rates?userIds={id}&startDate=&endDate=`
returns `{ effectiveDate, rateType: "hourly"|"monthly"|"yearly", defaultRate,
isDefaultRateEnabled, resourcesRates[] }`.

The AI triage draft of #42 recommended a **new Connecteam custom field** for the
rate instead, on the grounds that `resourcesRates[]` makes "the one rate"
ambiguous and a custom field keeps the mapping mechanism uniform.

## Decision

Source `rate` + `rateUnit` per employee from the **pay-rates API**, not a custom
field. Opt-in per client via a new `employmentHero.perEmployeeRate:
{ source: "connecteamPayRate" }` block; absent = today's behaviour (no `rate`
sent, record stays `Incomplete`).

- `rate` = `payRate.defaultRate` when `isDefaultRateEnabled`. `resourcesRates[]`
  per-resource overrides do **not** map to EH's single `rate` and are ignored;
  the consumer logs (`evt: "payrate_resource_overrides"`, no value) when any
  exist, so we learn if a real client depends on them.
- `rateType` → `rateUnit`: `hourly` → `Hourly`, `yearly` → `Annually`. `monthly`
  is **not** mapped — EH's accepted value for it is unconfirmed (issue #45); a
  monthly rate produces one follow-up naming the employee and no partial write.
- `paySchedule` / `primaryLocation` / `primaryPayCategory` still come from
  `employmentHero.defaults` (company-wide). `hoursPerWeek` is optional and comes
  from a per-employee `number` field rule.
- **Invariant:** with `perEmployeeRate` on, if the full required set cannot be
  resolved for an employee, `applyFieldMap` emits **no** pay-run keys and returns
  a plain-language `payRunIssues[]`; `decide` turns that into a single follow-up
  to the admin channel. EH is never sent a partial set.

## Considered options

- **New Connecteam custom field for the rate** (the triage recommendation):
  rejected. It duplicates data Connecteam already owns, the admin has to re-enter
  it and keep it in sync, and it silently drifts from the source of truth. The
  `resourcesRates[]` ambiguity is handled by taking `defaultRate` and logging
  overrides — good enough for v1, and revisited only if a client actually relies
  on per-resource rates. (KISS: reuse existing Connecteam data over new fields.)
- **Company-wide flat `defaults.rate` only** (issue #26, unchanged): still
  available, still the right answer for a genuinely single-rate workforce. This
  ADR adds the per-person path alongside it.
- **Assume `"Monthly"` for a monthly `rateType`**: rejected. An unverified
  `rateUnit` string risks a 400 on the whole set, blocking the employee. A
  follow-up until #45 confirms is safe and visible.

## Consequences

- One extra Connecteam API call per sync when `perEmployeeRate` is on — well
  within the 200/min, 20,000/day budget the sweep already tracks.
- `redact.ts` now treats `rate` / `defaultRate` / `payRate` / `baseRate` as
  sensitive keys; `rateUnit` / `rateType` stay readable in logs.
- A monthly-paid employee cannot be auto-completed until #45. A workforce that is
  entirely monthly gets no benefit from this feature yet.
- `field-map.json` schema gains a `number` transform and the `perEmployeeRate`
  block. `applyFieldMap` gains an `opts.payRate` argument but stays pure — the
  network call lives in the queue consumer.
