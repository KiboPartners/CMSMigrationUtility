/**
 * Summary reporting for File Manager import.
 */

import fs from "fs";
import path from "path";
import { ImportStats } from "./clone";

export function printSummary(stats: ImportStats): void {
  console.log("\n" + "═".repeat(65));
  console.log("  FILE MANAGER IMPORT SUMMARY");
  console.log("═".repeat(65));

  const header = [
    "Total".padStart(7),
    "Registered".padStart(12),
    "Folder Moved".padStart(14),
    "Skipped".padStart(9),
    "Errors".padStart(8),
  ].join(" │ ");

  console.log("  " + header);
  console.log("─".repeat(65));

  const row = [
    String(stats.total).padStart(7),
    String(stats.registered).padStart(12),
    String(stats.folderUpdated).padStart(14),
    String(stats.skipped).padStart(9),
    String(stats.errors.length).padStart(8),
  ].join(" │ ");

  console.log("  " + row);
  console.log("═".repeat(65) + "\n");
}

export function writeErrorReport(stats: ImportStats): string | null {
  if (stats.errors.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `asset-cloning-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);

  fs.writeFileSync(filepath, JSON.stringify(stats.errors, null, 2), "utf-8");
  return filepath;
}
