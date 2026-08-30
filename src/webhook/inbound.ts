/**
 * Inbound `user_updated` webhook handling (issue #8). Connecteam calls the
 * Worker whenever a user's profile changes; the Worker verifies the HMAC, pulls
 * the user id out of the payload and hands back a `profile_update` sync job for
 * the caller to enqueue. Verification and parsing are pure - the Hono route
 * (src/index.ts) does the actual `SYNC_QUEUE.send`.
 *
 * The exact payload shape is not published by Connecteam. {@link parseUserEdit}
 * therefore probes the handful of plausible locations for the user id and the
 * event time; confirm against a real delivery when the webhook is first
 * registered (docs/PLAN.md runbook step 8) and tighten if needed.
 */
import { verifyWebhookSignature, DEFAULT_SCHEME, type SignatureScheme } from "../connecteam/signature.js";
import type { SyncJob } from "../sync/job.js";

export interface WebhookInput {
  rawBody: string;
  signatureHeader: string | null | undefined;
  secret: string;
  scheme?: SignatureScheme;
  now?: () => number;
}

export interface WebhookOutcome {
  /** HTTP status the route should return. */
  status: number;
  body: { ok: true } | { error: string };
  /** Present only when the delivery was accepted - the caller enqueues it. */
  job?: SyncJob;
}

const ACCEPTED = 202;

export async function handleWebhook(input: WebhookInput): Promise<WebhookOutcome> {
  const now = input.now ?? Date.now;

  if (!input.secret) {
    return { status: 500, body: { error: "webhook secret not configured" } };
  }

  const ok = await verifyWebhookSignature(
    input.rawBody,
    input.signatureHeader ?? null,
    input.secret,
    input.scheme ?? DEFAULT_SCHEME,
  );
  if (!ok) return { status: 401, body: { error: "invalid or missing signature" } };

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "malformed JSON body" } };
  }

  const edit = parseUserEdit(payload, now());
  if (edit === null) {
    return { status: 400, body: { error: "no user id in payload" } };
  }

  return {
    status: ACCEPTED,
    body: { ok: true },
    job: { reason: "profile_update", ctUserId: edit.ctUserId, eventTimestamp: edit.eventTimestamp },
  };
}

export interface ParsedEdit {
  ctUserId: number;
  eventTimestamp: number;
}

/** Pull the user id + event time out of a webhook payload of unknown shape. */
export function parseUserEdit(payload: unknown, now: number): ParsedEdit | null {
  if (payload === null || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const data = asObject(o.data);
  const user = asObject(o.user) ?? asObject(data?.user);

  const ctUserId = firstId([
    data?.userId,
    data?.id,
    o.userId,
    o.id,
    user?.userId,
    user?.id,
  ]);
  if (ctUserId === null) return null;

  const rawTs = firstId([
    o.timestamp,
    o.eventTimestamp,
    o.createdAt,
    data?.modifiedAt,
    data?.updatedAt,
    data?.timestamp,
  ]);
  const eventTimestamp = rawTs === null ? now : toEpochMs(rawTs);

  return { ctUserId, eventTimestamp };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** First candidate that is a positive integer (or a string of one). */
function firstId(candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return Math.trunc(c);
    if (typeof c === "string" && /^\d+$/.test(c.trim())) {
      const n = Number(c.trim());
      if (n > 0) return n;
    }
  }
  return null;
}

/** Connecteam mixes epoch-seconds and epoch-millis; normalise to millis. */
function toEpochMs(n: number): number {
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}
