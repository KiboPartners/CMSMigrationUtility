# Kibo CMS Migration Utility

Migrate content — **content models, CMS entries, pages, redirects, file metadata** — between Kibo CMS environments or tenants, over the GraphQL APIs. No server or S3 access. Drive it from a **web UI** or the **CLI**.

- **Browse & select** what to migrate; dependencies are pulled in automatically.
- **Models fetched live from source** and provisioned on the target — no manual schema export.
- **Validates** existing target models before importing; blocks on field mismatch.
- **Folder structure preserved.** ACO folders for files, redirects, pages and CMS entries are recreated on the target (match-or-create, parents first) and each item is placed in its matching folder. A pre-import gate blocks if a folder can't sync (override: `--allow-folder-mismatch`).
- **Resumable, audited runs** with per-item success/failure + metrics + per-step timing.
- **Adaptive throttling** backs off automatically on rate limits.

Source is only ever **read**. Target is written only when you run a real (non–dry-run) migration.

---

## Setup

Prerequisites: **Node.js 20+** and **git**.

```bash
git clone <repo-url> kibo-cms-clone-tool
cd kibo-cms-clone-tool
npm install
npm run build
cp .env.example .env      # then fill in SOURCE_* and TARGET_* (see below)
```

One `.env` at the repo root is used by everything (a per-package `.env` is a fallback).

**Where to find each value** (per environment, in the Kibo admin):

| Var | Where |
|---|---|
| `*_ADMIN_GQL_URL` | Your Kibo CMS GraphQL endpoint — e.g. `https://cms-api.<region>.gcp.kibocommerce.com/graphql` |
| `*_MANAGE_URL` | Same host + `/cms/manage/<locale>` — e.g. `…/cms/manage/en-US` |
| `*_API_KEY` | An application/API key with **both** Admin GQL and Headless CMS (Manage) scopes (see Permissions below) |
| `*_TENANT` | The `/{tenantId}/` segment of your admin URL |
| `*_CDN_DOMAIN` | The CDN host that serves your file assets |

`.env.example` has a filled-in sample of the URL shapes to copy.

**Required** — per environment, prefixed `SOURCE_` and `TARGET_`:

| Var | Purpose |
|---|---|
| `*_ADMIN_GQL_URL` | Admin GraphQL endpoint (pages, redirects, files) |
| `*_MANAGE_URL` | Manage API endpoint (CMS entries + content models) |
| `*_API_KEY` | API key for that environment |
| `*_TENANT` | Tenant id (`root` if single-tenant) |
| `*_CDN_DOMAIN` | CDN host, for rewriting embedded asset URLs |
| `LOCALE` | e.g. `en-US` (shared, not prefixed) |

### Permissions prerequisite

Each `*_API_KEY` must be authorized for **both** APIs on **that tenant**, or only part of the content migrates:

| API | Covers | Without it |
|---|---|---|
| **Admin GraphQL** (`*_ADMIN_GQL_URL`) | pages, redirects, files, ACO folders | those artifacts can't be read/written |
| **Manage API** (`*_MANAGE_URL`) | content models + CMS entries | models/entries show **"Not authorized"** and are skipped — even though pages still pull |

A key scoped to Admin GQL only is the usual cause of *"pages migrated but models/entries didn't."* Grant the key the **Headless CMS (Manage)** application scope for the tenant. The catalog surfaces a per-type "Not authorized / no access" note rather than failing the whole run.

**Optional** — all have defaults:

| Var | Default | Effect |
|---|---|---|
| `SCHEMA_FILE` | — | Offline model-schema override (models are fetched live otherwise) |
| `MODELS` | all | Restrict cms-entries to named models |
| `SITE_ID_FILTER` | — | Only export entries with this `siteId` |
| `CONCURRENCY` | `5` | Parallel writes |
| `EXPORT_CONCURRENCY` | `6` | Parallel models during cms-entries export (falls back to `CONCURRENCY`) |
| `DRY_RUN` | `false` | Preview without writing |
| `SKIP_EXISTING` | `true` | file-manager: skip files already on target |
| `INCLUDE_UNPUBLISHED` | `true` | page-builder: include unpublished pages |
| `TAGS_FILTER` | — | file-manager: only export files with these tags |
| `SOURCE_S3_BUCKET` / `TARGET_S3_BUCKET` / `SOURCE_S3_PREFIX` | — | Names used in the generated `s3-copy-manifest.txt` |
| `RATE_LIMIT_DELAY_MS` | `0` | Base inter-request delay (floor; throttle is adaptive) |
| `DEBUG` | `false` | Verbose GraphQL logging |

See `.env.example` for the full template.

---

## Web UI

```bash
npx ts-node index.ts serve            # → http://localhost:4317  (--port to change)
```

