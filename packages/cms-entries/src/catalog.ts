/**
 * Catalog builder for CMS entries.
 *
 * Lists entries for each model from an environment (read-only) and produces a
 * CatalogSection: one CatalogItem per entry with a label, siteId/model metadata,
 * and dependency edges for file and ref fields (so selection can pull in the
 * files/entries an entry references).
 */

import pLimit from "p-limit";
import { GraphQLClient, CatalogItem, CatalogSection, logger, buildFolderPathMap } from "@kibo-cms-clone-tool/shared";
import { ModelDefinition, buildListQuery, parseSkippableField } from "./introspect";
import { introspectedFieldLines, entryDisplayLines } from "./entry-selection";
import { fetchEntryFolders, normalizeFolderId } from "./folders";
import { listSourceModels } from "./provision";

/** Build the model catalog section (content models available to migrate). */
export async function catalogModels(client: GraphQLClient): Promise<CatalogSection> {
  try {
    const models = await listSourceModels(client);
    const items: CatalogItem[] = models.map((m) => ({
      type: "model",
      id: m.modelId,
      label: m.name,
      group: m.group ?? undefined,
      metadata: { fields: m.fieldCount, singularApiName: m.singularApiName, group: m.group },
    }));
    return { type: "model", total: items.length, items };
  } catch (e) {
    return { type: "model", total: 0, items: [], note: e instanceof Error ? e.message : String(e) };
  }
}

type ListResponse = {
  [key: string]: {
    data: Record<string, unknown>[];
    meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
    error: { message: string } | null;
  };
};

/** Pick a human label for an entry: title-ish field, else slug, else id. */
function deriveLabel(values: Record<string, unknown>, fallback: string): string {
  for (const k of ["title", "name", "label", "heading"]) {
    if (typeof values[k] === "string" && values[k]) return values[k] as string;
  }
  if (typeof values["slug"] === "string" && values["slug"]) return values["slug"] as string;
  return fallback;
}

/** Extract file keys and referenced entryIds an entry depends on. */
function extractDeps(model: ModelDefinition, values: Record<string, unknown>): string[] {
  const deps: string[] = [];
  for (const field of model.fields) {
    const v = values[field.fieldId];
    if (v == null) continue;
    if (field.type === "file") {
      const arr = Array.isArray(v) ? v : [v];
      for (const f of arr) if (typeof f === "string" && f) deps.push(f);
    } else if (field.type === "ref") {
      const arr = Array.isArray(v) ? v : [v];
      for (const r of arr) {
        const eid = (r as { entryId?: string })?.entryId;
        if (eid) deps.push(eid);
      }
    }
  }
  return deps;
}

/** Read one field off an entry's nested object (e.g. createdBy.displayName). */
function nested(entry: Record<string, unknown>, obj: string, key: string): unknown {
  const o = entry[obj] as Record<string, unknown> | null | undefined;
  return o && typeof o === "object" ? o[key] : undefined;
}

