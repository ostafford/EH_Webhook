/**
 * The wizard's pay-run picker (issue #62): turns choices made from the client's
 * live Employment Hero lists into `employmentHero` settings in the field map.
 *
 * EH validates the pay-run set all-or-nothing (`docs/eh-pay-defaults.md`): the
 * location axis (pay schedule + primary location + primary pay category) is
 * only useful alongside a rate source, so the three names are written together
 * with one - the award classification or each employee's Connecteam pay rate -
 * or not at all.
 */

export type RateSource = "award" | "connecteamPayRate" | "skip";

export interface PayRunChoice {
  paySchedule: { id: number | string; name: string };
  location: { id: number | string; name: string };
  primaryPayCategory: string;
  rateSource: RateSource;
}

/**
 * A business's pay categories include every award allowance, leave type and
 * sub-category (227 on the demo account). Only top-level primary hourly/annual
 * categories make sense as an employee's primary pay category.
 */
export function primaryPayCategoryOptions(raw: any[]): Array<{ name: string; note?: string }> {
  const byName = new Map<string, string[]>();
  for (const c of raw) {
    if (!c?.isPrimary || c.parentId != null || c.payCategoryType !== "Standard") continue;
    if (c.rateUnit === "Fixed" || /taken|clearing/i.test(String(c.name))) continue;
    const name = String(c.name ?? "").trim();
    if (!name) continue;
    const awards = byName.get(name) ?? [];
    if (c.awardName) awards.push(String(c.awardName));
    byName.set(name, awards);
  }
  return [...byName].map(([name, awards]) => (awards.length ? { name, note: awards.join("; ") } : { name }));
}

export function rateSourceOptions(map: any): Array<{ key: RateSource; label: string }> {
  const awardField = (map?.fields ?? []).find((f: any) => f?.eh === "payRateTemplate");
  return [
    ...(awardField
      ? [{ key: "award" as const, label: `Award classification, picked per employee in Connecteam (field ${awardField.from?.customFieldId})` }]
      : []),
    { key: "connecteamPayRate", label: "Each employee's pay rate in Connecteam" },
    { key: "skip", label: "Skip - payroll sets pay settings in Employment Hero by hand (leaves the field map as it is)" },
  ];
}

export function applyPayRunChoice<T>(map: T, choice: PayRunChoice): T {
  if (choice.rateSource === "skip") return map;

  const out: any = structuredClone(map);
  const eh = out.employmentHero;
  // The rate comes from the chosen source, never a flat company-wide value.
  const { rate: _rate, rateUnit: _rateUnit, payRateTemplate: _template, ...keep } = eh.defaults ?? {};

  eh.payScheduleId = String(choice.paySchedule.id);
  eh.locationId = String(choice.location.id);
  eh.defaults = {
    ...keep,
    paySchedule: choice.paySchedule.name,
    primaryLocation: choice.location.name,
    primaryPayCategory: choice.primaryPayCategory,
  };
  if (choice.rateSource === "award") {
    eh.payRateTemplate = { source: "connecteamField" };
    delete eh.perEmployeeRate;
  } else {
    eh.perEmployeeRate = { source: "connecteamPayRate" };
    delete eh.payRateTemplate;
  }
  return out;
}
