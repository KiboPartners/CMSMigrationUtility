/**
 * CDN / file-URL assertions for live target-verify e2e.
 *
 * Hosts alone are not enough on multi-tenant installs that share one CDN
 * domain: SOURCE_CDN_DOMAIN === TARGET_CDN_DOMAIN is normal, and tenants are
 * distinguished by SOURCE_TENANT / TARGET_TENANT. In that case we validate
 * file references via the central key-map (sourceUrl → targetUrl) instead of
 * treating identical CDN hosts as "nothing to check".
 */

export function collectHttpsUrls(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectHttpsUrls(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectHttpsUrls(v, out);
  }
  return out;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function normHost(h: string): string {
  return h.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

export function tenantsDiffer(sourceTenant: string, targetTenant: string): boolean {
  return (sourceTenant || "").trim() !== "" && (targetTenant || "").trim() !== "" && sourceTenant.trim() !== targetTenant.trim();
}

/**
 * Fail if the payload still embeds absolute URLs on the source CDN host.
 *
 * When CDN hosts are identical:
 * - same tenant → no-op (same-env copy; host check has no signal)
 * - different tenants (shared CDN, multi-tenant) → host check is also a
 *   no-op for the host itself; callers must use `assertMigratedFileRefs`
 *   against the key-map for that tenant pair.
 */
export function assertTargetLocalCdn(
  payload: unknown,
  opts: {
    sourceCdn: string;
    targetCdn: string;
    label: string;
    sourceTenant?: string;
    targetTenant?: string;
  }
): void {
  const src = normHost(opts.sourceCdn);
  const tgt = normHost(opts.targetCdn);
  if (!src || !tgt) throw new Error(`assertTargetLocalCdn(${opts.label}): missing source/target CDN domain`);

  if (src === tgt) {
    // Shared CDN — host string cannot prove locality. Cross-tenant migrates
    // still need file-ref checks via assertMigratedFileRefs + keymap.
    return;
  }

  for (const url of collectHttpsUrls(payload)) {
    const host = hostOf(url);
    if (!host) continue;
    if (host === src || host.endsWith("." + src)) {
      throw new Error(`${opts.label}: still references source CDN: ${url}`);
    }
    if (host === tgt || host.endsWith("." + tgt)) continue;
    // Third-party hosts ignored
  }
}

/**
 * Fail if the payload still contains any sourceUrl that the key-map says
 * should have been rewritten to targetUrl for this tenant pair.
 *
 * On shared-CDN multi-tenant installs this is the real file-reference check:
 * domain swap is a no-op, so only key-changed remaps prove the import used
 * the target file object.
 *
 * Same-tenant (sourceTenant === targetTenant): no-op unless urlMap is non-empty
 * and still contains a stale sourceUrl in the payload.
 */
export function assertMigratedFileRefs(
  payload: unknown,
  opts: {
    label: string;
    sourceTenant: string;
    targetTenant: string;
    /** sourceUrl → targetUrl for the migrate tenant pair */
    urlMap: Record<string, string>;
  }
): void {
  const { label, sourceTenant, targetTenant, urlMap } = opts;
  const entries = Object.entries(urlMap || {}).filter(([from, to]) => !!from && !!to && from !== to);
  if (entries.length === 0) {
    // Nothing remapped for this pair — cannot assert key-changed refs.
    // Cross-tenant shared-CDN without remaps is still OK for payloads that
    // only embed same-key URLs (domain-identical).
    return;
  }

  const crossTenant = tenantsDiffer(sourceTenant, targetTenant);
  const urls = collectHttpsUrls(payload);
  if (urls.length === 0) return;

  const sourceUrls = new Set(entries.map(([from]) => from));
  const targetBySource = new Map(entries);

  for (const url of urls) {
    if (!sourceUrls.has(url)) continue;
    const expected = targetBySource.get(url);
    throw new Error(
      `${label}: still references source file URL that should have been remapped` +
        (crossTenant ? ` (tenants ${sourceTenant} → ${targetTenant}, shared CDN)` : "") +
        `\n  found   : ${url}` +
        `\n  expected: ${expected}`
    );
  }
}
