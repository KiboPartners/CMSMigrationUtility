# Kibo CMS Migration — Customer Guide

A practical runbook for copying CMS content (entries, pages, redirects, file
metadata) from one Kibo CMS environment to another. No server access needed —
everything runs locally against the Kibo GraphQL APIs.

> **You do not need to be an engineer to follow this.** You will copy one
> configuration file, run a few commands (or click through the web UI), and
> review a report.

---

## 1. What this tool does

| It does | It does not |
|---|---|
| Copies CMS **entries**, **pages**, **redirects**, and **file metadata** between environments | Copy the actual binary files in S3 (your AWS admin does that — see §7) |
| **Creates missing content models** on the target automatically | Change or delete anything on the **source** |
| Lets you **browse and pick** exactly what to migrate | Migrate without you confirming first (dry-run is available) |
| Records every migration as a **resumable, auditable run** | Require server/SSH access |

Source is only ever **read**. Writes happen only to the **target**, and only when
you run a real (non-dry) migration.

> **⚠ Files are not copied — only their metadata.** The tool migrates each file's
> registration + CDN reference and writes an **`s3-copy-manifest.txt`**; it does
> **not** move the binary objects. Hand that manifest to your AWS admin to copy the
> bytes between S3 buckets. See §7.

---

## 2. One-time setup

