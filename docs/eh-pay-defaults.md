# Company-wide EH pay-run defaults (issue #26)

## Problem

Every synced employee lands in Employment Hero as
`status: Incomplete — "Pay Run Defaults are incomplete"` because the sync never
sets award / pay category / rate / standard hours (out of scope for v1). A
payroll admin fixes each record by hand and a Manual-follow-up notice fires per
employee. Most of that data is **company-wide**, not per-person.

## Probe results — against EH test business `555455`

Run with `scripts/probe-eh-pay-defaults.sh` (creates and deletes one `ZZZTEST-`
employee, never touches a pay run). The business is bare: no awards, no pay-rate
templates, one pay schedule (`Weekly` / `32407`), one location (`Connecteam` /
`436590`), 50 system pay categories.

| Sent on `POST .../employee/unstructured` | Result |
|---|---|
| minimal create, no pay fields | `201`, `status: Incomplete` ("Basic Details…") — baseline |
| `payScheduleId:"32407"`, `locationId:"436590"` *(exactly what `apply.ts` sends today)* | `201`, but `paySchedule` / `primaryLocation` **read back `null`** — **these keys are silently ignored** |
| any single pay-run field (`hoursPerWeek`, `rate`, …) | `400` "Error validating pay run settings" — EH then demands the **whole set**: Default Pay Cycle Id, Primary Location Id, Default Pay Category Id, Rate, Rate Unit |
| `paySchedule:"Weekly"`, `primaryLocation:"Connecteam"`, `primaryPayCategory:"Permanent Ordinary Hours"`, `rate:30`, `rateUnit:"Hourly"`, `hoursPerWeek:38`, `hoursPerDay:7.6` — **all by name** | `201`, **all seven persisted on read-back** (status stays `Incomplete` only because this synthetic employee has no bank / super / full tax details — the pay-run axis is now satisfied) |
| `classification:"Level 2"` | **silently dropped** — not a recognised key; doesn't even trigger pay-run validation |
| `standardHoursPerWeek:40` | **silently dropped** — the real fields are `hoursPerWeek` / `hoursPerDay` |
| `awardId:0` | `400` "Award 0 not found for the business" — `awardId` **is** a validated input field (needs a real award id; this business has none to test) |

### Conclusions

1. **The unstructured endpoint _does_ accept pay-run defaults** — by **name**, and
   as an all-or-nothing set: `paySchedule`, `primaryLocation`,
   `primaryPayCategory`, `rate`, `rateUnit`, `hoursPerWeek`, `hoursPerDay`, plus
   `awardId` (numeric id, validated against the business).
2. **A partial set is a `400`.** The field-map `defaults` block therefore has to
   carry the whole set to move a record off `Incomplete` on the pay-run axis.
3. **`classification` / `payCategoryId` / `standardHoursPerWeek`** (this doc's
   first draft) are **not** accepted here. Use `primaryPayCategory` (name) and
   `hoursPerWeek` / `hoursPerDay`.
4. **`rate` is genuinely per-person** for most workforces — a single company-wide
   `rate` only fits a flat-rate team. So `defaults` is realistically "flip to
   Complete for a single-rate workforce"; anything with real pay bands still
   needs per-employee entry (Connecteam custom field or manual EH).

## Pre-existing bug found by the probe (NOT #26)

`src/mapping/apply.ts` sets `payScheduleId` and `locationId` on every payload
from `clients/self/field-map.json`. **EH's unstructured endpoint ignores those
key names** — the live test employee `14246310` has `paySchedule: null`,
`primaryLocation: null` despite the sync. The correct input keys are
`paySchedule` and `primaryLocation`, **by name**. Fixing it means the field-map
carries names (`"Weekly"`, `"Connecteam"`) instead of ids. Tracked separately —
see the issue raised from this probe.

## What this PR ships

- `field-map.json` schema accepts an opt-in `employmentHero.defaults` block with
  the **verified** field names:
  `{ awardId?, primaryPayCategory?, rate?, rateUnit?, hoursPerWeek?, hoursPerDay? }`.
- `applyFieldMap` folds every present default into the payload verbatim, beside
  the structural values.
- `scripts/probe-eh-pay-defaults.sh` — the probe above, re-runnable against any
  test business.
- Opt-in only: `_example` / `self` don't set the block, so it can't change an
  existing deployment.

## Not doing (yet)

- **Auto-flip to Complete.** `defaults` only helps a single-rate workforce, and
  even then only once the `paySchedule` / `primaryLocation` bug above is fixed so
  the *whole* pay-run set actually lands.
- **Sourcing values from Connecteam "Customizable defaults".**
- **`classification` / award classification** — needs a business with awards to
  probe, and likely a `payRateTemplate` rather than a bare field.
