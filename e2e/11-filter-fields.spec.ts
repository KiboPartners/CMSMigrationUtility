import { test, expect } from "@playwright/test";
import {
  DATE_PRESETS,
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  selectChips,
} from "./helpers";

async function fillNameFilters(page: import("@playwright/test").Page, pfx: "ex" | "cp" | "pg") {
  await page.locator(`#${pfx}NameEntries`).fill("hero, banner");
  await page.locator(`#${pfx}NameFiles`).fill("logo");
  await page.locator(`#${pfx}TagsFiles`).fill("promo");
  await page.locator(`#${pfx}NamePages`).fill("/home");
  await page.locator(`#${pfx}NameRedirects`).fill("/old");
  await page.locator(`#${pfx}Models`).fill("PromoBanner");
}

for (const ws of [
  { view: "export" as const, host: "#exTypes", pfx: "ex" as const },
  { view: "copy" as const, host: "#cpTypes", pfx: "cp" as const },
  { view: "purge" as const, host: "#pgTypes", pfx: "pg" as const },
]) {
  test.describe(`Filter fields — ${ws.view}`, () => {
    test("all date presets + custom datetime-local + timezone (Entries row)", async ({ page }) => {
      await page.goto("/");
      await goWorkspace(page, ws.view);
      await selectChips(page.locator(ws.host), [
        "file-manager",
        "cms-entries",
        "page-builder",
        "redirects",
      ]);
      await openFilters(page, ws.pfx);
      await enableArtifactFilter(page, ws.pfx, "cms-entry");

      await page.locator(`#${ws.pfx}DateField-cms-entry`).selectOption("modifiedOn");
      for (const preset of DATE_PRESETS) {
        await page.locator(`#${ws.pfx}DatePreset-cms-entry`).selectOption(preset);
        if (preset === "custom") {
          await expect(page.locator(`#${ws.pfx}DateCustom-cms-entry`)).toBeVisible();
          await page.locator(`#${ws.pfx}DateFrom-cms-entry`).fill("2026-01-01T00:00");
          await page.locator(`#${ws.pfx}DateTo-cms-entry`).fill("2026-01-31T23:59");
        } else {
          await expect(page.locator(`#${ws.pfx}DateCustom-cms-entry`)).toBeHidden();
        }
      }

      const tz = page.locator(`#${ws.pfx}Timezone-cms-entry`);
      await expect(tz.locator("option")).not.toHaveCount(0);
      const values = await tz.locator("option").evaluateAll((opts) =>
        opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean)
      );
      expect(values.length).toBeGreaterThan(0);
      await tz.selectOption(values[Math.min(1, values.length - 1)]);
      await expect(tz).not.toHaveValue("");
    });

    test("name/tags/models fields retain values across date changes", async ({ page }) => {
      await page.goto("/");
      await goWorkspace(page, ws.view);
      await selectChips(page.locator(ws.host), [
        "file-manager",
        "cms-models",
        "cms-entries",
        "page-builder",
        "redirects",
      ]);
      await openFilters(page, ws.pfx);
      await enableArtifactFilter(page, ws.pfx, "model");
      await enableArtifactFilter(page, ws.pfx, "cms-entry");
      await enableArtifactFilter(page, ws.pfx, "file");
      await enableArtifactFilter(page, ws.pfx, "page");
      await enableArtifactFilter(page, ws.pfx, "redirect");

      await fillNameFilters(page, ws.pfx);
      await page.locator(`#${ws.pfx}DatePreset-cms-entry`).selectOption("last_7d");
      await page.locator(`#${ws.pfx}DatePreset-cms-entry`).selectOption("last_30d");
      await page.locator(`#${ws.pfx}DateField-cms-entry`).selectOption("createdOn");

      await expect(page.locator(`#${ws.pfx}NameEntries`)).toHaveValue("hero, banner");
      await expect(page.locator(`#${ws.pfx}NameFiles`)).toHaveValue("logo");
      await expect(page.locator(`#${ws.pfx}TagsFiles`)).toHaveValue("promo");
      await expect(page.locator(`#${ws.pfx}NamePages`)).toHaveValue("/home");
      await expect(page.locator(`#${ws.pfx}NameRedirects`)).toHaveValue("/old");
      await expect(page.locator(`#${ws.pfx}Models`)).toHaveValue("PromoBanner");
    });

    test("save filter preset appears in preset select", async ({ page }) => {
      await page.goto("/");
      await goWorkspace(page, ws.view);
      await selectChips(page.locator(ws.host), ["redirects"]);
      await openFilters(page, ws.pfx);
      await enableArtifactFilter(page, ws.pfx, "redirect");
      await page.locator(`#${ws.pfx}DatePreset-redirect`).selectOption("last_24h");
      await page.locator(`#${ws.pfx}NameRedirects`).fill("/e2e-preset");

      page.once("dialog", async (d) => {
        await d.accept(`e2e-${ws.pfx}-${Date.now()}`);
      });
      await page.locator(`#${ws.pfx}SavePreset`).click();
      await expect(page.locator(`#${ws.pfx}PresetSel option`)).not.toHaveCount(0);
    });

    test("enabling Filter with no constraint blocks the action with an inline error", async ({ page }) => {
      await page.goto("/");
      await goWorkspace(page, ws.view);
      await selectChips(page.locator(ws.host), ["cms-entries"]);
      await openFilters(page, ws.pfx);
      await enableArtifactFilter(page, ws.pfx, "cms-entry");
      // Leave date preset + title blank — enabled Filter with zero constraints.

      const goId = ws.pfx === "ex" ? "#exGo" : ws.pfx === "cp" ? "#cpLoad" : "#pgLoad";
      let apiHit = false;
      page.on("request", (req) => {
        if (req.url().includes("/api/export") || req.url().includes("/api/catalog/build")) apiHit = true;
      });
      await page.locator(goId).click();

      const err = page.locator(`#${ws.pfx}FiltErr`);
      await expect(err).toBeVisible();
      await expect(err).toContainText("Add a constraint for Content Entries, or turn Filter off.");
      expect(apiHit).toBe(false);
    });
  });
}
