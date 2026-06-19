/**
 * Shared utility functions used across cloning packages.
 */

/**
 * Replace all occurrences of sourceDomain with targetDomain anywhere inside
 * a JSON-serialisable value. Uses JSON.stringify → replaceAll → JSON.parse so
 * it works regardless of where the URL appears in nested structures.
 *
 * Returns the original value unchanged if either domain arg is null/empty or
 * if the value itself is null/undefined.
 */
export function rewriteCdnUrls(
  content: unknown,
  sourceDomain: string | null,
  targetDomain: string | null
): unknown {
  if (!sourceDomain || !targetDomain || content == null) return content;
  const serialised = JSON.stringify(content);
  if (serialised === undefined) return content;
  return JSON.parse(serialised.replaceAll(sourceDomain, targetDomain)) as unknown;
}
