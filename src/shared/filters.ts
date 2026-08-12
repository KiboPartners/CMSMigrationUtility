/**
 * Performance-first advanced filters for Export and Migrate.
 *
 * GraphQL `where` pushdown is the primary path (suffix date ops, CMS values.*,
 * files name/tags, redirects from/to). Client residual matching covers fields
 * the API cannot express (mainly page path/title).
 *
 * Wire dates as `{ createdOn_gte, createdOn_lte }` or `createdOn_between` —
 * never nested `{ createdOn: { gte } }` (rejected on Kibo CMS 6.x).
 */

import fs from "fs";
import path from "path";
import type { ArtifactType, CatalogItem } from "./catalog";

// ── Types ────────────────────────────────────────────────────────────────────

export type DateField = "createdOn" | "modifiedOn";

export type RelativePreset =
  | "last_24h"
  | "last_7d"
  | "last_30d"
  | "this_month"
  | "previous_month"
  | "custom";

export interface DateRangeFilter {
  field: DateField;
  mode: "relative" | "absolute";
  preset?: RelativePreset;
  /** ISO date or datetime (local or UTC); resolved to UTC at freeze. */
  from?: string;
  to?: string;
}

export type DatedArtifact = "cms-entry" | "file" | "page" | "redirect";

export type FrozenDateRange = DateRangeFilter & {
  mode: "absolute";
  from: string;
  to: string;
  wireField: "createdOn" | "savedOn";
};

export type FieldOp = "contains" | "eq" | "in" | "exists";

export interface FieldFilter {
  /** Target artifact; omit = apply to all types that support the field. */
  artifact?: ArtifactType;
  field: string;
  op: FieldOp;
  value: string | string[];
}

/** User / UI filter input (presets may still be relative). */
export interface ArtifactFilterSpec {
  date?: DateRangeFilter;
  dates?: Partial<Record<DatedArtifact, DateRangeFilter>>;
  /** IANA zone per dated artifact when freezing `dates`; falls back to `timezone`. */
  dateTimezones?: Partial<Record<DatedArtifact, string>>;
  fields: FieldFilter[];
  timezone: string;
}

/** Spec with absolute UTC range frozen at Apply / job start. */
export interface FrozenFilterSpec extends ArtifactFilterSpec {
  date?: FrozenDateRange;
  dates?: Partial<Record<DatedArtifact, FrozenDateRange>>;
  frozenAt: string;
}

export type FilterCost = "pushdown" | "mixed" | "scan" | "none";

export interface ClausePlan {
  key: string;
  mode: "pushdown" | "residual" | "unsupported";
  detail: string;
}

export interface FilterPlan {
  artifact: ArtifactType;
  cost: FilterCost;
  pushdown: ClausePlan[];
  residual: ClausePlan[];
  unsupported: ClausePlan[];
  where: Record<string, unknown> | null;
  warnings: string[];
}

export interface WhereCapabilities {
  /** Suffix date ops available on the list where-input. */
  dates: { createdOn: boolean; savedOn: boolean; modifiedOn: boolean };
  /** String / enum fields that can be pushed. */
  fields: {
    siteId?: boolean;
    nameContains?: boolean; // values.title_contains or name_contains
    keyContains?: boolean;
    tagsIn?: boolean;
    status?: boolean;
    redirectFromContains?: boolean;
    redirectToContains?: boolean;
    isEnabled?: boolean;
  };
  /** CMS: title-ish field ids under values (per model). Empty → residual name. */
  titleFields?: string[];
}

/** Probe-validated defaults for tenant installs matching Phase 0. */
export const DEFAULT_WHERE_CAPS: Record<Exclude<ArtifactType, "model">, WhereCapabilities> = {
  "cms-entry": {
    dates: { createdOn: true, savedOn: true, modifiedOn: true },
    fields: { siteId: true, nameContains: true, status: true },
    titleFields: ["title", "name", "label", "heading", "text", "subtitle"],
  },
  file: {
    dates: { createdOn: true, savedOn: true, modifiedOn: true },
    fields: { nameContains: true, keyContains: true, tagsIn: true },
  },
  page: {
    dates: { createdOn: true, savedOn: true, modifiedOn: true },
    fields: { status: true },
    // path/title not in where — residual only
  },
  redirect: {
    dates: { createdOn: true, savedOn: true, modifiedOn: true },
    fields: { redirectFromContains: true, redirectToContains: true, isEnabled: true },
  },
};

const MAX_STRING = 500;
const MAX_IN = 50;
const MAX_RANGE_DAYS = 365 * 5;

// ── Validation / load ────────────────────────────────────────────────────────

export function emptyFilterSpec(timezone = "UTC"): ArtifactFilterSpec {
  return { fields: [], timezone };
}

function isDateFilterActive(date: DateRangeFilter | undefined): boolean {
  if (!date) return false;
  if (date.mode === "absolute") return !!(date.from || date.to);
  return !!(date.preset && date.preset !== "custom");
}

export function isFilterActive(spec: ArtifactFilterSpec | null | undefined): boolean {
  if (!spec) return false;
  if (isDateFilterActive(spec.date)) return true;
  if (spec.dates) {
    for (const d of Object.values(spec.dates)) {
      if (isDateFilterActive(d)) return true;
    }
  }
  return (spec.fields ?? []).some((f) => {
    if (f.op === "exists") return true;
    if (Array.isArray(f.value)) return f.value.length > 0;
    return String(f.value ?? "").trim().length > 0;
  });
}

