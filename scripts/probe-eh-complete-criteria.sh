#!/usr/bin/env bash
#
# Issue #45: what does EH's unstructured employee endpoint actually require for an
# employee to reach `status: Complete`, and what exact reason string does it give
# for each axis when that axis is omitted?
#
# EH has no "what's missing on this employee" endpoint. The only signals are the
# `status` flag and the `detailedStatus` phrase on the POST/PUT *response
# envelope* (NOT the read-back GET - that field is null there).
#
# IMPORTANT: `POST .../employee/unstructured` upserts by `taxFileNumber`, not by
# `externalId`, an update MERGES (an omitted field is not cleared), and DELETE
# does not free the TFN synchronously. So each probe gets its OWN unique, valid
# TFN (generated below) - that guarantees a clean 201 create carrying only that
# variant's fields. Build the maximal record, remove ONE axis, POST, record
# status + detailedStatus, then delete.
#
#   1. CONTROL: the maximal record, nothing removed  -> expect status: Complete,
#   2. one row per axis: maximal record minus that axis -> status + detailedStatus,
#   3. every test employee deleted as it goes (plus a trap sweep).
#
# It never touches a pay run. Re-runnable. Results -> docs/eh-complete-criteria.md.
#
#   scripts/probe-eh-complete-criteria.sh
#
# Credentials: EH_API_KEY / EH_BUSINESS_ID from the environment or .dev.vars.

set -uo pipefail

BASE="${EH_BASE_URL:-https://api.yourpayroll.com.au/api/v2}"

_dv() { [[ -f .dev.vars ]] && sed -n "s/^$1=//p" .dev.vars | tail -n1; }
API_KEY="${EH_API_KEY:-$(_dv EH_API_KEY || true)}"
BUSINESS_ID="${EH_BUSINESS_ID:-$(_dv EH_BUSINESS_ID || true)}"
[[ -n "$API_KEY" && -n "$BUSINESS_ID" ]] || {
  echo "set EH_API_KEY and EH_BUSINESS_ID (env or .dev.vars) first" >&2; exit 1
}
AUTH="Basic $(printf '%s:' "$API_KEY" | base64 | tr -d '\n')"
B="$BASE/business/$BUSINESS_ID"
H=(-H "authorization: $AUTH" -H "content-type: application/json" -H "accept: application/json")

# A maximal, valid employee. `taxFileNumber` is injected per-probe (unique valid
# TFN each). Pay-run uses the #39 award pay-rate template (EH fills rate/unit).
FULL_JSON='{
  "firstName": "Zztest", "surname": "Complete",
  "dateOfBirth": "1990-01-01", "gender": "Male",
  "startDate": "2020-01-01", "employmentType": "Casual",
  "residentialStreetAddress": "1 Test Street", "residentialSuburb": "Sydney",
  "residentialState": "NSW", "residentialPostCode": "2000", "residentialCountry": "AU",
  "claimTaxFreeThreshold": true, "australianResident": true,
  "helpDebt": false, "stslDebt": false,
  "dateTaxFileDeclarationSigned": "2020-01-05",
  "bankAccount1": "Electronic",
  "bankAccount1_AccountName": "Zztest Complete", "bankAccount1_BSB": "062000",
  "bankAccount1_AccountNumber": "12345678", "bankAccount1_AllocatedPercentage": 100,
  "superFund1_ProductCode": "STA0100AU", "superFund1_FundName": "AustralianSuper",
  "superFund1_MemberNumber": "A1000001", "superFund1_AllocatedPercentage": 100,
  "paySchedule": "Weekly", "primaryLocation": "Connecteam",
  "primaryPayCategory": "Casual - Ordinary Hours",
  "payRateTemplate": "General Retail Casual L3 21yrs & over",
  "hoursPerWeek": 38, "hoursPerDay": 7.6
}'

