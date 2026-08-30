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

export interface RateLimit {
  minuteRemaining: number | null;
  minuteLimit: number | null;
  dayRemaining: number | null;
}

export type CtResult<T> =
  | { outcome: "ok"; data: T }
  | { outcome: "retryable"; status: number | null; detail: string }
  | { outcome: "error"; status: number; detail: string };
