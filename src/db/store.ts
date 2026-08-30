/**
 * Drizzle-backed {@link SyncGateway} over the D1 database. The only place the
 * Worker talks SQL. Compiled into the Worker bundle, not the node test project -
 * unit tests use a fake gateway instead.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { employeeMap, onboardingState, syncLog } from "./schema.js";
import type {
  EmployeeLink,
  EmployeeLinkPatch,
  SyncGateway,
  SyncLogEntry,
} from "../sync/gateway.js";
import type { OnboardingStateRow } from "../cron/sweep.js";
import type { OnboardingAssignment } from "../connecteam/types.js";

export class SyncStore implements SyncGateway {
  readonly #db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.#db = drizzle(d1);
  }

  async getEmployeeLink(ctUserId: number): Promise<EmployeeLink | null> {
    const [row] = await this.#db
      .select()
      .from(employeeMap)
      .where(eq(employeeMap.ctUserId, ctUserId))
      .limit(1);
    if (!row) return null;
    return {
      ctUserId: row.ctUserId,
      ehEmployeeId: row.ehEmployeeId,
      lastSyncedTs: row.lastSyncedTs,
      failureCycleCount: row.failureCycleCount,
      lastPayloadHash: row.lastPayloadHash,
    };
  }

  async saveEmployeeLink(patch: EmployeeLinkPatch): Promise<void> {
    const now = Date.now();
    await this.#db
      .insert(employeeMap)
      .values({
        ctUserId: patch.ctUserId,
        ehEmployeeId: patch.ehEmployeeId,
        lastSyncedTs: patch.lastSyncedTs,
        lastPayloadHash: patch.lastPayloadHash,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: employeeMap.ctUserId,
        set: {
          ehEmployeeId: patch.ehEmployeeId,
          lastSyncedTs: patch.lastSyncedTs,
          lastPayloadHash: patch.lastPayloadHash,
          updatedAt: now,
        },
      });
  }

  async getFailureCount(ctUserId: number): Promise<number> {
    const [row] = await this.#db
      .select({ n: employeeMap.failureCycleCount })
      .from(employeeMap)
      .where(eq(employeeMap.ctUserId, ctUserId))
      .limit(1);
    return row?.n ?? 0;
  }

  async setFailureCount(ctUserId: number, count: number): Promise<void> {
    const now = Date.now();
    await this.#db
      .insert(employeeMap)
      .values({ ctUserId, failureCycleCount: count, updatedAt: now })
      .onConflictDoUpdate({
        target: employeeMap.ctUserId,
        set: { failureCycleCount: count, updatedAt: now },
      });
  }

  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    await this.#db.insert(syncLog).values({
      ctUserId: entry.ctUserId,
      at: entry.at,
      outcome: entry.outcome,
      detail: entry.detail,
    });
  }

  // --- cron approval sweep (issue #7) ---

  async readOnboardingState(): Promise<OnboardingStateRow[]> {
    const rows = await this.#db.select().from(onboardingState);
    return rows.map((r) => ({
      assignmentId: r.assignmentId,
      ctUserId: r.ctUserId,
      status: r.status,
      isWaitingApproval: r.isWaitingApproval,
    }));
  }

  async writeOnboardingState(
    assignments: readonly OnboardingAssignment[],
    seenAt: number,
  ): Promise<void> {
    for (const a of assignments) {
      await this.#db
        .insert(onboardingState)
        .values({
          assignmentId: a.id,
          ctUserId: a.userId,
          status: a.status,
          isWaitingApproval: a.isWaitingApproval,
          seenAt,
        })
        .onConflictDoUpdate({
          target: onboardingState.assignmentId,
          set: {
            ctUserId: a.userId,
            status: a.status,
            isWaitingApproval: a.isWaitingApproval,
            seenAt,
          },
        });
    }
  }
}
