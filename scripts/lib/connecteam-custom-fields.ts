/**
 * Connecteam custom-field DEFINITIONS (id, name, type) for the whole account,
 * independent of whether any employee has answered them yet.
 */

export interface CustomFieldDefinition {
  customFieldId: number;
  name: string;
  type: string;
}

export type CtGet = (path: string) => Promise<any>;

/**
 * `GET /users/v1/custom-fields` is paginated (default page size 10, no
 * single-field-by-id endpoint exists) - page through it until a short page.
 */
export async function listRawCustomFields(ctGet: CtGet): Promise<any[]> {
  const PAGE = 50;
  let offset = 0;
  const all: any[] = [];
  for (;;) {
    const page = (await ctGet(`/users/v1/custom-fields?limit=${PAGE}&offset=${offset}`))?.data?.customFields ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export async function listCustomFieldDefinitions(ctGet: CtGet): Promise<CustomFieldDefinition[]> {
  return (await listRawCustomFields(ctGet)).map((f) => ({
    customFieldId: f.id,
    name: String(f.name ?? ""),
    type: String(f.type ?? ""),
  }));
}
