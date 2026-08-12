/**
 * Migration planning — turn a catalog + a user selection into an ordered,
 * dependency-resolved plan.
 *
 * Given the ids a user picked, expand them with resolveDependencies() (so a
 * selected entry pulls in the files it references), then group by artifact type
 * and order the groups so dependencies are migrated first:
 *   file → cms-entry → page → redirect
 */

import { Catalog, CatalogItem, ArtifactType, resolveDependencies } from "./catalog";
import { fileDepAliases, normalizeFileDepId } from "./file-deps";

/** Types in dependency order — earlier types are migrated before later ones. */
export const TYPE_ORDER: ArtifactType[] = ["model", "file", "cms-entry", "page", "redirect"];

export interface MigrationStep {
  type: ArtifactType;
  ids: string[];
}

export interface MigrationPlan {
  steps: MigrationStep[];
  /** How many ids the user explicitly selected. */
  selectedCount: number;
  /** Total ids after dependency expansion. */
  resolvedCount: number;
  /** Ids pulled in by dependency resolution (not explicitly selected). */
  addedByDependencies: string[];
  /** Selected/expanded ids that were not found in the catalog. */
  unknownIds: string[];
}

function indexCatalog(catalog: Catalog): Map<string, CatalogItem> {
  const byId = new Map<string, CatalogItem>();
  for (const s of catalog.sections) {
    for (const it of s.items) {
      byId.set(it.id, it);
      if (it.type === "file") {
        for (const a of fileDepAliases(it.id)) byId.set(a, it);
        const key = it.metadata?.["key"];
        if (typeof key === "string" && key) {
          byId.set(key, it);
          byId.set(normalizeFileDepId(key), it);
        }
      }
    }
  }
  return byId;
}

/**
 * Build a dependency-ordered migration plan from a catalog and the selected ids.
 * Unknown ids (not present in the catalog) are reported, not silently dropped.
 */
export function planMigration(catalog: Catalog, selectedIds: Iterable<string>): MigrationPlan {
  const byId = indexCatalog(catalog);

  const selected = new Set(selectedIds);
  const resolved = resolveDependencies(catalog, selected);

  const addedByDependencies: string[] = [];
  const unknownIds: string[] = [];
  const byType = new Map<ArtifactType, string[]>();
  const seenCanonical = new Set<string>();

  for (const id of resolved) {
    const item = byId.get(id) ?? byId.get(normalizeFileDepId(id));
    if (!item) { unknownIds.push(id); continue; }
    if (seenCanonical.has(item.id)) continue;
    seenCanonical.add(item.id);
    if (!selected.has(item.id) && !selected.has(id)) addedByDependencies.push(item.id);
    const list = byType.get(item.type) ?? [];
    list.push(item.id);
    byType.set(item.type, list);
  }

  const steps: MigrationStep[] = [];
  for (const type of TYPE_ORDER) {
    const ids = byType.get(type);
    if (ids && ids.length) steps.push({ type, ids });
  }

  return {
    steps,
    selectedCount: selected.size,
    resolvedCount: seenCanonical.size,
    addedByDependencies,
    unknownIds,
  };
}

/** Parse a --select value: comma/space/newline-separated ids, or @file to read a file's lines. */
export function parseSelection(raw: string, readFile?: (p: string) => string): string[] {
  let text = raw;
  if (raw.startsWith("@") && readFile) text = readFile(raw.slice(1));
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
