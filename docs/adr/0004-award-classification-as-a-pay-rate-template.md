# Award classification is a pay-rate template name, sourced per employee

## Status

accepted

## Context

An award-covered client (most retail / hospitality / clerical workforces)
installs the relevant Fair Work award in Employment Hero once. Installing the
**Retail (General) Industry Award 2020 [MA000004]** on test business `555455`
(issue #39, probed 2026-09-10) added 117 award pay categories and **66 award
pay-rate templates** — one per classification × level × age band ×
permanent/casual, e.g. `General Retail Casual L3 21yrs & over`.

Probe findings against `POST .../employee/unstructured` (in
`docs/eh-pay-defaults.md`):

- The accepted key is **`payRateTemplate`**, the template **NAME**. It *is* the
  classification. EH auto-fills `rate` + `rateUnit` from it (28.89 / Hourly in
  the test), so no rate is sent.
- `payRateTemplate` is part of the same all-or-nothing set — sent alone (no
  `paySchedule` / `primaryLocation` / `primaryPayCategory`) it is a 400.
- `awardId`, `classification` (bare string), and `payRateTemplateId` (numeric)
  are **silently dropped** on this endpoint. Only the name works.
- The award install itself is business-wide EH admin setup. Connecteam plays no
  part in it and the sync never sends `awardId`.

The one per-employee value on the award path is which template (classification)
the employee is on. That is a payroll decision, not self-service data.

## Decision

Add an opt-in `employmentHero.payRateTemplate: { source: "connecteamField" }`
block. When set, the client also adds a `fields[]` rule with
`eh: "payRateTemplate"` pointing at an **admin-completed** Connecteam field whose
value is the award template name.

- The rate axis of the pay-run set is satisfied by `payRateTemplate` alone; EH
  derives `rate` / `rateUnit`. Any explicit `rate` / `rateUnit` on the payload is
  **dropped** — the award template is the sole rate source (never make EH
  disambiguate via `overrideTemplateRate`).
- The location axis (`paySchedule` + `primaryLocation` + `primaryPayCategory`)
  still comes from `employmentHero.defaults`, company-wide.
- **Mutually exclusive with `perEmployeeRate`** — both fill the rate axis. The
  schema rejects a map that sets both.
- **Invariant (same as #42):** if the template value is blank for an employee, or
  a location-axis default is missing, `applyFieldMap` emits **no** pay-run keys
  and returns a plain-language `payRunIssues[]`; `decide` turns that into one
  follow-up to the admin channel. EH is never sent a partial set.
- A company-wide `employmentHero.defaults.payRateTemplate` (string) is also
  accepted, for a genuinely single-classification workforce — it satisfies the
  rate axis the same way, no `fields[]` rule needed.
- `decide.ts`: `award` / `classification` phrases now re-route to the
  "field-map names don't match this business" follow-up **when
  `payRunDefaultsComplete` is true** (i.e. the client is on the award path).
  A client not on the award path still gets the plain admin follow-up for them.

## Considered options

- **A new Connecteam custom field holding the numeric template id**: rejected.
  The probe shows `payRateTemplateId` does not resolve on the unstructured
  endpoint — only the name works — and an id is opaque for the admin who sets it.
- **Send `awardId` + a `classification` string** (the shape the #39 draft
  guessed): rejected. Both are silently dropped by EH here; a partial set that
  looks accepted (201) but never applies is the worst failure mode.
- **Derive the template from role + age + employment type in the sync**: rejected
  for v1. The mapping from a job title to an award classification is a payroll
  judgement (which level, which grade) that varies per client and per award — it
  belongs with the admin, recorded once on the Connecteam profile, not encoded in
  the integration.
- **Keep award/classification a manual EH task** (status quo): still the default.
  This ADR only adds an opt-in path; absent the block, nothing changes.

## Consequences

- No extra network call — the template name rides in on the existing Connecteam
  user payload via a normal `fields[]` rule.
- `field-map.json` schema gains `employmentHero.payRateTemplate` and
  `defaults.payRateTemplate`, plus a `perEmployeeRate` XOR `payRateTemplate`
  refinement. `applyFieldMap` pay-run logic moves from a fixed 5-field
  `PAY_RUN_REQUIRED` to a location axis + a rate axis (`rate` + `rateUnit` **or**
  `payRateTemplate`).
- The award/pay-run axis is not the only `Complete` gate — even a full award set
  left the synthetic probe record `Incomplete` because bank / super / tax were
  absent (issue #45).
- Client onboarding for an award workforce gains one prerequisite: **install the
  award in EH first**, then map the classification field. Documented in
  `docs/eh-pay-defaults.md` → "Award path — how it maps to Connecteam".
- `_example` / `self` field maps are unchanged (opt-in only).
