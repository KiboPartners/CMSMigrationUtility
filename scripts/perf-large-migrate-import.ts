/**
 * Performance / scale harness for migrate + import.
 *
 * Live path (default): uses repo-root .env SOURCE_* / TARGET_* —
 *   1) catalog-all from source
 *   2) migrate --dry-run (full selection)
 *   3) export-selected → import-all --dry-run
 *   4) optional --live: real migrate + import of the full set
 *
 * Synthetic path (--synthetic N): builds an in-memory catalog of N pages+files
 * and times planMigration / hydrate / import selection planning (no API).
 *
 *   npx ts-node -r ./register-shared.js scripts/perf-large-migrate-import.ts
 *   npx ts-node -r ./register-shared.js scripts/perf-large-migrate-import.ts --live
 *   npx ts-node -r ./register-shared.js scripts/perf-large-migrate-import.ts --synthetic 5000
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
  loadRootEnv,
  planMigration,
  hydrateDependencies,
  catalogOmittingDeps,
  type Catalog,
  type CatalogItem,
} from "@kibo-cms-clone-tool/shared";
import { buildSelectiveExportSteps, stripOmittedIds } from "../src/jobs/selectiveExport";

loadRootEnv();

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".perf-tmp");
const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const synthArg = process.argv.find((a) => a.startsWith("--synthetic"));
const synthN = synthArg
  ? parseInt(process.argv[process.argv.indexOf(synthArg) + 1] || synthArg.split("=")[1] || "0", 10)
  : 0;

function hr(): number {
  return Date.now();
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Spawn node + ts-node directly (no npx). Windows Node 24: spawn("npx.cmd") → EINVAL.
const tsNodeBin = require.resolve("ts-node/dist/bin.js", { paths: [ROOT] });
const sharedRegister = path.join(ROOT, "register-shared.js");

function cli(cmdArgs: string[]): { ms: number; status: number; output: string } {
  const t0 = hr();
  const r = spawnSync(
    process.execPath,
    [tsNodeBin, "-r", sharedRegister, "index.ts", ...cmdArgs],
    { cwd: ROOT, encoding: "utf-8", env: process.env, maxBuffer: 32 * 1024 * 1024 }
  );
  return {
    ms: hr() - t0,
    status: r.status ?? 1,
    output: `${r.error ? String(r.error) + "\n" : ""}${r.stdout || ""}${r.stderr || ""}`,
  };
}

function catalogCounts(c: Catalog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of c.sections) out[s.type] = (s.items || []).length;
  return out;
}

function allIds(c: Catalog): string[] {
  const ids: string[] = [];
  for (const s of c.sections) for (const it of s.items || []) ids.push(it.id);
  return ids;
}

function syntheticCatalog(n: number): Catalog {
  const pages: CatalogItem[] = [];
  const files: CatalogItem[] = [];
  const models: CatalogItem[] = [
    { type: "model", id: "perfModel", label: "PerfModel", dependsOn: [] },
  ];
  const entries: CatalogItem[] = [];
  for (let i = 0; i < n; i++) {
    const fileId = `https://cdn.example.test/files/perf/${i}/hero.png`;
    files.push({
      type: "file",
      id: fileId,
      label: `hero-${i}.png`,
      metadata: { key: `perf/${i}/hero.png`, autoDep: false },
    });
    pages.push({
      type: "page",
      id: `/perf/page-${i}`,
      label: `Page ${i}`,
      dependsOn: [fileId],
      metadata: { path: `/perf/page-${i}` },
    });
    if (i % 10 === 0) {
      entries.push({
        type: "cms-entry",
        id: `entry-${i}`,
        label: `Entry ${i}`,
        dependsOn: ["perfModel", fileId],
      });
    }
  }
  return {
    environment: { role: "source", tenant: "synthetic", locale: "en-US" },
    generatedAt: new Date().toISOString(),
    sections: [
      { type: "model", total: models.length, items: models },
      { type: "file", total: files.length, items: files },
      { type: "cms-entry", total: entries.length, items: entries },
      { type: "page", total: pages.length, items: pages },
      { type: "redirect", total: 0, items: [] },
    ],
  };
}

async function runSynthetic(n: number): Promise<void> {
  console.log(`\n🧪 Synthetic catalog stress — ${n} pages (+ deps)\n`);
  const tBuild = hr();
  const catalog = syntheticCatalog(n);
  console.log(`  build catalog: ${fmt(hr() - tBuild)}  counts=`, catalogCounts(catalog));

  const selected = catalog.sections.find((s) => s.type === "page")!.items.slice(0, n).map((i) => i.id);

  const tHydrate = hr();
  const hydrated = await hydrateDependencies(catalog, selected, {}, { omitIds: [] });
  console.log(
    `  hydrateDependencies: ${fmt(hr() - tHydrate)}  hydrated=${hydrated.hydratedIds.length} unresolved=${hydrated.unresolvedIds.length}`
  );

  const tPlan = hr();
  const plan = planMigration(catalogOmittingDeps(hydrated.catalog, []), selected);
  console.log(
    `  planMigration: ${fmt(hr() - tPlan)}  selected=${plan.selectedCount} resolved=${plan.resolvedCount} steps=${plan.steps.map((s) => `${s.type}:${s.ids.length}`).join(",")}`
  );

  const tSteps = hr();
  const steps = buildSelectiveExportSteps(plan, path.join(OUT, "synth-out"));
  console.log(`  buildSelectiveExportSteps: ${fmt(hr() - tSteps)}  steps=${steps.length}`);

  const tStrip = hr();
  const stripped = stripOmittedIds(
    plan.steps.flatMap((s) => s.ids),
    plan.steps.find((s) => s.type === "file")?.ids.slice(0, 10) || []
  );
  console.log(`  stripOmittedIds: ${fmt(hr() - tStrip)}  kept=${stripped.length}`);

  const tImp = hr();
  const impPlan = planMigration(hydrated.catalog, selected.slice(0, Math.min(500, selected.length)));
  console.log(`  planMigration (import-like ≤500): ${fmt(hr() - tImp)}  resolved=${impPlan.resolvedCount}`);

  console.log("\n✅ Synthetic stress complete\n");
}

async function runLive(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const catalogPath = path.join(OUT, "catalog.json");
  const idsPath = path.join(OUT, "all.ids");
  const exportDir = path.join(OUT, "export");

  console.log("\n⏱  Live perf — SOURCE_TENANT=%s TARGET_TENANT=%s\n", process.env["SOURCE_TENANT"], process.env["TARGET_TENANT"]);

  console.log("── 1) catalog-all (source) ──");
  let r = cli(["catalog-all", "--env", "source", "--out", catalogPath]);
  console.log(`  exit=${r.status} wall=${fmt(r.ms)}`);
  if (r.status !== 0) {
    console.error(r.output.slice(-2000));
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as Catalog;
  const counts = catalogCounts(catalog);
  const ids = allIds(catalog);
  fs.writeFileSync(idsPath, ids.join("\n"), "utf-8");
  console.log(`  items=${ids.length}`, counts);
  if (ids.length < 100) {
    console.log(
      `\n  ⚠  Source tenant only has ${ids.length} catalog item(s) — not a large CMS set.\n` +
        `     Live steps still run on the full set; use --synthetic 5000 for orchestration stress.\n`
    );
  }

  console.log("── 2) migrate --dry-run (full selection) ──");
  r = cli([
    "migrate",
    "--catalog", catalogPath,
    "--select", `@${idsPath}`,
    "--dry-run",
  ]);
  console.log(`  exit=${r.status} wall=${fmt(r.ms)}`);
  if (r.status !== 0) {
    console.error(r.output.slice(-2500));
    process.exit(1);
  }

  console.log("── 3) export-selected (full closure) ──");
  if (fs.existsSync(exportDir)) fs.rmSync(exportDir, { recursive: true, force: true });
  r = cli([
    "export-selected",
    "--catalog", catalogPath,
    "--select", `@${idsPath}`,
    "--out", exportDir,
  ]);
  console.log(`  exit=${r.status} wall=${fmt(r.ms)}`);
  if (r.status !== 0) {
    console.error(r.output.slice(-2500));
    process.exit(1);
  }

  console.log("── 4) import-all --dry-run (full selection) ──");
  r = cli([
    "import-all",
    "--in", exportDir,
    "--select", `@${idsPath}`,
    "--dry-run",
    "--allow-schema-mismatch",
    "--allow-folder-mismatch",
  ]);
  console.log(`  exit=${r.status} wall=${fmt(r.ms)}`);
  if (r.status !== 0) {
    console.error(r.output.slice(-2500));
    process.exit(1);
  }

  if (live) {
    console.log("── 5) migrate LIVE (full selection) ──");
    r = cli([
      "migrate",
      "--catalog", catalogPath,
      "--select", `@${idsPath}`,
      "--continue-on-error",
      "--allow-folder-mismatch",
      "--allow-schema-mismatch",
    ]);
    console.log(`  exit=${r.status} wall=${fmt(r.ms)}`);
    const tail = r.output.trim().slice(-1500);
    if (tail) console.log(tail);

    console.log("── 6) import-all LIVE (full selection) ──");
    r = cli([
      "import-all",
      "--in", exportDir,
      "--select", `@${idsPath}`,
      "--continue-on-error",
      "--allow-folder-mismatch",
      "--allow-schema-mismatch",
    ]);
    console.log(`  exit=${r.status} wall=${fmt(r.ms)}`);
    const tail2 = r.output.trim().slice(-1500);
    if (tail2) console.log(tail2);
  } else {
    console.log("\n  (skip live writes — pass --live to migrate + import for real)\n");
  }

  console.log("✅ Live perf harness finished\n");
}

(async () => {
  if (synthN > 0) {
    await runSynthetic(synthN);
    return;
  }
  await runLive();
  // Always also run a synthetic stress so "large set" orchestration is covered.
  await runSynthetic(Math.max(2000, synthN || 2000));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