async function listModelEntries(
  client: GraphQLClient,
  model: ModelDefinition,
  folderPaths: Map<string, string>
): Promise<{ items: CatalogItem[]; skipped: string[] }> {
  const items: CatalogItem[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  const skipFields = new Set<string>();
  // Precise selection from the live schema; null → heuristic fallback.
  const fieldLines = await introspectedFieldLines(client, model).catch(() => null);
  // Display columns (author/dates/status/version/folder) — only fields the type has.
  const displayLines = await entryDisplayLines(client, model.listOperation).catch(() => []);

  while (hasMore) {
    const query = buildListQuery(model, undefined, cursor ?? undefined, skipFields, fieldLines ?? undefined, displayLines);
    const variables: Record<string, unknown> = {};
    if (cursor) variables.after = cursor;

    let resp: ListResponse;
    try {
      resp = await client.request<ListResponse>(query, variables);
    } catch (err) {
      // Drop a corrupt or unselectable field (genuine model fields only) and refetch.
      const bad = parseSkippableField(err);
      if (bad && !skipFields.has(bad) && model.fields.some((f) => f.fieldId === bad)) {
        skipFields.add(bad);
        logger.warn(`  ⚠  catalog: skipping unselectable field "${bad}" on ${model.name}`);
        continue;
      }
      throw err;
    }

    const result = resp[model.listOperation];
    if (!result) throw new Error(`Unexpected response for ${model.listOperation}`);
    if (result.error) throw new Error(result.error.message);

    for (const entry of result.data ?? []) {
      const values = (entry["values"] ?? {}) as Record<string, unknown>;
      const entryId = (entry["entryId"] as string) ?? String(entry["id"] ?? "");
      const status = (nested(entry, "meta", "status") as string) ?? null;
      const folderId = normalizeFolderId(nested(entry, "wbyAco_location", "folderId"));
      const live = status === "published";
      // Display name: a values title-ish field, else Kibo CMS's computed meta.title
      // (what the admin shows, e.g. "product-anchor-link-grid-aed"), else the id.
      const metaTitle = (nested(entry, "meta", "title") as string) || entryId;
      const name = deriveLabel(values, metaTitle);
      items.push({
        type: "cms-entry",
        id: entryId,
        label: name,
        group: model.name,
        metadata: {
          model: model.name,
          siteId: values["siteId"] ?? null,
          slug: values["slug"] ?? null,
          name,
          folderPath: folderId ? (folderPaths.get(folderId) ?? "(unknown)") : "/",
          author: (nested(entry, "createdBy", "displayName") as string) ?? null,
          createdOn: entry["createdOn"] ?? null,
          modifiedOn: entry["savedOn"] ?? null,
          status,
          live,
          version: live ? (nested(entry, "meta", "version") ?? null) : null,
        },
        // entry depends on its model (id = modelId) so selection provisions it first
        dependsOn: [model.modelId, ...extractDeps(model, values)],
      });
    }

    cursor = result.meta.cursor ?? null;
    hasMore = result.meta.hasMoreItems ?? false;
  }

  return { items, skipped: [...skipFields] };
}

/** Build the cms-entry catalog section across the given models. */
export async function catalogEntries(
  client: GraphQLClient,
  models: ModelDefinition[],
  adminClient?: GraphQLClient
): Promise<CatalogSection> {
  const items: CatalogItem[] = [];
  const skipped: string[] = [];

  // Each model needs several introspection round-trips (entry/values types, folder
  // tree) before its list query — latency-bound, so list models concurrently. The
  // adaptive per-tenant throttle still backs off under load. Promise.all preserves
  // model order, keeping the catalog grouped stably.
  const concurrency = Math.max(1, parseInt(process.env["EXPORT_CONCURRENCY"] ?? process.env["CONCURRENCY"] ?? "6", 10) || 6);
  const limit = pLimit(concurrency);
  const perModel = await Promise.all(
    models.map((model) =>
      limit(async () => {
        try {
          // Folder tree (for folder-path display) lives on the Admin endpoint,
          // keyed by modelId. Best-effort — no folders / no admin client → "/".
          let folderPaths = new Map<string, string>();
          if (adminClient) {
            const folders = await fetchEntryFolders(adminClient, model.modelId).catch(() => []);
            folderPaths = buildFolderPathMap(folders);
          }
          const r = await listModelEntries(client, model, folderPaths);
          return { items: r.items, skipped: r.skipped.map((f) => `${model.name}.${f}`) };
        } catch (err) {
          logger.warn(`  ⚠  catalog: failed to list ${model.name}: ${err instanceof Error ? err.message : String(err)}`);
          return { items: [] as CatalogItem[], skipped: [] as string[] };
        }
      })
    )
  );
  for (const r of perModel) { items.push(...r.items); skipped.push(...r.skipped); }
  const note = skipped.length ? `Excluded unselectable/corrupt field(s): ${skipped.join(", ")}` : undefined;
  return { type: "cms-entry", total: items.length, items, note };
}
