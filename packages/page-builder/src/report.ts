/**
 * Summary reporting for Page Builder import.
 */

import fs from "fs";
import path from "path";
import { ImportResult } from "./pages";

export function printSummary(result: ImportResult): void {
  console.log("\n" + "═".repeat(65));
  console.log("  PAGE BUILDER IMPORT SUMMARY");
  console.log("═".repeat(65));

  const header = [
    "Total".padStart(7),
    "Created".padStart(9),
    "Updated".padStart(9),
    "Published".padStart(11),
    "Errors".padStart(8),
  ].join(" │ ");

  console.log("  " + header);
  console.log("─".repeat(65));

  const row = [
    String(result.total).padStart(7),
    String(result.created).padStart(9),
    String(result.updated).padStart(9),
    String(result.published).padStart(11),
    String(result.errors.length).padStart(8),
  ].join(" │ ");

  console.log("  " + row);
  console.log("═".repeat(65) + "\n");
}

export function writeErrorReport(result: ImportResult): string | null {
  if (result.errors.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `page-cloning-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);

  fs.writeFileSync(filepath, JSON.stringify(result.errors, null, 2), "utf-8");
  return filepath;
}
