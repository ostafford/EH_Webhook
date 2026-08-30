/**
 * Resolves the field-map for the client this deployment serves, chosen by the
 * `FIELD_MAP_CLIENT` var, and validates it. A missing or invalid map throws -
 * the first request (and `/health`) surfaces it rather than the Worker running
 * with a broken config.
 */
import { parseFieldMap, type FieldMap } from "./schema.js";
import { FIELD_MAPS } from "./registry.js";

export class FieldMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldMapError";
  }
}

let cache: { client: string; map: FieldMap } | null = null;

export function loadFieldMap(client: string): FieldMap {
  if (cache?.client === client) return cache.map;

  const raw = FIELD_MAPS[client];
  if (raw === undefined) {
    throw new FieldMapError(
      `No field-map bundled for FIELD_MAP_CLIENT="${client}". ` +
        `Add clients/${client}/field-map.json and register it in src/mapping/registry.ts. ` +
        `Bundled clients: ${Object.keys(FIELD_MAPS).join(", ") || "(none)"}.`,
    );
  }

  let map: FieldMap;
  try {
    map = parseFieldMap(raw);
  } catch (err) {
    throw new FieldMapError(
      `Field-map for "${client}" is invalid. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cache = { client, map };
  return map;
}

/** Test-only: drop the memoised map. */
export function resetFieldMapCache(): void {
  cache = null;
}
