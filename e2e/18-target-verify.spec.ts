/**
 * Live e2e: presence, import-as-draft ON/OFF, and CDN locality.
 *
 * Drives one real (non–dry-run) migrate per content type through the Copy
 * workspace UI, then probes the TARGET tenant to confirm the item landed,
 * draft/publish behavior, and that migrated content references the target CDN.
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  openMigrateAdvanced,
  PK_TO_ARTIFACT,
  selectOnlyChip,
  waitForJob,
  waitMigrateUiDone,
} from "./helpers";
import {
  loadVerifyEnv,
  verifyModel,
  verifyCmsEntry,
  verifyPage,
  verifyRedirect,
  verifyFile,
} from "./target-verify";
import {
  assertTargetLocalCdn,
  assertMigratedFileRefs,
  hostOf,
  normHost,
  tenantsDiffer,
} from "./cdn-assert";
import { defaultKeymapDir, loadStore, selectUrlMap } from "../src/shared/keymap";

/** Prefer a tiny binary so the live file migrate stays bounded. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Stable source fixtures for page and small-file migrate scenarios. */
const FIXTURE_PAGE_ID = "6a206fac1adb340002532f0d";
const FIXTURE_PAGE_PATH = "/qa-test";
const FIXTURE_FILE_KEY = "c645810a420f74ea35b54acd47bd71e616de5d84.png";

type CatalogItem = {
  type: string;
  id: string;
  label?: string;
  metadata?: Record<string, unknown>;
  dependsOn?: string[];
};
type CatalogSection = { type: string; items?: CatalogItem[]; note?: string };
type Catalog = { sections?: CatalogSection[] };
type Ledger = {
  id: string;
  status: string;
  items: Array<{ type: string; id: string; status: string; action?: string; error?: string | null }>;
};

type Chip = "cms-models" | "cms-entries" | "page-builder" | "redirects" | "file-manager";

/** A source item is "published/live" per the catalog's own `status`/`live` metadata. */
function isPublished(item: CatalogItem): boolean {
  return item.metadata?.["status"] === "published" || item.metadata?.["live"] === true;
}

type PreVerify = { found: boolean; status: string | null; version: number | null };

/** Post-migrate version rules for as-draft OFF (scenarios 6/7). */
function assertPublishedVersion(
  result: { version: number | null },
  pre: PreVerify | null,
  ledgerItem: { status: string; action?: string } | undefined,
  label: string
): void {
  if (pre?.found && ledgerItem?.status !== "skipped") {
    const preV = Number(pre.version);
    const postV = Number(result.version);
    if (pre.status === "published" && !Number.isNaN(preV) && !Number.isNaN(postV)) {
      // Strict `>` only on a real *update* of an already-published target row.
      // `created` pages/entries often start at version 1 even when a prior path
      // match existed in the pre-snapshot (page ids are not preserved cross-tenant).
      if (pre.version != null && ledgerItem?.action === "updated") {
        expect(
          postV > preV,
          `${label}: expected version > ${pre.version} (ledger action=${ledgerItem?.action}), got ${result.version}`
        ).toBeTruthy();
      } else {
        expect(
          postV >= preV,
          `${label}: expected version >= ${pre.version}, got ${result.version} (ledger status=${ledgerItem?.status}, action=${ledgerItem?.action})`
        ).toBeTruthy();
      }
    } else {
      // First publish of a draft revision — version may stay equal (e.g. draft v1 → published v1).
      expect(result.version, `${label}: published but version is null`).not.toBeNull();
    }
  } else if (!pre?.found) {
    expect(result.version, `${label}: published but version is null`).not.toBeNull();
  }
}

/** Key-map sourceUrl→targetUrl for the configured tenant pair. */
function tenantUrlMap(sourceTenant: string, targetTenant: string): Record<string, string> {
  return selectUrlMap(loadStore(defaultKeymapDir()), sourceTenant, targetTenant);
}

/**
 * Host locality (distinct CDN domains) + file-ref remaps (shared CDN /
 * multi-tenant). When SOURCE_CDN_DOMAIN === TARGET_CDN_DOMAIN, tenantsDiffer
 * decides whether this is a real cross-tenant migrate that must honor the
 * key-map; same-tenant copies skip the remap assert when the map is empty.
 */
