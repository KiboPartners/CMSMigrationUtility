import { test, expect } from "@playwright/test";
import { goWorkspace, waitForJob, waitImportUiDone } from "./helpers";

test.describe("Import — selective combinations", () => {
  test("multi-type export → select subset → dry-run import + ledger", async ({ page, request }) => {
    const listRes = await request.get("/api/exports");
    expect(listRes.ok()).toBeTruthy();
    const dirs = (await listRes.json()) as Array<{ dir: string; types: string[] }>;

    // Prefer an export with at least 2 artifact types (not models-only)
    const preferred =
      dirs.find((d) => {
        const t = d.types || [];
        const content = t.filter((x) => x !== "Content Models");
        return content.length >= 2;
      }) ||
      dirs.find((d) => (d.types || []).includes("Redirects"));

    test.skip(!preferred, "No suitable multi-type export on server");

    await page.goto("/");
    await goWorkspace(page, "import");
    await page.locator("#imRefresh").click();
    const row = page.locator(`#imExportList [data-dir="${preferred!.dir}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await page.locator("#imNext1").click();

    await expect(page.locator("#imDry")).toBeChecked();
    await page.locator("#imNext2").click();

    await expect(page.locator("#imStep3")).toHaveClass(/on/);
    await expect(page.locator("#imContents")).not.toHaveText(/Choose a source/i, { timeout: 180_000 });

    // Select up to 3 item rows if present; else import-all (still dry-run)
    const boxes = page.locator("#imContents .trow .cb2, #imContents input[type='checkbox']");
    const n = await boxes.count();
    if (n > 0) {
      const take = Math.min(3, n);
      for (let i = 0; i < take; i++) {
        const cb = boxes.nth(i);
        // skip "select all" if first is section header — trow preferred
        await cb.check().catch(async () => {
          await cb.click();
        });
      }
    }

    await page.locator("#imNext3").click();
    await expect(page.locator("#imStep4")).toHaveClass(/on/);

    const importResp = page.waitForResponse(
      (r) =>
        r.url().includes("/api/import") &&
        r.request().method() === "POST" &&
        !r.url().includes("upload")
    );
    await page.locator("#imGo").click();
    const res = await importResp;
    expect(res.ok()).toBeTruthy();
    const { jobId } = (await res.json()) as { jobId: string };

    const job = await waitForJob(request, jobId);
    expect(job.status, job.error || "import").toBe("done");
    await waitImportUiDone(page);

    const ledger = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(ledger.ok()).toBeTruthy();
    const body = await ledger.json();
    expect(Array.isArray(body.items)).toBeTruthy();

    // Console panel has output
    await expect(page.locator("#imOut")).not.toHaveText(/^\s*$/);
  });
});
