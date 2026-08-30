import { loadFieldMap } from "./mapping/loader.js";

/** The bits of the Worker env that /health inspects. The real Env satisfies this. */
export interface HealthEnv {
  DB: { prepare(query: string): { first(): Promise<unknown> } };
  FIELD_MAP_CLIENT: string;
  EH_BUSINESS_ID: string;
  EH_PAY_SCHEDULE_ID: string;
  EH_LOCATION_ID: string;
}

export interface Health {
  ok: boolean;
  service: "eh-webhook";
  time: string;
  d1: "ok" | "error";
  /** "ok", or the reason the client's field-map failed to load. */
  fieldMap: string;
  config: {
    fieldMapClient: string;
    businessConfigured: boolean;
  };
}

export async function buildHealth(env: HealthEnv): Promise<Health> {
  let d1: Health["d1"] = "error";
  try {
    await env.DB.prepare("SELECT 1").first();
    d1 = "ok";
  } catch {
    d1 = "error";
  }

  let fieldMap = "ok";
  try {
    loadFieldMap(env.FIELD_MAP_CLIENT);
  } catch (err) {
    fieldMap = err instanceof Error ? err.message : "invalid field-map";
  }

  return {
    ok: d1 === "ok" && fieldMap === "ok",
    service: "eh-webhook",
    time: new Date().toISOString(),
    d1,
    fieldMap,
    config: {
      fieldMapClient: env.FIELD_MAP_CLIENT,
      businessConfigured: Boolean(
        env.EH_BUSINESS_ID && env.EH_PAY_SCHEDULE_ID && env.EH_LOCATION_ID,
      ),
    },
  };
}
