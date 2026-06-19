/**
 * cli-progress wrapper providing a consistent progress bar style
 * across all cloning packages.
 */

import cliProgress from "cli-progress";

export function createProgressBar(label: string, total: number): cliProgress.SingleBar {
  const bar = new cliProgress.SingleBar(
    {
      format: `  {label} │{bar}│ {value}/{total} ({percentage}%) {status}`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: true,
    },
    cliProgress.Presets.shades_classic
  );

  bar.start(total, 0, { label: label.padEnd(20), status: "" });
  return bar;
}

export function updateProgress(
  bar: cliProgress.SingleBar,
  value: number,
  status: string = ""
): void {
  bar.update(value, { status });
}

export function stopProgress(bar: cliProgress.SingleBar): void {
  bar.stop();
}
