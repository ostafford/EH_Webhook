# Company-wide EH pay-run defaults (issue #26)

## Problem

Every synced employee lands in Employment Hero as
`status: Incomplete — "Pay Run Defaults are incomplete"` because the sync never
sets award / classification / pay category / standard hours (out of scope for
v1, `docs/PLAN.md`). A payroll admin fixes each record by hand, and a
Manual-follow-up notice fires per employee.

Most of that data is **company-wide**, not per-person — the same category as
`payScheduleId` / `locationId`, which the sync already stamps on every payload
from `clients/self/field-map.json`. So: an opt-in `employmentHero.defaults`
block, applied on every create through the same code path.

```jsonc
"employmentHero": {
  "businessId": "…",
  "payScheduleId": "…",
  "locationId": "…",
  "defaults": {
    "awardId": "12345",
    "classification": "Level 2",
    "payCategoryId": "67890",
    "standardHoursPerWeek": 38
  }
}
```

Individual **salary** is a real per-person number — it stays a Connecteam custom
field or a manual EH entry, and the follow-up notice keeps covering it.

## Must verify first — is the unstructured endpoint enough?

`POST /api/v2/business/{id}/employee/unstructured` (`AuUnstructuredEmployeeModel`)
is the only write path this integration uses. Some pay-setup data lives on
*structured* endpoints instead, so each default field has to be confirmed.

What is known from the API reference so far:

| Field | On `AuUnstructuredEmployeeModel`? | Notes |
|---|---|---|
| `awardId` | **Yes** — confirmed writable property (`int32`) | |
| `classification` | Unconfirmed | classification appears on award / pay-rate-template models; may or may not be honoured here |
| `payCategoryId` | Unconfirmed / unlikely | pay category is normally per-earnings-line, not an employee default |
| `standardHoursPerWeek` | Unconfirmed | `standardWeeklyHours` exists on the employment-agreement / pay-rate-template model; the employee-level name and endpoint need checking |

Sources: KeyPay API reference — [`AuUnstructuredEmployeeModel`](https://api.keypay.com.au/australia/resources/auunstructuredemployeemodel?v=latest),
[Create or Update Employee](https://api.keypay.com.au/australia/reference/employee/au-employee--post-employee),
[`EmploymentAgreementModel`](https://api.keypay.com/australia/resources/employmentagreementmodel?v=latest).

### Run the probe

Against a **test** business (never production; the probe creates and deletes one
`ZZZTEST-` employee and never touches a pay run):

```bash
# EH_API_KEY / EH_BUSINESS_ID from env or .dev.vars
scripts/probe-eh-pay-defaults.sh --award 12345 --classification "Level 2" \
    --pay-category 67890 --hours 38
```

It creates the employee with those fields, reads the record back, prints which
fields persisted plus `status` / `detailedStatus`, then deletes it. Read the
output as:

- **✓ on read-back and `status` moved toward `Complete`** → safe to put in
  `employmentHero.defaults`; the `PAY_DEFAULT_EH_FIELD` map in
  `src/mapping/apply.ts` already carries the name.
- **✗ on read-back, or a `400` on create naming the field** → not honoured on
  this endpoint. Leave it out (the follow-up notice still covers it), or add a
  structured call in a follow-up issue. Fix the name in `PAY_DEFAULT_EH_FIELD`
  if the probe shows a different one works.

Record the outcome in the table above.

## What ships now

- `field-map.json` schema accepts the optional `employmentHero.defaults` block
  (`src/mapping/schema.ts`).
- `applyFieldMap` folds every present default into the payload verbatim, keyed
  through `PAY_DEFAULT_EH_FIELD`, right beside `payScheduleId` / `locationId`
  (`src/mapping/apply.ts`).
- `scripts/probe-eh-pay-defaults.sh` for the verification above.
- The example and `self` field-maps do **not** set the block — it is entirely
  opt-in, so an unverified field name cannot affect an existing deployment.

## Not doing (yet)

- **Sourcing the values from Connecteam's "Customizable defaults"** (Company
  Policies). Only worth the extra API wiring if a client needs non-technical
  self-serve; the field-map is the simpler surface for a set-once-at-setup value.
- **Per-employee salary.** Stays manual / a Connecteam custom field.
- **Structured-endpoint calls** for any default the probe shows the unstructured
  endpoint rejects.
