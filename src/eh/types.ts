/**
 * The slice of Employment Hero's AU unstructured-employee model this integration
 * touches. Field names are the ones the mapping produces; several still carry
 * `@todo` markers in src/mapping/rules.ts pending live verification (issue #2).
 */
export type EhEmployeePayload = Record<string, string | number | boolean>;

export interface EhEmployee {
  id: number;
  externalId: string | null;
  firstName?: string;
  surname?: string;
  /** e.g. "Active", "Incomplete" - the EH-side completeness state. */
  status?: string;
  [key: string]: unknown;
}
