# EH `Complete` criteria — every axis, verified (issue #45)

**Probed:** 2026-09-11, against EH test business `555455` (with the Retail
(General) Industry Award 2020 [MA000004] installed, `awardId: 1`).
**Script:** `scripts/probe-eh-complete-criteria.sh` — builds one maximal valid
`ZZZTEST-` employee, removes **one axis at a time**, records the
`status` + `detailedStatus` on the create envelope, deletes each test employee.
Never touches a pay run.

## Result: `Complete` is reachable

The maximal record (basic details + address + TFN + tax declaration + bank +
super + the #39 award pay-run set) came back **`status: Complete`, HTTP 201**.
This is the first end-to-end `Complete` the integration's mapping can produce.

EH exposes no "what is missing" endpoint. Two signals only:
- **`detailedStatus`** — a short phrase on the **POST/PUT response envelope**
  (it is `null` on the read-back GET, so capture it from the write result).
- **HTTP 400** — a hard validation failure; nothing is written at all.

## The axes

Legend: **gates Complete** = create succeeds (201) but `status: Incomplete` until
the axis is supplied. **Hard 400** = the write is rejected outright.

| EH axis / field | What EH does when it is missing / wrong | Connecteam source (existing) |
|---|---|---|
| **Basic details** — `firstName`, `surname` | required to create (`required: true` in the map, caught by `applyFieldMap` first) | profile custom fields (`self`: 42920713 / 42920714) |
| **Basic details** — `dateOfBirth` | **gates Complete** → `detailedStatus`: `"Basic Details are incomplete. If an employee is onboarding via Self Setup, they will receive a notification prompting them to complete their details"` | custom field (`self`: 25145118), `dateDmyToIso` |
| **Basic details** — `startDate` | **Hard 400**: `"'Start Date' should not be empty."` (map marks it `required`, so `applyFieldMap` catches it before the write) | custom field (`self`: 25145109) |
| **Basic details** — `employmentType` | **Hard 400**: `"'Employment Type Id' must be between 1 and 5. You entered 0."` (map marks it `required`) | custom field dropdown (`self`: 42920839) |
| **Address** — `residentialStreetAddress` | **gates Complete** → same `"Basic Details are incomplete…"` phrase | custom field (`self`: 25145120), `locationStreetLine` |
| **Address** — `residentialSuburb` | **gates Complete** → same phrase | custom field (`self`: 42920715) |
| **Address** — `residentialState`, `residentialPostCode`, `residentialCountry` | **no effect on Complete** (record stays `Complete` without them). Still sent — they matter for payroll correctness, not status. | custom fields (`self`: 42920838 / 42923224 / 42920716) |
| **Basic details** — `gender` | **no effect on Complete** | custom field (`self`: 25145119) |
| **Basic details** — `jobTitle` | **no effect on Complete** | custom field (`self`: 25145108) |
| **TFN** — `taxFileNumber` | **Hard 400**: `"Tax File Number is required"` (map marks it `required`) | custom field (`self`: 42923222), `digits`, sensitive |
| **Tax declaration** — `claimTaxFreeThreshold`, `australianResident` | **no effect on Complete** (omitting both still returned `Complete`). They drive withholding, and a bad combination 400s via a separate rule (`decide` / `rules.ts`), but they do **not** gate `status`. | `rules.taxDeclaration` Yes/No custom fields (`self`: 42923276 / 42923315 / 42923316) |
| **Tax declaration** — `dateTaxFileDeclarationSigned` / `…Reported` | **no effect on Complete** (both `null` and record still `Complete`). Not sent by the sync; leave unset. | — (not needed) |
| **Bank** — the account block is **omitted entirely** | **gates Complete** → `detailedStatus`: `"Bank Accounts are incomplete"` | — |
| **Bank** — block present but `bankAccount1_BSB` missing | **Hard 400**: `"BankAccount1: BSB is required if any bank account details are supplied"` | custom field (`self`: 42923223), `zeroPad6`, sensitive |
| **Bank** — block present but `bankAccount1_AccountNumber` missing | **Hard 400**: `"BankAccount1: Account Number is required if any bank account details are supplied"` | custom field (`self`: 42921172), `digits`, sensitive |
| **Bank** — block present but `bankAccount1_AccountName` missing | **Hard 400**: `"BankAccount1: Account Name is required if any bank account details are supplied"` | custom field (`self`: 42921173), sensitive |
| **Bank** — `bankAccount1_AllocatedPercentage` missing or ≠ 100 | **Hard 400**: `"BankAccount1: Allocated Percentage or Fixed Amount is required…"` and/or `"The sum of the allocated percentage should total 100 for bank accounts"` | constant `100` in `rules.constants` (v1 syncs one account) |
| **Bank** — `bankAccount1` (payment method, `"Electronic"`) | **no effect on Complete** | constant `"Electronic"` in `rules.constants` |
| **Super** — the fund block is **omitted entirely** | **no effect on Complete** — record still `Complete`. Super is **not** a `Complete` gate. | `rules.super` custom fields (`self`: 42920803 USI / 42920783 ABN / 42920782 name / 42920804 member no.) |
| **Super** — block present but `superFund1_AllocatedPercentage` ≠ 100 | **Hard 400**: `"The sum of the allocated percentage should total 100 for super funds"` | constant `100` (`rules.ts` `SINGLE_FUND_ALLOCATION`) |
| **Pay run** — `paySchedule` + `primaryLocation` + `primaryPayCategory` + a rate axis (`rate`+`rateUnit`, **or** `payRateTemplate`) | **gates Complete** → `detailedStatus`: `"Pay Run Defaults are incomplete"`. All-or-nothing (a partial set is a 400). Full detail in [`eh-pay-defaults.md`](./eh-pay-defaults.md). | field-map `employmentHero.defaults` (location axis) + `payRateTemplate` (#39, admin CT field) **or** `perEmployeeRate` (#42, Connecteam pay-rates API) |

## Consequences for the sync

1. **Nothing new to source from Connecteam.** Every field that gates `Complete`
   already has a mapping in `clients/self/field-map.json`. The `_example` map
   covers the same set. No new Connecteam custom field is needed.
2. **Super does not block `Complete`.** So the SMSF **Manual-follow-up notice**
   and a "no super fund" case are genuinely just follow-ups — they never leave a
   record `Incomplete`. Confirmed, not assumed.
3. **The tax-free-threshold / residency answers do not block `Complete`.** A
   wrong answer surfaces through withholding correctness and the
   non-resident-cannot-claim-TFT 400 rule, not through `status`.
4. **`residentialState` / `postcode` / `country` do not block `Complete`** — only
   street address + suburb do. The sync still sends all of them.
5. **Routing (`src/sync/decide.ts`).** The two new `detailedStatus` phrases —
   `"Basic Details are incomplete…"` and `"Bank Accounts are incomplete"` — are
   employee-fixable data, so they route to a **Correction message**, not the
   admin channel. `decide.ts` already does this (they do not match
   `ADMIN_ONLY_INCOMPLETE`); regression tests added in `test/sync-decide.test.ts`.
   The colon-less 400 phrases are already handled by
   `src/eh/errors.ts` (`/tax file number/i`, `/allocated percentage/i`,
   `/allocated percentage.*\b(super|fund)/i`). `startDate` / `employmentType`
   400s are pre-empted by the `required: true` check in `applyFieldMap`, so they
   are left unmapped in `errors.ts` (matches the existing
   `fieldForColonlessReason("Start date is required") === "(unknown)"` test).

## Caveat found while probing — EH upserts by `taxFileNumber`

`POST .../employee/unstructured` matches an existing employee by **`taxFileNumber`**,
not `externalId`, an update **merges** (an omitted field is not cleared), and
`DELETE` does not free the TFN synchronously. The sync is unaffected in normal
operation — `EhClient` does its own `GET .../externalid/{id}` then chooses
POST vs PUT — but two Connecteam users sharing a TFN, or a TFN correction, would
collide on EH's side. Worth a note if multi-account edge cases ever surface.