function parseDateRangeFilter(raw: unknown): DateRangeFilter | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const field = (d.field === "modifiedOn" ? "modifiedOn" : "createdOn") as DateField;
  const mode = d.mode === "absolute" ? "absolute" : "relative";
  const preset = (typeof d.preset === "string" ? d.preset : "last_7d") as RelativePreset;
  return {
    field,
    mode,
    preset,
    from: d.from != null ? String(d.from) : undefined,
    to: d.to != null ? String(d.to) : undefined,
  };
}

export function validateFilterSpec(raw: unknown): ArtifactFilterSpec {
  if (raw == null || typeof raw !== "object") {
    throw new Error("Filter JSON must be an object");
  }
  const o = raw as Record<string, unknown>;
  const timezone = typeof o.timezone === "string" && o.timezone.trim() ? o.timezone.trim() : "UTC";
  const fieldsIn = Array.isArray(o.fields) ? o.fields : [];
  if (fieldsIn.length > 40) throw new Error("Too many field filters (max 40)");

  const fields: FieldFilter[] = [];
  for (const f of fieldsIn) {
    if (!f || typeof f !== "object") throw new Error("Invalid field filter");
    const ff = f as Record<string, unknown>;
    const field = String(ff.field ?? "").trim();
    const op = String(ff.op ?? "contains") as FieldOp;
    if (!field || field.length > 64) throw new Error("Invalid filter field name");
    if (!["contains", "eq", "in", "exists"].includes(op)) throw new Error(`Invalid op: ${op}`);
    let value: string | string[] = "";
    if (op === "in") {
      const arr = Array.isArray(ff.value)
        ? ff.value.map((v) => String(v))
        : String(ff.value ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      if (arr.length > MAX_IN) throw new Error(`in-list too large (max ${MAX_IN})`);
      for (const s of arr) if (s.length > MAX_STRING) throw new Error("Filter value too long");
      value = arr;
    } else if (op !== "exists") {
      value = String(ff.value ?? "");
      if (value.length > MAX_STRING) throw new Error("Filter value too long");
    }
    const artifact = ff.artifact != null ? (String(ff.artifact) as ArtifactType) : undefined;
    fields.push({ artifact, field, op, value });
  }

  let date: DateRangeFilter | undefined;
  if (o.date && typeof o.date === "object") {
    date = parseDateRangeFilter(o.date);
  }

  let dates: Partial<Record<DatedArtifact, DateRangeFilter>> | undefined;
  if (o.dates && typeof o.dates === "object") {
    dates = {};
    for (const key of Object.keys(o.dates) as DatedArtifact[]) {
      const parsed = parseDateRangeFilter((o.dates as Record<string, unknown>)[key]);
      if (parsed) dates[key] = parsed;
    }
    if (!Object.keys(dates).length) dates = undefined;
  }

  let dateTimezones: Partial<Record<DatedArtifact, string>> | undefined;
  if (o.dateTimezones && typeof o.dateTimezones === "object") {
    dateTimezones = {};
    for (const key of Object.keys(o.dateTimezones) as DatedArtifact[]) {
      const tz = (o.dateTimezones as Record<string, unknown>)[key];
      if (typeof tz === "string" && tz.trim()) dateTimezones[key] = tz.trim();
    }
    if (!Object.keys(dateTimezones).length) dateTimezones = undefined;
  }

  return { date, dates, dateTimezones, fields, timezone };
}

/** Load filter JSON from a path, or from `@path` / bare path string used like --select. */
export function loadFilterSpec(fileOrAt: string): ArtifactFilterSpec {
  const p = fileOrAt.startsWith("@") ? fileOrAt.slice(1) : fileOrAt;
  if (!p || p.includes("\0")) throw new Error("Invalid filter path");
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`Filter file not found: ${abs}`);
  const raw = JSON.parse(fs.readFileSync(abs, "utf-8")) as unknown;
  return validateFilterSpec(raw);
}

/**
 * Parse `--filter` CLI option: empty → null; `@file` / path → freeze at call time.
 * Optionally merge --site-id / --tags overrides (CLI wins).
 */
export function parseFilterCliOption(
  filterPath: string | undefined,
  overrides?: { siteId?: string; tags?: string },
  now = new Date()
): FrozenFilterSpec | null {
  let spec: ArtifactFilterSpec | null = null;
  if (filterPath?.trim()) {
    spec = loadFilterSpec(filterPath.trim());
  }
  if (overrides?.siteId?.trim() || overrides?.tags?.trim()) {
    spec = mergeCliOverrides(spec ?? emptyFilterSpec(), overrides);
  }
  if (!spec || !isFilterActive(spec)) return null;
  return freezeFilterSpec(spec, now);
}

export function writeFilterSpec(filePath: string, spec: ArtifactFilterSpec | FrozenFilterSpec): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), "utf-8");
}

/** Merge CLI --site-id / --tags into a filter spec (CLI wins on that dimension). */
export function mergeCliOverrides(
  spec: ArtifactFilterSpec,
  opts: { siteId?: string; tags?: string }
): ArtifactFilterSpec {
  const fields = [...(spec.fields ?? [])];
  if (opts.siteId?.trim()) {
    const i = fields.findIndex((f) => f.field === "siteId" && (!f.artifact || f.artifact === "cms-entry"));
    const row: FieldFilter = { artifact: "cms-entry", field: "siteId", op: "eq", value: opts.siteId.trim() };
    if (i >= 0) fields[i] = row;
    else fields.push(row);
  }
  if (opts.tags?.trim()) {
    const tags = opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const i = fields.findIndex((f) => f.field === "tags" && (!f.artifact || f.artifact === "file"));
    const row: FieldFilter = { artifact: "file", field: "tags", op: "in", value: tags };
    if (i >= 0) fields[i] = row;
    else fields.push(row);
  }
  return { ...spec, fields };
}

