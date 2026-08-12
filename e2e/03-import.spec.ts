import { test, expect } from "@playwright/test";
import { goWorkspace, waitForJob, waitImportUiDone } from "./helpers";

test.describe("Import workspace", () => {
  test("wizard: pick latest server export → dry-run import", async ({ page, request }) => {
    // Prefer a redirects-only export from the prior e2e export step.
    const listRes = await request.get("/api/exports");
    expect(listRes.ok()).toBeTruthy();
    const dirs = (await listRes.json()) as Array<{ dir: string; types: string[] }>;
    test.skip(!dirs.length, "No export folders on server — run export e2e first");

    const preferred =
      dirs.find((d) => {
        const t = d.types || [];
        return t.includes("Redirects") && !t.includes("Content Models") && !t.includes("Content Entries");
      }) || dirs.find((d) => (d.types || []).length === 1 && d.types[0] === "Redirects");
    test.skip(!preferred, "No redirects-only export available — run export e2e first");

    await page.goto("/");
    await goWorkspace(page, "import");

    await page.locator("#imRefresh").click();
    const row = page.locator(`#imExportList [data-dir="${preferred.dir}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator("#imNext1")).toBeEnabled();
    await page.locator("#imNext1").click();

    await expect(page.locator("#imStep2")).toHaveClass(/on/);
    await expect(page.locator("#imTenant")).not.toHaveValue("");
    await expect(page.locator("#imDry")).toBeChecked();
    await page.locator("#imNext2").click();

    await expect(page.locator("#imStep3")).toHaveClass(/on/);
    // Wait for contents load (catalog of export items)
    await expect(page.locator("#imContents")).not.toHaveText(/Choose a source/i, { timeout: 120_000 });
    await page.locator("#imNext3").click();

    await expect(page.locator("#imStep4")).toHaveClass(/on/);
    await expect(page.locator("#imReview")).not.toBeEmpty();

    const importResp = page.waitForResponse(
      (r) => r.url().includes("/api/import") && r.request().method() === "POST" && !r.url().includes("upload")
    );
    await page.locator("#imGo").click();
    const res = await importResp;
    expect(res.ok()).toBeTruthy();
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).toBeTruthy();

    const job = await waitForJob(request, jobId);
    expect(job.status, job.error || "import job").toBe("done");
    await waitImportUiDone(page);

    await expect(page.locator("#imProgress")).toBeVisible();
    await expect(page.locator("#imOut")).not.toHaveText("Starting…");

    const run = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(run.ok(), "import ledger via /api/runs/:id").toBeTruthy();
    const ledger = await run.json();
    expect(ledger.id).toBe(jobId);
    expect(Array.isArray(ledger.items)).toBeTruthy();
  });

  test("upload mode toggles dropzone", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "import");
    await page.locator("#imModeUpload").click();
    await expect(page.locator("#imSrcUpload")).toBeVisible();
    await expect(page.locator("#imDrop")).toBeVisible();
    await page.locator("#imModeServer").click();
    await expect(page.locator("#imSrcServer")).toBeVisible();
  });
});
