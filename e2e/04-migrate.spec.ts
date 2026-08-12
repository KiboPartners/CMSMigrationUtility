import { test, expect } from "@playwright/test";
import {
  assertFilterRows,
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  selectOnlyChip,
  waitForJob,
  waitMigrateUiDone,
} from "./helpers";

test.describe("Migrate workspace", () => {
  test("filters + dry-run migrate for Redirects", async ({ page, request }) => {
    await page.goto("/");
    await goWorkspace(page, "copy");

    await selectOnlyChip(page.locator("#cpTypes"), "redirects");
    await openFilters(page, "cp");
    await assertFilterRows(page, "cp", { visible: ["redirect"] });
    await enableArtifactFilter(page, "cp", "redirect");
    await page.locator("#cpDatePreset-redirect").selectOption("last_30d");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#cpLoad").click();
    const catRes = await catalogResp;
    const catBody = await catRes.json();
    expect(catRes.ok(), catBody.error || catBody.detail || "catalog build").toBeTruthy();
    expect(catBody.error).toBeFalsy();

    await expect(page.locator("#cpSelect")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#cpCatalog")).not.toHaveText("—", { timeout: 30_000 });

    // Row checkboxes (skip section "select all")
    const itemCb = page.locator("#cpCatalog .trow .cb2").first();
    if (!(await itemCb.count())) {
      test.info().annotations.push({
        type: "note",
        description: "Catalog loaded with 0 redirects in the date window — skipping migrate start",
      });
      return;
    }
    await itemCb.check();
    await expect(page.locator("#cpSelN")).not.toContainText("(0 selected)");

    await expect(page.locator("#cpDry")).toBeChecked();

    const migResp = page.waitForResponse(
      (r) => r.url().includes("/api/migrate") && r.request().method() === "POST"
    );
    await page.locator("#cpGo").click();
    const res = await migResp;
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { jobId?: string; dryRun?: boolean; error?: string };
    expect(body.error || "").toBeFalsy();
    expect(body.jobId).toBeTruthy();
    expect(body.dryRun).toBeTruthy();

    const job = await waitForJob(request, body.jobId!);
    expect(job.status, job.error || "migrate dry-run").toBe("done");
    await waitMigrateUiDone(page);

    // Dry-run migrate records no ledger (by design) — console job should still appear in logs
    const logs = await request.get("/api/logs?workstream=migrate");
    expect(logs.ok()).toBeTruthy();
    const runs = (await logs.json()) as Array<{ runId: string }>;
    expect(runs.some((r) => r.runId === body.jobId)).toBeTruthy();
  });
});
