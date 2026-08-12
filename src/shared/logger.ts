/**
 * Swappable logger for engine code.
 *
 * Library modules emit progress/warnings through `logger` instead of calling
 * `console` directly, so an embedding host (API server, UI, tests) can capture
 * or silence output by calling setLogger(). The default is the console logger,
 * so CLI behaviour is unchanged.
 *
 * This is a pragmatic module-level sink rather than full dependency injection —
 * good enough to make the engine embeddable without threading a logger argument
 * through every function signature.
 */

export interface Logger {
  log(message?: unknown, ...rest: unknown[]): void;
  warn(message?: unknown, ...rest: unknown[]): void;
  error(message?: unknown, ...rest: unknown[]): void;
  /** Write without a trailing newline (progress lines). */
  write(text: string): void;
}

export const consoleLogger: Logger = {
  log: (m, ...r) => console.log(m as string, ...(r as string[])),
  warn: (m, ...r) => console.warn(m as string, ...(r as string[])),
  error: (m, ...r) => console.error(m as string, ...(r as string[])),
  write: (t) => process.stdout.write(t),
};

export const silentLogger: Logger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  write: () => {},
};

export interface CollectedLine {
  level: "log" | "warn" | "error" | "write";
  text: string;
}

/** A logger that records everything into an array — useful for APIs/tests. */
export function createCollectingLogger(): { logger: Logger; lines: CollectedLine[] } {
  const lines: CollectedLine[] = [];
  const push = (level: CollectedLine["level"]) => (m?: unknown, ...rest: unknown[]) =>
    lines.push({ level, text: [m, ...rest].filter((x) => x !== undefined).map(String).join(" ") });
  return {
    lines,
    logger: {
      log: push("log"),
      warn: push("warn"),
      error: push("error"),
      write: (t) => lines.push({ level: "write", text: t }),
    },
  };
}

let active: Logger = consoleLogger;

/** Replace the active logger (e.g. silentLogger or a collecting logger). */
export function setLogger(next: Logger): void {
  active = next;
}

/** The active logger. Library code imports this and calls logger.log/warn/etc. */
export const logger: Logger = {
  log: (m, ...r) => active.log(m, ...r),
  warn: (m, ...r) => active.warn(m, ...r),
  error: (m, ...r) => active.error(m, ...r),
  write: (t) => active.write(t),
};
