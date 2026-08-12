/**
 * Page identity helpers shared by export --select, import --select, and purge.
 */

/** Narrowing filter for --select. Empty/absent selection keeps everything. */
export function selectedFilter(
  onlyIds: Set<string> | null | undefined,
  ...keys: Array<string | null | undefined>
): boolean {
  if (!onlyIds || onlyIds.size === 0) return true;
  return keys.some((k) => k != null && k !== "" && onlyIds.has(k));
}

/** Strip #revision suffix (catalog ids are bare entryIds). */
export function barePageId(value: string | null | undefined): string {
  return String(value ?? "").split("#")[0];
}

/** Collect a page's identifier keys (id/pid/entryId/path/slug + properties.*) for selection matching. */
export function pageKeys(page: Record<string, unknown>): Array<string | undefined> {
  const out: string[] = [];
  for (const f of ["id", "pid", "entryId", "path", "slug"]) {
    const v = page[f];
    if (typeof v !== "string" || !v) continue;
    out.push(v);
    const bare = barePageId(v);
    if (bare && bare !== v) out.push(bare);
  }
  // properties is a JSON scalar on Kibo WbPage — request bare `properties`, then read path/slug.
  let props = page["properties"] as unknown;
  if (typeof props === "string") {
    try { props = JSON.parse(props); } catch { props = null; }
  }
  if (props && typeof props === "object") {
    const o = props as Record<string, unknown>;
    for (const f of ["path", "slug", "title"]) {
      const v = o[f];
      if (typeof v === "string" && v) out.push(v);
    }
  }
  return out;
}

/** Path used for upsert lookup — root path, else properties.path. */
export function pagePathOf(page: Record<string, unknown>): string {
  const root = page["path"];
  if (typeof root === "string" && root) return root;
  let props = page["properties"] as unknown;
  if (typeof props === "string") {
    try { props = JSON.parse(props); } catch { props = null; }
  }
  if (props && typeof props === "object") {
    const p = (props as Record<string, unknown>)["path"];
    if (typeof p === "string" && p) return p;
  }
  return "";
}
