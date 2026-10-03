/**
 * The admin-only Connecteam dropdown holding EH's award pay rate templates
 * (issues #39, #65), and the field-map rule that reads it.
 *
 * The rule is only ever written together with `employmentHero.payRateTemplate`
 * (by the pay-run picker): a rule without that rate source would send EH a
 * lone `payRateTemplate`, which it rejects (`docs/eh-pay-defaults.md`).
 */

export const AWARD_FIELD_NAME = "EH Pay Rate Template";

/** The award field among `GET /users/v1/custom-fields` results, matched by name. */
export function findAwardField(raw: any[], name = AWARD_FIELD_NAME): any | undefined {
  const want = name.trim().toLowerCase();
  const field = raw.find((f) => String(f?.name ?? "").trim().toLowerCase() === want);
  if (field && field.type !== "dropdown") {
    throw new Error(`Connecteam field ${field.id} ("${field.name}") is type "${field.type}", not a dropdown - rename or delete it`);
  }
  return field;
}

const isAwardRule = (f: any) => f?.eh === "payRateTemplate";

export function withAwardRule<T>(map: T, fieldId: number): T {
  const out: any = structuredClone(map);
  out.fields = [
    ...(out.fields ?? []).filter((f: any) => !isAwardRule(f)),
    { eh: "payRateTemplate", from: { customFieldId: fieldId }, transform: "dropdownValue" },
  ];
  return out;
}

export function withoutAwardRule<T>(map: T): T {
  const out: any = structuredClone(map);
  out.fields = (out.fields ?? []).filter((f: any) => !isAwardRule(f));
  return out;
}