**KIBO CMS Import Export Utility** — a collapsible left nav over five workspaces (light/dark theme):

| Workspace | What it does | CLI equivalent |
|---|---|---|
| **Export** | Pick a source tenant + artifact types (+ optional CMS model filter); writes to a timestamped server folder `export/exp-<tenant>-<ts>/`. | `export-all` |
| **Import** | Choose a previously exported folder, pick types **and/or individual items** (select none = whole folder), **dry-run** + **allow folder mismatch** toggles. | `import-all` |
| **Migrate** | Direct source→target: load catalog → select artifacts → migrate, with **dry-run / skip-export / allow schema mismatch / allow folder mismatch** toggles + per-item progress. CMS-entry & page rows show name, folder path, author, created/modified, status, and Live (with version when live). Import is selective too. | `catalog-all` → `plan` → `migrate` |
| **Purge** | Catalog the **target**, select items, **dry-run preview**, then delete behind a **typed-tenant confirmation** modal. Toggles: **permanent** (else soft-delete to bin/Trash), **allow same tenant**. | per-package `purge --select` |
| **Logs** | Run-ledger browser: text search + from/to date filter, aggregate metrics, per-run detail. | `runs`, `metrics` |

**Parity note:** every workspace maps to a CLI command (above). **CLI-only** (not in the UI): run **resume**, and advanced flags (site-id, concurrency, locale). UI export/import/migrate/purge are synchronous — for very large jobs use the CLI.

---

## CLI

The root orchestrator (`index.ts`) drives the two main flows: **selective copy** (`catalog-all` → `plan` → `migrate`) and **whole-environment** (`export-all` → `import-all`). All commands below run from the repo root.

### Selective copy (catalog → plan → migrate)

```bash
# 1. Catalog the source (models, entries, pages, redirects, files)
npx ts-node index.ts catalog-all --env source --out catalog.json
npx ts-node index.ts catalog-all --env target --out target.json   # read target instead
npx ts-node index.ts catalog-all --env source --skip file-manager --out catalog.json  # skip a type

# 2. Plan a selection (ids from the catalog; "a,b,c" inline or @file for a list)
npx ts-node index.ts plan --catalog catalog.json --select "id1,id2"
npx ts-node index.ts plan --catalog catalog.json --select @ids.txt --out plan.json

# 3. Migrate — dry-run first (no writes, no run recorded), then for real
npx ts-node index.ts migrate --catalog catalog.json --select @ids.txt --dry-run
npx ts-node index.ts migrate --catalog catalog.json --select @ids.txt

# Migrate with overrides
npx ts-node index.ts migrate --catalog catalog.json --select @ids.txt --allow-schema-mismatch   # import despite a field-incompatible target model
npx ts-node index.ts migrate --catalog catalog.json --select @ids.txt --allow-folder-mismatch    # items whose folder didn't sync fall back to root
npx ts-node index.ts migrate --catalog catalog.json --select @ids.txt --skip-export              # reuse the existing ./export staging dir (caution: stale ids become errors)

# 4. Audit / resume
npx ts-node index.ts runs                       # list recorded runs
npx ts-node index.ts runs --show <run-id>       # full per-item ledger for one run
npx ts-node index.ts metrics                    # totals + top errors across all runs
npx ts-node index.ts migrate --resume <run-id>  # re-run only the items that didn't finish
```

`migrate` runs in dependency order (**models → files → entries → pages → redirects**), provisions missing models from the live source schema, validates existing ones, recreates ACO folders + places items in them, and records a resumable run under `.runs/`. Each run prints a per-step timing table. (Dry-run records no run — it just prints the plan.)

**Tenants** default from `.env`; override per command with env-var prefixes:

```bash
SOURCE_TENANT=<src> TARGET_TENANT=<tgt> npx ts-node index.ts migrate --catalog catalog.json --select @ids.txt
```

### Whole-environment copy (export-all → import-all)

```bash
# Export every artifact type from source → ./export/{files,cms,pages,redirects}
npx ts-node index.ts export-all --out ./export

# Scope the export
npx ts-node index.ts export-all --out ./export --models PromoBanner,Article   # only these CMS models
npx ts-node index.ts export-all --out ./export --site-id kibo-us              # only CMS entries with this siteId
npx ts-node index.ts export-all --out ./export --tags hero,banners           # only files with these tags
npx ts-node index.ts export-all --out ./export --locale en-US                # locale for cms-entries + pages
npx ts-node index.ts export-all --out ./export --skip file-manager,redirects # skip whole packages

# Import the staged export → target. Dry-run first, then real.
npx ts-node index.ts import-all --in ./export --dry-run
npx ts-node index.ts import-all --in ./export
npx ts-node index.ts import-all --in ./export --allow-folder-mismatch        # items whose folder didn't sync fall back to root
npx ts-node index.ts import-all --in ./export --skip redirects               # skip a package on import
```

