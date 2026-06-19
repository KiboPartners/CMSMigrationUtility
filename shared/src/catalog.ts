/**
 * Catalog model — the read-side inventory that powers "view & select".
 *
 * A Catalog is a typed snapshot of what exists in one environment: artifacts
 * grouped by type, each with a stable selection id, a human label, metadata, and
 * dependency edges (e.g. a CMS entry that references a file or another entry).
 *
 * Per-artifact builders live in each package (e.g. cms-entries/src/catalog.ts)
 * and produce CatalogSection objects; the API/UI assembles them into a Catalog.
 */

export type ArtifactType = "model" | "cms-entry" | "page" | "redirect" | "file";

export interface CatalogItem {
  type: ArtifactType;
  /** Stable identity used for selection + cross-references (entryId / path / redirectFrom / file key). */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Sub-grouping within a type (model name, folder, …). */
  group?: string;
  metadata?: Record<string, unknown>;
  /** Ids of other catalog items this one references (file keys, entryIds, …). */
  dependsOn?: string[];
}

export interface CatalogSection {
  type: ArtifactType;
  /** Total available on the source (may exceed items.length if a limit was applied). */
  total: number;
  items: CatalogItem[];
  /** Set when listing failed or was skipped (capability missing, etc.). */
  note?: string;
}

export interface Catalog {
  environment: { role: string; tenant: string; locale: string };
  generatedAt: string | null;
  sections: CatalogSection[];
}

/** Assemble sections into a Catalog. generatedAt is caller-supplied (ISO string) or null. */
export function buildCatalog(
  environment: Catalog["environment"],
  sections: CatalogSection[],
  generatedAt: string | null = null
): Catalog {
  return { environment, sections, generatedAt };
}

/** Flat count of items across all sections. */
export function catalogSize(catalog: Catalog): number {
  return catalog.sections.reduce((n, s) => n + s.items.length, 0);
}

/**
 * Resolve the transitive selection: given the ids the user picked, include any
 * catalog items those depend on (files before the entries that reference them,
 * etc.). Returns the expanded id set.
 */
export function resolveDependencies(catalog: Catalog, selectedIds: Iterable<string>): Set<string> {
  const byId = new Map<string, CatalogItem>();
  for (const s of catalog.sections) for (const it of s.items) byId.set(it.id, it);

  const result = new Set<string>();
  const stack = [...selectedIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const item = byId.get(id);
    for (const dep of item?.dependsOn ?? []) if (!result.has(dep)) stack.push(dep);
  }
  return result;
}
