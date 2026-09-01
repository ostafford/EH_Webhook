#!/usr/bin/env bash
#
# Issue #26 "Must verify first": does EH's UNSTRUCTURED employee endpoint
# (POST /api/v2/business/{id}/employee/unstructured) actually honour the
# company-wide pay-run-default fields - award / classification / pay category /
# standard hours - or do some of them only exist on the structured endpoints?
#
# This creates ONE throwaway employee (externalId ZZZTEST-<ts>), sets whichever
# default fields you pass, reads the record back, reports which ones persisted
# and whether the record reached `Complete`, then DELETEs it. It never touches
# a pay run.
#
#   scripts/probe-eh-pay-defaults.sh \
#       --award 12345 --classification "Level 2" \
#       --pay-category 67890 --hours 38
#
# Any subset of the four flags works; with none it just probes the baseline.
# Credentials come from EH_API_KEY / EH_BUSINESS_ID in the environment or in
# .dev.vars (same file the integration tests read).

set -euo pipefail

BASE="${EH_BASE_URL:-https://api.yourpayroll.com.au/api/v2}"

# --- credentials -----------------------------------------------------------
_from_dev_vars() { [[ -f .dev.vars ]] && sed -n "s/^$1=//p" .dev.vars | tail -n1; }
API_KEY="${EH_API_KEY:-$(_from_dev_vars EH_API_KEY || true)}"
BUSINESS_ID="${EH_BUSINESS_ID:-$(_from_dev_vars EH_BUSINESS_ID || true)}"
[[ -n "$API_KEY" && -n "$BUSINESS_ID" ]] || {
  echo "set EH_API_KEY and EH_BUSINESS_ID (env or .dev.vars) first" >&2; exit 1
}
AUTH="Basic $(printf '%s:' "$API_KEY" | base64 | tr -d '\n')"

# --- args ----------------------------------------------------------------
AWARD="" ; CLASSIFICATION="" ; PAY_CATEGORY="" ; HOURS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --award)          AWARD="$2"; shift 2 ;;
    --classification) CLASSIFICATION="$2"; shift 2 ;;
    --pay-category)   PAY_CATEGORY="$2"; shift 2 ;;
    --hours)          HOURS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

EXT="ZZZTEST-$(date +%s)"

# --- build the create body (node keeps the JSON well-formed) -------------
BODY=$(EXT="$EXT" AWARD="$AWARD" CLASSIFICATION="$CLASSIFICATION" \
       PAY_CATEGORY="$PAY_CATEGORY" HOURS="$HOURS" node -e '
  const b = {
    firstName: "Zztest", surname: "PayDefaults",
    startDate: "2020-01-01", employmentType: "Casual",
    taxFileNumber: "123456782",
    externalId: process.env.EXT,
  };
  const num = (v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  if (process.env.AWARD)          b.awardId = num(process.env.AWARD);
  if (process.env.CLASSIFICATION) b.classification = process.env.CLASSIFICATION;
  if (process.env.PAY_CATEGORY)   b.payCategoryId = num(process.env.PAY_CATEGORY);
  if (process.env.HOURS)          b.standardHoursPerWeek = num(process.env.HOURS);
  process.stdout.write(JSON.stringify(b));
')

echo "▸ probing business $BUSINESS_ID with externalId $EXT"
echo "  sending: $BODY"
echo

CREATE=$(curl -sS -X POST "$BASE/business/$BUSINESS_ID/employee/unstructured" \
  -H "authorization: $AUTH" -H "content-type: application/json" \
  -H "accept: application/json" -d "$BODY")
echo "◂ create response:"
printf '%s\n' "$CREATE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch(e){console.log(s)}})' | sed 's/^/    /'

EMP_ID=$(printf '%s' "$CREATE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id||"")}catch(e){console.log("")}})')
if [[ -z "$EMP_ID" ]]; then
  echo
  echo "✗ no employee id came back - EH likely rejected the create. See the response above:"
  echo "  a 400 that names 'awardId' / 'classification' / 'payCategoryId' /"
  echo "  'standardHoursPerWeek' means that field is NOT accepted on the unstructured"
  echo "  endpoint and belongs on a structured call instead."
  exit 2
fi

echo
echo "▸ reading it back..."
READBACK=$(curl -sS "$BASE/business/$BUSINESS_ID/employee/unstructured/externalid/$EXT" \
  -H "authorization: $AUTH" -H "accept: application/json")

EXT="$EXT" AWARD="$AWARD" CLASSIFICATION="$CLASSIFICATION" PAY_CATEGORY="$PAY_CATEGORY" HOURS="$HOURS" \
node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    let r; try { r = JSON.parse(s); } catch(e){ console.log("  could not parse read-back:\n"+s); return; }
    const show = (label, sent, got) => {
      if (!sent) return;
      const ok = got !== undefined && got !== null && String(got) !== "";
      console.log(`  ${ok ? "✓" : "✗"} ${label}: sent ${JSON.stringify(sent)}  read-back ${JSON.stringify(got)}`);
    };
    console.log(`  status: ${r.status}   detailedStatus: ${r.detailedStatus ?? "(none)"}`);
    show("awardId", process.env.AWARD, r.awardId ?? r.awardName);
    show("classification", process.env.CLASSIFICATION, r.classification ?? r.classificationName);
    show("payCategoryId", process.env.PAY_CATEGORY, r.payCategoryId ?? r.payCategoryName);
    show("standardHoursPerWeek", process.env.HOURS, r.standardHoursPerWeek ?? r.hoursPerWeek);
  });
' <<<"$READBACK"

echo
echo "▸ cleaning up (DELETE employee $EMP_ID)..."
curl -sS -o /dev/null -w "  delete HTTP %{http_code}\n" -X DELETE \
  "$BASE/business/$BUSINESS_ID/employee/$EMP_ID" -H "authorization: $AUTH"

cat <<'EON'

Read the result:
  - a field that shows ✓ on read-back AND moved `status` from Incomplete toward
    Complete is safe to put in field-map `employmentHero.defaults`.
  - a field that read back ✗ (or a 400 on create naming it) is not honoured here;
    leave it out and keep the Manual-follow-up notice for it, or add a structured
    call in a follow-up.
  - record the outcome in docs/eh-pay-defaults.md.
EON
