# File Manager Migrator

Clones Kibo CMS File Manager **metadata** between environments in two steps: **export** (source → local JSON) then **import** (local JSON → target + S3 manifest).

File binaries are not copied by this script. The import step generates an `s3-copy-manifest.txt` with ready-to-run `aws s3 cp` commands — share this with whoever has S3 access.

## Setup

```bash
cd packages/file-manager
cp .env.example .env
npm install
```

## Workflow

### Step 1 — Export from source

Enumerates all file records from the source File Manager and writes them to `files.json`.

```bash
# Export all files
npx ts-node index.ts export --out ./export/files

# Export only tagged files
npx ts-node index.ts export --tags hero-images,banners
```

Output:
```
export/files/
  files.json    ← { sourceCdnDomain, files: [...] }
```

### Step 2 — Review and edit (optional)

Open `files.json` and remove any file entries you don't want to register in target. The S3 manifest will only include files present in the JSON at import time.

### Step 3 — Import metadata + generate S3 manifest

```bash
# Dry run first
npx ts-node index.ts import --dir ./export/files --dry-run

# Real import
npx ts-node index.ts import --dir ./export/files
```

The import step:
- Registers each file's metadata in target (`createFile` with `src` pointing to `TARGET_CDN_DOMAIN`)
- Writes `s3-copy-manifest.txt` in the current directory

### Step 4 — S3 binary copy (manual)

Share `s3-copy-manifest.txt` with your AWS admin:

```bash
# Option A — sync entire prefix (recommended)
aws s3 sync s3://source-bucket/files/ s3://target-bucket/files/

# Option B — copy individual files (listed in manifest)
aws s3 cp "s3://source-bucket/files/abc/photo.jpg" "s3://target-bucket/files/abc/photo.jpg"
...
```

Files resolve correctly via the target CDN once the binaries are in place, because the S3 key (path) is identical in both environments.

## Environment Variables

| Variable | Step | Description |
|---|---|---|
| `SOURCE_ADMIN_GQL_URL` | export | Source admin GraphQL endpoint |
| `SOURCE_API_KEY` | export | Source API key |
| `SOURCE_CDN_DOMAIN` | export + import | Source CloudFront domain |
| `SOURCE_S3_BUCKET` | import | Source S3 bucket (manifest output only) |
| `SOURCE_S3_PREFIX` | import | S3 prefix, default `files/` (manifest only) |
| `TARGET_ADMIN_GQL_URL` | import | Target admin GraphQL endpoint |
| `TARGET_API_KEY` | import | Target API key |
| `TARGET_CDN_DOMAIN` | import | Target CloudFront domain |
| `TARGET_S3_BUCKET` | import | Target S3 bucket (manifest output only) |
| `TAGS_FILTER` | export | Only export files with these tags (comma-sep) |
| `CONCURRENCY` | import | Parallel GraphQL writes (default: `10`) |
| `DRY_RUN` | import | Preview without writing (default: `false`) |
| `SKIP_EXISTING` | import | Skip already-registered files (default: `true`) |

## Why the split approach works

Kibo CMS file IDs are unique per environment, but the **S3 key** is stable. By registering metadata with the same `key` and a `src` pointing to the target CDN domain, then physically copying files to the same S3 key path, everything resolves correctly — no URL rewriting needed in the file records themselves.

URL rewriting in CMS entries and pages (which embed full CDN URLs) is handled by the `cms-entries` and `page-builder` migrators via their `SOURCE_CDN_DOMAIN`/`TARGET_CDN_DOMAIN` config.

## Folder Structure Limitation

Kibo CMS File Manager folder organisation (stored in DynamoDB, not S3) is not cloned. All files will appear in the root of the target File Manager UI. File URLs and binaries are unaffected.

## Idempotency

Re-running is safe. Files already registered in target (matched by `key`) are skipped when `SKIP_EXISTING=true`.
