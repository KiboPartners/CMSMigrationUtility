/**
 * Consolidated configuration loader.
 *
 * Single source of truth for environment variables across every package.
 * Instead of a per-package `.env`, all packages load ONE repo-root `.env`
 * (found by walking up to the workspace root). A local `.env` in the current
 * working directory is still honoured as a fallback for any var the root
 * `.env` does not set, so existing per-package setups keep working.
 *
 * Each package's own `config.ts` is a thin adapter that maps the values
 * resolved here onto its existing ExportConfig / ImportConfig shape.
 */

import fs from "fs";
import path from "path";
import { config as dotenvConfig } from "dotenv";

let envLoaded = false;

/** Walk up from startDir to find the monorepo root (package.json with "workspaces"). */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const json = JSON.parse(fs.readFileSync(pj, "utf-8")) as { workspaces?: unknown };
        if (json.workspaces) return dir;
      } catch {
        /* ignore unparseable package.json and keep walking up */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the consolidated repo-root `.env` (authoritative), then a local `.env`
 * from the current directory as a fallback. Idempotent — safe to call from
 * every package; only the first call does work.
 *
 * dotenv never overrides an already-set variable, so root values win and the
 * local `.env` only fills gaps.
 */
export function loadRootEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const root = findRepoRoot();
  if (root) dotenvConfig({ path: path.join(root, ".env") });
  dotenvConfig(); // local ./.env fills any vars the root .env did not define
}

// ── Primitive accessors ───────────────────────────────────────────────────────

export function requireEnv(name: string): string {
  loadRootEnv();
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `  Set it in the repo-root .env (see .env.example).`
    );
  }
  return v;
}

export function optionalEnv(name: string, fallback = ""): string {
  loadRootEnv();
  return process.env[name] ?? fallback;
}

export function envFlag(name: string): boolean {
  loadRootEnv();
  return process.env[name] === "true";
}

export function envInt(name: string, fallback: number): number {
  loadRootEnv();
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isNaN(n) ? fallback : n; // honor an explicit 0
}

// ── Environment (source | target) ──────────────────────────────────────────────

export type EnvRole = "source" | "target";

/** Connection details for one Kibo CMS environment. */
export interface EnvironmentConfig {
  adminGqlUrl: string; // Admin GQL — schema introspection, page-builder, file-manager, redirects
  manageUrl: string;   // Manage API — CMS entry CRUD + content-model management ("" if unused)
  apiKey: string;
  tenant: string;
  cdnDomain: string;   // "" if unused
}

export interface ResolveEnvOptions {
  /** Require ROLE_MANAGE_URL (cms-entries). Default false. */
  requireManage?: boolean;
  /** Require ROLE_CDN_DOMAIN. Default false. */
  requireCdn?: boolean;
  /**
   * Whether the core fields (admin url, api key) are required. Default true.
   * Set false to tolerate a missing target during dry-runs.
   */
  required?: boolean;
}

/**
 * Resolve one environment from ROLE_*-prefixed variables, e.g.
 * SOURCE_ADMIN_GQL_URL / TARGET_API_KEY / TARGET_TENANT.
 */
export function resolveEnvironment(role: EnvRole, opts: ResolveEnvOptions = {}): EnvironmentConfig {
  loadRootEnv();
  const P = role.toUpperCase();
  const required = opts.required !== false;
  const core = required ? requireEnv : (n: string) => optionalEnv(n);

  return {
    adminGqlUrl: core(`${P}_ADMIN_GQL_URL`),
    manageUrl: opts.requireManage && required ? requireEnv(`${P}_MANAGE_URL`) : optionalEnv(`${P}_MANAGE_URL`),
    apiKey: core(`${P}_API_KEY`),
    tenant: optionalEnv(`${P}_TENANT`, "root"),
    cdnDomain: opts.requireCdn && required ? requireEnv(`${P}_CDN_DOMAIN`) : optionalEnv(`${P}_CDN_DOMAIN`),
  };
}

// ── Shared option accessors ─────────────────────────────────────────────────────

export function getLocale(fallback = "en-US"): string {
  return optionalEnv("LOCALE", fallback);
}
export function getRateLimitDelay(): number {
  return envInt("RATE_LIMIT_DELAY_MS", 0);
}
export function getDebug(): boolean {
  return envFlag("DEBUG");
}

/**
 * Safety gate for destructive purges. A purge always targets TARGET_TENANT — but
 * teams often reuse one Kibo instance with several tenants as both source and
 * target. If TARGET_TENANT === SOURCE_TENANT, a purge would delete the very tenant
 * being used as a source. Refuse unless explicitly overridden.
 *
 * Throws when the two tenants match and allowSameTenant is false.
 */
/**
 * Banner shown before a real (non-dry-run) purge that was requested without
 * --force. The CLI prints this and aborts; the user re-runs with --force to
 * actually delete. `note` states the per-artifact reversibility.
 */
export function purgeWarning(artifact: string, tenant: string, note: string): string {
  const bar = "═".repeat(64);
  return [
    "",
    bar,
    `  ⚠  PURGE — about to delete ${artifact}`,
    `     Target tenant: ${tenant}`,
    `     ${note}`,
    `     This is destructive. Re-run with --force to execute, or --confirm alone to preview.`,
    bar,
    "",
  ].join("\n");
}

export function assertPurgeTargetSafe(allowSameTenant = false): void {
  const src = (process.env["SOURCE_TENANT"] ?? "").trim();
  const tgt = (process.env["TARGET_TENANT"] ?? "").trim();
  if (src && tgt && src === tgt && !allowSameTenant) {
    throw new Error(
      `Refusing to purge: TARGET_TENANT (${tgt}) is the same as SOURCE_TENANT.\n` +
        `  A purge deletes content on the TARGET. Set a different TARGET_TENANT,\n` +
        `  or pass --allow-same-tenant if you truly intend to purge this tenant.`
    );
  }
}
