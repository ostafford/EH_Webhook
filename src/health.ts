import type { Env } from "./env.js";

export interface Health {
  ok: boolean;
  service: "eh-webhook";
  time: string;
  d1: "ok" | "error";
  config: {
    fieldMapClient: string;
    businessConfigured: boolean;
  };
}

/** Cheap liveness + config snapshot. Touches D1 with a trivial query. */
export async function buildHealth(env: Env): Promise<Health> {
  let d1: Health["d1"] = "error";
  try {
    await env.DB.prepare("SELECT 1").first();
    d1 = "ok";
  } catch {
    d1 = "error";
  }

  return {
    ok: d1 === "ok",
    service: "eh-webhook",
    time: new Date().toISOString(),
    d1,
    config: {
      fieldMapClient: env.FIELD_MAP_CLIENT,
      businessConfigured: Boolean(
        env.EH_BUSINESS_ID && env.EH_PAY_SCHEDULE_ID && env.EH_LOCATION_ID,
      ),
    },
  };
}
