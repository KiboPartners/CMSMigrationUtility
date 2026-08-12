import { test, expect } from "@playwright/test";
import { goWorkspace } from "./helpers";

test.describe("Logs — console + ledger depth", () => {
  test("Export/Import runs show console; ledger items when _hasLedger", async ({ page, request }) => {
    const logsRes = await request.get("/api/logs");
    expect(logsRes.ok()).toBeTruthy();
    const consoleRuns = (await logsRes.json()) as Array<{
      runId: string;
      workstream: string;
      status: string;
    }>;

    const runsRes = await request.get("/api/runs");
    const ledgers = (await runsRes.json()) as Array<{ id: string; summary?: Record<string, number> }>;
    const ledgerIds = new Set(ledgers.map((l) => l.id));

    await page.goto("/");
    await goWorkspace(page, "logs");
    await page.locator("#lgReload").click();
    await expect(page.locator("#lgRuns .runrow").first()).toBeVisible({ timeout: 20_000 });

    for (const ws of ["export", "import", "migrate"] as const) {
      await page.locator(`#lgWsFilters .ws-chip[data-ws="${ws}"]`).click();
      const row = page.locator("#lgRuns .runrow").first();
      if (!(await row.count())) continue;

      await row.click();
      await expect(page.locator("#lgDetail")).toBeVisible();
      await expect(page.locator("#lgHead")).not.toBeEmpty();

      await expect(page.locator("#lgHead")).toBeVisible();
      // Items panel is shown only when a ledger is attached; console-only runs hide it
      const items = page.locator("#lgItems");
      const headText = await page.locator("#lgHead").innerText();
      const matched = consoleRuns.find(
        (r) => r.workstream === ws && headText.includes(r.runId.slice(0, 8))
      );
      // Console is below ledger; both folds use a chevron summary
      const ledgerFold = page.locator("#lgLedgerFold");
      const consoleFold = page.locator("#lgConsoleFold");
      await expect(consoleFold).toBeVisible({ timeout: 15_000 });
      await expect(consoleFold.locator("summary .filt-chev")).toBeVisible();

      if (matched && ledgerIds.has(matched.runId)) {
        await expect(ledgerFold).toBeVisible({ timeout: 15_000 });
        await expect(ledgerFold.locator("summary .filt-chev")).toBeVisible();
        // DOM order: ledger section before console
        const order = await page.evaluate(() => {
          const a = document.getElementById("lgLedgerFold");
          const b = document.getElementById("lgConsoleFold");
          if (!a || !b) return 0;
          return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
        });
        expect(order).toBe(1);

        await expect(items).toBeVisible({ timeout: 15_000 });
        await expect(items).not.toContainText("No item ledger");
        await expect(page.locator("#lgStats")).toBeVisible();
        const tot = await page.locator("#lgTot").innerText();
        expect(/^\d+$/.test(tot.trim())).toBeTruthy();

        // Collapse ledger via summary click
        await ledgerFold.locator("summary").click();
        await expect(ledgerFold).not.toHaveAttribute("open", "");
        await ledgerFold.locator("summary").click();
        await expect(ledgerFold).toHaveAttribute("open", "");
      } else {
        // Console-only (e.g. dry-run migrate): detail still loads
        await expect(page.locator("#lgDetail")).toBeVisible();
      }

      await page.locator("#lgBack").click();
      await expect(page.locator("#lgBrowse")).toBeVisible();
    }
  });

  test("API ledger items have type/status for a recent export/import run", async ({ request }) => {
    const logs = (await (await request.get("/api/logs")).json()) as Array<{
      runId: string;
      workstream: string;
    }>;
    const candidate =
      logs.find((r) => r.workstream === "export") ||
      logs.find((r) => r.workstream === "import");
    test.skip(!candidate, "No export/import console runs yet");

    const res = await request.get(`/api/runs/${encodeURIComponent(candidate!.runId)}`);
    if (!res.ok()) {
      test.info().annotations.push({
        type: "note",
        description: `Run ${candidate!.runId} has console but no ledger (e.g. dry-run migrate)`,
      });
      return;
    }
    const ledger = await res.json();
    expect(Array.isArray(ledger.items)).toBeTruthy();
    for (const it of ledger.items.slice(0, 20)) {
      expect(it.type).toBeTruthy();
      expect(["pending", "done", "skipped", "error"]).toContain(it.status);
    }
  });

  test("metrics aggregates across workstreams", async ({ request }) => {
    const m = await (await request.get("/api/metrics")).json();
    expect(typeof m.runs).toBe("number");
    expect(m.byStatus).toBeTruthy();
  });
});
