/**
 * Summary reporting for redirects import.
 */

import fs from "fs";
import path from "path";
import { ImportStats } from "./clone";

export function printSummary(stats: ImportStats): void {
  console.log("\n" + "═".repeat(65));
  console.log("  REDIRECTS IMPORT SUMMARY");
  console.log("═".repeat(65));

  const header = [
    "Total".padStart(7),
    "Created".padStart(9),
    "Updated".padStart(9),
    "Unchanged".padStart(11),
    "Errors".padStart(8),
  ].join(" │ ");

  console.log("  " + header);
  console.log("─".repeat(65));

  const row = [
    String(stats.total).padStart(7),
    String(stats.created).padStart(9),
    String(stats.updated).padStart(9),
    String(stats.skipped).padStart(11),
    String(stats.errors.length).padStart(8),
  ].join(" │ ");

  console.log("  " + row);
  console.log("═".repeat(65) + "\n");
}

export function writeErrorReport(stats: ImportStats): string | null {
  if (stats.errors.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `redirects-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);

  fs.writeFileSync(filepath, JSON.stringify(stats.errors, null, 2), "utf-8");
  return filepath;
}
