import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFieldMap } from "../src/mapping/schema.js";
import type { ConnecteamUser } from "../src/mapping/apply.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";
import {
  runSyncJob,
  dispatchBatch,
  handleDeadLetter,
  type SyncDeps,
} from "../src/sync/consumer.js";
import type { SyncJob } from "../src/sync/job.js";
import type { EmployeeLink, EmployeeLinkPatch, SyncGateway, SyncLogEntry } from "../src/sync/gateway.js";

const fieldMap = parseFieldMap(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../clients/_example/field-map.json", import.meta.url)), "utf8"),
  ),
);

const cloneUser = (): ConnecteamUser => structuredClone(syntheticUser);

// --- fakes -----------------------------------------------------------------

function fakeGateway(seed: Partial<EmployeeLink> = {}): SyncGateway & {
  rows: Map<number, EmployeeLink>;
  log: SyncLogEntry[];
  counters: Map<string, number>;
} {
  const rows = new Map<number, EmployeeLink>();
  if (seed.ctUserId !== undefined) {
    rows.set(seed.ctUserId, {
      ctUserId: seed.ctUserId,
      ehEmployeeId: seed.ehEmployeeId ?? null,
      lastSyncedTs: seed.lastSyncedTs ?? null,
      failureCycleCount: seed.failureCycleCount ?? 0,
      lastPayloadHash: seed.lastPayloadHash ?? null,
    });
  }
  const log: SyncLogEntry[] = [];
  const counters = new Map<string, number>();
  return {
    rows,
    log,
    counters,
    async bumpCounter(key: string, delta: number) {
      counters.set(key, (counters.get(key) ?? 0) + delta);
    },
    async getEmployeeLink(id) {
      return rows.get(id) ?? null;
    },
    async saveEmployeeLink(patch: EmployeeLinkPatch) {
      const prev = rows.get(patch.ctUserId);
      rows.set(patch.ctUserId, {
        ctUserId: patch.ctUserId,
        ehEmployeeId: patch.ehEmployeeId,
        lastSyncedTs: patch.lastSyncedTs,
        lastPayloadHash: patch.lastPayloadHash,
        failureCycleCount: prev?.failureCycleCount ?? 0,
      });
    },
    async getFailureCount(id) {
      return rows.get(id)?.failureCycleCount ?? 0;
    },
    async setFailureCount(id, count) {
      const prev = rows.get(id);
      rows.set(id, {
        ctUserId: id,
        ehEmployeeId: prev?.ehEmployeeId ?? null,
        lastSyncedTs: prev?.lastSyncedTs ?? null,
        lastPayloadHash: prev?.lastPayloadHash ?? null,
        failureCycleCount: count,
      });
    },
    async appendSyncLog(entry) {
      log.push(entry);
    },
  };
}

interface EhStub {
  write?: unknown;
  /** Fields to override on the echoed read-back record (e.g. simulate a value that did not persist). */
  readBackOverrides?: Record<string, unknown>;
  id?: number;
  status?: string;
  detailedStatus?: string | null;
  created?: boolean;
}

type CtFake = SyncDeps["ct"] & { dms: Array<{ userId: number; text: string }>; channels: Array<{ id: string; text: string }> };
type EhFake = SyncDeps["eh"] & { upserts: Array<{ externalId: string; payload: Record<string, unknown> }> };

function fakeCt(user: ConnecteamUser | null, userOutcome: "ok" | "retryable" | "error" = "ok"): CtFake {
  const dms: Array<{ userId: number; text: string }> = [];
  const channels: Array<{ id: string; text: string }> = [];
  return {
    dms,
    channels,
    async getUser() {
      if (userOutcome === "retryable") return { outcome: "retryable", status: 503, detail: "down" };
      if (userOutcome === "error") return { outcome: "error", status: 500, detail: "bad" };
      return { outcome: "ok", data: user };
    },
    async sendDirectMessage(userId: number, text: string) {
      dms.push({ userId, text });
      return { outcome: "ok", data: null };
    },
    async sendChannelMessage(id: string, text: string) {
      channels.push({ id, text });
      return { outcome: "ok", data: null };
    },
  } as unknown as CtFake;
}

