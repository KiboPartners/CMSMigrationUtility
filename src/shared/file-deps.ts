/**
 * Normalize file dependency ids so page/entry edges match file catalog ids.
 *
 * Catalog file ids are usually the CDN `src` URL (else S3 `key`). Page builders
 * scrape full URLs out of JSON; those often carry query/hash or host casing
 * differences that break exact Set/Map lookups in planMigration.
 */

/** Strip query/hash, lowercase host, trim trailing slash (except root). */
export function normalizeFileDepId(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    u.hash = "";
    u.search = "";
    const host = u.hostname.toLowerCase();
    let pathname = u.pathname || "/";
    // Prefer the stable /files/… suffix when present (ignore CDN path prefixes).
    const lower = pathname.toLowerCase();
    const filesIdx = lower.indexOf("/files/");
    if (filesIdx >= 0) pathname = pathname.slice(filesIdx);
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${u.protocol}//${host}${pathname}`;
  } catch {
    return s.replace(/[?#].*$/, "");
  }
}

/**
 * Guess an S3-style key from a dep id (URL or bare key).
 * e.g. https://cdn…/files/abc/original/x.png → abc/original/x.png
 */
export function fileKeyFromDepId(id: string): string | null {
  const n = normalizeFileDepId(id);
  if (!n) return null;
  if (!/^https?:\/\//i.test(n)) return n;
  const m = n.match(/\/files\/(.+)$/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/** All lookup keys that should resolve to the same file catalog row. */
export function fileDepAliases(raw: string): string[] {
  const n = normalizeFileDepId(raw);
  const out = new Set<string>();
  if (raw) out.add(String(raw).trim());
  if (n) out.add(n);
  const key = fileKeyFromDepId(raw);
  if (key) out.add(key);
  return [...out];
}

/** Expand a selection of file ids with URL/key aliases for matching. */
export function expandFileSelectionIds(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    for (const a of fileDepAliases(id)) out.add(a);
  }
  return out;
}
