/**
 * Turns an Employment Hero Payroll error body into a flat list of
 * `{ field, reason }`.
 *
 * Confirmed against the live API (issue #2): validation failures come back as
 * HTTP 400 with `{ "message": "Field: reason\nField: reason" }` - one string,
 * newline-separated, each line usually prefixed `Field: `. The other shapes
 * below are kept as defensive fallbacks.
 */
export interface EhFieldError {
  /** EH field name if the line named one, otherwise "(unknown)". */
  field: string;
  reason: string;
}

const NO_FIELD = "(unknown)";
const LINE = /^([A-Za-z0-9_.\[\]]+):\s+(.*\S)\s*$/;

function fromMessageString(message: string): EhFieldError[] {
  const out: EhFieldError[] = [];
  for (const raw of message.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    out.push(m ? { field: m[1]!, reason: m[2]! } : { field: NO_FIELD, reason: line });
  }
  return out;
}

export function parseValidationBody(body: unknown): EhFieldError[] {
  // Primary: { message: "Field: reason\n..." } (also { Message: ... })
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    const message = typeof obj.message === "string" ? obj.message : typeof obj.Message === "string" ? obj.Message : null;
    if (message && message.trim() !== "") return fromMessageString(message);

    // Fallback: ModelState-style { FieldName: ["msg", ...] }
    const out: EhFieldError[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const messages = Array.isArray(value) ? value : [value];
      for (const m of messages) {
        if (typeof m === "string" && m.trim() !== "") out.push({ field: key, reason: m.trim() });
      }
    }
    if (out.length) return out;
  }

  // Fallback: ["msg", "msg"]
  if (Array.isArray(body)) {
    const errs = body
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((reason) => ({ field: NO_FIELD, reason: reason.trim() }));
    if (errs.length) return errs;
  }

  // Fallback: bare string
  if (typeof body === "string" && body.trim() !== "") {
    return fromMessageString(body);
  }

  return [{ field: NO_FIELD, reason: "Employment Hero rejected the record but gave no detail." }];
}