function fakeEh(stub: EhStub = {}): EhFake {
  let last: Record<string, unknown> = {};
  const upserts: Array<{ externalId: string; payload: Record<string, unknown> }> = [];
  return {
    upserts,
    async upsertByExternalId(externalId: string, payload: Record<string, unknown>) {
      upserts.push({ externalId, payload });
      last = payload;
      if (stub.write) return stub.write;
      return {
        outcome: "ok",
        data: {
          id: stub.id ?? 987,
          status: stub.status ?? "Active",
          detailedStatus: stub.detailedStatus ?? null,
          operationType: "Update",
          created: stub.created ?? false,
        },
      };
    },
    async getByExternalId(externalId: string) {
      return {
        outcome: "ok",
        data: {
          id: stub.id ?? 987,
          externalId,
          status: stub.status ?? "Active",
          ...last,
          ...(stub.readBackOverrides ?? {}),
        },
      };
    },
  } as unknown as EhFake;
}

function deps(over: Partial<SyncDeps> & { now?: () => number } = {}): SyncDeps {
  return {
    ct: (over.ct ?? fakeCt(cloneUser())) as unknown as SyncDeps["ct"],
    eh: (over.eh ?? fakeEh()) as unknown as SyncDeps["eh"],
    store: over.store ?? fakeGateway(),
    fieldMap,
    adminChannelId: "chan-1",
    now: over.now ?? (() => 1_000_000),
  };
}

const job = (over: Partial<SyncJob> = {}): SyncJob => ({
  reason: "approval",
  ctUserId: 17760356,
  eventTimestamp: 1000,
  ...over,
});

// --- tests ---------------------------------------------------------------

describe("runSyncJob - first sync", () => {
  it("creates the Employment Hero record and links it in the store", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555, created: true });
    const d = deps({ store, eh });

    const out = await runSyncJob(job(), d);

    expect(out.status).toBe("synced");
    expect(out.ehEmployeeId).toBe("555");
    expect(eh.upserts).toHaveLength(1);
    expect(eh.upserts[0]!.externalId).toBe("17760356");

    const row = store.rows.get(17760356)!;
    expect(row.ehEmployeeId).toBe("555");
    expect(row.lastSyncedTs).toBe(1000);
    expect(row.lastPayloadHash).toBeTruthy();
    expect(store.log.at(-1)).toMatchObject({ ctUserId: 17760356, outcome: "ok" });
  });
});

describe("runSyncJob - ordering and idempotency", () => {
  it("skips an event no newer than the last synced one", async () => {
    const store = fakeGateway({ ctUserId: 17760356, lastSyncedTs: 5000, ehEmployeeId: "9" });
    const eh = fakeEh();
    const out = await runSyncJob(job({ eventTimestamp: 5000 }), deps({ store, eh }));
    expect(out).toMatchObject({ status: "skipped" });
    expect(eh.upserts).toHaveLength(0);
  });

  it("processes a newer event for the same user, updating the same record", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555 });
    const d = deps({ store, eh });

    await runSyncJob(job({ eventTimestamp: 1000 }), d);
    const out = await runSyncJob(job({ eventTimestamp: 2000, reason: "profile_update" }), { ...d, ct: fakeCt(cloneUser()) as never });

    // Second run: payload unchanged -> no second write, still a no-op skip.
    expect(out).toMatchObject({ status: "skipped", reason: "identical to the last processed state" });
    expect(eh.upserts).toHaveLength(1);
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(1000);
  });

  it("re-syncs when the mapped payload actually changed", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555 });

    await runSyncJob(job({ eventTimestamp: 1000 }), deps({ store, eh, ct: fakeCt(cloneUser()) as never }));

    const edited = cloneUser();
    edited.customFields.find((f) => f.customFieldId === 25145108)!.value = "Senior Support Officer";
    const out = await runSyncJob(
      job({ eventTimestamp: 2000 }),
      deps({ store, eh, ct: fakeCt(edited) as never }),
    );

    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(2);
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(2000);
  });
});

