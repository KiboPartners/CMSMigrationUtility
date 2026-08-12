import { test, expect } from "@playwright/test";
import { goWorkspace } from "./helpers";

test.describe("Logs workspace", () => {
  test("lists runs, filters by Export workstream, opens detail with ledger when present", async ({ page, request }) => {
    const apiRuns = await request.get("/api/runs");
    expect(apiRuns.ok()).toBeTruthy();
    const ledgers = (await apiRuns.json()) as Array<{ id: string; summary?: Record<string, number> }>;

    const apiLogs = await request.get("/api/logs");
    expect(apiLogs.ok()).toBeTruthy();
    const consoleRuns = (await apiLogs.json()) as Array<{ runId: string; workstream: string }>;

    await page.goto("/");
    await goWorkspace(page, "logs");
    await page.locator("#lgReload").click();

    await expect(page.locator("#lgMetrics")).not.toHaveText(/^\s*$/);
    await expect(page.locator("#lgRuns")).not.toHaveText("—", { timeout: 15_000 });

    // Filter to Export
    await page.locator('#lgWsFilters .ws-chip[data-ws="export"]').click();
    await expect(page.locator('#lgWsFilters .ws-chip[data-ws="export"]')).toHaveClass(/on/);

    const list = page.locator("#lgRuns");
    const row = list.locator(".runrow").first();
    if (await row.count()) {
      await row.click();
      await expect(page.locator("#lgDetail")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#lgHead")).not.toBeEmpty();
      // Prefer ledger items when the export/import run has one
      const items = page.locator("#lgItems");
      if (await items.isVisible()) {
        await expect(items).not.toHaveText(/No item ledger/i);
      }
      await page.locator("#lgBack").click();
      await expect(page.locator("#lgBrowse")).toBeVisible();
    } else if (consoleRuns.some((r) => r.workstream === "export")) {
      const exportId = consoleRuns.find((r) => r.workstream === "export")!.runId;
      await page.locator("#lgQ").fill(exportId);
      await expect(list).toContainText(exportId.slice(0, 12));
    }

    // Metrics endpoint aggregates across workstreams
    const metrics = await request.get("/api/metrics");
    expect(metrics.ok()).toBeTruthy();
    const m = await metrics.json();
    expect(typeof m.runs).toBe("number");

    if (ledgers.length) {
      const one = ledgers[0];
      const detail = await request.get(`/api/runs/${encodeURIComponent(one.id)}`);
      expect(detail.ok()).toBeTruthy();
      const full = await detail.json();
      expect(full.items).toBeDefined();
    }
  });

  test("search + clear filters", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "logs");
    await page.locator("#lgQ").fill("export-");
    await page.locator("#lgClear").click();
    await expect(page.locator("#lgQ")).toHaveValue("");
  });
});
