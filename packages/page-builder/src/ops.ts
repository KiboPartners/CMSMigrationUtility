/**
 * Discover Page Builder operation names and page field structure from the live schema.
 *
 * Handles any Kibo CMS version:
 *   - Kibo CMS 5.x: `pageBuilder { listPageBuilderCategories … }`
 *   - Kibo CMS 6.x namespace A: `pageBuilder { listPages … }` (top-level-ish)
 *   - Kibo CMS 6.x namespace B: `websiteBuilder { listPages … }` (this install)
 *
 * Strategy:
 *   1. Introspect root query + mutation fields to find the namespace field
 *   2. Introspect the namespace type to find the operations we need
 *   3. Follow listPages → response type → data type to discover all page fields
 *   4. For each object field on the page type, introspect one level of sub-fields
 */

import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";

// ── GQL introspection type helpers ────────────────────────────────────────────

interface GQLTypeRef {
  name: string | null;
  kind: string;
  ofType?: GQLTypeRef | null;
}

interface GQLArg {
  name: string;
  type: GQLTypeRef;
}

interface GQLField {
  name: string;
  type: GQLTypeRef;
  args?: GQLArg[];
}

function resolveTypeName(t: GQLTypeRef): string | null {
  if (t.name) return t.name;
  if (t.ofType) return resolveTypeName(t.ofType);
  return null;
}

