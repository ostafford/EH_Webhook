/**
 * The slice of Employment Hero's AU unstructured-employee model this integration
 * touches. Field names confirmed against the live API in issue #2.
 */
export type EhEmployeePayload = Record<string, string | number | boolean>;

/** Full employee record, as returned by GET .../employee/unstructured/externalid/{id}. */
export interface EhEmployee {
  id: number;
  externalId: string | null;
  firstName?: string;
  surname?: string;
  /** "Active" | "Incomplete" - the EH-side completeness state. */
  status?: string;
  [key: string]: unknown;
}

/**
 * What a create/update returns - an outcome envelope, NOT the employee.
 * POST create -> 201, PUT update -> 200, both with this shape.
 */
export interface EhWriteResult {
  id: number;
  status: string | null;
  /** Human explanation when the record is Incomplete (e.g. "Basic Details are incomplete"). */
  detailedStatus: string | null;
  operationType: string | null;
  /** true if we created (POST), false if we updated (PUT). */
  created: boolean;
}
