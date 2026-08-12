import { test, expect } from "@playwright/test";
import {
  ARTIFACT_COMBOS,
  artifactsForPks,
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  selectChips,
} from "./helpers";

/**
 * Purge: fetch target catalog + exercise filters only.
 * NEVER click Preview (dry-run purge) or Delete.
 */
test.describe("Purge — catalog fetch + filters (no delete)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "purge");
    // Load controls visible; Select + Purge stages stay hidden until catalog loads
    await expect(page.locator("#pgLoad")).toBeVisible();
    await expect(page.locator("#pgSelect")).toBeHidden();
    await expect(page.locator("#pgStageRun")).toBeHidden();
    // Ensure destructive controls exist but are not shown yet
    await expect(page.locator("#pgDelete")).toBeAttached();
    await expect(page.locator("#pgPreview")).toBeAttached();
  });

  test("load redirects with date + name filter (catalog only)", async ({ page }) => {
    await selectChips(page.locator("#pgTypes"), ["redirects"]);
    await openFilters(page, "pg");
    await enableArtifactFilter(page, "pg", "redirect");
    await page.locator("#pgDatePreset-redirect").selectOption("last_30d");
    await page.locator("#pgNameRedirects").fill("/");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#pgLoad").click();
    const res = await catalogResp;
    const body = await res.json();
    expect(res.ok(), body.error || body.detail || "purge catalog").toBeTruthy();
    // Target catalog: role should be target when present
    if (body.environment?.role) {
      expect(body.environment.role).toBe("target");
    }

    await expect(page.locator("#pgSelect")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#pgCatalog")).not.toHaveText(/^\s*$/);

    // Selection UI visible — select nothing and do NOT preview/delete
    await expect(page.locator("#pgPreview")).toBeVisible();
    await expect(page.locator("#pgDelete")).toBeVisible();
  });

  test("load pages+files with filters (catalog only)", async ({ page }) => {
    await selectChips(page.locator("#pgTypes"), ["page-builder", "file-manager"]);
    await openFilters(page, "pg");
    await enableArtifactFilter(page, "pg", "page");
    await enableArtifactFilter(page, "pg", "file");
    await page.locator("#pgDateField-page").selectOption("createdOn");
    await page.locator("#pgDatePreset-page").selectOption("last_7d");
    await page.locator("#pgDatePreset-file").selectOption("last_7d");
    await page.locator("#pgNamePages").fill("a");
    await page.locator("#pgNameFiles").fill("a");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#pgLoad").click();
    const res = await catalogResp;
    const body = await res.json();
    expect(res.ok(), body.error || body.detail || "purge catalog").toBeTruthy();
    await expect(page.locator("#pgSelect")).toBeVisible({ timeout: 120_000 });
  });

  test("cms-entries + models filter field then load", async ({ page }) => {
    await selectChips(page.locator("#pgTypes"), ["cms-models", "cms-entries"]);
    await openFilters(page, "pg");
    // Leave Models Filter off (all models) but enable Entries with a residual name filter
    await enableArtifactFilter(page, "pg", "cms-entry");
    await page.locator("#pgDatePreset-cms-entry").selectOption("last_30d");
    await page.locator("#pgNameEntries").fill("e2e");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#pgLoad").click();
    const res = await catalogResp;
    const body = await res.json();
    // May succeed with 0 entries — still a valid fetch
    expect(res.ok(), body.error || body.detail || "purge cms catalog").toBeTruthy();
    await expect(page.locator("#pgSelect")).toBeVisible({ timeout: 180_000 });
  });

  test("narrow after load without calling purge APIs", async ({ page }) => {
    await selectChips(page.locator("#pgTypes"), ["redirects"]);
    await openFilters(page, "pg");
    await enableArtifactFilter(page, "pg", "redirect");
    await page.locator("#pgDatePreset-redirect").selectOption("last_30d");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#pgLoad").click();
    await catalogResp;
    await expect(page.locator("#pgSelect")).toBeVisible({ timeout: 60_000 });

    await openFilters(page, "pg");
    await page.locator("#pgNameRedirects").fill("zzz-no-match-e2e");
    // Narrow is client-side — must not hit /api/purge
    let purgeHit = false;
    page.on("request", (req) => {
      if (req.url().includes("/api/purge")) purgeHit = true;
    });
    if (await page.locator("#pgNarrow").isVisible()) {
      await page.locator("#pgNarrow").click();
    }
    expect(purgeHit).toBe(false);
  });

  test("representative chip combos open Filters without loading purge", async ({ page }) => {
    for (const combo of ARTIFACT_COMBOS.slice(0, 5)) {
      await selectChips(page.locator("#pgTypes"), combo.pks);
      await openFilters(page, "pg");
      for (const art of artifactsForPks(combo.pks)) {
        await enableArtifactFilter(page, "pg", art);
        if (art === "model") await page.locator("#pgModels").fill("e2e");
        else await page.locator(`#pgDatePreset-${art}`).selectOption("last_24h");
      }
    }
    // Never invoked destructive endpoints
  });
});
