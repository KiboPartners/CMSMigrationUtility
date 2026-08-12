/**
 * NDJSON (newline-delimited JSON) streaming helpers — shared across artifact
 * exporters/importers so a large dataset never sits fully in memory.
 *
 * Format: one JSON record per line, UTF-8, "\n"-delimited. JSON.stringify escapes
 * `\n`/`\r` inside values, but leaves U+2028/U+2029 literal — Node's `readline`
 * treats those as line breaks (Node 24+), so we escape them on write and split
 * only on `\n`/`\r\n` when reading.
 */

import fs from "fs";
import path from "path";

/** Escape LS/PS so a record never contains a readline line terminator. */
function escapeJsonLineSeparators(json: string): string {
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** One record → a single NDJSON line (record + trailing "\n"). */
export function encodeLine(obj: unknown): string {
  return escapeJsonLineSeparators(JSON.stringify(obj)) + "\n";
}

/** Parse one NDJSON line. Blank/whitespace-only lines return undefined (skip). */
export function parseLine(line: string): unknown | undefined {
  const t = line.trim();
  if (!t) return undefined;
  return JSON.parse(t);
}

/**
 * Buffered line writer over a file write stream. `write` appends one record;
 * `close` flushes and closes. Parent directory is created. Backpressure from the
 * stream is respected implicitly by Node's internal buffer; for our page-sized
 * bursts (≤50 records) that is sufficient.
 */
export function createNdjsonWriter(filePath: string): { write(obj: unknown): void; close(): Promise<void> } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { encoding: "utf-8" });
  return {
    write(obj: unknown) {
      stream.write(encodeLine(obj));
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        stream.end(resolve);
      });
    },
  };
}

/**
 * Stream a file line-by-line, calling `onItem` for each parsed record (awaited so
 * a slow consumer applies backpressure). Blank lines are skipped. Returns the
 * number of records processed. Splits only on `\n` / `\r\n` (not U+2028/U+2029).
 */
export async function readNdjsonLines(
  filePath: string,
  onItem: (obj: Record<string, unknown>) => void | Promise<void>
): Promise<number> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  let buf = "";
  let count = 0;

  const emit = async (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const obj = parseLine(line);
    if (obj === undefined) return;
    await onItem(obj as Record<string, unknown>);
    count++;
  };

  for await (const chunk of stream) {
    buf += chunk as string;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      await emit(line);
    }
  }
  if (buf.length) await emit(buf);
  return count;
}
