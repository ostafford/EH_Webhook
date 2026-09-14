# Company-wide EH pay-run defaults (issue #26)

> The pay-run set is **one** of the axes EH needs for `status: Complete`. The
> full set — basic details, address, TFN, bank, pay-run — is verified in
> [`eh-complete-criteria.md`](./eh-complete-criteria.md) (issue #45).

## Problem

Every synced employee lands in Employment Hero as
`status: Incomplete — "Pay Run Defaults are incomplete"` because the sync never
sets award / pay category / rate / standard hours (out of scope for v1). A
payroll admin fixes each record by hand and a Manual-follow-up notice fires per
employee. Most of that data is **company-wide**, not per-person.

## Probe results — against EH test business `555455`

Run with `scripts/probe-eh-pay-defaults.sh` (creates and deletes one `ZZZTEST-`
employee, never touches a pay run). Business config: one pay schedule
(`Weekly` / `32407`), one location (`Connecteam` / `436590`). Originally bare
(no awards / templates); the **Retail (General) Industry Award 2020 [MA000004]**
was installed 2026-09-10 (`awardId: 1`) for the #39 probe — that added 117 award
pay categories and 66 award pay-rate templates (one per classification × level ×
age × permanent/casual, e.g. `General Retail Casual L3 21yrs & over`).

| Sent on `POST .../employee/unstructured` | Result |
|---|---|
| minimal create, no pay fields | `201`, `status: Incomplete` ("Basic Details…") — baseline |
| `payScheduleId:"32407"`, `locationId:"436590"` *(exactly what `apply.ts` sends today)* | `201`, but `paySchedule` / `primaryLocation` **read back `null`** — **these keys are silently ignored** |
| any single pay-run field (`hoursPerWeek`, `rate`, …) | `400` "Error validating pay run settings" — EH then demands the **whole set**: Default Pay Cycle Id, Primary Location Id, Default Pay Category Id, Rate, Rate Unit |
| `paySchedule:"Weekly"`, `primaryLocation:"Connecteam"`, `primaryPayCategory:"Permanent Ordinary Hours"`, `rate:30`, `rateUnit:"Hourly"`, `hoursPerWeek:38`, `hoursPerDay:7.6` — **all by name** | `201`, **all seven persisted on read-back** (status stays `Incomplete` only because this synthetic employee has no bank / super / full tax details — the pay-run axis is now satisfied) |
| `standardHoursPerWeek:40` | **silently dropped** — the real fields are `hoursPerWeek` / `hoursPerDay` |

### Award / classification (issue #39 — probed 2026-09-10, award `1` installed)

| Sent on `POST .../employee/unstructured` | Result |
|---|---|
| `payRateTemplate:"General Retail Casual L3 21yrs & over"` **+ the full pay-run set** (`paySchedule` + `primaryLocation` + `primaryPayCategory`, by name) | `201`, **`payRateTemplate` persists**; EH **auto-fills `rate` (28.89) and `rateUnit` (Hourly)** from the award template — no `rate`/`rateUnit` sent. `primaryPayCategory` is normalised to the award's name (`Casual - Ordinary Hours`). `overrideTemplateRate` reads back `False`. |
| `payRateTemplate:"…"` **alone** (no `paySchedule`/`primaryLocation`/`primaryPayCategory`) | `400` "Default Pay Cycle Id / Primary Location Id / Default Pay Category Id should not be empty" — **`payRateTemplate` is part of the same all-or-nothing pay-run set** |
| `payRateTemplateId: <numeric id>` (e.g. `2130323`) | **silently dropped** — with a full set it even `400`s "'Rate' must not be empty" (the id does **not** resolve the template). Use the **name**, key `payRateTemplate`. |
| `awardId: 1` (a real, installed award id) | **silently dropped** on the unstructured endpoint — never persists, changes nothing vs. omitting it. The award link is implicit in `payRateTemplate`. |
| `awardId: 0` | `400` "Award 0 not found for the business" — `awardId` is still *parsed* and validated, it just isn't *stored* on the employee here |
| `classification:"Level 2"` (bare string) | **silently dropped** — not a recognised key |
| full set + `payRateTemplate` (award rate) — synthetic employee, no bank details | `status` **stays `Incomplete`** — the award/pay-run axis is satisfied but the basic-details / bank axes are not (see [`eh-complete-criteria.md`](./eh-complete-criteria.md), #45) |

### Conclusions

1. **The unstructured endpoint _does_ accept pay-run defaults** — by **name**, and
   as an all-or-nothing set: `paySchedule`, `primaryLocation`,
   `primaryPayCategory`, then **either** `rate` + `rateUnit` **or**
   `payRateTemplate` (name), plus optional `hoursPerWeek` / `hoursPerDay`.
2. **A partial set is a `400`.** The field-map `defaults` block therefore has to
   carry the whole set to move a record off `Incomplete` on the pay-run axis.
3. **`classification` / `payCategoryId` / `standardHoursPerWeek` / `awardId` /
   `payRateTemplateId`** are **not** accepted. Use `primaryPayCategory` (name),
   `hoursPerWeek` / `hoursPerDay`, and — for award workforces — `payRateTemplate`
   (the template **name**, which *is* the classification).
4. **Award classification == a pay-rate template name.** For an award workforce
   the per-employee value is the `payRateTemplate` string; EH derives the correct
   `rate`/`rateUnit` from it and keeps that rate current at each Fair Work review.
   `awardId` itself is business-wide (installed once in EH) and is **not** sent
   per employee. `overrideTemplateRate: true` + an explicit `rate` would override
   the template rate — not needed for the award path.
5. **`rate` (non-award path) is genuinely per-person** for most workforces — a
   single company-wide `rate` only fits a flat-rate team. So `defaults` alone is
   "flip to Complete for a single-rate workforce"; real pay bands need either
   `payRateTemplate` per employee (award) or `perEmployeeRate` (#42, non-award).
6. **The award/pay-run axis is not the only Complete gate.** Even a full set with
   a valid award template left the synthetic record `Incomplete` — bank / super /
   tax-declaration are separate axes (#45).

## Bug found by the probe — fixed in #34

`src/mapping/apply.ts` used to set `payScheduleId` and `locationId` on every
payload. **EH's unstructured endpoint ignores those key names** — the live test
employee `14246310` had `paySchedule: null`, `primaryLocation: null` despite the
sync. #34 removed that dead emission. Pay schedule and location now go through
`defaults` as `paySchedule` / `primaryLocation`, **by name**, as part of the
all-or-nothing set — so they only ship when the client has also given a pay
category, rate and rate unit (a lone `paySchedule` is a `400`).

## What ships

- `field-map.json` schema accepts an opt-in `employmentHero.defaults` block with
  the **verified** field names:
  `{ paySchedule?, primaryLocation?, primaryPayCategory?, rate?, rateUnit?, hoursPerWeek?, hoursPerDay?, awardId? }`.
- `applyFieldMap` folds every present default into the payload verbatim, by name.
  When the block is absent it emits **no** pay-run keys at all (record lands
  `Incomplete`, an admin finishes it — unchanged from before).
- `scripts/probe-eh-pay-defaults.sh` — the probe above, re-runnable against any
  test business.
- Opt-in only: `_example` / `self` don't set the block.
- **Follow-up re-routing when the set is complete.** `applyFieldMap` now returns
  `payRunDefaultsComplete` (true when `paySchedule` + `primaryLocation` +
  `primaryPayCategory` + `rate` + `rateUnit` are all set). When that is true and
  EH *still* reports the record `Incomplete` for a pay-run reason
  (`decide.ts` → `PAY_RUN_SET_INCOMPLETE`), the Manual-follow-up notice no longer
  says "a payroll admin needs to finish this employee by hand" — it says the
  configured default *names* don't match the business and the field-map needs one
  fix for the whole workforce. `award` / `classification` / `employing entity`
  phrases are excluded from that re-route (defaults don't cover them) and still
  produce the plain admin follow-up. In the happy path — complete set, names
  valid — EH returns no pay-run phrase at all, so no pay-run notice fires.
- **`EH_PAY_SCHEDULE_ID` / `EH_LOCATION_ID` env vars retired.** Since #34 they
  were never sent to EH; they only fed `/health`'s `businessConfigured` flag,
  which now reads `EH_BUSINESS_ID` alone. `wrangler.jsonc`, `src/env.ts`,
  `src/health.ts`, the wizard and `discover.ts` no longer mention them. The
  field-map keeps `employmentHero.payScheduleId` / `locationId` as **optional**
  reference (the numeric IDs behind the `defaults` names); nothing reads them.

## Not doing (yet)

- **True auto-flip to Complete.** EH owns `status`; the sync can't set it. The
  re-routing above only relabels the notice — `defaults` still only helps a
  single-rate workforce, and anything with real pay bands needs per-employee
  entry.
- **Sourcing values from Connecteam "Customizable defaults".** Checked the
  public API (2026-09, `developer.connecteam.com/llms.txt`): **no endpoint
  exposes it.** The nearest surfaces are `pay-rates/v1` (strictly **per-user**
  rate: `effectiveDate` + `rateType` `hourly|monthly|yearly` + amount, with
  `useDefaultRate` / `useParentRate` inheritance flags) and
  `company-policies/v1/pay-rule-policies` (GET returns only `{id, name}`; PUT
  only assigns users). Neither carries pay category, award, classification,
  standard hours, pay schedule or location. The "Customizable defaults" screen
  is UI-only. **Conclusion: the field-map `defaults` block stays the only
  source** for `paySchedule` / `primaryLocation` / `primaryPayCategory`.

## Per-employee `rate` from the Connecteam pay-rates API (issue #42)

Done. `employmentHero.perEmployeeRate: { source: "connecteamPayRate" }` (opt-in)
makes the sync call `GET /pay-rates/v1/pay-rates?userIds={id}&startDate=&endDate=`
per employee and fold `rate` + `rateUnit` into the pay-run set, with
`paySchedule` / `primaryLocation` / `primaryPayCategory` still from `defaults`
and an optional `hoursPerWeek` from a per-employee `number` field rule. See
[`adr/0003-source-per-employee-pay-rate-from-connecteam.md`](./adr/0003-source-per-employee-pay-rate-from-connecteam.md).

- `rate` = `defaultRate` (only when `isDefaultRateEnabled`); `resourcesRates[]`
  overrides are ignored, and logged (`evt: "payrate_resource_overrides"`).
- `rateType` → `rateUnit`: `hourly` → `Hourly`, `yearly` → `Annually`, `monthly`
  → `Monthly` — **confirmed 2026-09-11** (`scripts/probe-eh-pay-defaults.sh
  --rate-unit Monthly`): `201`, `rateUnit: "Monthly"` persists on read-back. Any
  other `rateType` (e.g. `fortnightly`) still raises a follow-up naming the
  employee and sends no pay-run keys. One quirk found: EH read back `6500` sent
  as `6499.99931` — an internal rounding artefact on its side (likely a
  weekly/annual-equivalent conversion), not something the sync can avoid.
- **All-or-nothing preserved, but only the pay-run keys.** If the RATE axis
  can't be resolved for an employee (no pay rate on file, disabled default rate,
  an unmapped `rateType`, no classification picked yet), `applyFieldMap` emits
  **no** pay-run keys - EH is never sent a partial set - but the record's other
  fields still get created/updated as normal, with one follow-up raised instead
  of the pay-run keys. Only a missing LOCATION-axis name in `defaults`
  (`paySchedule` / `primaryLocation` / `primaryPayCategory`) still blocks the
  whole write: that's a field-map misconfiguration affecting every employee
  identically, not a per-person data gap, so nothing is sent at all until it's
  fixed (`MappingResult.payRunBlocking` in `src/mapping/apply.ts` carries this
  distinction).
- **`classification` / award classification** — resolved by #39 (probed
  2026-09-10 against `awardId: 1`). The accepted key is **`payRateTemplate`**,
  the template **name** (which encodes classification + level + age +
  permanent/casual), sent as part of the all-or-nothing pay-run set. EH fills
  `rate` / `rateUnit` from the template. `awardId`, `classification`,
  `payRateTemplateId` are **not** accepted on the unstructured endpoint. See the
  "Award / classification" table above.

## Award path — how it maps to Connecteam (issue #39)

For an **award-covered** client the split is:

| Piece | Where it lives | Per-employee? | Connecteam involvement |
|---|---|---|---|
| The award itself (`awardId`) | Installed once in **EH** by a payroll admin | No — business-wide | **None.** Connecteam has no field for it and the sync never sends it. |
| `paySchedule` / `primaryLocation` / `primaryPayCategory` | field-map `employmentHero.defaults` | No — business-wide | Config only |
| **Classification** = `payRateTemplate` name | **EH** (the award auto-creates the templates) | **Yes** | One Connecteam field holding the template name, e.g. `General Retail Casual L3 21yrs & over`. It is a payroll decision, so it must be an **admin-completed** onboarding-pack field / admin-maintained profile field — never employee self-service. |
| `rate` / `rateUnit` | Derived by EH from the template | n/a | **None** — do *not* also send `perEmployeeRate` (#42) on the award path; the two are alternatives. |
| `hoursPerWeek` / `hoursPerDay` | Per-employee `number` field rule (#42 plumbing) | Yes | Existing per-employee number field |

**Built (issue #39).** Opt in with `employmentHero.payRateTemplate:
{ source: "connecteamField" }` plus a `fields[]` rule `{ eh: "payRateTemplate",
from: { customFieldId: <admin field> }, transform: "dropdownValue" }` if the
Connecteam field is a dropdown (the norm - see
`scripts/provision-award-classification-field.ts`, which provisions exactly
that: an admin-only dropdown seeded from EH's own `payratetemplate` list), or
`transform: "trimString"` for a plain free-text field. **Getting this wrong is a
silent trap, not a schema error**: a dropdown custom field's Connecteam value is
`[{id, value}]`, not a string - `trimString` throws `"expected a string, got
object"` on it, which the sync then reports as a Correction to the *employee*
(a config problem misrouted as if it were their mistake), not a follow-up to
the admin. `applyFieldMap` treats the resolved template name as the rate axis
(drops any explicit `rate` / `rateUnit`) and keeps the location axis from
`defaults`; the whole pay-run key set is still all-or-nothing (never a partial
set sent to EH). A blank template for one employee raises an admin follow-up
but no longer blocks their EH record from being created/updated at all - only
a misconfigured *location* axis (`defaults.paySchedule` / `primaryLocation` /
`primaryPayCategory`, which affects every employee identically) still blocks
the whole write. Mutually exclusive with `perEmployeeRate`. A
single-classification workforce can instead set
`employmentHero.defaults.payRateTemplate` (string) directly. See
[`adr/0004-award-classification-as-a-pay-rate-template.md`](./adr/0004-award-classification-as-a-pay-rate-template.md).