> When driven from the UI, `export-all`/`import-all` need an **absolute** `--out`/`--in` (each package spawns with its own cwd; a relative path scatters output). From the repo root the relative defaults are fine.

---

## Per-package commands

Each package (`packages/<name>`) also runs standalone. Common flags: `--dry-run`, `--select ids|@file`, `--in`/`--out`.

| Package | Migrates | Notable commands |
|---|---|---|
| `cms-entries` | CMS entries + content models | `export`, `import [--create-missing-model] [--allow-schema-mismatch] [--allow-folder-mismatch]`, `models [--env src] [--provision ids]`, `catalog`, `purge` |
| `file-manager` | File metadata (+ `s3-copy-manifest.txt`) | `export`, `import [--allow-folder-mismatch]`, `catalog`, `purge` |
| `page-builder` | Pages | `export`, `import [--allow-folder-mismatch]`, `catalog`, `purge` |
| `redirects` | Redirects | `export`, `import [--allow-folder-mismatch]`, `catalog`, `purge` |

Run these from inside the package dir (`cd packages/<name>`). Defaults write/read `./export/<type>`.

```bash
# cms-entries — export (live model introspection unless --models / --schema-file given)
cd packages/cms-entries
npx ts-node index.ts export --out ./export/cms                       # ALL models
npx ts-node index.ts export --out ./export/cms --models PromoBanner,Article
npx ts-node index.ts export --out ./export/cms --site-id kibo-us --locale en-US
# cms-entries — import (model is provisioned live from source when --create-missing-model)
npx ts-node index.ts import --in ./export/cms --dry-run
npx ts-node index.ts import --in ./export/cms --create-missing-model
npx ts-node index.ts import --in ./export/cms --create-missing-model --allow-schema-mismatch --allow-folder-mismatch
npx ts-node index.ts import --in ./export/cms --select @ids.txt      # only these entryIds
npx ts-node index.ts models --env source                            # list models
npx ts-node index.ts models --provision @model-ids.txt              # create selected models on target

# file-manager — metadata only (binaries go via the generated s3-copy-manifest.txt)
cd packages/file-manager
npx ts-node index.ts export --out ./export/files --tags hero,banners
npx ts-node index.ts import --in ./export/files --dry-run
npx ts-node index.ts import --in ./export/files --allow-folder-mismatch
npx ts-node index.ts import --in ./export/files --select @keys.txt  # only these files (src URL or key)

# page-builder
cd packages/page-builder
npx ts-node index.ts export --out ./export/pages --locale en-US --include-unpublished false
npx ts-node index.ts import --in ./export/pages --dry-run
npx ts-node index.ts import --in ./export/pages --select @page-ids.txt --allow-folder-mismatch

# redirects
cd packages/redirects
npx ts-node index.ts export --out ./export/redirects
npx ts-node index.ts import --in ./export/redirects --dry-run
npx ts-node index.ts import --in ./export/redirects --select @from-paths.txt --allow-folder-mismatch
```

### Purge (rollback) — destructive, heavily guarded

Purge deletes content **from the target** (per package). It is gated by a safety ladder — each step is opt-in:

| Step | Flag | Effect |
|---|---|---|
| 1 | *(none)* | **Dry-run** — lists what would be deleted, writes nothing |
| 2 | `--confirm` | Prints a destructive-action **warning and stops** (preview the impact) |
| 3 | `--force` | Overrides the warning and **actually deletes** |
| — | `--permanent` | Hard-delete (skip the bin/Trash, **unrecoverable**). Default is **soft delete** |
| — | `--allow-same-tenant` | Required to purge when `TARGET_TENANT == SOURCE_TENANT` (otherwise refused) |

**Soft delete by default (recoverable):** entries and pages are deleted with `options: { permanently: false }` → they go to the recycle bin / Trash and can be restored in the CMS admin. `--permanent` hard-deletes. **Deleting a content model** removes all of its entries and is **always unrecoverable**.

**Same-tenant guard:** a real purge refuses to run when target == source (a real purge once wiped a source tenant). Override only with `--allow-same-tenant`.