# A pool of unique, checksum-valid TFNs (ATO weights 1,4,3,7,5,8,6,9,10; sum % 11 == 0).
TFNS=()
while IFS= read -r _tfn; do TFNS+=("$_tfn"); done < <(node -e '
  const w = [1,4,3,7,5,8,6,9,10]; const out = [];
  for (let p = 10000000; out.length < 60; p++) {
    const d = String(p).split("").map(Number);
    const s8 = d.reduce((a, x, i) => a + x * w[i], 0);
    const c = s8 % 11; if (c === 10) continue;      // no valid check digit
    out.push(String(p) + c);
  }
  console.log(out.join("\n"));
')

N=0
CREATED=()
cleanup() {
  for id in "${CREATED[@]:-}"; do
    [[ -n "$id" ]] && curl -sS -o /dev/null -X DELETE "$B/employee/$id" -H "authorization: $AUTH"
  done
}
trap cleanup EXIT

# $1 label   $2 node expression mutating `o` (the parsed FULL_JSON), "" for none
probe() {
  local label="$1" mutate="${2:-}"
  N=$((N + 1))
  local ext="ZZZTEST-$(date +%s)-$N-$RANDOM"
  local tfn="${TFNS[$((N - 1))]}"
  local body
  body=$(FULL="$FULL_JSON" MUT="$mutate" TFN="$tfn" node -e '
    const o = JSON.parse(process.env.FULL);
    o.taxFileNumber = process.env.TFN;              // unique valid TFN per probe
    o.surname = "Complete" + process.argv[2];       // unique name too
    if (process.env.MUT) (new Function("o", process.env.MUT))(o);
    o.externalId = process.argv[1];
    process.stdout.write(JSON.stringify(o));
  ' "$ext" "$N")
  local code
  code=$(curl -sS -o /tmp/pcc -w '%{http_code}' -X POST "$B/employee/unstructured" "${H[@]}" -d "$body")
  node -e '
    const label = process.argv[1], code = process.argv[2];
    let r = {}; try { r = JSON.parse(require("fs").readFileSync("/tmp/pcc", "utf8")); } catch {}
    const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
    if (r && r.id) {
      console.log(pad(label, 32), "| HTTP", code, "| status:", pad(String(r.status), 11),
                  "| detailedStatus:", JSON.stringify(r.detailedStatus ?? null));
    } else {
      const msg = (r && (r.message || r.Message)) || require("fs").readFileSync("/tmp/pcc","utf8");
      console.log(pad(label, 32), "| HTTP", code, "| ERROR:", String(msg).slice(0, 240).replace(/\n/g, " ⏎ "));
    }
  ' "$label" "$code"
  # Delete now; also record for the trap sweep in case a delete does not stick
  # (EH's DELETE is not always synchronous).
  local id
  id=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync("/tmp/pcc","utf8"));process.stdout.write(String(r.id||""))}catch{}')
  if [[ -n "$id" ]]; then
    CREATED+=("$id")
    curl -sS -o /dev/null -X DELETE "$B/employee/$id" -H "authorization: $AUTH"
  fi
}

echo "probing business $BUSINESS_ID - EH Complete criteria (issue #45)"
echo "each row = the maximal record with ONE axis removed; compare status + detailedStatus"
echo

probe "CONTROL (nothing removed)"        ""
# --- basic details axis ---
probe "no dateOfBirth"                   "delete o.dateOfBirth"
probe "no gender"                        "delete o.gender"
probe "no employmentType"               "delete o.employmentType"
probe "no startDate"                     "delete o.startDate"
probe "no jobTitle (never set anyway)"   ""
probe "no address (all 5 fields)"        "for (const k of ['residentialStreetAddress','residentialSuburb','residentialState','residentialPostCode','residentialCountry']) delete o[k]"
probe "no residentialStreetAddress"      "delete o.residentialStreetAddress"
probe "no residentialSuburb"             "delete o.residentialSuburb"
probe "no residentialState"              "delete o.residentialState"
probe "no residentialPostCode"           "delete o.residentialPostCode"
probe "no residentialCountry"            "delete o.residentialCountry"
# --- tax / TFN axis ---
probe "no TFN"                           "delete o.taxFileNumber"
probe "no tax decl (tft+resident)"       "delete o.claimTaxFreeThreshold; delete o.australianResident"
probe "no TFN declaration date"          "delete o.dateTaxFileDeclarationSigned"
# --- bank axis ---
probe "no bank (whole block)"            "for (const k of Object.keys(o)) if (k.startsWith('bankAccount1')) delete o[k]"
probe "no bank BSB only"                 "delete o.bankAccount1_BSB"
probe "no bank AccountNumber only"       "delete o.bankAccount1_AccountNumber"
probe "no bank AccountName only"         "delete o.bankAccount1_AccountName"
probe "no bank payment method"           "delete o.bankAccount1"
probe "no bank allocation field"         "delete o.bankAccount1_AllocatedPercentage"
probe "bank allocation 50 not 100"       "o.bankAccount1_AllocatedPercentage = 50"
# --- super axis ---
probe "no super (whole block)"           "for (const k of Object.keys(o)) if (k.startsWith('superFund1')) delete o[k]"
probe "super allocation 50 not 100"      "o.superFund1_AllocatedPercentage = 50"
# --- pay-run axis (control - already documented in eh-pay-defaults.md) ---
probe "no pay-run set"                   "for (const k of ['paySchedule','primaryLocation','primaryPayCategory','payRateTemplate','hoursPerWeek','hoursPerDay']) delete o[k]"

echo
echo "Read the result:"
echo "  - CONTROL status == 'Complete'  => the maximal set is sufficient; each"
echo "    other row that drops to 'Incomplete' names an axis EH requires, and its"
echo "    detailedStatus is the reason string to record + route (src/eh/errors.ts,"
echo "    src/sync/decide.ts)."
echo "  - CONTROL still 'Incomplete'    => note its detailedStatus; there is a"
echo "    further axis this script does not cover yet - add it above."
echo "Record the outcome in docs/eh-complete-criteria.md (dated 3-col table:"
echo "  axis/field -> reason string when omitted -> existing Connecteam source)."
