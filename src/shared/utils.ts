/**
 * Shared utility functions used across cloning packages.
 */

import fs from "fs";

/**
 * Replace all occurrences of sourceDomain with targetDomain anywhere inside
 * a JSON-serialisable value. Uses JSON.stringify → replaceAll → JSON.parse so
 * it works regardless of where the URL appears in nested structures.
 *
 * When urlMap is given, full source-URL → target-URL remaps are applied FIRST
 * (for files whose S3 key changed), then the domain swap covers key-unchanged
 * files. Backward compatible: omitting urlMap behaves exactly as before.
 *
 * Returns the original value unchanged if the value itself is null/undefined.
 */
export function rewriteCdnUrls(
  content: unknown,
  sourceDomain: string | null,
  targetDomain: string | null,
  urlMap?: Record<string, string>
): unknown {
  if (content == null) return content;
  let serialised = JSON.stringify(content);
  if (serialised === undefined) return content;
  // Full-URL remaps first (files whose key changed) — most specific.
  if (urlMap) {
    for (const [from, to] of Object.entries(urlMap)) {
      if (from && to) serialised = serialised.replaceAll(from, to);
    }
  }
  // Then the domain swap for key-unchanged files.
  if (sourceDomain && targetDomain) {
    serialised = serialised.replaceAll(sourceDomain, targetDomain);
  }
  return JSON.parse(serialised) as unknown;
}

/**
 * Load a key-map JSON file (Record<sourceUrl, targetUrl>) from disk.
 * Returns {} if the path is falsy, the file doesn't exist, or it can't be parsed.
 * This makes it safe to pass an unconditional path — the file is optional.
 */
export function loadKeyMap(p: string | undefined): Record<string, string> {
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Whether an exported CMS entry/page was published on the source.
 * Prefers `meta.status`, then root `status`. Missing/unknown → not published.
 */
export function sourceIsPublished(item: Record<string, unknown>): boolean {
  const meta = item["meta"];
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const s = (meta as Record<string, unknown>)["status"];
    if (typeof s === "string") return s === "published";
  }
  return item["status"] === "published";
}

/** Publish after upsert only when not in as-draft mode and the source was published. */
export function shouldPublishAfterUpsert(asDraft: boolean, sourcePublished: boolean): boolean {
  return !asDraft && sourcePublished;
}
