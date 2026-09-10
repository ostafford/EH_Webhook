/** Shapes returned by the Connecteam API endpoints this integration uses. */

export interface OnboardingAssignment {
  id: number;
  userId: number;
  status: "in_progress" | "completed";
  isWaitingApproval: boolean;
}

export interface ConnecteamCustomFieldValue {
  customFieldId: number;
  value: unknown;
  type: string;
  name: string;
}

export interface ConnecteamUser {
  userId: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  userType?: string;
  isArchived?: boolean;
  modifiedAt?: number;
  customFields: ConnecteamCustomFieldValue[];
}

export interface Conversation {
  id: string;
  title: string;
  type: string;
}

/**
 * One user's pay rate from `GET /pay-rates/v1/pay-rates` (issue #42). The API
 * returns a single effective `payRate` per user for the requested date window.
 * `resourcesRates` holds per-resource overrides - not mappable to EH's single
 * `rate`, so the sync ignores them and only logs that they exist.
 */
export interface PayRate {
  effectiveDate?: string;
  /** "hourly" | "monthly" | "yearly" (only hourly / yearly map to EH so far). */
  rateType: string;
  defaultRate: number;
  isDefaultRateEnabled: boolean;
  resourcesRates?: unknown[];
}

export interface RateLimit {
  minuteRemaining: number | null;
  minuteLimit: number | null;
  dayRemaining: number | null;
}

export type CtResult<T> =
  | { outcome: "ok"; data: T }
  | { outcome: "retryable"; status: number | null; detail: string }
  | { outcome: "error"; status: number; detail: string };