function assertTargetFileLocality(
  payload: unknown,
  env: { sourceTenant: string; targetTenant: string; sourceCdn: string; targetCdn: string },
  label: string
): void {
  if (!env.sourceCdn || !env.targetCdn) return;
  assertTargetLocalCdn(payload, {
    sourceCdn: env.sourceCdn,
    targetCdn: env.targetCdn,
    sourceTenant: env.sourceTenant,
    targetTenant: env.targetTenant,
    label,
  });
  const urlMap = tenantUrlMap(env.sourceTenant, env.targetTenant);
  // Cross-tenant shared CDN: always run remap check (may no-op if map empty /
  // payload has no intersecting URLs). Same-tenant: only when map has remaps.
  if (tenantsDiffer(env.sourceTenant, env.targetTenant) || Object.keys(urlMap).length > 0) {
    assertMigratedFileRefs(payload, {
      label,
      sourceTenant: env.sourceTenant,
      targetTenant: env.targetTenant,
      urlMap,
    });
  }
}

/**
 * Pick a cms-entry catalog item that is NOT already published on target, so
 * as-draft ON can be proven to actually leave it in draft (rather than
 * inheriting an already-published row from a prior skip-identical run).
 * Probes up to `maxProbes` candidates via a direct target read; prefers a
 * missing target row, falls back to one already in `draft`, and finally
 * falls back to the first candidate with a resolvable model (old behavior)
 * so the test still runs (and can then correctly skip) rather than aborting.
 */
async function pickUnpublishedCmsEntry(cat: Catalog, maxProbes = 20): Promise<CatalogItem | null> {
  const items = ((cat.sections || []).find((s) => s.type === "cms-entry")?.items || []).filter(
    (it) => !!it.dependsOn?.[0]
  );
  let draftFallback: CatalogItem | null = null;
  for (let i = 0; i < Math.min(items.length, maxProbes); i++) {
    const it = items[i]!;
    try {
      const probe = await verifyCmsEntry(it.dependsOn![0]!, it.id);
      if (!probe.found) return it;
      if (!draftFallback && probe.status === "draft") draftFallback = it;
    } catch {
      // Probe failed (e.g. model not on target yet) — try the next candidate.
    }
  }
  // Never fall back to an already-published target row: as-draft ON cannot
  // demote it, and Manage list often still reports `published` after update.
  return draftFallback;
}

/**
 * Pick a published cms-entry catalog item whose target row is missing or
 * still `draft`, so as-draft OFF is forced to actually run its publish path
 * rather than short-circuiting on an already-published target (skip-identical
 * pollution). Probes up to `maxProbes` candidates; falls back to the first
 * published candidate (old behavior) if none qualify.
 */
async function pickPublishableCmsEntry(cat: Catalog, maxProbes = 8): Promise<CatalogItem | null> {
  const items = ((cat.sections || []).find((s) => s.type === "cms-entry")?.items || []).filter(
    (it) => isPublished(it) && !!it.dependsOn?.[0]
  );
  for (let i = 0; i < Math.min(items.length, maxProbes); i++) {
    const it = items[i]!;
    try {
      const probe = await verifyCmsEntry(it.dependsOn![0]!, it.id);
      if (!probe.found || probe.status === "draft") return it;
    } catch {
      // Probe failed — try the next candidate.
    }
  }
  return items[0] ?? null;
}

/**
 * Pick a page that is missing (or draft) on target for as-draft ON.
 * Prefers the QA TEST fixture when it is absent on target (clean migrate).
 * Never falls back to an already-published target row.
 */
async function pickUnpublishedPage(cat: Catalog, maxProbes = 20): Promise<CatalogItem | null> {
  const items = (cat.sections || []).find((s) => s.type === "page")?.items || [];
  const ordered = [
    ...items.filter((p) => p.id === FIXTURE_PAGE_ID || p.metadata?.["path"] === FIXTURE_PAGE_PATH),
    ...items.filter((p) => p.id !== FIXTURE_PAGE_ID && p.metadata?.["path"] !== FIXTURE_PAGE_PATH),
  ];
  let draftFallback: CatalogItem | null = null;
  for (let i = 0; i < Math.min(ordered.length, maxProbes); i++) {
    const it = ordered[i]!;
    const path = typeof it.metadata?.["path"] === "string" ? (it.metadata!["path"] as string) : undefined;
    try {
      const probe = await verifyPage({ entryId: it.id, path });
      if (!probe.found) return it;
      if (!draftFallback && probe.status !== "published") draftFallback = it;
    } catch {
      // Probe failed — try the next candidate.
    }
  }
  return draftFallback;
}

