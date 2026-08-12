/**
 * Export selected + Import omit parity for dependency hydration.
 * Mocks catalog/build, export, and import/contents so CI needs no live CMS.
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
    { type: "file", total: 0, items: [] },
  ],
};

const MOCK_IMPORT_CONTENTS = {
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
    {
      type: "file",
      total: 1,
      items: [
        {
          type: "file",
          id: FILE_DEP,
          label: "hero.png",
          dependsOn: [],
          metadata: { name: "hero.png" },
        },
      ],
    },
  ],
};

test.describe("Export selected — hydrate closure", () => {
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

  test("select page → dep row → Export selected sends selectedIds + omittedDepIds", async ({
    page,
  }) => {
    await page.goto("/");
    await goWorkspace(page, "export");
    await selectOnlyChip(page.locator("#exTypes"), "page-builder");

    await expect(page.locator("#exStageRun")).toBeHidden();
    await page.locator("#exLoad").click();
    await expect(page.locator("#exSelect")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#exStageRun")).toBeVisible();
    await expect(page.locator("#exGo")).toBeVisible();
    await expect(page.locator("#exGoSel")).toBeHidden();

    await page.locator('#exCatalog .trow[data-id="/home"] .cb2').check();

    const fileRow = page.locator(`#exCatalog .trow[data-id="${FILE_DEP}"]`);
    await expect(fileRow).toBeVisible({ timeout: 5_000 });
    await expect(fileRow.locator(".cb2")).toBeChecked();
    await expect(page.locator("#exSelN")).toContainText("dep auto-included");
    await expect(page.locator("#exGoSel")).toBeVisible();
    await expect(page.locator("#exGo")).toBeHidden();

    // Uncheck page → orphaned auto-dep clears; Export all returns.
    await page.locator('#exCatalog .trow[data-id="/home"] .cb2').uncheck();
    await expect(fileRow.locator(".cb2")).not.toBeChecked();
    await expect(page.locator("#exGoSel")).toBeHidden();
    await expect(page.locator("#exGo")).toBeVisible();

    // Re-select for omit-modal assertion below.
    await page.locator('#exCatalog .trow[data-id="/home"] .cb2').check();
    await expect(fileRow.locator(".cb2")).toBeChecked();

    await fileRow.click();
    await expect(page.locator("#depModal")).toBeVisible();
    await page.locator("#depRemove").click();

    await page.route("**/api/export", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "e2e-ex-sel", dir: "export/exp-e2e", selective: true }),
      });
    });
    await page.route("**/api/jobs/**/stream", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "done", meta: { status: "done", runId: "e2e-ex-sel" } })}\n\n`,
      });
    });
    const expPromise = page.waitForRequest(
      (r) => r.url().includes("/api/export") && r.method() === "POST"
    );
    await page.locator("#exGoSel").click();
    const req = await expPromise;
    const body = req.postDataJSON() as {
      selectedIds: string[];
      omittedDepIds?: string[];
    };
    expect(body.selectedIds).toContain("/home");
    expect(body.selectedIds).not.toContain(FILE_DEP);
    expect(body.omittedDepIds || []).toContain(FILE_DEP);
  });
});

test.describe("Import — omit modal + omittedDepIds", () => {
  test("auto-includes file dep from folder catalog; omit sends omittedDepIds", async ({ page }) => {
    await page.route("**/api/exports", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { dir: "export/exp-e2e-folder", mtime: new Date().toISOString(), types: ["Pages", "Files"] },
        ]),
      });
    });
    await page.route("**/api/import/contents**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_IMPORT_CONTENTS),
      });
    });

    await page.goto("/");
    await goWorkspace(page, "import");
    await expect(page.locator('#imExportList [data-dir="export/exp-e2e-folder"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.locator('#imExportList [data-dir="export/exp-e2e-folder"]').click();
    await page.locator("#imNext1").click();
    await expect(page.locator("#imTenant")).not.toHaveValue("", { timeout: 5_000 });
    await page.locator("#imNext2").click();

    await expect(page.locator('#imContents .trow[data-id="/home"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('#imContents .trow[data-id="/home"] .cb2').check();

    const fileRow = page.locator(`#imContents .trow[data-id="${FILE_DEP}"]`);
    await expect(fileRow.locator(".cb2")).toBeChecked();
    await expect(page.locator("#imSelN")).toContainText("dep auto-included");

    // Uncheck page → orphaned auto-dep clears.
    await page.locator('#imContents .trow[data-id="/home"] .cb2').uncheck();
    await expect(fileRow.locator(".cb2")).not.toBeChecked();
    await expect(page.locator("#imSelN")).toContainText("0 selected");

    // Re-select for omit-modal assertion below.
    await page.locator('#imContents .trow[data-id="/home"] .cb2').check();
    await expect(fileRow.locator(".cb2")).toBeChecked();

    await fileRow.click();
    await expect(page.locator("#depModal")).toBeVisible();
    await page.locator("#depRemove").click();

    await page.locator("#imNext3").click();

    await page.route("**/api/import", async (route) => {
      if (route.request().url().includes("/api/import/")) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "e2e-im-omit" }),
      });
    });
    await page.route("**/api/jobs/**/stream", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "done", meta: { status: "done", runId: "e2e-im-omit" } })}\n\n`,
      });
    });
    const impPromise = page.waitForRequest(
      (r) =>
        r.url().includes("/api/import") &&
        r.method() === "POST" &&
        !r.url().includes("/api/import/")
    );
    await page.locator("#imGo").click();
    const req = await impPromise;
    const body = req.postDataJSON() as {
      selectedIds: string[];
      omittedDepIds?: string[];
    };
    expect(body.selectedIds).toContain("/home");
    expect(body.omittedDepIds || []).toContain(FILE_DEP);
  });
});
