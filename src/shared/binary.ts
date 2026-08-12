/**
 * Binary transfer engine for File Manager content.
 * Pure helpers first (size gate, formatting); transfer functions added in later tasks.
 */

import fs from "fs";
import path from "path";

export function parseMaxBytes(mb: number | string | undefined): number {
  const n = typeof mb === "string" ? parseFloat(mb) : mb ?? 0;
  if (!n || Number.isNaN(n) || n <= 0) return 0; // 0 = no limit
  return Math.floor(n * 1024 * 1024);
}

export function isWithinSizeLimit(sizeBytes: number, maxBytes: number): boolean {
  if (maxBytes === 0) return true;
  return sizeBytes <= maxBytes;
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const rounded = Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  key: string;
  /** The target file id minted by the server (the S3 key is `<fileId>/<name>`). */
  fileId?: string;
}

export const PRESIGN_FALLBACK = {
  opName: "getPreSignedPostPayload",
  inputType: "PreSignedPostPayloadInput",
} as const;

export function buildPresignQuery(opName: string, inputType: string): string {
  // The S3 POST target (url + form fields) is nested inside the `data` JSON
  // scalar — `GetPreSignedPostPayloadResponseData` has NO sibling `url` field.
  return /* GraphQL */ `
    query GetPresign($data: ${inputType}!) {
      fileManager {
        ${opName}(data: $data) {
          data {
            data
            file { id key name type size }
          }
          error { message }
        }
      }
    }
  `;
}

export function parsePresignResponse(raw: unknown): PresignedPost {
  const fm = (raw as { fileManager?: Record<string, unknown> })?.fileManager ?? {};
  // The op name is whatever was discovered — take the single payload object present.
  const payload = Object.values(fm)[0] as
    | { data: { data: unknown; file?: { id?: string; key?: string } } | null; error: { message: string } | null }
    | undefined;

  if (!payload) throw new Error("Presign response missing fileManager payload");
  if (payload.error) throw new Error(payload.error.message);
  if (!payload.data) throw new Error("Presign returned no data");

  // Webiny nests the AWS presigned-POST object — `{ url, fields }` — inside the
  // `data` JSON scalar. Some versions deliver it as a JSON string; handle both.
  let inner = payload.data.data as unknown;
  if (typeof inner === "string") inner = JSON.parse(inner);
  const obj = (inner ?? {}) as Record<string, unknown>;

  const url = (obj["url"] as string) ?? "";
  const fields: Record<string, string> =
    obj["fields"] && typeof obj["fields"] === "object"
      ? (obj["fields"] as Record<string, string>)
      : (Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "url")) as Record<string, string>);

  if (!url) throw new Error("Presign response missing upload url (data.data.url)");
  const key = payload.data.file?.key ?? fields["key"];
  if (!key) throw new Error("Presign response missing S3 key");

  return { url, fields, key, fileId: payload.data.file?.id };
}

export type FetchFn = typeof fetch;

export function buildUploadForm(
  presign: PresignedPost,
  body: Blob | Buffer,
  filename: string,
  contentType: string
): FormData {
  const form = new FormData();
  // All presign fields FIRST, file LAST — S3 POST policy requires this order.
  for (const [k, v] of Object.entries(presign.fields)) {
    if (k === "file") continue;
    form.append(k, v);
  }
  const blob = body instanceof Blob ? body : new Blob([body], { type: contentType });
  form.append("file", blob, filename);
  return form;
}

export async function uploadToS3(
  presign: PresignedPost,
  body: Blob | Buffer,
  filename: string,
  contentType: string,
  fetchFn: FetchFn = fetch
): Promise<void> {
  const form = buildUploadForm(presign, body, filename, contentType);
  const res = await fetchFn(presign.url, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 upload failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

export interface BinaryClient {
  request<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface FileMeta {
  id: string;
  key: string;
  name: string;
  type: string;
  size: number;
}

export async function presignFor(
  client: BinaryClient,
  meta: FileMeta,
  opName: string = PRESIGN_FALLBACK.opName,
  inputType: string = PRESIGN_FALLBACK.inputType
): Promise<PresignedPost> {
  const query = buildPresignQuery(opName, inputType);
  // Send only name/type/size. Do NOT pass a `key`: Webiny does not honor an
  // arbitrary key — it mints its own file id and treats the key string as the
  // filename (stripping `/`), which yields a corrupted `<newId>/<oldId><name>`
  // key. We let the server own id+key generation and remap URLs via the store.
  const raw = await client.request(query, {
    data: { name: meta.name, type: meta.type, size: meta.size },
  });
  return parsePresignResponse(raw);
}

/**
 * Thrown when the source asset returns 404 — the source has metadata but no
 * binary (orphan record). Callers should SKIP the file, not fail the run.
 */
export class SourceAssetMissingError extends Error {
  constructor(public readonly url: string) {
    super(`source binary not found (HTTP 404) for ${url}`);
    this.name = "SourceAssetMissingError";
  }
}

async function fetchSourceBytes(sourceUrl: string, fetchFn: FetchFn): Promise<Buffer> {
  const res = await fetchFn(sourceUrl);
  if (res.status === 404) throw new SourceAssetMissingError(sourceUrl);
  if (!res.ok) throw new Error(`source fetch failed (HTTP ${res.status}) for ${sourceUrl}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function transferBinary(args: {
  meta: FileMeta;
  sourceUrl: string;
  targetClient: BinaryClient;
  opName?: string;
  inputType?: string;
  fetchFn?: FetchFn;
}): Promise<{ key: string; fileId?: string }> {
  const fetchFn = args.fetchFn ?? fetch;
  const bytes = await fetchSourceBytes(args.sourceUrl, fetchFn);
  const presign = await presignFor(args.targetClient, args.meta, args.opName, args.inputType);
  await uploadToS3(presign, bytes, args.meta.name, args.meta.type, fetchFn);
  return { key: presign.key, fileId: presign.fileId };
}

export async function uploadLocalBinary(args: {
  meta: FileMeta;
  filePath: string;
  targetClient: BinaryClient;
  opName?: string;
  inputType?: string;
  readFile?: (p: string) => Buffer;
  fetchFn?: FetchFn;
}): Promise<{ key: string; fileId?: string }> {
  const fetchFn = args.fetchFn ?? fetch;
  const read = args.readFile ?? ((p: string) => fs.readFileSync(p));
  const bytes = read(args.filePath);
  const presign = await presignFor(args.targetClient, args.meta, args.opName, args.inputType);
  await uploadToS3(presign, bytes, args.meta.name, args.meta.type, fetchFn);
  return { key: presign.key, fileId: presign.fileId };
}

/**
 * Resolve `key` under `baseDir`, returning the absolute path only if it stays
 * inside baseDir. Returns null when the key escapes (path traversal) — callers
 * must skip such keys. `key` may be a source-controlled S3 key.
 */
export function safeKeyPath(baseDir: string, key: string): string | null {
  const root = path.resolve(baseDir);
  const dest = path.resolve(root, key);
  if (dest !== root && !dest.startsWith(root + path.sep)) return null;
  return dest;
}