/** Prefer QA TEST when published on source; used for as-draft OFF. */
async function pickPublishedPageForMigrate(cat: Catalog): Promise<CatalogItem | null> {
  const pages = (cat.sections || []).find((s) => s.type === "page")?.items || [];
  const fixture =
    pages.find((p) => p.id === FIXTURE_PAGE_ID) ||
    pages.find((p) => p.metadata?.["path"] === FIXTURE_PAGE_PATH);
  if (fixture && isPublished(fixture)) return fixture;
  return pages.find(isPublished) ?? null;
}

function pickSmallestFile(cat: Catalog, maxBytes: number): CatalogItem | null {
  const files = (cat.sections || []).find((s) => s.type === "file")?.items || [];
  const byFixture = files.find((f) => {
    const key = String(f.metadata?.["key"] ?? "");
    const name = String(f.metadata?.["name"] ?? "");
    const label = String(f.label ?? "");
    const id = String(f.id ?? "");
    const hay = `${key}\n${name}\n${label}\n${id}`;
    return hay.includes(FIXTURE_FILE_KEY);
  });
  if (byFixture) return byFixture;
  const sized = files
    .filter((f) => {
      const size = f.metadata?.["size"];
      // Catalog may expose size as number (bytes) or a small MB float from UI export.
      if (typeof size === "number" && size > 0) {
        const bytes = size < 1000 ? size * 1024 * 1024 : size; // treat tiny numbers as MB
        return bytes <= maxBytes;
      }
      return false;
    })
    .sort((a, b) => {
      const sa = a.metadata!["size"] as number;
      const sb = b.metadata!["size"] as number;
      return sa - sb;
    });
  return sized[0] || null;
}


/**
 * Drive one live (non–dry-run) migrate through the Copy workspace: pick a
 * chip, load the catalog, select an item via `opts.pick`, set as-draft/dry
 * checkboxes + folder-mismatch allow, click Go, and wait for the job to
 * finish without error. Mirrors `liveMigrateOneSmallFile` in
 * e2e/17-live-binary-resume.spec.ts, generalized across all five chips.
 */
