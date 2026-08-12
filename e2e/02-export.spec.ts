import { test, expect } from "@playwright/test";
import {
  assertFilterRows,
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  selectOnlyChip,
  waitExportUiDone,
  waitForJob,
} from "./helpers";

test.describe("Export workspace", () => {
  test("type chips + filters show Redirects row only when selected", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "export");

    await selectOnlyChip(page.locator("#exTypes"), "redirects");
    await openFilters(page, "ex");
    await assertFilterRows(page, "ex", { visible: ["redirect"] });

    await enableArtifactFilter(page, "ex", "redirect");
    await page.locator("#exDatePreset-redirect").selectOption("last_7d");
    await expect(page.locator("#exFiltBadge")).toContainText(/Filtered/);
  });

  test("export Redirects only (live) and write ledger under .logs/export", async ({ page, request }) => {
    await page.goto("/");
    await goWorkspace(page, "export");
    await selectOnlyChip(page.locator("#exTypes"), "redirects");

    // Capture jobId from the export API response
    const exportResp = page.waitForResponse(
      (r) => r.url().includes("/api/export") && r.request().method() === "POST"
    );
    await page.locator("#exGo").click();
    const res = await exportResp;
    expect(res.ok()).toBeTruthy();
    const { jobId, dir } = (await res.json()) as { jobId: string; dir: string };
    expect(jobId).toBeTruthy();
    expect(dir).toMatch(/^export\/exp-/);

    await expect(page.locator("#exResult")).toBeVisible();
    await expect(page.locator("#exDir")).toContainText(dir);

    const job = await waitForJob(request, jobId);
    expect(job.status, job.error || "export job").toBe("done");
    await waitExportUiDone(page);

    await expect(page.locator("#exMsg")).toContainText("Export complete", { timeout: 30_000 });

    // Ledger co-located with workstream run
    const run = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(run.ok(), "export ledger via /api/runs/:id").toBeTruthy();
    const ledger = await run.json();
    expect(ledger.id).toBe(jobId);
    expect(Array.isArray(ledger.items)).toBeTruthy();

    // Export folder listed for Import
    const exports = await request.get("/api/exports");
    const list = (await exports.json()) as Array<{ dir?: string; name?: string }>;
    const found = list.some((e) => (e.dir || e.name || "").includes(dir.split("/").pop() || dir));
    expect(found, `export ${dir} listed in /api/exports`).toBeTruthy();
  });
});
