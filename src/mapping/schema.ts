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

export const fieldMap = z
  .object({
    client: z.string().min(1),
    connecteam: z.object({ onboardingPackId: z.number().int().positive() }).strict(),
    employmentHero: z
      .object({
        businessId: z.string().min(1),
        payScheduleId: z.string().min(1),
        locationId: z.string().min(1),
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
  })
  .strict();

export type FieldMap = z.infer<typeof fieldMap>;
export type FieldRule = z.infer<typeof fieldRule>;
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
