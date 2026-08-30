/**
 * Turns an Employment Hero Payroll 422 body into a flat list of
 * `{ field, reason }`. EH returns validation errors in a few shapes; we handle
 * all of them defensively.
 *
 * @todo #2 - confirm the exact 422 shape against the live API and tighten this.
 */
export interface EhFieldError {
  /** EH field name if EH named one, otherwise "(unknown)". */
  field: string;
  reason: string;
}

const NO_FIELD = "(unknown)";

export function parseValidationBody(body: unknown): EhFieldError[] {
  // Shape 1: ["message", "message"]
  if (Array.isArray(body)) {
    const errs = body
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((reason) => ({ field: NO_FIELD, reason: reason.trim() }));
    if (errs.length) return errs;
  }

  // Shape 2: { "FieldName": ["message", ...], "message": "..." }
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const out: EhFieldError[] = [];
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if ((key === "message" || key === "Message") && typeof value === "string") {
        out.push({ field: NO_FIELD, reason: value });
        continue;
      }
      const messages = Array.isArray(value) ? value : [value];
      for (const m of messages) {
        if (typeof m === "string" && m.trim() !== "") out.push({ field: key, reason: m.trim() });
      }
    }
    if (out.length) return out;
  }

  // Shape 3: a bare string
  if (typeof body === "string" && body.trim() !== "") {
    return [{ field: NO_FIELD, reason: body.trim() }];
  }

  return [{ field: NO_FIELD, reason: "Employment Hero rejected the record but gave no detail." }];
}