1. Install [Node.js](https://nodejs.org) 20+ and **git**.
2. Get the code and build it once:
   ```
   git clone <repo-url> kibo-cms-clone-tool
   cd kibo-cms-clone-tool
   npm install
   npm run build
   ```
3. Copy `.env.example` to `.env` and fill in your two environments:
   ```
   SOURCE_ADMIN_GQL_URL=...     SOURCE_MANAGE_URL=...
   SOURCE_API_KEY=...           SOURCE_TENANT=...
   TARGET_ADMIN_GQL_URL=...     TARGET_MANAGE_URL=...
   TARGET_API_KEY=...           TARGET_TENANT=...
   ```
   **Where to find each value** (in the Kibo admin, per environment):
   - **`*_ADMIN_GQL_URL`** — your Kibo CMS GraphQL endpoint, e.g. `https://cms-api.<region>.gcp.kibocommerce.com/graphql`.
   - **`*_MANAGE_URL`** — the same host + `/cms/manage/<locale>`, e.g. `…/cms/manage/en-US`.
   - **`*_API_KEY`** — an application/API key authorized for **both** Admin GQL and Headless CMS (Manage) — see the Permissions prerequisite below.
   - **`*_TENANT`** — the `/{tenantId}/` segment in your admin URL.
   - **`*_CDN_DOMAIN`** — the CDN host serving your file assets.
   - `.env.example` shows the URL shapes to copy. Keep `.env` private — it holds API keys and is never committed.

### Permissions prerequisite (read this first)

Each API key (`SOURCE_API_KEY` / `TARGET_API_KEY`) must be authorized for **both**
APIs on **that tenant**, or only part of the content migrates:

| API | Covers | If the key lacks it |
|---|---|---|
| **Admin GraphQL** (`*_ADMIN_GQL_URL`) | pages, redirects, files, folders | those artifacts can't be read/written |
| **Manage API** (`*_MANAGE_URL`) | content models + CMS entries | models/entries show **"Not authorized"** and are skipped (pages still pull) |

If you see *"pages migrated but models/entries didn't"*, the key is missing the
**Headless CMS (Manage)** scope for that tenant — grant it in the Kibo admin and
re-run. The catalog flags each type's access, so a missing scope is visible rather
than silent.

That's the whole setup. **You do not need to export a schema file** — the tool
reads content-model definitions straight from the source environment and recreates
them on the target automatically.

_(Optional)_ If you ever want to pin an offline schema instead of reading it live,
export it from Kibo admin (**Content Models → ⋮ → Export**), save as
`cms-schema.json`, and pass `--schema-file ./cms-schema.json` to the commands below.

---

## 3. The simplest path — the web UI

```
npx ts-node index.ts serve
```

Open **http://localhost:4317** — the **KIBO CMS Import Export Utility**. A
collapsible left nav (light/dark toggle top-right) with five workspaces:

- **Export** — pick the **source tenant** and the artifact types to pull (Files,
  CMS Entries, Pages, Redirects; optional CMS model filter). The tool writes the
  data to a timestamped folder on this machine under `export/exp-<tenant>-<time>/`.
  The source is only read.
- **Import** — pick a folder you exported earlier, then choose artifact **types**
  and/or **individual items** (selecting nothing imports the whole folder), and
  click **Start import**. Toggles: **dry-run** (preview first) and **allow folder
  mismatch** (import even if a folder couldn't be recreated — those items go to the
  root folder). A progress bar shows **succeeded / failed / total**.
- **Migrate** — direct tenant→tenant with no local files: enter source + target,
  **Load source artifacts**, tick what to migrate (dependencies pulled in
  automatically; entry/page rows show name, folder path, author, created/modified,
  status, and Live + version), then **Start migration**. Toggles: **dry-run**,
  **skip-export** (default OFF), **allow schema mismatch**, **allow folder
  mismatch**. Per-item ✓/✗ progress.
- **Purge** — clean up the **target** tenant: **Load target artifacts**, select
  the items to remove, **Preview** (dry-run) what would be deleted, then **Delete**
  — guarded by a modal that makes you type the target tenant id to confirm.
  Toggles: **permanent** (off = soft-delete to the recycle bin / Trash, recoverable)
  and **allow same tenant**.
- **Logs** — every export/import/migration is recorded. Search by id/status/tenant,
  filter by date, view aggregate metrics (totals + top errors), and open any run's
  item-by-item detail.

Folder structure is preserved automatically: the source folder tree is recreated
on the target and each item is placed in its matching folder. After a run that
includes files, the result shows the **`s3-copy-manifest.txt` path** to hand to
your AWS admin (see §7).

> For **resuming** an interrupted run or very large jobs, use the CLI (§4). Every
> workspace above maps to a CLI command: Export→`export-all`, Import→`import-all`,
> Migrate→`catalog-all`/`plan`/`migrate`, Purge→`purge`, Logs→`runs`/`metrics`.

---

## 4. The command-line path

```
# 1. Catalog the source (what's available — models, entries, pages, redirects, files)
npx ts-node index.ts catalog-all --env source --out catalog.json

# 2. Preview a plan for the items you picked (ids from the catalog)
npx ts-node index.ts plan --catalog catalog.json --select "id1,id2,id3"

# 3. Dry-run the migration (no writes)
npx ts-node index.ts migrate --catalog catalog.json --select "id1,id2" --dry-run

# 4. Run it for real
npx ts-node index.ts migrate --catalog catalog.json --select "id1,id2"
```

Tip: put many ids in a text file (one per line) and pass `--select @ids.txt`.

**Choosing tenants from the CLI** — the source/target tenants come from `.env`
(`SOURCE_TENANT` / `TARGET_TENANT`). To migrate a different tenant pair for one
command, set them inline:

```bash
SOURCE_TENANT=<source-tenant> TARGET_TENANT=<target-tenant> npx ts-node index.ts migrate \
  --catalog catalog.json --select @ids.txt
```

---

## 5. Models, provisioning, and validation

Content models are handled automatically — no manual export:

- **Missing on target** → `migrate` reads the model definition **live from the
  source** and creates it on the target before importing entries. You'll see
  `🧩 Provisioning … ✓ created` in the output.
- **Already on target** → before importing, the tool **validates** that the
  target model's fields are compatible with the source. If a field is missing or
  its type changed, the import **stops** with a field-by-field report (re-run with
  `--allow-schema-mismatch` to override). Existing models are never altered
  automatically.

To browse or provision models on their own:

```
cd packages/cms-entries
npx ts-node index.ts models --env source                      # list source models
npx ts-node index.ts models --provision PromoBanner,Article   # create them on target
```

---

## 6. Runs, resume, and reports

- **List runs:** `npx ts-node index.ts runs`
- **Show one run (audit):** `npx ts-node index.ts runs --show <run-id>`
- **Resume an interrupted run** (re-does only what didn't finish; already-done
  items are skipped): `npx ts-node index.ts migrate --resume <run-id>`
- **Overall metrics + top errors:** `npx ts-node index.ts metrics`

Every run is saved under `.runs/` as JSON plus a `.events.jsonl` event stream you
can hand to your monitoring tools.

---

## 7. Files (important)

This tool migrates **file metadata** (the file's registration and CDN reference),
not the binary bytes. After a migration that includes files, copy the actual
binaries between S3 buckets separately — share the generated
`s3-copy-manifest.txt` with your AWS administrator.

---

## 8. Troubleshooting

| Symptom | What it means / fix |
|---|---|
| `0 entries exported` | Wrong `SOURCE_TENANT`. Check the tenant id in your admin URL. |
| `Unknown type "<Model>Input"` on import | The model isn't on the target. Run `migrate` (it provisions automatically from the live source schema) or `import --create-missing-model`. |
| `Target schema incompatible with source` | An existing target model is missing a field, or a field's type changed vs the source. Fix the target model, or re-run with `--allow-schema-mismatch` to import anyway (mismatched fields may fail). |
| `Tried to get value from a failed Result` on publish | Not a failure — Kibo publishes in the background. The item is published. |
| `Folder validation failed … reference folders that did not sync` | A folder couldn't be recreated on the target (permissions/API). Fix the target, or re-run with `--allow-folder-mismatch` — those items import into the root folder instead. |
| Migration slows down mid-run | Normal — the tool automatically backs off when the server signals rate limits, then speeds back up. |
| A field shows `corrupt stored data … excluding it` | One source record has a malformed value (often rich-text). That field is skipped so the rest still migrate; fix the source record if you need it. |
| Run stopped partway | Re-run with `migrate --resume <run-id>`. |

---

## 9. Safety summary

- Source is read-only.
- Dry-run previews everything without writing.
- Every real run is recorded and resumable.
- Re-running is idempotent: **identical entries and pages are skipped** (matched by
  a content fingerprint), so only changed or new items are written.
- `entryId` and file ids are preserved so cross-references stay valid; pages and
  redirects are matched by path/slug.

---

## 10. Purge (rollback) — delete content on the target

Purge removes content **from the target** (for rollback or cleanup). It is heavily
guarded — you opt in at each step.

**Web UI (Purge workspace):** Load the target → select the items → **Preview**
(dry-run, deletes nothing) → **Delete**. A modal makes you **type the target tenant
id** to confirm. Toggles: **permanent** (off = soft-delete, recoverable) and
**allow same tenant**.

**CLI** (per package, from its folder — e.g. `cd packages/cms-entries`):

```bash
npx ts-node index.ts purge --in ./export/cms                 # DRY RUN — preview only (default)
npx ts-node index.ts purge --in ./export/cms --confirm       # shows the warning, then STOPS
npx ts-node index.ts purge --in ./export/cms --force         # actually deletes (soft → recycle bin)
npx ts-node index.ts purge --all --models PromoBanner --force # every entry of a model (needs --models)
```

Safety rules (CLI + UI):
- **Soft delete by default** — entries/pages go to the recycle bin / Trash and are
  recoverable in the admin. Add **`--permanent`** to hard-delete (unrecoverable).
- A real purge **refuses when the target tenant equals the source** unless you pass
  **`--allow-same-tenant`** (a real purge once wiped a source tenant).
- **Deleting a content model removes all its entries** and is always unrecoverable.
- Scope a purge with **`--select <ids|@file>`**; without it, purge targets everything
  matched (or use `--in <export-dir>` to delete only what was cloned).
- Files: purge removes only the **metadata** registration — S3 binaries are untouched.