**Scope:** `--all` (everything for the matched type on target) or export-manifest `--in <dir>` (only what's in that export).

```bash
# cms-entries
cd packages/cms-entries
npx ts-node index.ts purge --in ./export/cms                        # DRY RUN (default)
npx ts-node index.ts purge --all --models PromoBanner --confirm    # shows the warning, then stops
npx ts-node index.ts purge --all --models PromoBanner --force      # actually deletes
npx ts-node index.ts purge --all --models PromoBanner --force --allow-same-tenant

# file-manager — metadata only; S3 binaries are NOT removed
cd packages/file-manager
npx ts-node index.ts purge --in ./export/files                      # DRY RUN
npx ts-node index.ts purge --all --force                           # every file registration on target

# page-builder — pages are moved to TRASH (empty Trash in the admin to remove permanently).
# WbPage has no stable cross-env id, so page purge is always all-pages (no --in / --all).
cd packages/page-builder
npx ts-node index.ts purge                                          # DRY RUN — all pages
npx ts-node index.ts purge --force

# redirects
cd packages/redirects
npx ts-node index.ts purge --in ./export/redirects                  # DRY RUN
npx ts-node index.ts purge --all --force
```

> **Irreversible cascade:** purging CMS entries (or models) on the target cannot be undone — re-importing is the only recovery. Always run the dry-run first and double-check `TARGET_TENANT`.

---

## Notes

- **Idempotent.** Imports upsert by stable key — entries by `entryId`, pages by path/slug, redirects by `redirectFrom`, files by key. Safe to re-run. Folder sync is match-or-create, so re-runs reuse folders rather than duplicating them.
- **Folders preserved.** The source ACO folder tree is recreated on the target (parents first) and each item is placed in its matching folder — files/redirects/pages by `location.folderId`, CMS entries by `wbyAco_location` (folder tree on Admin GQL, entry membership on Manage). A failed/unmapped folder blocks the import unless `--allow-folder-mismatch` (then it falls back to root).
- **Models are create-only.** Missing → created from the live source def; existing → validated, never auto-altered (override a mismatch with `--allow-schema-mismatch`).
- **Files = metadata only.** Binaries aren't copied — share the generated `s3-copy-manifest.txt` with your AWS admin.
- **`cms-schema.json` is optional.** Pass `--schema-file` only to use an offline model schema instead of reading it live.
- **Purge** is heavily guarded: dry-run by default → `--confirm` warns → `--force` deletes; soft-delete to bin/Trash unless `--permanent`; refuses target==source unless `--allow-same-tenant`. See the [Purge section](#purge-rollback--destructive-heavily-guarded).

Full step-by-step walkthrough: **[CUSTOMER-GUIDE.md](CUSTOMER-GUIDE.md)**.

---

## Kibo 6.x specifics

Namespace is `websiteBuilder`; CMS entry fields live under `values{}`; model management + entry ops are on the **Manage API** (not Admin GQL); input/operation type names are discovered by **runtime introspection**, never hardcoded. `"Tried to get value from a failed Result"` on publish is an async-job false error (the item is published).

---

## For contributors

```
index.ts        root CLI orchestrator (export-all/import-all/catalog-all/plan/migrate/runs/metrics/serve)
server.ts       Express web UI — Export / Import / Migrate / Purge / Logs (single embedded page)
shared/src/     graphql (adaptive throttle), config (one .env), provider (createClient),
                catalog, plan, runstore (.runs ledger), observability, folders (ACO engine)
packages/*      per-artifact engines: cms-entries, file-manager, page-builder, redirects
                each: index.ts (CLI) + src/{config,export,import/clone,catalog,…}
tests/          vitest — pure-logic unit tests (no live API)
```

```bash
npm install          # workspaces
npm run build        # compile all packages (root index.ts/server.ts run via ts-node)
npx vitest run       # ~55 tests
```

**How the pieces fit:** the root orchestrator spawns each package CLI in dependency order (model → file → cms-entry → page → redirect). Each package exports source→disk and imports disk→target; the orchestrator wires selection, the run ledger, and per-step timing around them. The web UI shells out to the same CLI.

**Key invariants — read before changing migration logic:**
- **Live model fetch is the default.** `--schema-file` is an optional offline override; don't re-introduce env defaults for it (that footgun was removed).
- **Introspect at runtime; never hardcode** GraphQL type/op names — they vary by Kibo version.
- **Folders go through the shared engine.** Add a foldered artifact by writing a `FolderAdapter` (`listTargetFolders`/`createFolder`) and calling `syncFolders` + `validateFolderMapping`; `"root"` means no folder.
- **CMS entries:** content under `values{}`, refs shaped `{ modelId, id }` on input, folder tree on Admin `aco` (type = modelId) but membership in `wbyAco_location` on Manage.
- **Preserved ids:** `entryId` and file id are preserved cross-env; pages/redirects matched by path/slug/redirectFrom.
- **UI export/import use absolute `--out`/`--in`** (per-package cwd would otherwise scatter output).

**Never commit:** `.env` (keys), `.runs/`, `export/`, `.migrate-tmp/`, `.catalog-tmp/` — all gitignored.