async function liveMigrateOne(
  page: Page,
  request: APIRequestContext,
  opts: {
    chip: Chip;
    pick: (cat: Catalog) => CatalogItem | null | Promise<CatalogItem | null>;
    asDraft?: boolean; // default true
    uncheckDry?: boolean; // default true
    /**
     * Date preset for the catalog load. Default `last_30d`. Pass `""` to clear
     * the preset (needed for fixtures older than 30d, e.g. QA TEST page).
     */
    datePreset?: string;
    /** Optional name/path filter applied before catalog load (e.g. file fixture key). */
    nameContains?: string;
    /** Invoked with the picked item right before the migrate is submitted — lets
     * a caller snapshot target state (e.g. pre-migrate version) at the latest
     * safe point before the mutation fires. */
    beforeGo?: (item: CatalogItem) => Promise<void>;
  }
): Promise<{ jobId: string; item: CatalogItem; sourceTenant: string; targetTenant: string }> {
  const env = loadVerifyEnv();

  await page.goto("/");
  await goWorkspace(page, "copy");
  await selectOnlyChip(page.locator("#cpTypes"), opts.chip);

  // Models have no date-where clause — the Models Filter row has no date controls,
  // so skip enabling/dating it and rely on the chip alone to scope the migrate.
  if (opts.chip !== "cms-models") {
    const art = PK_TO_ARTIFACT[opts.chip];
    await openFilters(page, "cp");
    await enableArtifactFilter(page, "cp", art);
    const preset = opts.datePreset !== undefined ? opts.datePreset : "last_30d";
    if (preset) await page.locator(`#cpDatePreset-${art}`).selectOption(preset);
    if (opts.nameContains) {
      const nameId =
        opts.chip === "file-manager"
          ? "#cpNameFiles"
          : opts.chip === "page-builder"
            ? "#cpNamePages"
            : opts.chip === "redirects"
              ? "#cpNameRedirects"
              : opts.chip === "cms-entries"
                ? "#cpNameEntries"
                : null;
      if (nameId) await page.locator(nameId).fill(opts.nameContains);
    }
  }

  const catalogResp = page.waitForResponse(
    (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
  );
  await page.locator("#cpLoad").click();
  const catRes = await catalogResp;
  const cat = (await catRes.json()) as Catalog & { error?: string };
  test.skip(!catRes.ok() || !!cat.error, cat.error || "catalog failed");

  const item = await opts.pick(cat);
  test.skip(!item, `No suitable ${opts.chip} fixture in catalog`);

  await expect(page.locator("#cpSelect")).toBeVisible({ timeout: 60_000 });
  const rows = page.locator("#cpCatalog .trow");
  const n = await rows.count();
  test.skip(n === 0, "No catalog rows");
  let checked = false;
  for (let i = 0; i < n; i++) {
    const id = await rows.nth(i).getAttribute("data-id");
    if (id === item!.id) {
      await rows.nth(i).locator(".cb2").check();
      checked = true;
      break;
    }
  }
  // Only migrate the picked item — do not fall back to another catalog row.
  test.skip(!checked, `Catalog row for picked ${opts.chip} item "${item!.id}" not found in UI — refusing to migrate a different item`);

  const uncheckDry = opts.uncheckDry ?? true;
  if (uncheckDry) await page.locator("#cpDry").uncheck();
  else await page.locator("#cpDry").check();

  const asDraft = opts.asDraft ?? true;
  if (asDraft) await page.locator("#cpAsDraft").check();
  else await page.locator("#cpAsDraft").uncheck();

  await openMigrateAdvanced(page);
  await page.locator("#cpFolder").check();

  if (opts.chip === "file-manager") {
    const size = item!.metadata?.["size"];
    const sizeMb =
      typeof size === "number" && size > 0
        ? Math.max(1, Math.ceil((size + 1) / (1024 * 1024)))
        : 1; // fixture PNG is ~0.01 MB; catalog size may be missing ("—")
    await page.locator("#cpMaxMb").fill(String(sizeMb));
  }

  if (opts.beforeGo) await opts.beforeGo(item!);

  const migResp = page.waitForResponse(
    (r) => r.url().includes("/api/migrate") && r.request().method() === "POST"
  );
  await page.locator("#cpGo").click();
  const migBody = (await (await migResp).json()) as { jobId: string; dryRun?: boolean; error?: string };
  expect(migBody.error || "").toBeFalsy();
  expect(migBody.dryRun).toBeFalsy();
  expect(migBody.jobId).toBeTruthy();

  const job = await waitForJob(request, migBody.jobId, 15 * 60 * 1000);
  expect(job.status, job.error || `${opts.chip} live migrate job`).not.toBe("error");
  await waitMigrateUiDone(page);

  return {
    jobId: migBody.jobId,
    item: item!,
    sourceTenant: env.sourceTenant,
    targetTenant: env.targetTenant,
  };
}

test.describe("Live target verification — presence + as-draft ON + CDN", () => {
  test("1. model — migrate one, verify present on target", async ({ page, request }) => {
    const { item } = await liveMigrateOne(page, request, {
      chip: "cms-models",
      pick: (cat) => (cat.sections || []).find((s) => s.type === "model")?.items?.[0] ?? null,
    });

    const result = await verifyModel(item.id);
    expect(result.found, `model "${item.id}" not found on target`).toBeTruthy();
  });

  test("2. file — migrate smallest ≤2MB, verify present + target CDN src", async ({ page, request }) => {
    const env = loadVerifyEnv();
    const { jobId, item } = await liveMigrateOne(page, request, {
      chip: "file-manager",
      // Prefer FIXTURE_FILE_KEY; clear date + name filter so the 0.01 MB PNG catalogs.
      datePreset: "",
      nameContains: FIXTURE_FILE_KEY,
      pick: (cat) => pickSmallestFile(cat, MAX_FILE_BYTES),
    });

    const ledgerRes = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(ledgerRes.ok()).toBeTruthy();
    const ledger = (await ledgerRes.json()) as Ledger;
    const fileItem = ledger.items.find((i) => i.type === "file" && i.id === item.id);
    expect(
      fileItem,
      ledger.items.map((i) => `${i.type}:${i.id}=${i.status}`).join(" | ") || "no ledger items"
    ).toBeTruthy();
    expect(["done", "skipped"]).toContain(fileItem!.status);

    // Catalog `id` is the file's src CDN URL (matches entry file-field deps);
    // the actual fileId used by the keymap store is `metadata.fmId`.
    const fileId = (item.metadata?.["fmId"] as string | undefined) ?? item.id;
    const result = await verifyFile(fileId, { sourceKey: item.metadata?.["key"] as string | undefined });
    expect(result.found, `file "${fileId}" (src=${item.id}) not found on target`).toBeTruthy();
    expect(result.src, `file "${fileId}" missing src on target`).toBeTruthy();

    // Shared CDN (same domain, different tenants) is normal — prove the file
    // landed via keymap remap when the S3 key changed; host equality alone
    // is not a skip/fail signal.
    if (env.sourceCdn && env.targetCdn) {
      assertTargetLocalCdn(
        { src: result.src },
        {
          sourceCdn: env.sourceCdn,
          targetCdn: env.targetCdn,
          sourceTenant: env.sourceTenant,
          targetTenant: env.targetTenant,
          label: `file ${item.id}`,
        }
      );
      const srcCdnHost = normHost(env.sourceCdn);
      const tgt = normHost(env.targetCdn);
      if (srcCdnHost !== tgt) {
        const host = hostOf(result.src || "");
        expect(
          !!host && (host === tgt || host.endsWith("." + tgt)),
          `file ${item.id}: src host "${host}" is not the target CDN "${tgt}" (src=${result.src})`
        ).toBeTruthy();
      }
    }
    if (tenantsDiffer(env.sourceTenant, env.targetTenant)) {
      const urlMap = tenantUrlMap(env.sourceTenant, env.targetTenant);
      const sourceUrl = item.id; // catalog id is the source CDN src
      if (urlMap[sourceUrl]) {
        expect(
          result.src,
          `file "${fileId}": target src should match keymap remap for ${sourceUrl}`
        ).toBe(urlMap[sourceUrl]);
      }
    }
  });

  test("3. redirect — migrate one, verify present + redirectTo", async ({ page, request }) => {
    const { item } = await liveMigrateOne(page, request, {
      chip: "redirects",
      pick: (cat) => (cat.sections || []).find((s) => s.type === "redirect")?.items?.[0] ?? null,
    });

    const result = await verifyRedirect(item.id);
    expect(result.found, `redirect "${item.id}" not found on target`).toBeTruthy();
    expect(result.redirectTo || "").not.toBe("");
  });

  test("4. cms-entry as-draft ON — verify present, draft, target-local CDN", async ({ page, request }) => {
    const env = loadVerifyEnv();
    let pre: PreVerify | null = null;

    const { jobId, item } = await liveMigrateOne(page, request, {
      chip: "cms-entries",
      pick: (cat) => pickUnpublishedCmsEntry(cat),
      asDraft: true,
      beforeGo: async (picked) => {
        const modelId = picked.dependsOn?.[0];
        if (modelId) pre = await verifyCmsEntry(modelId, picked.id);
      },
    });

    const modelId = item.dependsOn?.[0];
    test.skip(!modelId, `cms-entry "${item.id}" has no dependsOn[0] modelId`);

    const result = await verifyCmsEntry(modelId!, item.id);
    expect(result.found, `cms-entry "${item.id}" not found on target`).toBeTruthy();

    const ledgerRes = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(ledgerRes.ok()).toBeTruthy();
    const ledger = (await ledgerRes.json()) as Ledger;
    const ledgerItem = ledger.items.find((i) => i.type === "cms-entry" && i.id === item.id);

    // skip-identical / already-live: as-draft ON cannot demote a published
    // revision; Manage list also often returns live `published` after an
    // update that only minted a draft revision.
    test.skip(
      result.status === "published" &&
        (ledgerItem?.status === "skipped" || pre?.status === "published"),
      `cms-entry "${item.id}" already published on target (ledger=${ledgerItem?.status ?? "?"}, pre=${pre?.status ?? "none"}) — as-draft ON cannot demote it`
    );

    expect(
      result.status,
      `cms-entry "${item.id}" is published with as-draft ON (ledger status=${ledgerItem?.status ?? "?"})`
    ).not.toBe("published");

    assertTargetFileLocality(result.values, env, `cms-entry ${item.id}`);
  });

  test("5. page as-draft ON — verify present, draft, target-local CDN", async ({ page, request }) => {
    const env = loadVerifyEnv();
    let pre: PreVerify | null = null;
    const { item } = await liveMigrateOne(page, request, {
      chip: "page-builder",
      // Clear date filter so the fixture page is included in the catalog.
      datePreset: "",
      nameContains: "qa-test",
      pick: (cat) => pickUnpublishedPage(cat),
      asDraft: true,
      beforeGo: async (picked) => {
        const path =
          typeof picked.metadata?.["path"] === "string" ? (picked.metadata!["path"] as string) : undefined;
        pre = await verifyPage({ entryId: picked.id, path });
      },
    });

    // Clean migrate: page should not have been published on target beforehand.
    expect(
      !pre?.found || pre.status !== "published",
      `page "${item.id}" was already published on target — delete it for a clean as-draft ON create`
    ).toBeTruthy();

    const path = typeof item.metadata?.["path"] === "string" ? (item.metadata!["path"] as string) : undefined;
    const result = await verifyPage({ entryId: item.id, path });
    expect(result.found, `page "${item.id}" not found on target`).toBeTruthy();
    expect(result.status, `page "${item.id}" is published with as-draft ON`).not.toBe("published");

    assertTargetFileLocality(result.page, env, `page ${item.id}`);
  });

  test("6. cms-entry as-draft OFF — published source publishes on target, revision advances", async ({
    page,
    request,
  }) => {
    let modelId: string | undefined;
    let pre: PreVerify | null = null;

    const { jobId, item } = await liveMigrateOne(page, request, {
      chip: "cms-entries",
      pick: (cat) => pickPublishableCmsEntry(cat),
      asDraft: false,
      beforeGo: async (picked) => {
        modelId = picked.dependsOn?.[0];
        if (modelId) pre = await verifyCmsEntry(modelId, picked.id);
      },
    });

    test.skip(!modelId, `cms-entry "${item.id}" has no dependsOn[0] modelId`);

    const result = await verifyCmsEntry(modelId!, item.id);
    expect(result.found, `cms-entry "${item.id}" not found on target`).toBeTruthy();

    const ledgerRes = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(ledgerRes.ok()).toBeTruthy();
    const ledger = (await ledgerRes.json()) as Ledger;
    const ledgerItem = ledger.items.find((i) => i.type === "cms-entry" && i.id === item.id);

    expect(
      result.status,
      `cms-entry "${item.id}" is not published with as-draft OFF (ledger status=${ledgerItem?.status ?? "?"}, pre-migrate target status=${pre?.status ?? "none"})`
    ).toBe("published");

    assertPublishedVersion(result, pre, ledgerItem, `cms-entry "${item.id}"`);
    assertTargetFileLocality(result.values, loadVerifyEnv(), `cms-entry ${item.id}`);
  });

  test("7. page as-draft OFF — published source publishes on target, revision advances", async ({
    page,
    request,
  }) => {
    let pre: PreVerify | null = null;

    const { jobId, item } = await liveMigrateOne(page, request, {
      chip: "page-builder",
      // Clear date filter so the fixture page is included in the catalog.
      datePreset: "",
      nameContains: "qa-test",
      pick: (cat) => pickPublishedPageForMigrate(cat),
      asDraft: false,
      beforeGo: async (picked) => {
        const path = typeof picked.metadata?.["path"] === "string" ? (picked.metadata!["path"] as string) : undefined;
        pre = await verifyPage({ entryId: picked.id, path });
      },
    });

    expect(
      !pre?.found || pre.status !== "published",
      `page "${item.id}" was already published on target before as-draft OFF — delete it for a clean publish validation`
    ).toBeTruthy();

    const path = typeof item.metadata?.["path"] === "string" ? (item.metadata!["path"] as string) : undefined;
    const result = await verifyPage({ entryId: item.id, path });
    expect(result.found, `page "${item.id}" not found on target`).toBeTruthy();
    expect(result.status, `page "${item.id}" is not published with as-draft OFF`).toBe("published");

    const ledgerRes = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(ledgerRes.ok()).toBeTruthy();
    const ledger = (await ledgerRes.json()) as Ledger;
    const ledgerItem = ledger.items.find((i) => i.type === "page" && i.id === item.id);

    assertPublishedVersion(result, pre, ledgerItem, `page "${item.id}"`);
    assertTargetFileLocality(result.page, loadVerifyEnv(), `page ${item.id}`);
  });
});
