/**
 * Group catalog selection ids for the root `purge` command.
 *
 * Catalog rows of type `model` mean "purge all entries of this model" — they
 * must never be passed as cms-entry `--select` ids (modelId ≠ entryId).
 */

export type PurgeItemMeta = { type: string; model?: string };

export type PurgeTypeGroup = { ids: string[]; models: Set<string> };

export function groupPurgeSelection(
  ids: string[],
  meta: Map<string, PurgeItemMeta>
): {
  byType: Map<string, PurgeTypeGroup>;
  modelFullPurge: Set<string>;
  unknown: string[];
} {
  const byType = new Map<string, PurgeTypeGroup>();
  const modelFullPurge = new Set<string>();
  const unknown: string[] = [];

  for (const id of ids) {
    const m = meta.get(id);
    if (!m) {
      unknown.push(id);
      continue;
    }
    if (m.type === "model") {
      modelFullPurge.add(id);
      const g = byType.get("cms-entry") ?? { ids: [], models: new Set<string>() };
      g.models.add(id);
      byType.set("cms-entry", g);
      continue;
    }
    const g = byType.get(m.type) ?? { ids: [], models: new Set<string>() };
    g.ids.push(id);
    if (m.model) g.models.add(m.model);
    byType.set(m.type, g);
  }

  return { byType, modelFullPurge, unknown };
}
