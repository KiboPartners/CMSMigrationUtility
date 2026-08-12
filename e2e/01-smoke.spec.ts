import { test, expect } from "@playwright/test";
import { goWorkspace } from "./helpers";

test.describe("Smoke — shell, APIs, navigation (no purge actions)", () => {
  test("APIs: env, exports, runs, logs, metrics respond", async ({ request }) => {
    const env = await request.get("/api/env");
    expect(env.ok()).toBeTruthy();
    const body = await env.json();
    expect(body.source?.tenant).toBeTruthy();
    expect(body.target?.tenant).toBeTruthy();
    expect(body.source?.url).toMatch(/^https?:\/\//);

    for (const path of ["/api/exports", "/api/runs", "/api/logs", "/api/metrics"]) {
      const res = await request.get(path);
      expect(res.ok(), path).toBeTruthy();
    }
  });

  test("home loads brand + Export workspace by default", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header .brand")).toContainText("KIBO CMS");
    await expect(page.locator("#v-export")).toHaveClass(/on/);
    await expect(page.locator("#exTenant")).not.toHaveValue("");
    await expect(page.locator("#exSrcUrl")).not.toHaveText("—");
  });

  test("nav switches Export → Import → Migrate → Logs (skips Purge actions)", async ({ page }) => {
    await page.goto("/");

    await goWorkspace(page, "import");
    await expect(page.locator("#v-import .vh")).toContainText("Import");
    await expect(page.locator("#imStep1")).toHaveClass(/on/);
    // as-draft default on (DOM present even if wizard step hidden)
    await expect(page.locator("#imAsDraft")).toBeAttached();
    await expect(page.locator("#imAsDraft")).toBeChecked();
    await expect(page.locator("#tgImAsDraft .tip")).toBeAttached();

    await goWorkspace(page, "copy");
    await expect(page.locator("#v-copy .vh")).toContainText("Migrate");
    await expect(page.locator("#cpSrc")).not.toHaveValue("");
    await expect(page.locator("#cpTgt")).not.toHaveValue("");
    await expect(page.locator("#cpAsDraft")).toBeChecked();
    await expect(page.locator("#tgCpAsDraft .tip")).toBeAttached();

    await goWorkspace(page, "logs");
    await expect(page.locator("#v-logs .vh")).toContainText("Logs");
    await expect(page.locator("#lgWsFilters")).toBeVisible();

    // Purge nav exists but we never open destructive flows in this suite
    await expect(page.locator('.navi[data-v="purge"]')).toBeVisible();
  });

  test("theme toggle flips data-theme", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator("html").getAttribute("data-theme");
    await page.locator("#theme").click();
    const after = await page.locator("html").getAttribute("data-theme");
    expect(after).not.toBe(before);
  });
});
