/**
 * Dependency hydration — fetch file/model catalog rows that fall outside the
 * user's filter window but are still required by the selection graph.
 */

import { Catalog, CatalogItem, CatalogSection, resolveDependencies } from "./catalog";
import { normalizeFileDepId, fileDepAliases } from "./file-deps";

export const DEFAULT_HYDRATE_CAP = 500;

export interface HydrateFetchers {
  fetchFileByDepId?(id: string): Promise<CatalogItem | null>;
  fetchModelById?(modelId: string): Promise<CatalogItem | null>;
  fetchEntryById?(entryId: string): Promise<CatalogItem | null>;
}

export interface HydrateResult {
  catalog: Catalog;
  /** User selection unchanged. */
  selectedIds: string[];
  /** Newly fetched file/model/entry ids (canonical catalog ids). */
  hydratedIds: string[];
  /** Still missing after fetch attempts. */
  unresolvedIds: string[];
}

function catalogHasId(catalog: Catalog, id: string): CatalogItem | undefined {
  const aliases = new Set(fileDepAliases(id));
  aliases.add(id);
  aliases.add(normalizeFileDepId(id));
  for (const s of catalog.sections) {
    for (const it of s.items) {
      if (aliases.has(it.id)) return it;
      if (it.type === "file") {
        for (const a of fileDepAliases(it.id)) if (aliases.has(a)) return it;
        const key = it.metadata?.["key"];
        if (typeof key === "string" && aliases.has(key)) return it;
      }
    }
  }
  return undefined;
}

function guessMissingType(id: string, parents: CatalogItem[]): "file" | "model" | "cms-entry" | "unknown" {
  if (/^https?:\/\//i.test(id) || id.includes("/files/") || id.includes("/")) return "file";
  for (const p of parents) {
    const deps = p.dependsOn ?? [];
    if (!deps.includes(id) && !deps.some((d) => normalizeFileDepId(d) === normalizeFileDepId(id))) continue;
    if (p.type === "page") return "file";
    if (p.type === "cms-entry") {
      // First dep is conventionally the modelId.
      if (deps[0] === id) return "model";
      if (/^https?:\/\//i.test(id) || id.includes("/")) return "file";
      return "cms-entry";
    }
  }
  // Heuristic: short alphanumeric modelIds vs UUID-ish entryIds — prefer model when no slash/url.
  if (!id.includes("/") && !id.includes(":") && id.length < 64) return "model";
  return "unknown";
}

function mergeItem(catalog: Catalog, item: CatalogItem): Catalog {
  const sections = catalog.sections.map((s) => ({ ...s, items: [...s.items] }));
  let sec = sections.find((s) => s.type === item.type);
  if (!sec) {
    sec = { type: item.type, total: 0, items: [] };
    sections.push(sec);
  }
  if (!sec.items.some((it) => it.id === item.id)) {
    sec.items.push(item);
    sec.total = Math.max(sec.total, sec.items.length);
  }
  return { ...catalog, sections: sections as CatalogSection[] };
}

/** True when migrate should exit before planning (missing deps, no override). */
export function shouldAbortForUnresolvedDeps(
  unresolvedIds: readonly string[],
  allowMissingDeps: boolean
): boolean {
  return unresolvedIds.length > 0 && !allowMissingDeps;
}

/** Human-readable unresolved-deps line for migrate logs / errors. */
export function formatUnresolvedDepsMessage(unresolvedIds: readonly string[]): string {
  const sample = unresolvedIds.slice(0, 5).join(", ");
  const more = unresolvedIds.length > 5 ? "…" : "";
  return `${unresolvedIds.length} unresolved dep(s): ${sample}${more}`;
}

/** Drop intentionally omitted edges so plan/hydrate won't pull them back in. */
export function catalogOmittingDeps(catalog: Catalog, omitIds: Iterable<string>): Catalog {
  const omit = new Set<string>();
  for (const id of omitIds) {
    omit.add(id);
    omit.add(normalizeFileDepId(id));
  }
  if (!omit.size) return catalog;
  return {
    ...catalog,
    sections: catalog.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => ({
        ...it,
        dependsOn: (it.dependsOn ?? []).filter(
          (d) => !omit.has(d) && !omit.has(normalizeFileDepId(d))
        ),
      })),
    })),
  };
}

/**
 * Expand selection deps; for ids missing from the catalog, call fetchers
 * (no name/date filters). Caps hydrated items per run.
 */
export async function hydrateDependencies(
  catalog: Catalog,
  selectedIds: Iterable<string>,
  fetchers: HydrateFetchers,
  opts: { maxHydrated?: number; omitIds?: Iterable<string> } = {}
): Promise<HydrateResult> {
  const maxHydrated = opts.maxHydrated ?? DEFAULT_HYDRATE_CAP;
  const selected = [...selectedIds];
  let working = catalogOmittingDeps(catalog, opts.omitIds ?? []);
  const hydratedIds: string[] = [];
  const unresolvedIds: string[] = [];
  const omit = new Set(
    [...(opts.omitIds ?? [])].flatMap((id) => [id, normalizeFileDepId(id)])
  );

  // Iterate until closure is stable or we hit the cap (deps of hydrated items may need more).
  for (let pass = 0; pass < 4; pass++) {
    const resolved = resolveDependencies(working, selected);
    const parents = working.sections.flatMap((s) => s.items);
    const missing: string[] = [];
    for (const id of resolved) {
      if (omit.has(id) || omit.has(normalizeFileDepId(id))) continue;
      if (!catalogHasId(working, id)) missing.push(id);
    }
    // Deduplicate by normalized form
    const seen = new Set<string>();
    const uniqueMissing: string[] = [];
    for (const id of missing) {
      const k = normalizeFileDepId(id) || id;
      if (seen.has(k)) continue;
      seen.add(k);
      uniqueMissing.push(id);
    }

    if (!uniqueMissing.length) break;

    for (const id of uniqueMissing) {
      if (hydratedIds.length >= maxHydrated) {
        throw new Error(
          `Dependency hydration exceeded cap of ${maxHydrated} item(s). Narrow the selection or raise the cap.`
        );
      }
      const kind = guessMissingType(id, parents);
      let fetched: CatalogItem | null = null;
      if (kind === "file" && fetchers.fetchFileByDepId) {
        fetched = await fetchers.fetchFileByDepId(id);
      } else if (kind === "model" && fetchers.fetchModelById) {
        fetched = await fetchers.fetchModelById(id);
      } else if (kind === "cms-entry" && fetchers.fetchEntryById) {
        fetched = await fetchers.fetchEntryById(id);
      } else if (kind === "unknown") {
        // Try file then model
        if (fetchers.fetchFileByDepId) fetched = await fetchers.fetchFileByDepId(id);
        if (!fetched && fetchers.fetchModelById) fetched = await fetchers.fetchModelById(id);
        if (!fetched && fetchers.fetchEntryById) fetched = await fetchers.fetchEntryById(id);
      }

      if (fetched) {
        working = mergeItem(working, fetched);
        hydratedIds.push(fetched.id);
      } else if (!unresolvedIds.includes(id)) {
        unresolvedIds.push(id);
      }
    }
  }

  // Drop unresolved that were later resolved via alias of a hydrated item
  const still = unresolvedIds.filter((id) => !catalogHasId(working, id));

  return {
    catalog: working,
    selectedIds: selected,
    hydratedIds: [...new Set(hydratedIds)],
    unresolvedIds: still,
  };
}
