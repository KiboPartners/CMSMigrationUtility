import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export type Workspace = "export" | "import" | "copy" | "logs" | "purge";

/** Navigate to a workspace via the left nav. */
export async function goWorkspace(page: Page, view: Workspace): Promise<void> {
  await page.locator(`.navi[data-v="${view}"]`).click();
  await expect(page.locator(`#v-${view}`)).toHaveClass(/on/);
}

/** Leave only the chip with `data-pk` selected inside a type host. */
export async function selectOnlyChip(host: Locator, pk: string): Promise<void> {
  await selectChips(host, [pk]);
}

/** Select exactly the given chip pks (others off). */
export async function selectChips(host: Locator, pks: string[]): Promise<void> {
  const want = new Set(pks);
  const chips = host.locator(".chip");
  const n = await chips.count();
  for (let i = 0; i < n; i++) {
    const chip = chips.nth(i);
    const dataPk = await chip.getAttribute("data-pk");
    if (!dataPk) continue;
    const on = await chip.evaluate((el) => el.classList.contains("on"));
    const shouldOn = want.has(dataPk);
    if (shouldOn !== on) await chip.click();
  }
  await expect(host.locator(".chip.on")).toHaveCount(pks.length);
  for (const pk of pks) {
    await expect(host.locator(`.chip.on[data-pk="${pk}"]`)).toHaveCount(1);
  }
}

export async function openFilters(page: Page, pfx: "ex" | "cp" | "pg"): Promise<void> {
  const details = page.locator(`#${pfx}Filt`);
  const open = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!open) await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
}

/** Open Migrate "Advanced options" so skip-export / schema / folder / max-MB are actionable. */
export async function openMigrateAdvanced(page: Page): Promise<void> {
  const details = page.locator("#cpAdvanced");
  const open = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!open) await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
}

export type FilterPrefix = "ex" | "cp" | "pg";
export type Artifact = "model" | "cms-entry" | "file" | "page" | "redirect";

/** All per-artifact filter rows, in the order they render in the UI. */
export const ARTIFACTS: Artifact[] = ["model", "cms-entry", "file", "page", "redirect"];

/** Type-chip pk → filter-row artifact key (mirrors `PK_TO_ARTIFACT` in server.ts). */
export const PK_TO_ARTIFACT: Record<string, Artifact> = {
  "cms-models": "model",
  "cms-entries": "cms-entry",
  "file-manager": "file",
  "page-builder": "page",
  redirects: "redirect",
};

/** Artifact keys whose Filter row is shown for a given set of selected type-chip pks. */
export function artifactsForPks(pks: string[]): Artifact[] {
  const shown = new Set<Artifact>();
  for (const pk of pks) {
    const art = PK_TO_ARTIFACT[pk];
    if (art) shown.add(art);
  }
  // The Model row is reachable from either the Models or the Entries chip
  // (mirrors ART_ROW_PKS in server.ts) — entries-only runs can still narrow by Model name.
  if (pks.includes("cms-models") || pks.includes("cms-entries")) shown.add("model");
  return ARTIFACTS.filter((a) => shown.has(a));
}

/** Turn on one artifact's opt-in Filter toggle and wait for its body panel to expand. */
export async function enableArtifactFilter(
  page: Page,
  pfx: FilterPrefix,
  artifact: Artifact
): Promise<void> {
  const box = page.locator(`#${pfx}FiltOn-${artifact}`);
  await box.check();
  await expect(page.locator(`#${pfx}FiltBody-${artifact}`)).toBeVisible();
}

/**
 * Assert per-artifact Filter row visibility (driven by selected type chips) and
 * body-panel expansion (driven by each row's opt-in Filter toggle).
 */
export async function assertFilterRows(
  page: Page,
  pfx: FilterPrefix,
  opts: { visible: Artifact[]; enabled?: Artifact[] }
): Promise<void> {
  for (const art of ARTIFACTS) {
    const row = page.locator(`#${pfx}FiltRow-${art}`);
    if (opts.visible.includes(art)) await expect(row).toBeVisible();
    else await expect(row).toBeHidden();
    const body = page.locator(`#${pfx}FiltBody-${art}`);
    if (opts.enabled?.includes(art)) await expect(body).toBeVisible();
    else await expect(body).toBeHidden();
  }
}

export type JobSnap = {
  jobId: string;
  status: "running" | "done" | "error";
  error?: string;
  meta?: { runId?: string; status?: string };
  lines?: string[];
};

/** Poll `/api/jobs/:id` until done/error or timeout. */
export async function waitForJob(
  request: APIRequestContext,
  jobId: string,
  timeoutMs = 8 * 60 * 1000
): Promise<JobSnap> {
  const deadline = Date.now() + timeoutMs;
  let last: JobSnap | null = null;
  while (Date.now() < deadline) {
    const res = await request.get(`/api/jobs/${encodeURIComponent(jobId)}`);
    expect(res.ok()).toBeTruthy();
    last = (await res.json()) as JobSnap;
    if (last.status === "done" || last.status === "error") return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} still ${last?.status ?? "unknown"} after ${timeoutMs}ms`);
}

export async function waitExportUiDone(page: Page, timeoutMs = 8 * 60 * 1000): Promise<void> {
  await expect(page.locator("#exGo")).toBeEnabled({ timeout: timeoutMs });
  await expect(page.locator("#exMsg")).not.toContainText("Exporting", { timeout: 5_000 });
}

export async function waitImportUiDone(page: Page, timeoutMs = 8 * 60 * 1000): Promise<void> {
  await expect(page.locator("#imGo")).toBeEnabled({ timeout: timeoutMs });
}

export async function waitMigrateUiDone(page: Page, timeoutMs = 8 * 60 * 1000): Promise<void> {
  await expect(page.locator("#cpGo")).toBeEnabled({ timeout: timeoutMs });
}

/** Chip sets used across advanced UI matrices (not a full power-set — representative combos). */
export const ARTIFACT_COMBOS: Array<{ name: string; pks: string[] }> = [
  { name: "redirects-only", pks: ["redirects"] },
  { name: "pages-only", pks: ["page-builder"] },
  { name: "files-only", pks: ["file-manager"] },
  { name: "cms-models-only", pks: ["cms-models"] },
  { name: "cms-entries-only", pks: ["cms-entries"] },
  { name: "cms-both", pks: ["cms-models", "cms-entries"] },
  { name: "files+pages", pks: ["file-manager", "page-builder"] },
  { name: "pages+redirects", pks: ["page-builder", "redirects"] },
  { name: "files+entries", pks: ["file-manager", "cms-entries"] },
  { name: "all-five", pks: ["file-manager", "cms-models", "cms-entries", "page-builder", "redirects"] },
];

export const DATE_PRESETS = [
  "last_24h",
  "last_7d",
  "last_30d",
  "this_month",
  "previous_month",
  "custom",
] as const;