describe("runSyncJob - correction path", () => {
  it("an Employment Hero 400 validation failure DMs the employee and logs a correction", async () => {
    const store = fakeGateway();
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({
      write: {
        outcome: "validation",
        status: 400,
        issues: [{ field: "BankAccount1", reason: "BSB must contain 6 digits only" }],
      },
    });

    const out = await runSyncJob(job(), deps({ store, eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(ct.dms).toHaveLength(1);
    expect(ct.dms[0]!.userId).toBe(17760356);
    expect(ct.dms[0]!.text).toMatch(/BSB/);
    expect(store.log.at(-1)).toMatchObject({ outcome: "correction" });
    // The attempt's hash is stored (clean or not) so a byte-identical
    // re-delivery is skipped; a real edit changes the payload and re-tries.
    expect(store.rows.get(17760356)!.lastPayloadHash).toEqual(expect.any(String));
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(1000);
  });

  it("a mapping issue corrects the employee without calling Employment Hero", async () => {
    const bad = cloneUser();
    bad.customFields.find((f) => f.customFieldId === 25145118)!.value = "not-a-date";
    const ct = fakeCt(bad);
    const eh = fakeEh();

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(eh.upserts).toHaveLength(0);
    expect(ct.dms[0]!.text).toMatch(/date of birth/i);
  });

  it("a record that stays Incomplete after a 200 write triggers a correction", async () => {
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({ status: "Incomplete", detailedStatus: "Tax Details are incomplete" });

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(ct.dms[0]!.text).toMatch(/tax declaration/i);
  });

  it("the third consecutive failure also DMs the direct manager", async () => {
    const user = cloneUser();
    user.customFields.push({ customFieldId: 25145114, type: "directManager", name: "Direct manager", value: 999001 });
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 2 });
    const ct = fakeCt(user);
    const eh = fakeEh({
      write: { outcome: "validation", status: 400, issues: [{ field: "taxFileNumber", reason: "invalid" }] },
    });

    const out = await runSyncJob(job(), deps({ store, eh, ct: ct as never }));

    expect(out.managerNotified).toBe(true);
    expect(ct.dms.map((d) => d.userId).sort()).toEqual([17760356, 999001]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(3);
  });

  it("a clean sync after failures resets the failure count", async () => {
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 2 });
    const out = await runSyncJob(job(), deps({ store, ct: fakeCt(cloneUser()) as never }));
    expect(out.status).toBe("synced");
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(0);
  });
});

describe("runSyncJob - follow-up path", () => {
  it("a non-resident result posts to the admin channel and still completes the sync", async () => {
    const user = cloneUser();
    user.customFields.find((f) => f.customFieldId === 42923315)!.value = [{ id: 1, value: "No" }]; // non-resident
    user.customFields.find((f) => f.customFieldId === 42923276)!.value = [{ id: 1, value: "No" }]; // consistent: no TFT
    const ct = fakeCt(user);
    const store = fakeGateway();

    const out = await runSyncJob(job(), deps({ store, ct: ct as never }));

    expect(out.status).toBe("follow_up");
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.id).toBe("chan-1");
    expect(ct.channels[0]!.text).toMatch(/follow-up/i);
    expect(store.log.at(-1)).toMatchObject({ outcome: "follow_up" });
    expect(store.rows.get(17760356)!.lastPayloadHash).toBeTruthy();
  });
});

describe("runSyncJob - read-back mismatch", () => {
  it("a non-sensitive field that did not persist triggers a correction", async () => {
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({ readBackOverrides: { residentialSuburb: "SomewhereElse" } });

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(ct.dms[0]!.text).toMatch(/address/i);
  });

  it("ignores a reformatted date on read-back (not a real mismatch)", async () => {
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({ readBackOverrides: { startDate: "2026-09-01T00:00:00", dateOfBirth: "1992-04-07T00:00:00" } });

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("synced");
    expect(ct.dms).toHaveLength(0);
  });
});

describe("runSyncJob - retryable faults", () => {
  it("an Employment Hero outage returns retry and writes nothing", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ write: { outcome: "retryable", status: 503, detail: "service unavailable" } });

    const out = await runSyncJob(job(), deps({ store, eh, ct: fakeCt(cloneUser()) as never }));

    expect(out.status).toBe("retry");
    expect(store.rows.size).toBe(0);
    expect(store.log).toHaveLength(0);
  });

  it("a Connecteam outage returns retry", async () => {
    const out = await runSyncJob(job(), deps({ ct: fakeCt(null, "retryable") as never }));
    expect(out.status).toBe("retry");
  });

  it("a Connecteam user that no longer exists is skipped, not retried", async () => {
    const out = await runSyncJob(job(), deps({ ct: fakeCt(null, "ok") as never }));
    expect(out).toMatchObject({ status: "skipped", reason: "connecteam user no longer exists" });
  });
});

