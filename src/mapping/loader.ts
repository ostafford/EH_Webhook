/**
 * Resolves this deployment's field-map and validates it. One repo clone serves
 * one client (`clients/self/`); `FIELD_MAP_CLIENT` only needs setting for a
 * multi-tenant deployment. A missing or invalid map throws - the first request
 * (and `/health`) surfaces it rather than the Worker running with a broken config.
 */
import { parseFieldMap, type FieldMap } from "./schema.js";
import { FIELD_MAPS, DEFAULT_CLIENT } from "./registry.js";

export class FieldMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldMapError";
  }
}

let cache: { client: string; map: FieldMap } | null = null;

/**
 * Resolve the field-map for this deployment. With no argument (or a blank
 * `FIELD_MAP_CLIENT`) it loads `clients/self/` - the single-client default.
 */
export function loadFieldMap(client?: string | null): FieldMap {
  const key = client && client.trim() !== "" ? client.trim() : DEFAULT_CLIENT;
  if (cache?.client === key) return cache.map;

  const raw = FIELD_MAPS[key];
  if (raw === undefined) {
    throw new FieldMapError(
      `No field-map bundled for FIELD_MAP_CLIENT="${key}". ` +
        `Add clients/${key}/field-map.json and register it in src/mapping/registry.ts. ` +
        `Bundled clients: ${Object.keys(FIELD_MAPS).join(", ") || "(none)"}.`,
    );
  }

  let map: FieldMap;
  try {
    map = parseFieldMap(raw);
  } catch (err) {
    throw new FieldMapError(
      `Field-map for "${key}" is invalid. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cache = { client: key, map };
  return map;
}

/** Test-only: drop the memoised map. */
export function resetFieldMapCache(): void {
  cache = null;
}
