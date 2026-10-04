import { describe, it, expect } from "vitest";
import {
  GENERIC_CORRECTION,
  correctionMessage,
  managerEscalationMessage,
  followUpNoticeMessage,
  systemAlertMessage,
  collisionAlertMessage,
} from "../src/sync/messages.js";
import { digestMessages } from "../src/status/digest.js";
import type { EhFieldError } from "../src/eh/errors.js";

describe("names Employment Hero, not 'payroll'", () => {
  // The details land in Employment Hero, and this integration only targets
  // it, so a message names it. "payroll admin" stays: that's a person's role.
  it("no message says 'payroll' except for the payroll admin role", () => {
    const ref = { ctUserId: 7, firstName: "Jane", lastName: "Smith" };
    const fields: EhFieldError[] = [{ field: "somethingUnheardOf", reason: "odd" }];
    const messages = [
      GENERIC_CORRECTION,
      correctionMessage(fields),
      managerEscalationMessage(fields, ref),
      followUpNoticeMessage([], ref),
      systemAlertMessage("detail", ref),
      collisionAlertMessage("555", ref, 9),
      ...digestMessages([{ ctUserId: 7, ehEmployeeId: "1", state: "waiting_on_admin", reasons: ["x"] }], 1),
    ];
    for (const text of messages) expect(text).not.toMatch(/payroll(?! admin)/i);
  });
});
