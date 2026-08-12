import { test, expect } from "@playwright/test";
import {
  ARTIFACT_COMBOS,
  artifactsForPks,
  assertFilterRows,
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  selectChips,
} from "./helpers";

for (const ws of [
  { view: "export" as const, host: "#exTypes", pfx: "ex" as const },
  { view: "copy" as const, host: "#cpTypes", pfx: "cp" as const },
  { view: "purge" as const, host: "#pgTypes", pfx: "pg" as const },
]) {
  test.describe(`Filter row visibility — ${ws.view}`, () => {
    for (const combo of ARTIFACT_COMBOS) {
      test(`${combo.name}`, async ({ page }) => {
        await page.goto("/");
        await goWorkspace(page, ws.view);
        await selectChips(page.locator(ws.host), combo.pks);
        await openFilters(page, ws.pfx);
        // Chips alone only reveal the row; bodies stay collapsed until Filter is toggled on.
        await assertFilterRows(page, ws.pfx, { visible: artifactsForPks(combo.pks) });
      });
    }
  });
}

test.describe("Opt-in Filter toggle: bodies stay isolated per artifact", () => {
  test("export cms-models-only: enabling Filter reveals only the Models body", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "export");
    await selectChips(page.locator("#exTypes"), ["cms-models"]);
    await openFilters(page, "ex");
    await assertFilterRows(page, "ex", { visible: ["model"] });

    await enableArtifactFilter(page, "ex", "model");
    await assertFilterRows(page, "ex", { visible: ["model"], enabled: ["model"] });
  });

  test("export all-five: enabling one row's Filter does not expand the others", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "export");
    await selectChips(page.locator("#exTypes"), [
      "file-manager",
      "cms-models",
      "cms-entries",
      "page-builder",
      "redirects",
    ]);
    await openFilters(page, "ex");
    await assertFilterRows(page, "ex", {
      visible: ["model", "cms-entry", "file", "page", "redirect"],
    });

    await enableArtifactFilter(page, "ex", "file");
    await assertFilterRows(page, "ex", {
      visible: ["model", "cms-entry", "file", "page", "redirect"],
      enabled: ["file"],
    });

    // Deselecting a chip whose row was enabled clears + hides that row.
    await selectChips(page.locator("#exTypes"), ["cms-models", "cms-entries", "page-builder", "redirects"]);
    await assertFilterRows(page, "ex", {
      visible: ["model", "cms-entry", "page", "redirect"],
    });
    await expect(page.locator("#exFiltOn-file")).not.toBeChecked();
  });
});
