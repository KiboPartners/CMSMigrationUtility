import { test, expect } from "@playwright/test";
import {
  artifactsForPks,
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  selectChips,
  waitExportUiDone,
  waitForJob,
  waitMigrateUiDone,
} from "./helpers";

/**
 * High-value live jobs (not full power-set). Each asserts job success + ledger/console where applicable.
 */
test.describe("Live export combinations", () => {
  const combos: Array<{ name: string; pks: string[]; filters?: () => Promise<void> }> = [
    {
      name: "redirects + last_7d",
      pks: ["redirects"],
      filters: async () => {},
    },
    {
      name: "pages + redirects + name filters",
      pks: ["page-builder", "redirects"],
    },
    {
      name: "files + redirects (no binaries)",
      pks: ["file-manager", "redirects"],
    },
  ];

  for (const combo of combos) {
    test(`export: ${combo.name}`, async ({ page, request }) => {
      await page.goto("/");
      await goWorkspace(page, "export");
      await selectChips(page.locator("#exTypes"), combo.pks);
      await openFilters(page, "ex");
      for (const art of artifactsForPks(combo.pks)) {
        await enableArtifactFilter(page, "ex", art);
        await page.locator(`#exDatePreset-${art}`).selectOption("last_7d");
      }
      if (combo.pks.includes("page-builder")) {
        await page.locator("#exNamePages").fill("e2e-unlikely-page-xyz");
      }
      if (combo.pks.includes("redirects")) {
        await page.locator("#exNameRedirects").fill("/");
      }
      if (combo.pks.includes("file-manager")) {
        await page.locator("#exNameFiles").fill("e2e-unlikely-file-xyz");
      }

      // Page name filter may confirm residual scan
      page.on("dialog", async (d) => {
        await d.accept();
      });

      const exportResp = page.waitForResponse(
        (r) => r.url().includes("/api/export") && r.request().method() === "POST"
      );
      await page.locator("#exGo").click();
      const res = await exportResp;
      expect(res.ok()).toBeTruthy();
      const { jobId, dir } = (await res.json()) as { jobId: string; dir: string };
      expect(jobId).toBeTruthy();
      expect(dir).toMatch(/^export\/exp-/);

      const job = await waitForJob(request, jobId);
      expect(job.status, job.error || combo.name).toBe("done");
      await waitExportUiDone(page);
      await expect(page.locator("#exMsg")).toContainText("Export complete");

      const ledger = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
      expect(ledger.ok()).toBeTruthy();
      const body = await ledger.json();
      expect(body.items).toBeDefined();

      const logs = await request.get("/api/logs?workstream=export");
      const runs = (await logs.json()) as Array<{ runId: string }>;
      expect(runs.some((r) => r.runId === jobId)).toBeTruthy();
    });
  }
});

test.describe("Live migrate catalog + dry-run (filtered)", () => {
  test("pages+redirects catalog load then dry-run one item", async ({ page, request }) => {
    await page.goto("/");
    await goWorkspace(page, "copy");
    await selectChips(page.locator("#cpTypes"), ["page-builder", "redirects"]);
    await openFilters(page, "cp");
    await enableArtifactFilter(page, "cp", "page");
    await enableArtifactFilter(page, "cp", "redirect");
    await page.locator("#cpDatePreset-page").selectOption("last_30d");
    await page.locator("#cpDatePreset-redirect").selectOption("last_30d");
    await page.locator("#cpNameRedirects").fill("/");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#cpLoad").click();
    const catRes = await catalogResp;
    const cat = await catRes.json();
    expect(catRes.ok(), cat.error || cat.detail || "catalog").toBeTruthy();

    await expect(page.locator("#cpSelect")).toBeVisible({ timeout: 30_000 });
    const row = page.locator("#cpCatalog .trow .cb2").first();
    test.skip(!(await row.count()), "No catalog rows in filter window");

    await row.check();
    await expect(page.locator("#cpDry")).toBeChecked();

    const migResp = page.waitForResponse(
      (r) => r.url().includes("/api/migrate") && r.request().method() === "POST"
    );
    await page.locator("#cpGo").click();
    const res = await migResp;
    const body = await res.json();
    expect(res.ok(), body.error).toBeTruthy();
    expect(body.dryRun).toBeTruthy();

    const job = await waitForJob(request, body.jobId);
    expect(job.status, job.error).toBe("done");
    await waitMigrateUiDone(page);

    // Console present; dry-run has no item ledger by design
    const logs = await request.get("/api/logs?workstream=migrate");
    const runs = (await logs.json()) as Array<{ runId: string }>;
    expect(runs.some((r) => r.runId === body.jobId)).toBeTruthy();
  });

  test("files-only catalog with tags/name filters (load only)", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "copy");
    await selectChips(page.locator("#cpTypes"), ["file-manager"]);
    await openFilters(page, "cp");
    await enableArtifactFilter(page, "cp", "file");
    await page.locator("#cpDatePreset-file").selectOption("last_30d");
    await page.locator("#cpNameFiles").fill("a");
    await page.locator("#cpTagsFiles").fill("");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#cpLoad").click();
    const catRes = await catalogResp;
    const cat = await catRes.json();
    expect(catRes.ok(), cat.error || cat.detail || "catalog").toBeTruthy();
    await expect(page.locator("#cpSelect")).toBeVisible();
    // Do not migrate — catalog fetch only for this combo
  });
});
