/**
 * Introspection-driven selection sets for CMS entries.
 *
 * Instead of guessing each field's sub-selection from its type/settings, this
 * reads the actual GraphQL schema: it resolves a model's `values` object type
 * (list operation → response → data element → values), then builds a selection
 * from the real field types — scalars bare, objects/refs expanded with their
 * genuine subfields. Falls back (returns null) when the schema can't be resolved,
 * so callers keep the heuristic builder + field-drop resilience.
 */

import { GraphQLClient } from "@kibo-cms-clone-tool/shared";
import { ModelDefinition, SYSTEM_FIELDS } from "./introspect";

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}

/** Walk NON_NULL/LIST wrappers down to the innermost named type. */
export function unwrapType(t: TypeRef | null | undefined): { kind: string; name: string | null } {
  let cur: TypeRef | null | undefined = t;
  while (cur && !cur.name && cur.ofType) cur = cur.ofType;
  return { kind: cur?.kind ?? "", name: cur?.name ?? null };
}

const SCALARISH = new Set(["SCALAR", "ENUM"]);

const TYPE_Q = (name: string) =>
  `{ __type(name: "${name}") { kind fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`;

interface IntrospectedField { name: string; type: TypeRef }

async function typeFields(client: GraphQLClient, name: string): Promise<IntrospectedField[] | null> {
  const r = await client.request<{ __type: { fields: IntrospectedField[] | null } | null }>(
    TYPE_Q(name), undefined, { maxAttempts: 1 }
  );
  return r.__type?.fields ?? null;
}

/** Recursively build a subfield selection for an object type (depth/cycle bounded). */
async function subSelection(client: GraphQLClient, typeName: string, depth: number, seen: Set<string>): Promise<string> {
  if (depth <= 0 || seen.has(typeName)) return "";
  const fields = await typeFields(client, typeName);
  if (!fields) return "";
  // Per-path ancestor set (copy, not shared) — so two sibling fields of the same
  // object type don't prune each other; only true cycles in one path are cut.
  const ancestors = new Set(seen);
  ancestors.add(typeName);
  const lines: string[] = [];
  for (const f of fields) {
    const base = unwrapType(f.type);
    if (SCALARISH.has(base.kind)) {
      lines.push(f.name);
    } else if (base.name) {
      const sub = await subSelection(client, base.name, depth - 1, ancestors);
      if (sub) lines.push(`${f.name} { ${sub} }`);
      // object whose subtree can't be resolved (cycle/depth) → omitted (can't select bare)
    }
  }
  return lines.join(" ");
}

/** listOperation → response type → `data` element type (the entry object type). */
async function resolveEntryType(client: GraphQLClient, listOperation: string): Promise<string | null> {
  const queryFields = await typeFields(client, "Query");
  const listField = queryFields?.find((f) => f.name === listOperation);
  const respName = listField ? unwrapType(listField.type).name : null;
  if (!respName) return null;

  const respFields = await typeFields(client, respName);
  const dataField = respFields?.find((f) => f.name === "data");
  return dataField ? unwrapType(dataField.type).name : null;
}

/** listOperation → entry type → its `values` object type. */
async function resolveValuesType(client: GraphQLClient, listOperation: string): Promise<string | null> {
  const entryType = await resolveEntryType(client, listOperation);
  if (!entryType) return null;

  const entryFields = await typeFields(client, entryType);
  const valuesField = entryFields?.find((f) => f.name === "values");
  return valuesField ? unwrapType(valuesField.type).name : null;
}

/**
 * Root selection line for the entry's ACO folder membership, or null when the
 * entry type has no `wbyAco_location` field (so the query stays valid).
 */
export async function entryAcoLocationLine(
  client: GraphQLClient,
  listOperation: string
): Promise<string | null> {
  try {
    const entryType = await resolveEntryType(client, listOperation);
    if (!entryType) return null;
    const entryFields = await typeFields(client, entryType);
    const hasAco = entryFields?.some((f) => f.name === "wbyAco_location");
    return hasAco ? "wbyAco_location { folderId }" : null;
  } catch {
    return null;
  }
}

/**
 * Extra root selection lines for the catalog's display columns — only the system
 * fields that actually exist on the entry type, so the query stays valid across
 * Kibo versions. Covers author, created/modified dates, status, version, folder.
 */
export async function entryDisplayLines(
  client: GraphQLClient,
  listOperation: string
): Promise<string[]> {
  try {
    const entryType = await resolveEntryType(client, listOperation);
    if (!entryType) return [];
    const fields = await typeFields(client, entryType);
    if (!fields) return [];
    const names = new Set(fields.map((f) => f.name));
    const lines: string[] = [];
    for (const scalar of ["createdOn", "savedOn"]) if (names.has(scalar)) lines.push(scalar);
    if (names.has("wbyAco_location")) lines.push("wbyAco_location { folderId }");

    // Object fields: include only the subfields the type actually exposes.
    const objLine = async (field: string, wanted: string[]) => {
      const f = fields.find((x) => x.name === field);
      const t = f ? unwrapType(f.type).name : null;
      if (!t) return;
      const sub = await typeFields(client, t);
      const present = wanted.filter((w) => sub?.some((s) => s.name === w));
      if (present.length) lines.push(`${field} { ${present.join(" ")} }`);
    };
    await objLine("createdBy", ["displayName", "id"]);
    await objLine("meta", ["status", "version", "title"]);
    return lines;
  } catch {
    return [];
  }
}

/**
 * Top-level `values` fieldId → its precise selection line, from the live schema.
 * Returns null if the schema can't be resolved (caller falls back to heuristics).
 */
export async function introspectedFieldLines(
  client: GraphQLClient,
  model: ModelDefinition
): Promise<Map<string, string> | null> {
  let valuesType: string | null;
  try {
    valuesType = await resolveValuesType(client, model.listOperation);
  } catch {
    return null;
  }
  if (!valuesType) return null;

  const fields = await typeFields(client, valuesType);
  if (!fields) return null;

  const map = new Map<string, string>();
  for (const f of fields) {
    if (SYSTEM_FIELDS.has(f.name)) continue;
    const base = unwrapType(f.type);
    if (SCALARISH.has(base.kind)) {
      map.set(f.name, f.name);
    } else if (base.name) {
      const sub = await subSelection(client, base.name, 3, new Set());
      if (sub) map.set(f.name, `${f.name} { ${sub} }`);
      // object with no resolvable subfields → omit (can't be selected)
    }
  }
  return map.size ? map : null;
}
