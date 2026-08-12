/**
 * UI coverage for dependency hydration / auto-select (filters = discovery).
 * Uses a mocked /api/catalog/build so these tests do not need a live CMS catalog.
 */
import { test, expect } from "@playwright/test";
import { goWorkspace, selectOnlyChip } from "./helpers";

const FILE_DEP = "https://cdn.example.com/files/abc/original/hero.png";

const MOCK_CATALOG = {
  environment: { role: "source", tenant: "e2e", locale: "en-US" },
  generatedAt: new Date().toISOString(),
  sections: [
    {
      type: "page",
      total: 1,
      items: [
        {
          type: "page",
          id: "/home",
          label: "Home",
          dependsOn: [FILE_DEP],
          metadata: { name: "Home", path: "/home" },
        },
      ],
    },
    // File intentionally absent — simulates Files filter excluding the image.
    { type: "file", total: 0, items: [] },
  ],
};

test.describe("Hydrate deps UI — Migrate auto-include + uncheck warning", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/catalog/build", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_CATALOG),
      });
    });
  });

  test("PAGE script runs: Migrate tenants fill from /api/env", async ({ page, request }) => {
    const env = await (await request.get("/api/env")).json();
    await page.goto("/");
    await goWorkspace(page, "copy");
    await expect(page.locator("#cpSrc")).toHaveValue(env.source.tenant);
    await expect(page.locator("#cpTgt")).toHaveValue(env.target.tenant);
    await expect(page.locator("#cpSrcUrl")).not.toHaveText("—");
  });

  test("selecting a page merges missing file dep as checked dep row", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "copy");
    await selectOnlyChip(page.locator("#cpTypes"), "page-builder");

    await expect(page.locator("#cpStageRun")).toBeHidden();
    await page.locator("#cpLoad").click();
    await expect(page.locator("#cpSelect")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#cpStageRun")).toBeVisible();
    await expect(page.locator('#cpCatalog .trow[data-id="/home"]')).toBeVisible();

    // File bay starts empty (filter window).
    await expect(page.locator('#cpCatalog .bay .tag.file')).toBeVisible();
    await expect(page.locator("#cpCatalog .bay").filter({ hasText: "Files" })).toContainText("0");

    await page.locator('#cpCatalog .trow[data-id="/home"] .cb2').check();

    // Dep row appears, checked, with dep badge.
    const fileRow = page.locator(`#cpCatalog .trow[data-id="${FILE_DEP}"]`);
    await expect(fileRow).toBeVisible({ timeout: 5_000 });
    await expect(fileRow).toHaveClass(/auto-dep/);
    await expect(fileRow.locator(".cb2")).toBeChecked();
    await expect(fileRow.locator(".dep-auto")).toHaveText("dep");
    await expect(page.locator("#cpSelN")).toContainText("dep auto-included");

    // Unchecking the page clears orphaned auto-deps.
    await page.locator('#cpCatalog .trow[data-id="/home"] .cb2').uncheck();
    await expect(fileRow.locator(".cb2")).not.toBeChecked();
    await expect(page.locator("#cpSelN")).toHaveText("(0 selected)");
  });

  test("uncheck required dep: Cancel keeps it; OK omits and sends omittedDepIds", async ({
    page,
  }) => {
    await page.goto("/");
    await goWorkspace(page, "copy");
    await selectOnlyChip(page.locator("#cpTypes"), "page-builder");
    await page.locator("#cpLoad").click();
    await expect(page.locator('#cpCatalog .trow[data-id="/home"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('#cpCatalog .trow[data-id="/home"] .cb2').check();

    const fileRow = page.locator(`#cpCatalog .trow[data-id="${FILE_DEP}"]`);
    await expect(fileRow.locator(".cb2")).toBeChecked();

    // Row click toggles → in-app modal (same pattern as purge confirm).
    await fileRow.click();
    await expect(page.locator("#depModal")).toBeVisible();
    await expect(page.locator("#depModalTitle")).toContainText("Remove dependency");
    await page.locator("#depKeep").click();
    await expect(page.locator("#depModal")).toBeHidden();
    await expect(fileRow.locator(".cb2")).toBeChecked();

    await fileRow.click();
    await expect(page.locator("#depModal")).toBeVisible();
    await page.locator("#depRemove").click();
    await expect(page.locator("#depModal")).toBeHidden();
    await expect(fileRow.locator(".cb2")).not.toBeChecked();

    const migPromise = page.waitForRequest(
      (r) => r.url().includes("/api/migrate") && r.method() === "POST"
    );
    // Abort the migrate job call so we only assert the request body.
    await page.route("**/api/migrate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "e2e-omit-dry", dryRun: true, preview: [] }),
      });
    });
    await page.locator("#cpGo").click();
    const req = await migPromise;
    const body = req.postDataJSON() as {
      selectedIds: string[];
      omittedDepIds?: string[];
      dryRun?: boolean;
    };
    expect(body.selectedIds).toContain("/home");
    expect(body.selectedIds).not.toContain(FILE_DEP);
    expect(body.omittedDepIds || []).toContain(FILE_DEP);
  });
});