describe("dispatchBatch", () => {
  const mkMsg = (body: SyncJob) => {
    const calls: string[] = [];
    return {
      body,
      ack: () => calls.push("ack"),
      retry: () => calls.push("retry"),
      calls,
    };
  };

  it("acks a synced message and retries a retryable one", async () => {
    const good = mkMsg(job({ ctUserId: 1 }));
    const bad = mkMsg(job({ ctUserId: 2 }));
    const d = deps({
      ct: {
        async getUser(id: number) {
          return id === 2 ? { outcome: "retryable", status: 503, detail: "x" } : { outcome: "ok", data: cloneUser() };
        },
        async sendDirectMessage() {
          return { outcome: "ok", data: null };
        },
        async sendChannelMessage() {
          return { outcome: "ok", data: null };
        },
      } as never,
    });

    await dispatchBatch({ queue: "eh-webhook-sync", messages: [good, bad] }, d, "eh-webhook-dlq");

    expect(good.calls).toEqual(["ack"]);
    expect(bad.calls).toEqual(["retry"]);
  });

  it("coalesces a burst for one user - runs only the newest, acks the rest", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555, created: true });
    const older1 = mkMsg(job({ ctUserId: 17760356, eventTimestamp: 1000 }));
    const older2 = mkMsg(job({ ctUserId: 17760356, eventTimestamp: 1500 }));
    const newest = mkMsg(job({ ctUserId: 17760356, eventTimestamp: 2000 }));

    await dispatchBatch(
      { queue: "eh-webhook-sync", messages: [older1, newest, older2] },
      deps({ store, eh }),
      "eh-webhook-dlq",
    );

    expect(eh.upserts).toHaveLength(1);
    expect(store.log).toHaveLength(1);
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(2000);
    expect(older1.calls).toEqual(["ack"]);
    expect(older2.calls).toEqual(["ack"]);
    expect(newest.calls).toEqual(["ack"]);
  });

  it("does not coalesce across different users", async () => {
    const store = fakeGateway();
    const a = mkMsg(job({ ctUserId: 1, eventTimestamp: 1000 }));
    const b = mkMsg(job({ ctUserId: 2, eventTimestamp: 1000 }));

    await dispatchBatch(
      { queue: "eh-webhook-sync", messages: [a, b] },
      deps({ store, ct: fakeCt(cloneUser()) as never }),
      "eh-webhook-dlq",
    );

    expect(a.calls).toEqual(["ack"]);
    expect(b.calls).toEqual(["ack"]);
    expect(store.log).toHaveLength(2);
  });

  it("routes a dead-letter batch to the system-alert handler and always acks", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    const msg = mkMsg(job());
    await dispatchBatch(
      { queue: "eh-webhook-dlq", messages: [msg] },
      deps({ ct: ct as never, store }),
      "eh-webhook-dlq",
    );
    expect(msg.calls).toEqual(["ack"]);
    expect(ct.channels[0]!.text).toMatch(/could not be retried/i);
    expect(store.log.at(-1)).toMatchObject({ outcome: "dead_letter" });
  });
});

describe("handleDeadLetter", () => {
  it("posts a system alert naming the user and logs dead_letter", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    await handleDeadLetter(job({ ctUserId: 42 }), {
      ct: ct as never,
      store,
      adminChannelId: "chan-1",
      now: () => 5,
    });
    expect(ct.channels[0]!.id).toBe("chan-1");
    expect(ct.channels[0]!.text).toContain("42");
    expect(store.log[0]).toMatchObject({ ctUserId: 42, at: 5, outcome: "dead_letter" });
  });

  it("also notifies the integrator when onSystemAlert is provided", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    const alerts: Array<{ ctUserId: number; reason: string }> = [];
    await handleDeadLetter(job({ ctUserId: 7, reason: "profile_update" }), {
      ct: ct as never,
      store,
      adminChannelId: "chan-1",
      now: () => 5,
      onSystemAlert: async (info) => {
        alerts.push(info);
      },
    });
    expect(alerts).toEqual([{ ctUserId: 7, reason: "retries exhausted (profile_update)" }]);
  });

  it("works without onSystemAlert (integrator telemetry off)", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    await expect(
      handleDeadLetter(job({ ctUserId: 8 }), { ct: ct as never, store, adminChannelId: "c", now: () => 1 }),
    ).resolves.toBeUndefined();
  });
});
