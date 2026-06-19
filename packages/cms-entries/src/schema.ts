/**
 * Load model definitions from a Kibo CMS CMS model export JSON file.
 *
 * The file is produced by the Kibo CMS UI: Content Models → ⋮ → Export.
 * It contains `groups` and `models` arrays; we only care about `models`.
 *
 * Using this file as the schema source replaces the listContentModels API
 * round-trips and all their version-specific fallback logic.
 */

import fs from "fs";
import { ModelDefinition, FieldDefinition, SYSTEM_FIELDS } from "./introspect";
import { logger } from "@kibo-cms-clone-tool/shared";

// ── Kibo CMS export shape (only the fields we actually use) ─────────────────────

interface CmsExportField {
  fieldId: string;
  type: string;       // "text" | "file" | "rich-text" | "ref" | "number" | "boolean" | "object" | …
  list: boolean;      // true = multipleValues
  settings?: Record<string, unknown>;
  storageId?: string; // e.g. "text@dkhfbwwz" — informational only
}

interface CmsExportModel {
  modelId: string;
  name: string;
  singularApiName: string;
  pluralApiName: string;
  fields: CmsExportField[];
}

interface CmsExportFile {
  groups?: unknown[];
  models: CmsExportModel[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Map a Kibo CMS export field to our internal FieldDefinition.
 * The `type` value is kept as-is — it matches the values our buildSelectionSet
 * already understands ("ref", "file", "object", etc.).
 */
function mapField(f: CmsExportField): FieldDefinition {
  return {
    fieldId: f.fieldId,
    type: f.type,
    multipleValues: f.list ?? false,
    settings: f.settings ?? {},
  };
}

/**
 * Build a ModelDefinition from a single Kibo CMS export model entry.
 * Operation names are derived directly from singularApiName / pluralApiName —
 * these are exactly what Kibo CMS uses in the GraphQL schema.
 */
function buildModelDef(m: CmsExportModel): ModelDefinition {
  const singularCap = capitalize(m.singularApiName);
  const pluralCap   = capitalize(m.pluralApiName);

  const fields: FieldDefinition[] = (m.fields ?? [])
    .filter((f) => !SYSTEM_FIELDS.has(f.fieldId))
    .map(mapField);

  return {
    modelId:        m.modelId,
    name:           m.name ?? m.singularApiName,
    pluralApiName:  m.pluralApiName,
    fields,
    listOperation:    `list${pluralCap}`,
    createOperation:  `create${singularCap}`,
    updateOperation:  `update${singularCap}`,
    publishOperation: `publish${singularCap}`,
    deleteOperation:  `delete${singularCap}`,
    whereInputType:   `${singularCap}ListWhereInput`,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a Kibo CMS model export JSON file and return a map of
 * modelName → ModelDefinition for the requested models.
 *
 * @param filePath       Path to the Kibo CMS export JSON
 * @param requestedModels Names to include (case-insensitive). Pass ["ALL"] for everything.
 */
export function loadSchemaFile(
  filePath: string,
  requestedModels: string[]
): Map<string, ModelDefinition> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Schema file not found: ${filePath}\n  Export it from the CMS admin UI: Content Models → ⋮ → Export`);
  }

  let raw: CmsExportFile;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CmsExportFile;
  } catch (e) {
    throw new Error(`Failed to parse schema file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error(`Schema file ${filePath} contains no models`);
  }

  const all = requestedModels.length === 1 && requestedModels[0].toUpperCase() === "ALL";
  const result = new Map<string, ModelDefinition>();

  for (const m of raw.models) {
    const modelName = m.name ?? m.singularApiName;
    if (!all && !requestedModels.some((r) => r.toLowerCase() === modelName.toLowerCase())) {
      continue;
    }
    result.set(modelName, buildModelDef(m));
  }

  // Warn about requested models absent from the file
  if (!all) {
    for (const req of requestedModels) {
      if (![...result.keys()].some((k) => k.toLowerCase() === req.toLowerCase())) {
        logger.warn(`  ⚠  Model "${req}" not found in schema file — check the name matches exactly`);
      }
    }
  }

  return result;
}
