/**
 * Every client's field-map, bundled into the Worker. Workers have no filesystem
 * at runtime, so each map is a static import and ends up in the deploy bundle.
 *
 * ADD A CLIENT:
 *   1. create clients/<slug>/field-map.json
 *   2. add an import + one entry below
 *   3. set the deployment's FIELD_MAP_CLIENT var to <slug>
 */
import exampleMap from "../../clients/_example/field-map.json";

export const FIELD_MAPS: Readonly<Record<string, unknown>> = {
  _example: exampleMap,
};