function resolveKind(t: GQLTypeRef): string {
  if (t.kind !== "NON_NULL" && t.kind !== "LIST") return t.kind;
  if (t.ofType) return resolveKind(t.ofType);
  return t.kind;
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface PageBuilderOps {
  /** Query namespace: "websiteBuilder" | "pageBuilder" | null (top-level) */
  namespace: string | null;
  /** Mutation namespace (often same as query namespace, or null) */
  mutNamespace: string | null;
  /** Operation names under their respective namespace */
  listPages: string;
  createPage: string | null;
  updatePage: string | null;
  publishPage: string | null;
  deletePage: string | null;
  listCategories: string | null;
  createCategory: string | null;
  /** Full GQL selection set for one page, built from schema introspection */
  pageSelection: string;
  /** The GraphQL type name for the listPages `where` argument (e.g. "WbPagesListWhereInput") */
  listPagesWhereType: string | null;
  /** The GraphQL type name for the createPage `data` argument (e.g. "WbPageCreateInput") */
  createPageInputType: string | null;
  /** The GraphQL type name for the updatePage `data` argument (e.g. "WbPageUpdateInput") */
  updatePageInputType: string | null;
  /** Valid top-level field names accepted by createPage's data input */
  createPageInputFields: Set<string>;
  /** Valid top-level field names accepted by updatePage's data input */
  updatePageInputFields: Set<string>;
  /** Which identifier/status fields exist on the page type */
  pageKeyFields: {
    hasSlug: boolean;
    hasPath: boolean;
    hasPid: boolean;
    hasStatus: boolean;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NAMESPACES = ["websitebuilder", "pagebuilder", "pb", "wby"];

/** Fetch field names from a GraphQL INPUT_OBJECT type. */
async function fetchInputFields(client: GraphQLClient, typeName: string): Promise<string[]> {
  type Resp = { __type: { inputFields: Array<{ name: string }> } | null };
  try {
    const r = await client.request<Resp>(
      `{ __type(name: "${typeName}") { inputFields { name } } }`,
      undefined,
      { maxAttempts: 1 }
    );
    return r.__type?.inputFields?.map((f) => f.name) ?? [];
  } catch {
    return [];
  }
}

async function fetchTypeFields(client: GraphQLClient, typeName: string): Promise<GQLField[]> {
  type Resp = { __type: { fields: GQLField[] } | null };
  try {
    const r = await client.request<Resp>(
      `{ __type(name: "${typeName}") { fields {
          name
          args { name type { name kind ofType { name kind ofType { name kind } } } }
          type { name kind ofType { name kind ofType { name kind } } }
        } } }`,
      undefined,
      { maxAttempts: 1 }
    );
    return r.__type?.fields ?? [];
  } catch {
    return [];
  }
}

function pickOp(fields: GQLField[], ...names: string[]): string | null {
  for (const n of names) {
    const f = fields.find((f) => f.name.toLowerCase() === n.toLowerCase());
    if (f) return f.name;
  }
  return null;
}

/**
 * Recursively build a GQL selection set for a type.
 * Scalars/Enums are included directly.
 * Object fields get one level of sub-field introspection; scalar sub-fields are kept.
 * Skips internal GQL types (__*).
 */
async function buildSelection(
  client: GraphQLClient,
  typeName: string,
  depth = 0
): Promise<string> {
  if (depth > 2) return "";

  const fields = await fetchTypeFields(client, typeName);
  if (!fields.length) return "";

  const lines: string[] = [];

  for (const field of fields) {
    if (field.name.startsWith("__")) continue;

    const kind = resolveKind(field.type);
    const subTypeName = resolveTypeName(field.type);

    if (kind === "SCALAR" || kind === "ENUM") {
      lines.push(field.name);
    } else if ((kind === "OBJECT" || kind === "INTERFACE") && subTypeName && !subTypeName.startsWith("__")) {
      const subSel = await buildSelection(client, subTypeName, depth + 1);
      if (subSel) {
        lines.push(`${field.name} { ${subSel} }`);
      }
    }
    // LIST of scalars
    else if (kind === "LIST") {
      const innerKind = field.type.ofType ? resolveKind(field.type.ofType) : "";
      if (innerKind === "SCALAR" || innerKind === "ENUM") {
        lines.push(field.name);
      } else if (subTypeName && !subTypeName.startsWith("__")) {
        const subSel = await buildSelection(client, subTypeName, depth + 1);
        if (subSel) lines.push(`${field.name} { ${subSel} }`);
      }
    }
  }

  return lines.join(" ");
}

// ── Main discovery function ───────────────────────────────────────────────────

export async function discoverPageBuilderOps(client: GraphQLClient): Promise<PageBuilderOps> {
  // Step 1 — root schema
  type RootResp = {
    __schema: {
      queryType: { fields: GQLField[] };
      mutationType: { fields: GQLField[] } | null;
    };
  };

  const root = await client.request<RootResp>(
    `{ __schema {
        queryType   { fields { name type { name kind ofType { name kind ofType { name kind } } } } }
        mutationType { fields { name type { name kind ofType { name kind ofType { name kind } } } } }
      } }`,
    undefined,
    { maxAttempts: 1 }
  );

  const qRoot = root.__schema.queryType.fields;
  const mRoot = root.__schema.mutationType?.fields ?? [];

  // Step 2 — find namespace or fall back to top-level
  const qNsField = qRoot.find((f) => NAMESPACES.includes(f.name.toLowerCase()));
  const mNsField = mRoot.find((f) => NAMESPACES.includes(f.name.toLowerCase()));

  const namespace    = qNsField?.name ?? null;
  const mutNamespace = mNsField?.name ?? null;

  let qFields: GQLField[];
  let mFields: GQLField[];

  if (namespace) {
    const nsType = resolveTypeName(qNsField!.type);
    logger.log(`  Query namespace "${namespace}" → type "${nsType ?? "(unresolved)"}"`);
    qFields = nsType ? await fetchTypeFields(client, nsType) : qRoot;
    if (!nsType) logger.warn("  ⚠  Could not resolve namespace type — falling back to root fields");
  } else {
    qFields = qRoot;
  }

  if (mutNamespace) {
    const nsType = resolveTypeName(mNsField!.type);
    logger.log(`  Mutation namespace "${mutNamespace}" → type "${nsType ?? "(unresolved)"}"`);
    mFields = nsType ? await fetchTypeFields(client, nsType) : mRoot;
    if (!nsType) logger.warn("  ⚠  Could not resolve mutation namespace type — falling back to root fields");
  } else {
    mFields = mRoot;
  }

  // Step 3 — find operations
  const listPagesOp   = pickOp(qFields, "listPages", "pbListPages");
  const createPageOp  = pickOp(mFields, "createPage", "pbCreatePage");
  const updatePageOp  = pickOp(mFields, "updatePage", "pbUpdatePage");
  const publishPageOp = pickOp(mFields, "publishPage", "pbPublishPage");
  const deletePageOp  = pickOp(mFields, "deletePage", "pbDeletePage");
  const listCatsOp    = pickOp(qFields,
    "listPageBuilderCategories", "listCategories", "pbListCategories",
    "listPageCategories", "listFolders", "listPageFolders");
  const createCatOp   = pickOp(mFields,
    "createPageBuilderCategory", "createCategory", "pbCreateCategory",
    "createPageCategory", "createFolder", "createPageFolder");

  if (!listPagesOp) {
    logger.error("\n  Available query fields (namespace or root):");
    for (const f of qFields) logger.error(`    ${f.name}`);
    logger.error("\n  Available mutation fields:");
    for (const f of mFields) logger.error(`    ${f.name}`);
    throw new Error("Could not find 'listPages' (or equivalent) in the Page Builder schema.");
  }

  // Log available namespace fields to help diagnose missing ops
  if (!listCatsOp) {
    logger.log("  ℹ  No category/folder op found. Available query ops in namespace:");
    for (const f of qFields) logger.log(`       ${f.name}`);
  }

  // Step 4 — discover page type, build selection, and extract key field/input type info
  let pageSelection = "id";
  let listPagesWhereType: string | null = null;
  let createPageInputType: string | null = null;
  let updatePageInputType: string | null = null;
  const pageKeyFields = { hasSlug: false, hasPath: false, hasPid: false, hasStatus: false };

  const listPagesField = qFields.find((f) => f.name === listPagesOp);
  if (listPagesField) {
    // Extract the `where` arg type name from the listPages field args
    const whereArg = listPagesField.args?.find((a) => a.name === "where");
    if (whereArg) listPagesWhereType = resolveTypeName(whereArg.type);

    const respTypeName = resolveTypeName(listPagesField.type);
    if (respTypeName) {
      const respFields = await fetchTypeFields(client, respTypeName);
      const dataField  = respFields.find((f) => f.name === "data");
      if (dataField) {
        const pageTypeName = resolveTypeName(dataField.type);
        if (pageTypeName) {
          logger.log(`  Introspecting page type: ${pageTypeName}`);
          const pageTypeFields = await fetchTypeFields(client, pageTypeName);
          const fieldNames = new Set(pageTypeFields.map((f) => f.name));
          pageKeyFields.hasSlug   = fieldNames.has("slug");
          pageKeyFields.hasPath   = fieldNames.has("path");
          pageKeyFields.hasPid    = fieldNames.has("pid");
          pageKeyFields.hasStatus = fieldNames.has("status");

          const sel = await buildSelection(client, pageTypeName);
          if (sel) pageSelection = sel;
        }
      }
    }
  }

  // Extract data arg types from createPage / updatePage (mutations), then introspect their fields
  if (createPageOp) {
    const createField = mFields.find((f) => f.name === createPageOp);
    const dataArg = createField?.args?.find((a) => a.name === "data");
    if (dataArg) createPageInputType = resolveTypeName(dataArg.type);
  }
  if (updatePageOp) {
    const updateField = mFields.find((f) => f.name === updatePageOp);
    const dataArg = updateField?.args?.find((a) => a.name === "data");
    if (dataArg) updatePageInputType = resolveTypeName(dataArg.type);
  }

  const createPageInputFieldsList = createPageInputType
    ? await fetchInputFields(client, createPageInputType)
    : [];
  const updatePageInputFieldsList = updatePageInputType
    ? await fetchInputFields(client, updatePageInputType)
    : [];
  const createPageInputFields = new Set(createPageInputFieldsList);
  const updatePageInputFields = new Set(updatePageInputFieldsList);

  logger.log(`    createPage fields: ${createPageInputFieldsList.join(", ") || "(none)"}`);
  logger.log(`    updatePage fields: ${updatePageInputFieldsList.join(", ") || "(none)"}`);

  // Step 5 — report
  logger.log("  Page Builder operations discovered:");
  logger.log(`    namespace       : ${namespace ?? "(top-level)"}`);
  logger.log(`    mutNamespace    : ${mutNamespace ?? "(top-level)"}`);
  logger.log(`    listPages       : ${listPagesOp}`);
  logger.log(`    whereInputType  : ${listPagesWhereType ?? "(not found)"}`);
  logger.log(`    createPage      : ${createPageOp ?? "❌ not found"}`);
  logger.log(`    createInputType : ${createPageInputType ?? "(not found)"}`);
  logger.log(`    updatePage      : ${updatePageOp ?? "❌ not found"}`);
  logger.log(`    updateInputType : ${updatePageInputType ?? "(not found)"}`);
  logger.log(`    publishPage     : ${publishPageOp ?? "❌ not found"}`);
  logger.log(`    deletePage      : ${deletePageOp ?? "❌ not found"}`);
  logger.log(`    listCategories  : ${listCatsOp ?? "(not found — skipping categories)"}`);
  logger.log(`    page key fields : slug=${pageKeyFields.hasSlug} path=${pageKeyFields.hasPath} pid=${pageKeyFields.hasPid} status=${pageKeyFields.hasStatus}`);
  logger.log(`    page fields     : ${pageSelection.replace(/\s+/g, " ").slice(0, 120)}…`);

  return {
    namespace,
    mutNamespace,
    listPages:            listPagesOp,
    createPage:           createPageOp,
    updatePage:           updatePageOp,
    publishPage:          publishPageOp,
    deletePage:           deletePageOp,
    listCategories:       listCatsOp,
    createCategory:       createCatOp,
    pageSelection,
    listPagesWhereType,
    createPageInputType,
    updatePageInputType,
    createPageInputFields,
    updatePageInputFields,
    pageKeyFields,
  };
}