// ── Date resolution (freeze at Apply) ────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as UTC ISO without ms. */
export function toUtcIso(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000Z`
  );
}

/**
 * Resolve relative/absolute date filter to a frozen UTC inclusive range.
 * `now` is injectable for tests. Timezone is used for calendar presets
 * (this_month / previous_month) via Intl offset approximation — for v1 we
 * resolve calendar months in the given IANA zone when possible, else UTC.
 */
export function resolveAbsoluteRange(
  date: DateRangeFilter,
  timezone: string,
  now = new Date()
): { from: string; to: string; wireField: "createdOn" | "savedOn" } {
  const wireField: "createdOn" | "savedOn" = date.field === "modifiedOn" ? "savedOn" : "createdOn";
  let from: Date;
  let to: Date = new Date(now.getTime());

  if (date.mode === "absolute" || date.preset === "custom") {
    if (!date.from && !date.to) throw new Error("Custom date range needs from and/or to");
    from = date.from ? parseFlexibleDate(date.from, false, timezone) : new Date(0);
    to = date.to ? parseFlexibleDate(date.to, true, timezone) : new Date(now.getTime());
  } else {
    const preset = date.preset ?? "last_7d";
    switch (preset) {
      case "last_24h":
        from = new Date(now.getTime() - 24 * 3600_000);
        break;
      case "last_7d":
        from = new Date(now.getTime() - 7 * 24 * 3600_000);
        break;
      case "last_30d":
        from = new Date(now.getTime() - 30 * 24 * 3600_000);
        break;
      case "this_month": {
        const parts = zonedYmd(now, timezone);
        from = new Date(Date.UTC(parts.y, parts.m - 1, 1, 0, 0, 0));
        break;
      }
      case "previous_month": {
        const parts = zonedYmd(now, timezone);
        const pm = parts.m === 1 ? 12 : parts.m - 1;
        const py = parts.m === 1 ? parts.y - 1 : parts.y;
        from = new Date(Date.UTC(py, pm - 1, 1, 0, 0, 0));
        to = new Date(Date.UTC(parts.y, parts.m - 1, 1, 0, 0, 0) - 1);
        break;
      }
      default:
        from = new Date(now.getTime() - 7 * 24 * 3600_000);
    }
  }

  if (from.getTime() > to.getTime()) throw new Error("Filter date range: from is after to");
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new Error(`Filter date range too large (max ${MAX_RANGE_DAYS} days)`);
  }

  return { from: toUtcIso(from), to: toUtcIso(to), wireField };
}

/** Wall-clock parts of an instant in an IANA timezone. */
function wallPartsInZone(
  ms: number,
  timeZone: string
): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: n("year"), m: n("month"), d: n("day"), h: n("hour"), mi: n("minute"), s: n("second") };
}

/**
 * Convert a wall-clock date/time in `timeZone` to a UTC Date.
 * `hms` is "HH:mm", "HH:mm:ss", or "HH:mm:ss.SSS".
 */
export function zonedWallToUtc(ymd: string, hms: string, timeZone: string): Date {
  const [Y, M, D] = ymd.split("-").map(Number);
  const [hPart, mPart, sPart = "0"] = hms.split(":");
  const h = Number(hPart);
  const mi = Number(mPart);
  const sWhole = String(sPart).split(".")[0] ?? "0";
  const s = Number(sWhole);
  const frac = String(sPart).includes(".") ? String(sPart).split(".")[1] : "";
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  const desired = Date.UTC(Y, M - 1, D, h, mi, s, ms);
  // Iterate: adjust UTC guess until its wall clock in the zone matches desired parts.
  let t = desired;
  for (let i = 0; i < 4; i++) {
    const w = wallPartsInZone(t, timeZone || "UTC");
    const wallAsUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s, ms);
    const diff = desired - wallAsUtc;
    if (diff === 0) break;
    t += diff;
  }
  return new Date(t);
}

/**
 * Parse date-only (`YYYY-MM-DD`), datetime-local (`YYYY-MM-DDTHH:mm`),
 * or ISO strings. Date/datetime-local are interpreted in `timeZone`
 * (endOfDay → 23:59:59.999 when time is omitted).
 */
export function parseFlexibleDate(s: string, endOfDay: boolean, timeZone = "UTC"): Date {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return zonedWallToUtc(t, endOfDay ? "23:59:59.999" : "00:00:00.000", timeZone);
  }
  // datetime-local from <input type="datetime-local"> — no zone suffix
  const local = t.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
  if (local && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    const sec = local[3] ?? "00";
    const frac = local[4] ? `.${local[4]}` : "";
    return zonedWallToUtc(local[1], `${local[2]}:${sec}${frac}`, timeZone);
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

function zonedYmd(now: Date, timeZone: string): { y: number; m: number; d: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(now);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const d = Number(parts.find((p) => p.type === "day")?.value);
    if (y && m && d) return { y, m, d };
  } catch {
    /* fall through */
  }
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

/** Freeze relative presets into absolute UTC — call once at job start. */
export function freezeFilterSpec(spec: ArtifactFilterSpec, now = new Date()): FrozenFilterSpec {
  const frozenAt = toUtcIso(now);
  const fields = [...(spec.fields ?? [])];
  let date: FrozenFilterSpec["date"];
  if (spec.date) {
    const resolved = resolveAbsoluteRange(spec.date, spec.timezone || "UTC", now);
    date = {
      field: spec.date.field,
      mode: "absolute",
      preset: spec.date.preset ?? "custom",
      from: resolved.from,
      to: resolved.to,
      wireField: resolved.wireField,
    };
  }
  let dates: FrozenFilterSpec["dates"];
  if (spec.dates) {
    dates = {};
    for (const key of Object.keys(spec.dates) as DatedArtifact[]) {
      const d = spec.dates[key];
      if (!d) continue;
      const tz = spec.dateTimezones?.[key] || spec.timezone || "UTC";
      const resolved = resolveAbsoluteRange(d, tz, now);
      dates[key] = {
        field: d.field,
        mode: "absolute",
        preset: d.preset ?? "custom",
        from: resolved.from,
        to: resolved.to,
        wireField: resolved.wireField,
      };
    }
    if (!Object.keys(dates).length) dates = undefined;
  }
  return {
    timezone: spec.timezone,
    dateTimezones: spec.dateTimezones,
    fields,
    date,
    dates,
    frozenAt,
  };
}

export function frozenDateForArtifact(
  spec: FrozenFilterSpec,
  artifact: ArtifactType
): FrozenDateRange | undefined {
  if (artifact === "model") return undefined;
  const key = artifact as DatedArtifact;
  return spec.dates?.[key] ?? spec.date;
}

function isFrozenFilterSpec(spec: FrozenFilterSpec | ArtifactFilterSpec): spec is FrozenFilterSpec {
  if (!("frozenAt" in spec)) return false;
  if (spec.date && "wireField" in spec.date) return true;
  if (spec.dates && Object.values(spec.dates).some((d) => d && "wireField" in d)) return true;
  return false;
}

// ── Where builders ───────────────────────────────────────────────────────────

function fieldApplies(f: FieldFilter, artifact: ArtifactType): boolean {
  return !f.artifact || f.artifact === artifact;
}

function strVal(v: string | string[]): string {
  return Array.isArray(v) ? (v[0] ?? "") : v;
}

function arrVal(v: string | string[]): string[] {
  return Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * GraphQL `*_contains` usually maps to ES/Lucene. Characters like `-` are NOT
 * operators and `.` splits tokens, so `name_contains: "my-file.jpg"` returns no
 * hits even when the file exists. Force residual (substring) match instead.
 * Redirects keep pushdown (paths with `/` are the normal case there).
 */
export function containsNeedleUnsafeForPushdown(needle: string): boolean {
  return /[-.+=&|!(){}[\]^"~*?:\\]/.test(needle);
}

function containsNeedlesUnsafeForPushdown(needles: string[]): boolean {
  return needles.some(containsNeedleUnsafeForPushdown);
}

/** Field shape used to pick the CMS values.* title field for `*_contains` pushdown. */
export interface TitleFieldCandidate {
  fieldId: string;
  type?: string;
  settings?: Record<string, unknown>;
}

const TITLE_NAME_PRIORITY = ["title", "name", "label", "heading", "text", "subtitle"];
const TEXTISH_TYPES = new Set(["text", "long-text", "longtext", "rich-text", "richtext", "textarea"]);

/**
 * Pick the best per-model field id for `values.{id}_contains` name search.
 * Order: settings.title / isTitle → preferred names among text types →
 * preferred names any type → first text-like field. Returns null → residual name.
 */
export function resolveModelTitleField(fields: TitleFieldCandidate[]): string | null {
  if (!fields.length) return null;
  for (const f of fields) {
    const s = f.settings;
    if (s && (s["title"] === true || s["isTitle"] === true || s["useAsTitle"] === true)) {
      return f.fieldId;
    }
  }
  const isTextish = (f: TitleFieldCandidate) => {
    const t = (f.type ?? "").toLowerCase();
    return !t || TEXTISH_TYPES.has(t) || t.includes("text");
  };
  for (const pref of TITLE_NAME_PRIORITY) {
    const hit = fields.find((f) => f.fieldId.toLowerCase() === pref && isTextish(f));
    if (hit) return hit.fieldId;
  }
  for (const pref of TITLE_NAME_PRIORITY) {
    const hit = fields.find((f) => f.fieldId.toLowerCase() === pref);
    if (hit) return hit.fieldId;
  }
  const text = fields.find((f) => f.type && TEXTISH_TYPES.has(f.type.toLowerCase()));
  return text?.fieldId ?? null;
}

export type FilterBadgeKind = "none" | "source" | "mixed" | "scan";

/**
 * UI cost badge for a filter + the artifact types in the run.
 * "source" only when every non-model type can push all expensive clauses.
 */
export function filterBadgeKind(
  types: ArtifactType[],
  spec: ArtifactFilterSpec | FrozenFilterSpec | null | undefined
): FilterBadgeKind {
  if (!spec || !isFilterActive(spec)) return "none";
  const relevant = types.filter((t) => t !== "model");
  if (!relevant.length) return "none";
  if (allTypesSourceFiltered(relevant, spec)) return "source";
  let anyScan = false;
  let anyMixed = false;
  let pageNameResidual = false;
  for (const t of relevant) {
    const plan = buildWhereForArtifact(t, spec);
    if (plan.cost === "scan") anyScan = true;
    if (plan.cost === "mixed") anyMixed = true;
    if (
      t === "page" &&
      plan.residual.some((c) => c.key === "name" || c.key === "path" || c.key === "title")
    ) {
      pageNameResidual = true;
    }
  }
  // Expected limitation (no page path where) — surface as Mixed, not Full scan
  if (pageNameResidual) return "mixed";
  if (anyScan && !relevant.some((t) => buildWhereForArtifact(t, spec).cost === "pushdown")) {
    return "scan";
  }
  if (anyMixed || anyScan) return "mixed";
  return "source";
}

/** Soft guard: true when active filters force a full list scan for any selected type. */
export function needsScanConfirm(
  types: ArtifactType[],
  spec: ArtifactFilterSpec | FrozenFilterSpec | null | undefined
): boolean {
  if (!spec || !isFilterActive(spec)) return false;
  return types
    .filter((t) => t !== "model")
    .some((t) => buildWhereForArtifact(t, spec).cost === "scan");
}

/** Build suffix date where fragment. Prefer `*_between` when both ends set. */
export function buildDateWhere(
  wireField: "createdOn" | "savedOn",
  from: string,
  to: string,
  caps: WhereCapabilities
): Record<string, unknown> | null {
  const ok =
    wireField === "createdOn" ? caps.dates.createdOn : caps.dates.savedOn || caps.dates.modifiedOn;
  if (!ok) return null;
  if (from && to) return { [`${wireField}_between`]: [from, to] };
  const w: Record<string, unknown> = {};
  if (from) w[`${wireField}_gte`] = from;
  if (to) w[`${wireField}_lte`] = to;
  return Object.keys(w).length ? w : null;
}

/**
 * Build GraphQL `where` + classify pushdown vs residual for one artifact type.
 * For CMS, pass `modelTitleFields` / `hasSiteId` when known.
 */
export function buildWhereForArtifact(
  artifact: ArtifactType,
  spec: FrozenFilterSpec | ArtifactFilterSpec,
  caps: WhereCapabilities = DEFAULT_WHERE_CAPS[artifact as Exclude<ArtifactType, "model">] ?? {
    dates: { createdOn: false, savedOn: false, modifiedOn: false },
    fields: {},
  },
  opts?: {
    /** Preferred: full field defs (type + settings) for accurate title pick. */
    modelFields?: TitleFieldCandidate[];
    /** Fallback: field ids only. */
    modelTitleFields?: string[];
    hasSiteId?: boolean;
  }
): FilterPlan {
  if (artifact === "model") {
    return {
      artifact,
      cost: "none",
      pushdown: [],
      residual: [],
      unsupported: [],
      where: null,
      warnings: [],
    };
  }

  const frozen: FrozenFilterSpec = isFrozenFilterSpec(spec) ? spec : freezeFilterSpec(spec);

  const where: Record<string, unknown> = {};
  const pushdown: ClausePlan[] = [];
  const residual: ClausePlan[] = [];
  const unsupported: ClausePlan[] = [];
  const warnings: string[] = [];
  const values: Record<string, unknown> = {};

  // Date
  const dateSlice = frozenDateForArtifact(frozen, artifact);
  if (dateSlice?.from && dateSlice?.to) {
    const wire = dateSlice.wireField;
    const dw = buildDateWhere(wire, dateSlice.from, dateSlice.to, caps);
    if (dw) {
      Object.assign(where, dw);
      pushdown.push({
        key: "date",
        mode: "pushdown",
        detail: `${wire}_between ${dateSlice.from} … ${dateSlice.to}`,
      });
    } else {
      residual.push({ key: "date", mode: "residual", detail: `${wire} (no date ops in where-input)` });
      warnings.push(`No date pushdown for ${artifact} — date filter applied client-side (full list scan).`);
    }
  }

  const titleCandidates: TitleFieldCandidate[] =
    opts?.modelFields?.length
      ? opts.modelFields
      : opts?.modelTitleFields?.length
      ? opts.modelTitleFields.map((id) => ({ fieldId: id }))
      : (caps.titleFields ?? []).map((id) => ({ fieldId: id }));
  const titleFieldResolved = resolveModelTitleField(titleCandidates);

  for (const f of frozen.fields ?? []) {
    if (!fieldApplies(f, artifact)) continue;
    const key = f.field.toLowerCase();

    if (artifact === "cms-entry") {
      if (key === "siteid") {
        const v = strVal(f.value).trim();
        if (!v) continue;
        if (caps.fields.siteId && opts?.hasSiteId !== false) {
          if (f.op === "contains") values.siteId_contains = v;
          else values.siteId = v;
          pushdown.push({ key: "siteId", mode: "pushdown", detail: `values.siteId=${v}` });
        } else {
          residual.push({ key: "siteId", mode: "residual", detail: v });
        }
        continue;
      }
      if (key === "name" || key === "title") {
        const needles = arrVal(f.value).map((s) => s.trim()).filter(Boolean);
        if (!needles.length) continue;
        const titleField = titleFieldResolved;
        if (caps.fields.nameContains && titleField && !containsNeedlesUnsafeForPushdown(needles)) {
          if (needles.length === 1) {
            values[`${titleField}_contains`] = needles[0];
            pushdown.push({
              key: "name",
              mode: "pushdown",
              detail: `values.${titleField}_contains=${needles[0]}`,
            });
          } else {
            // Webiny ANDs top-level keys; OR of contains for multi-value name lists
            where.OR = needles.map((n) => ({ values: { [`${titleField}_contains`]: n } }));
            pushdown.push({
              key: "name",
              mode: "pushdown",
              detail: `OR values.${titleField}_contains ×${needles.length}`,
            });
          }
        } else {
          residual.push({ key: "name", mode: "residual", detail: needles.join(", ") });
          if (!titleField) {
            warnings.push("CMS name filter: no title-like field on model — residual match on label.");
          } else if (containsNeedlesUnsafeForPushdown(needles)) {
            warnings.push(
              "CMS name filter: hyphen/punctuation in value — matching in-process (API contains breaks on - .)."
            );
          }
        }
        continue;
      }
      if (key === "status") {
        const v = strVal(f.value).trim();
        if (!v) continue;
        if (caps.fields.status) {
          where.status = v;
          pushdown.push({ key: "status", mode: "pushdown", detail: `status=${v}` });
        } else {
          residual.push({ key: "status", mode: "residual", detail: v });
        }
        continue;
      }
    }

    if (artifact === "file") {
      if (key === "tags") {
        const tags = arrVal(f.value);
        if (!tags.length) continue;
        if (caps.fields.tagsIn) {
          where.tags_in = tags;
          pushdown.push({ key: "tags", mode: "pushdown", detail: `tags_in=[${tags.join(",")}]` });
        } else {
          residual.push({ key: "tags", mode: "residual", detail: tags.join(",") });
        }
        continue;
      }
      if (key === "name" || key === "key") {
        const needles = arrVal(f.value).map((s) => s.trim()).filter(Boolean);
        if (!needles.length) continue;
        const useKey = key === "key";
        const can =
          (useKey && caps.fields.keyContains) || (!useKey && caps.fields.nameContains);
        const op = useKey ? "key_contains" : "name_contains";
        if (can && !containsNeedlesUnsafeForPushdown(needles)) {
          if (needles.length === 1) {
            where[op] = needles[0];
            pushdown.push({ key: useKey ? "key" : "name", mode: "pushdown", detail: `${op}=${needles[0]}` });
          } else {
            where.OR = needles.map((n) => ({ [op]: n }));
            pushdown.push({
              key: useKey ? "key" : "name",
              mode: "pushdown",
              detail: `OR ${op} ×${needles.length}`,
            });
          }
        } else {
          residual.push({ key: useKey ? "key" : "name", mode: "residual", detail: needles.join(", ") });
          if (containsNeedlesUnsafeForPushdown(needles)) {
            warnings.push(
              `File ${useKey ? "key" : "name"} filter: hyphen/punctuation in value — matching in-process (API contains breaks on - .).`
            );
          }
        }
        continue;
      }
    }

    if (artifact === "page") {
      if (key === "status") {
        const v = strVal(f.value).trim();
        if (!v) continue;
        if (caps.fields.status) {
          where.status = v;
          pushdown.push({ key: "status", mode: "pushdown", detail: `status=${v}` });
        } else {
          residual.push({ key: "status", mode: "residual", detail: v });
        }
        continue;
      }
      if (key === "name" || key === "title" || key === "path") {
        const needles = arrVal(f.value).map((s) => s.trim()).filter(Boolean);
        if (!needles.length) continue;
        residual.push({ key: key === "path" ? "path" : "name", mode: "residual", detail: needles.join(", ") });
        continue;
      }
    }

    if (artifact === "redirect") {
      if (key === "name" || key === "from" || key === "redirectfrom") {
        const needles = arrVal(f.value).map((s) => s.trim()).filter(Boolean);
        if (!needles.length) continue;
        if (caps.fields.redirectFromContains) {
          if (needles.length === 1) {
            where.redirectFrom_contains = needles[0];
            pushdown.push({
              key: "redirectFrom",
              mode: "pushdown",
              detail: `redirectFrom_contains=${needles[0]}`,
            });
          } else {
            where.OR = needles.map((n) => ({ redirectFrom_contains: n }));
            pushdown.push({
              key: "redirectFrom",
              mode: "pushdown",
              detail: `OR redirectFrom_contains ×${needles.length}`,
            });
          }
        } else {
          residual.push({ key: "redirectFrom", mode: "residual", detail: needles.join(", ") });
        }
        continue;
      }
      if (key === "to" || key === "redirectto") {
        const needles = arrVal(f.value).map((s) => s.trim()).filter(Boolean);
        if (!needles.length) continue;
        if (caps.fields.redirectToContains) {
          if (needles.length === 1) {
            where.redirectTo_contains = needles[0];
            pushdown.push({
              key: "redirectTo",
              mode: "pushdown",
              detail: `redirectTo_contains=${needles[0]}`,
            });
          } else {
            where.OR = needles.map((n) => ({ redirectTo_contains: n }));
            pushdown.push({
              key: "redirectTo",
              mode: "pushdown",
              detail: `OR redirectTo_contains ×${needles.length}`,
            });
          }
        } else {
          residual.push({ key: "redirectTo", mode: "residual", detail: needles.join(", ") });
        }
        continue;
      }
    }

    unsupported.push({ key: f.field, mode: "unsupported", detail: `${f.op} on ${artifact}` });
  }

  if (Object.keys(values).length) where.values = values;

  const whereOut = Object.keys(where).length ? where : null;
  let cost: FilterCost = "none";
  if (pushdown.length && residual.length) cost = "mixed";
  else if (pushdown.length) cost = "pushdown";
  else if (residual.length || unsupported.length) cost = "scan";

  if (cost === "scan" && isFilterActive(frozen)) {
    warnings.push(
      `Full scan for ${artifact} — filters could not be pushed to GraphQL where (or only residual).`
    );
  }

  return {
    artifact,
    cost,
    pushdown,
    residual,
    unsupported,
    where: whereOut,
    warnings,
  };
}

export function describeFilterPlan(
  artifact: ArtifactType,
  spec: FrozenFilterSpec | ArtifactFilterSpec,
  caps?: WhereCapabilities,
  opts?: {
    modelFields?: TitleFieldCandidate[];
    modelTitleFields?: string[];
    hasSiteId?: boolean;
  }
): FilterPlan {
  return buildWhereForArtifact(artifact, spec, caps, opts);
}

/** True when every selected expensive clause is pushdown for the given types. */
export function allTypesSourceFiltered(
  types: ArtifactType[],
  spec: FrozenFilterSpec | ArtifactFilterSpec
): boolean {
  if (!isFilterActive(spec)) return false;
  const expensive = new Set(["date", "siteId", "tags", "name"]);
  for (const t of types) {
    if (t === "model") continue;
    const plan = buildWhereForArtifact(t, spec);
    const keys = new Set(plan.pushdown.map((c) => c.key));
    // If we have residual for any expensive clause that was requested, not fully source-filtered
    for (const r of plan.residual) {
      if (expensive.has(r.key) || r.key === "path" || r.key === "title") return false;
    }
    if (plan.cost === "scan" || plan.cost === "mixed") {
      // mixed (e.g. pages with name residual) → not "Source-filtered" for all
      if (plan.residual.some((c) => c.key === "name" || c.key === "path" || c.key === "title")) {
        return false;
      }
      if (plan.cost === "scan") return false;
    }
    void keys;
  }
  return types.some((t) => t !== "model" && buildWhereForArtifact(t, spec).pushdown.length > 0);
}

// ── Residual / catalog match ─────────────────────────────────────────────────

function includesCI(hay: unknown, needle: string): boolean {
  if (!needle) return true;
  if (hay == null) return false;
  return String(hay).toLowerCase().includes(needle.toLowerCase());
}

function itemDateMs(item: CatalogItem, field: "createdOn" | "modifiedOn"): number | null {
  const meta = item.metadata ?? {};
  const raw =
    field === "modifiedOn"
      ? (meta.modifiedOn ?? meta.savedOn ?? meta.updatedOn)
      : (meta.createdOn ?? meta.created);
  if (raw == null) return null;
  const t = new Date(String(raw)).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Client-side match for residual clauses / UI refine on an already-loaded catalog.
 * When `residualOnly` is true, only clauses that were not pushed are checked
 * (and date if date was residual). When false, applies the full spec.
 */
export function matchCatalogItem(
  item: CatalogItem,
  spec: FrozenFilterSpec | ArtifactFilterSpec,
  opts?: { residualKeys?: Set<string>; full?: boolean }
): boolean {
  const frozen: FrozenFilterSpec = isFrozenFilterSpec(spec) ? spec : freezeFilterSpec(spec);

  const residualKeys = opts?.residualKeys;
  const check = (key: string) => opts?.full || !residualKeys || residualKeys.has(key);

  const dateSlice = frozenDateForArtifact(frozen, item.type);
  if (dateSlice?.from && dateSlice?.to && check("date")) {
    const field = dateSlice.field;
    const ms = itemDateMs(item, field);
    if (ms != null) {
      const from = new Date(dateSlice.from).getTime();
      const to = new Date(dateSlice.to).getTime();
      if (ms < from || ms > to) return false;
    }
  }

  for (const f of frozen.fields ?? []) {
    if (f.artifact && f.artifact !== item.type) continue;
    const key = f.field.toLowerCase();
    const planKey =
      key === "redirectfrom" || key === "from"
        ? "redirectFrom"
        : key === "redirectto" || key === "to"
        ? "redirectTo"
        : key === "title"
        ? "name"
        : key;
    if (!check(planKey) && !check(key)) continue;

    const needles = arrVal(f.value).map((s) => s.trim()).filter(Boolean);
    const anyNeedle = (haystack: unknown) =>
      !needles.length || needles.some((n) => includesCI(haystack, n));
    const v = needles[0] ?? "";

    if (key === "siteid") {
      if (v && String((item.metadata ?? {}).siteId ?? "") !== v && f.op === "eq") return false;
      if (needles.length && f.op === "contains" && !anyNeedle((item.metadata ?? {}).siteId)) return false;
      continue;
    }
    if (key === "name" || key === "title") {
      // OR across comma-separated needles (any match). Include key for files
      // (S3 key / path often holds my-file.jpg when display name differs).
      if (
        needles.length &&
        !needles.some(
          (n) =>
            includesCI(item.label, n) ||
            includesCI((item.metadata ?? {}).name, n) ||
            includesCI((item.metadata ?? {}).path, n) ||
            includesCI((item.metadata ?? {}).key, n)
        )
      ) {
        return false;
      }
      continue;
    }
    if (key === "path") {
      if (
        needles.length &&
        !needles.some((n) => includesCI((item.metadata ?? {}).path, n) || includesCI(item.label, n))
      ) {
        return false;
      }
      continue;
    }
    if (key === "status") {
      if (v && !includesCI((item.metadata ?? {}).status, v)) return false;
      continue;
    }
    if (key === "tags") {
      const want = needles.map((t) => t.toLowerCase());
      const have = ((item.metadata ?? {}).tags as string[] | undefined) ?? [];
      if (want.length && have.length && !want.every((t) => have.some((h) => String(h).toLowerCase() === t))) {
        // If tags not in metadata, don't reject (export path uses pushdown)
        if (have.length) return false;
      }
      continue;
    }
    if (key === "key") {
      if (needles.length && !needles.some((n) => includesCI((item.metadata ?? {}).key, n) || includesCI(item.id, n))) {
        return false;
      }
      continue;
    }
    if (key === "from" || key === "redirectfrom") {
      if (needles.length && !needles.some((n) => includesCI(item.id, n) || includesCI(item.label, n))) {
        return false;
      }
      continue;
    }
    if (key === "to" || key === "redirectto") {
      if (needles.length && !anyNeedle((item.metadata ?? {}).to)) return false;
      continue;
    }
  }
  return true;
}

/** Filter a list of catalog items with residual (or full) matching. */
export function filterCatalogItems(
  items: CatalogItem[],
  spec: FrozenFilterSpec | ArtifactFilterSpec,
  plan?: FilterPlan
): CatalogItem[] {
  if (!isFilterActive(spec)) return items;
  const residualKeys = plan
    ? new Set([...plan.residual.map((c) => c.key), ...plan.unsupported.map((c) => c.key)])
    : undefined;
  // If there are residual clauses, apply those; if plan says scan, apply full.
  const full = !plan || plan.cost === "scan" || plan.cost === "none";
  return items.filter((it) =>
    matchCatalogItem(it, spec, {
      residualKeys: full ? undefined : residualKeys,
      full: full || !residualKeys?.size,
    })
  );
}

// ── Caps cache ───────────────────────────────────────────────────────────────

export interface CapsCacheFile {
  key: string;
  savedAt: string;
  ttlMs: number;
  caps: Partial<Record<ArtifactType, WhereCapabilities>>;
}

export function capsCacheKey(opts: {
  manageUrl?: string;
  adminUrl?: string;
  tenant: string;
  locale?: string;
}): string {
  return [opts.manageUrl || opts.adminUrl || "", opts.tenant, opts.locale || "en-US"].join("|");
}

export function loadCapsCache(
  cacheDir: string,
  key: string,
  ttlMs = 24 * 3600_000
): CapsCacheFile | null {
  const p = path.join(cacheDir, "where-caps.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as CapsCacheFile;
    if (raw.key !== key) return null;
    if (Date.now() - new Date(raw.savedAt).getTime() > (raw.ttlMs || ttlMs)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCapsCache(cacheDir: string, file: CapsCacheFile): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "where-caps.json"), JSON.stringify(file, null, 2), "utf-8");
}

/**
 * Derive capabilities from introspected where-input field names (lowercase).
 * Used by probes / caps warm; fail-closed when date suffix ops absent.
 */
export function capsFromInputFieldNames(
  artifact: Exclude<ArtifactType, "model">,
  inputFieldNames: string[]
): WhereCapabilities {
  const lower = new Set(inputFieldNames.map((n) => n.toLowerCase()));
  const has = (n: string) => lower.has(n.toLowerCase());
  const base = { ...DEFAULT_WHERE_CAPS[artifact], fields: { ...DEFAULT_WHERE_CAPS[artifact].fields } };
  base.dates = {
    createdOn: has("createdOn_gte") || has("createdOn_between") || has("createdon_gte"),
    savedOn: has("savedOn_gte") || has("savedOn_between") || has("savedon_gte"),
    modifiedOn: has("modifiedOn_gte") || has("modifiedOn_between") || has("modifiedon_gte"),
  };
  if (artifact === "cms-entry") {
    // values is nested — presence of values alone isn't enough; keep defaults if values exists
    base.fields.siteId = has("values") || base.fields.siteId;
    base.fields.nameContains = has("values") || base.fields.nameContains;
    base.fields.status = has("status") || has("status_in");
  }
  if (artifact === "file") {
    base.fields.nameContains = has("name_contains");
    base.fields.keyContains = has("key_contains");
    base.fields.tagsIn = has("tags_in");
  }
  if (artifact === "page") {
    base.fields.status = has("status") || has("status_in");
  }
  if (artifact === "redirect") {
    base.fields.redirectFromContains = has("redirectfrom_contains");
    base.fields.redirectToContains = has("redirectto_contains");
    base.fields.isEnabled = has("isenabled");
  }
  return base;
}

export function formatFilterPlanLog(plan: FilterPlan): string {
  const lines = [
    `Filter plan (${plan.artifact}): cost=${plan.cost}`,
    ...plan.pushdown.map((c) => `  pushdown: ${c.detail}`),
    ...plan.residual.map((c) => `  residual: ${c.key} — ${c.detail}`),
    ...plan.unsupported.map((c) => `  unsupported: ${c.detail}`),
    ...plan.warnings.map((w) => `  ⚠ ${w}`),
  ];
  if (plan.where) lines.push(`  where: ${JSON.stringify(plan.where)}`);
  return lines.join("\n");
}
