/**
 * Summary reporting for CMS entries import.
 */

import fs from "fs";
import path from "path";
import { ModelCloneResult } from "./clone";

export function printSummary(results: ModelCloneResult[]): void {
  console.log("\n" + "═".repeat(75));
  console.log("  IMPORT SUMMARY");
  console.log("═".repeat(75));

  const header = [
    "Model".padEnd(20),
    "Total".padStart(7),
    "Created".padStart(9),
    "Updated".padStart(9),
    "Published".padStart(11),
    "Skipped".padStart(9),
    "Errors".padStart(8),
  ].join(" │ ");

  console.log("  " + header);
  console.log("─".repeat(75));

  let totalTotal = 0, totalCreated = 0, totalUpdated = 0;
  let totalPublished = 0, totalSkipped = 0, totalErrors = 0;

  for (const r of results) {
    const row = [
      r.modelName.padEnd(20),
      String(r.total).padStart(7),
      String(r.created).padStart(9),
      String(r.updated).padStart(9),
      String(r.published).padStart(11),
      String(r.skipped).padStart(9),
      String(r.errors.length).padStart(8),
    ].join(" │ ");
    console.log("  " + row);

    totalTotal += r.total;
    totalCreated += r.created;
    totalUpdated += r.updated;
    totalPublished += r.published;
    totalSkipped += r.skipped;
    totalErrors += r.errors.length;
  }

  console.log("─".repeat(75));
  const totalsRow = [
    "TOTAL".padEnd(20),
    String(totalTotal).padStart(7),
    String(totalCreated).padStart(9),
    String(totalUpdated).padStart(9),
    String(totalPublished).padStart(11),
    String(totalSkipped).padStart(9),
    String(totalErrors).padStart(8),
  ].join(" │ ");
  console.log("  " + totalsRow);
  console.log("═".repeat(75) + "\n");
}

export function writeErrorReport(results: ModelCloneResult[]): string | null {
  const allErrors = results.flatMap((r) =>
    r.errors.map((e) => ({ model: r.modelName, ...e }))
  );

  if (allErrors.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `cloning-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);

  fs.writeFileSync(filepath, JSON.stringify(allErrors, null, 2), "utf-8");
  return filepath;
}
