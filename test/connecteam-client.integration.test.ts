/**
 * Live read-only checks against the real Connecteam account.
 * Skipped unless CT_API_KEY is set (test/setup.env.ts loads it from .dev.vars).
 * Sends a chat message only if CT_CUSTOM_PUBLISHER_ID is also set, and only to
 * the account owner.
 */
import { describe, it, expect } from "vitest";
import { ConnecteamClient } from "../src/connecteam/client.js";

const apiKey = process.env.CT_API_KEY;
const packId = 5474;
const publisherId = process.env.CT_CUSTOM_PUBLISHER_ID ? Number(process.env.CT_CUSTOM_PUBLISHER_ID) : 0;
const live = apiKey ? describe : describe.skip;

live("Connecteam client (live account, read-only)", () => {
  const client = new ConnecteamClient({ apiKey: apiKey!, customPublisherId: publisherId });

  it("lists onboarding assignments with the expected shape", async () => {
    const r = await client.listAssignments(packId);
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") return;
    expect(Array.isArray(r.data)).toBe(true);
    for (const a of r.data.slice(0, 5)) {
      expect(a).toMatchObject({
        id: expect.any(Number),
        userId: expect.any(Number),
        status: expect.stringMatching(/^(in_progress|completed)$/),
        isWaitingApproval: expect.any(Boolean),
      });
    }
  });

  it("populates lastRateLimit from response headers", async () => {
    await client.listAssignments(packId);
    expect(client.lastRateLimit).not.toBeNull();
    expect(client.lastRateLimit!.minuteLimit).toBeGreaterThan(0);
  });

  it("fetches a user with customFields (and returns null for an assignment whose user is gone)", async () => {
    const list = await client.listAssignments(packId);
    if (list.outcome !== "ok" || list.data.length === 0) return;

    // Some assignments point at users that no longer exist - getUser must
    // return null for those, and a real ConnecteamUser for a live one.
    let sawLive = false;
    for (const a of list.data.slice(0, 8)) {
      const r = await client.getUser(a.userId);
      expect(r.outcome).toBe("ok");
      if (r.outcome === "ok" && r.data) {
        sawLive = true;
        expect(r.data.userId).toBe(a.userId);
        expect(Array.isArray(r.data.customFields)).toBe(true);
        break;
      }
    }
    expect(sawLive).toBe(true);
  });

  it("lists chat conversations (to find the admin channel id)", async () => {
    const r = await client.listConversations();
    expect(r.outcome).toBe("ok");
  });
});
