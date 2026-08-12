/**
 * Run an artifact CLI in-process (no spawn). Traps process.exit so a CLI
 * failure cannot tear down the host (server / orchestrator).
 */

import { createCollectingLogger, setLogger, consoleLogger, Logger } from "../shared/logger";

export type ArtifactPkg = "cms-entries" | "file-manager" | "page-builder" | "redirects";

class CliExitError extends Error {
  constructor(public readonly code: number) {
    super(`CLI exited with code ${code}`);
    this.name = "CliExitError";
  }
}

type ArtifactModule = {
  runArtifactCli: (args: string[]) => Promise<void>;
};

async function loadArtifact(pkg: ArtifactPkg): Promise<ArtifactModule> {
  switch (pkg) {
    case "cms-entries":
      return import("../artifacts/cms-entries/cli");
    case "file-manager":
      return import("../artifacts/file-manager/cli");
    case "page-builder":
      return import("../artifacts/page-builder/cli");
    case "redirects":
      return import("../artifacts/redirects/cli");
    default:
      throw new Error(`Unknown artifact: ${pkg}`);
  }
}

export interface RunArtifactResult {
  ok: boolean;
  output: string;
  exitCode: number;
}

/**
 * Invoke `src/artifacts/<pkg>/cli.ts` with the given argv (no node/binary prefix).
 * When `capture` is true, console output is buffered (and still echoed) for ledgers.
 */
export async function runArtifact(
  pkg: ArtifactPkg,
  args: string[],
  opts: { capture?: boolean; extraLogger?: Logger } = {}
): Promise<RunArtifactResult> {
  const mod = await loadArtifact(pkg);
  const collected = opts.capture ? createCollectingLogger() : null;
  const prevExit = process.exit;

  let restoreLogger: (() => void) | undefined;
  if (collected) {
    const tee: Logger = {
      log: (m, ...r) => {
        consoleLogger.log(m, ...r);
        collected.logger.log(m, ...r);
        opts.extraLogger?.log(m, ...r);
      },
      warn: (m, ...r) => {
        consoleLogger.warn(m, ...r);
        collected.logger.warn(m, ...r);
        opts.extraLogger?.warn(m, ...r);
      },
      error: (m, ...r) => {
        consoleLogger.error(m, ...r);
        collected.logger.error(m, ...r);
        opts.extraLogger?.error(m, ...r);
      },
      write: (t) => {
        consoleLogger.write(t);
        collected.logger.write(t);
        opts.extraLogger?.write(t);
      },
    };
    setLogger(tee);
    restoreLogger = () => setLogger(consoleLogger);

    // Also tee raw console.* used by report.ts / orchestrator-style prints in CLIs
    const orig = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...a: unknown[]) => {
      orig.log(...a);
      collected.logger.log(...a);
    };
    console.warn = (...a: unknown[]) => {
      orig.warn(...a);
      collected.logger.warn(...a);
    };
    console.error = (...a: unknown[]) => {
      orig.error(...a);
      collected.logger.error(...a);
    };
    const prevRestore = restoreLogger;
    restoreLogger = () => {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      prevRestore();
    };
  } else if (opts.extraLogger) {
    const tee: Logger = {
      log: (m, ...r) => {
        consoleLogger.log(m, ...r);
        opts.extraLogger!.log(m, ...r);
      },
      warn: (m, ...r) => {
        consoleLogger.warn(m, ...r);
        opts.extraLogger!.warn(m, ...r);
      },
      error: (m, ...r) => {
        consoleLogger.error(m, ...r);
        opts.extraLogger!.error(m, ...r);
      },
      write: (t) => {
        consoleLogger.write(t);
        opts.extraLogger!.write(t);
      },
    };
    setLogger(tee);
    restoreLogger = () => setLogger(consoleLogger);
  }

  process.exit = ((code?: number) => {
    throw new CliExitError(code ?? 0);
  }) as typeof process.exit;

  let exitCode = 0;
  try {
    await mod.runArtifactCli(args);
  } catch (e) {
    if (e instanceof CliExitError) {
      exitCode = e.code;
    } else {
      exitCode = 1;
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      if (collected) collected.logger.error(msg);
      else console.error(msg);
    }
  } finally {
    process.exit = prevExit;
    restoreLogger?.();
  }

  const output = collected
    ? collected.lines.map((l) => l.text).join("\n")
    : "";
  return { ok: exitCode === 0, output, exitCode };
}
