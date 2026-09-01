/**
 * Schema for a client's `field-map.json` - the per-client artifact that says
 * which Connecteam field feeds each Employment Hero Payroll field and how to
 * transform it. Validated once at Worker start-up; a bad map fails fast.
 */
import { z } from "zod";

const source = z.union([
  z.object({ customFieldId: z.number().int().positive() }).strict(),
  z
    .object({
      userField: z.enum(["firstName", "lastName", "email", "phoneNumber", "userId"]),
    })
    .strict(),
]);

const transform = z.enum([
  "trimString",
  "lowerTrim",
  "dateDmyToIso",
  "dropdownValue",
  "phoneAu",
  "locationFull",
  "locationStreetLine",
  "digits",
  "zeroPad4",
  "zeroPad6",
]);

export const fieldRule = z
  .object({
    /** Target field name on the Employment Hero unstructured employee model. */
    eh: z.string().min(1),
    from: source,
    transform,
    /** When true, a missing/blank source value is a mapping issue, not a skip. */
    required: z.boolean().default(false),
    /** Optional value lookup applied after `transform` (e.g. dropdown -> EH enum). */
    map: z.record(z.string()).optional(),
    /** Used verbatim when the source value is absent. Skips `transform`. */
    default: z.string().optional(),
    /** Marks TFN / bank values - never logged, never read back. */
    sensitive: z.boolean().default(false),
  })
  .strict();

const yesNoSource = z.object({ customFieldId: z.number().int().positive() }).strict();

export const rules = z
  .object({
    /** Connecteam Yes/No dropdowns that feed the EH tax file declaration. */
    taxDeclaration: z
      .object({
        claimTaxFreeThreshold: yesNoSource,
        australianResident: yesNoSource,
        hasHelpOrStslDebt: yesNoSource,
      })
      .strict()
      .optional(),
    /** Connecteam custom fields holding super fund details (APRA or SMSF). */
    super: z
      .object({
        usiField: z.number().int().positive(),
        abnField: z.number().int().positive(),
        fundNameField: z.number().int().positive(),
        memberNumberField: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /** Fixed values folded verbatim into every payload. */
    constants: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

export const fieldMap = z
  .object({
    client: z.string().min(1),
    connecteam: z.object({ onboardingPackId: z.number().int().positive() }).strict(),
    employmentHero: z
      .object({
        businessId: z.string().min(1),
        payScheduleId: z.string().min(1),
        locationId: z.string().min(1),
        /**
         * Company-wide pay-run defaults, stamped on every payload beside the
         * structural values (issue #26). Fully opt-in: omit the block and
         * nothing changes. Field names verified against the live unstructured
         * endpoint (`docs/eh-pay-defaults.md`): EH takes the pay category /
         * award by NAME, and validates the pay-run set all-or-nothing - a
         * partial set is a 400, so set every field or none.
         */
        defaults: z
          .object({
            /** Award name/id (validated against the business). */
            awardId: z.union([z.string().min(1), z.number()]).optional(),
            /** Primary pay category, by NAME (e.g. "Permanent Ordinary Hours"). */
            primaryPayCategory: z.string().min(1).optional(),
            rate: z.number().nonnegative().optional(),
            /** e.g. "Hourly", "Annually". */
            rateUnit: z.string().min(1).optional(),
            hoursPerWeek: z.number().positive().optional(),
            hoursPerDay: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    identity: z
      .object({
        externalIdFrom: z.literal("userId").default("userId"),
        emailFallbackFrom: z.literal("email").default("email"),
      })
      .strict()
      .default({ externalIdFrom: "userId", emailFallbackFrom: "email" }),
    fields: z.array(fieldRule).min(1),
    rules: rules.optional(),
  })
  .strict();

export type FieldMap = z.infer<typeof fieldMap>;
export type FieldRule = z.infer<typeof fieldRule>;
export type Rules = z.infer<typeof rules>;
export type TransformName = z.infer<typeof transform>;

export function parseFieldMap(json: unknown): FieldMap {
  const result = fieldMap.safeParse(json);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`Invalid field-map:\n${lines.join("\n")}`);
  }
  return result.data;
}
