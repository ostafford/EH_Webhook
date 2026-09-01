#!/usr/bin/env bash
#
# Issue #26 "Must verify first": what does EH's UNSTRUCTURED employee endpoint
# (POST /api/v2/business/{id}/employee/unstructured) actually accept for the
# company-wide pay-run defaults, and does it flip a record off `Incomplete`?
#
# This runs three throwaway creates (externalId ZZZTEST-*), reads each back to
# see which fields persisted and the resulting status, then DELETEs them. It
# never touches a pay run.
#
#   scripts/probe-eh-pay-defaults.sh \
#       --pay-category "Permanent Ordinary Hours" --rate 30 --rate-unit Hourly \
#       --hours-week 38 --hours-day 7.6 --award 12345
#
# Credentials: EH_API_KEY / EH_BUSINESS_ID from the environment or .dev.vars.
# See docs/eh-pay-defaults.md for the recorded results.

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

PAY_CATEGORY="" RATE="" RATE_UNIT="" HOURS_WEEK="" HOURS_DAY="" AWARD="" \
  PAY_SCHEDULE="" LOCATION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pay-category) PAY_CATEGORY="$2"; shift 2 ;;
    --rate)         RATE="$2"; shift 2 ;;
    --rate-unit)    RATE_UNIT="$2"; shift 2 ;;
    --hours-week)   HOURS_WEEK="$2"; shift 2 ;;
    --hours-day)    HOURS_DAY="$2"; shift 2 ;;
    --award)        AWARD="$2"; shift 2 ;;
    --pay-schedule) PAY_SCHEDULE="$2"; shift 2 ;;
    --location)     LOCATION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# one create + read-back + delete. $1 label, $2 JSON of extra fields.
probe() {
  local ext="ZZZTEST-$(date +%s)-$RANDOM"
  local body
  body=$(node -e '
    const o = JSON.parse(process.argv[2]);
    Object.assign(o, {
      externalId: process.argv[1], firstName: "Zztest", surname: "Probe",
      startDate: "2020-01-01", employmentType: "Casual", taxFileNumber: "123456782",
    });
    process.stdout.write(JSON.stringify(o));
  ' "$ext" "$2")
  local code
  code=$(curl -sS -o /tmp/probe_cr -w '%{http_code}' -X POST "$B/employee/unstructured" "${H[@]}" -d "$body")
  echo "── $1"
  echo "   sent  : $2"
  echo "   create: HTTP $code"
  local emp
  emp=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync("/tmp/probe_cr","utf8")).id||""))}catch(e){}')
  if [[ -z "$emp" ]]; then
    echo "   error : $(cat /tmp/probe_cr)"
    echo
    return
  fi
  curl -sS "${H[@]}" "$B/employee/unstructured/externalid/$ext" -o /tmp/probe_rb
  node -e '
    const r = JSON.parse(require("fs").readFileSync("/tmp/probe_rb","utf8"));
    console.log("   status:", r.status, "| detailedStatus:", JSON.stringify(r.detailedStatus));
    const keys = ["paySchedule","primaryLocation","primaryPayCategory","rate","rateUnit",
                  "hoursPerWeek","hoursPerDay","awardId","businessAwardPackage",
                  "classification","standardHoursPerWeek","payScheduleId","locationId"];
    for (const k of keys) {
      const v = r[k];
      if (v !== undefined && v !== null && v !== "" && v !== 0 && v !== "False")
        console.log("   kept  :", k, "=", JSON.stringify(v));
    }
  '
  curl -sS -o /dev/null -X DELETE "$B/employee/$emp" -H "authorization: $AUTH"
  echo
}

echo "probing business $BUSINESS_ID"
echo

# 1. baseline: does the CURRENT sync's payScheduleId/locationId even land?
probe "baseline: payScheduleId + locationId as the sync sends them today" \
  "$(node -e 'process.stdout.write(JSON.stringify({payScheduleId:"'"${PAY_SCHEDULE:-}"'"||"0",locationId:"'"${LOCATION:-}"'"||"0"}))')"

# 2. the pay-run-default set, by NAME (the shape docs/eh-pay-defaults.md verifies)
probe "pay-run defaults by name (full set)" \
  "$(PAY_SCHEDULE="$PAY_SCHEDULE" LOCATION="$LOCATION" PAY_CATEGORY="$PAY_CATEGORY" \
     RATE="$RATE" RATE_UNIT="$RATE_UNIT" HOURS_WEEK="$HOURS_WEEK" HOURS_DAY="$HOURS_DAY" AWARD="$AWARD" node -e '
    const o = {};
    const s = (k,v) => { if (v) o[k] = v; };
    const n = (k,v) => { if (v) o[k] = Number(v); };
    s("paySchedule", process.env.PAY_SCHEDULE);
    s("primaryLocation", process.env.LOCATION);
    s("primaryPayCategory", process.env.PAY_CATEGORY);
    n("rate", process.env.RATE);
    s("rateUnit", process.env.RATE_UNIT);
    n("hoursPerWeek", process.env.HOURS_WEEK);
    n("hoursPerDay", process.env.HOURS_DAY);
    if (process.env.AWARD) o.awardId = /^\d+$/.test(process.env.AWARD) ? Number(process.env.AWARD) : process.env.AWARD;
    process.stdout.write(JSON.stringify(o));
  ')"

# 3. the names this doc's FIRST draft guessed - expected to be dropped silently
probe "rejected names (classification / standardHoursPerWeek) - expect silently dropped" \
  '{"classification":"Level 2","standardHoursPerWeek":40}'

cat <<'EON'
Read the result:
  - "baseline" keeping paySchedule/primaryLocation null == the sync's current
    payScheduleId/locationId keys are ignored (a separate bug).
  - the "by name" probe keeping all fields AND status improving == put that set
    in field-map employmentHero.defaults.
  - "rejected names" keeping nothing == those keys are dead; don't use them.
Record the outcome in docs/eh-pay-defaults.md.
EON
