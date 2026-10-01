import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { request } from "undici";
import type { CanonicalAttachment } from "../canonical/index.js";
import type { SourceAdapter } from "../adapters/types.js";
import type { Snapshot } from "../snapshot/index.js";
import { canonicalRecords } from "../transform/index.js";
import { backoffDelay, defaultRetry, retryAfterMs, type RetryPolicy } from "../adapters/http.js";
import { Ledger } from "../load/ledger.js";

/**
 * ATTACHMENTS
 *
 * The second pass, and the slow one. Tens of thousands of photographs behind
 * signed URLs that expire, fetched politely from a server other people's
 * businesses are using at the same time.
 *
 * Every file is downloaded into the working directory beside the snapshot,
 * with an index line recording where it came from, what it is attached to,
 * its size and its SHA-256, and (when `load` has run) the id of the target
 * record it belongs to. That index is the resume point: a file already in it
 * is not fetched again.
 *
 * It stops there, and says why. OpenTradesOS has no endpoint a third party
 * can use to upload a file and attach it to a record. The only upload path
 * is the field device queue, which accepts bytes a registered phone has
 * already announced; driving it from a migration would mean impersonating a
 * phone. So the files land locally, indexed against their target records,
 * ready to attach the day the API takes them (`attachments.upload` in
 * docs/target-api-gaps.md). Downloading now is still the right move: the
 * signed URLs and the source account may both be gone by then.
 */

export interface AttachmentIndexEntry {
  sourceId: string;
  entityType: string;
  entitySourceId: string;
  /** The target record it belongs to, when `load` has put that record there. */
  targetEntityId: string | null;
  path: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
  at: string;
}

export interface AttachmentReport {
  downloaded: number;
  already: number;
  failed: { sourceId: string; reason: string }[];
  /** Records the source exported that had nothing to fetch. */
  empty: number;
  bytes: number;
  dir: string;
}

const INDEX = "index.ndjson";

/** A path segment that cannot climb out of its directory or collide with another. */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return cleaned === "" ? "_" : cleaned;
}

async function readIndex(dir: string): Promise<Map<string, AttachmentIndexEntry>> {
  const out = new Map<string, AttachmentIndexEntry>();
  let text = "";
  try { text = await readFile(join(dir, INDEX), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as AttachmentIndexEntry;
      out.set(entry.sourceId, entry);
    } catch { /* a killed run's last line */ }
  }
  return out;
}

/** Bytes through a hash on their way to disk, so the index can prove what was fetched. */
function hashing(): { stream: Transform; digest: () => string; bytes: () => number } {
  const hash = createHash("sha256");
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest("hex"), bytes: () => size };
}

/**
 * Storage links redirect (an app URL to a bucket, a bucket to a CDN), and
 * the client here does not follow on its own, so this does, a few hops deep.
 */
async function follow(url: string, hops = 5): Promise<Awaited<ReturnType<typeof request>>> {
  let current = url;
  for (let i = 0; i <= hops; i += 1) {
    const response = await request(current, { method: "GET" });
    const location = response.headers["location"];
    if (response.statusCode >= 300 && response.statusCode < 400 && typeof location === "string") {
      await response.body.dump();
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`more than ${hops} redirects`);
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Fetch one URL to a file, with the same manners as the API transport:
 * backoff with full jitter, Retry-After honoured. Written to `.part` and
 * renamed, so a killed download never looks like a finished one.
 */
export async function download(url: string, path: string, policy: RetryPolicy = defaultRetry()): Promise<{ bytes: number; sha256: string; contentType: string | null }> {
  const part = `${path}.part`;
  let lastError = "";
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let retryAfter: number | undefined;
    try {
      const response = await follow(url);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        const hashed = hashing();
        await pipeline(response.body, hashed.stream, createWriteStream(part));
        await rename(part, path);
        const type = response.headers["content-type"];
        return { bytes: hashed.bytes(), sha256: hashed.digest(), contentType: typeof type === "string" ? type : null };
      }
      await response.body.dump();
      lastError = `HTTP ${response.statusCode}`;
      // A 403 on a signed URL means it expired. Retrying will not un-expire it.
      if (!RETRYABLE.has(response.statusCode)) break;
      retryAfter = retryAfterMs(response.headers["retry-after"]);
    } catch (error) {
      lastError = (error as Error).message;
    }
    await rm(part, { force: true });
    if (attempt === policy.maxAttempts) break;
    const delayMs = retryAfter ?? backoffDelay(attempt, policy);
    policy.onRetry?.({ attempt, delayMs, reason: lastError });
    await policy.sleep(delayMs);
  }
  await rm(part, { force: true });
  throw new Error(lastError || "download failed");
}

async function copyLocal(from: string, path: string): Promise<{ bytes: number; sha256: string }> {
  const hashed = hashing();
  const part = `${path}.part`;
  await pipeline(createReadStream(from), hashed.stream, createWriteStream(part));
  await rename(part, path);
  return { bytes: hashed.bytes(), sha256: hashed.digest() };
}

export interface AttachmentOptions {
  /** Where files land. Defaults to `<snapshot>/attachments`. */
  outDir?: string;
  /** When given, each file is indexed against the target record `load` made. */
  ledger?: Ledger;
  retry?: RetryPolicy;
  onProgress?: (done: number) => void;
}

export async function fetchAttachments(snapshot: Snapshot, adapter: SourceAdapter, options: AttachmentOptions = {}): Promise<AttachmentReport> {
  const dir = options.outDir ?? join(snapshot.snapshotDir, "attachments");
  await mkdir(dir, { recursive: true });
  const index = await readIndex(dir);
  const report: AttachmentReport = { downloaded: 0, already: 0, failed: [], empty: 0, bytes: 0, dir };

  let done = 0;
  for await (const item of canonicalRecords(snapshot, adapter, "attachment")) {
    done += 1;
    options.onProgress?.(done);
    if (!("record" in item)) {
      report.failed.push({ sourceId: item.failure.sourceId, reason: item.failure.error });
      continue;
    }
    const a = item.record as unknown as CanonicalAttachment;
    if (index.has(a.sourceId)) { report.already += 1; continue; }
    if (!a.downloadUrl && !a.localPath) { report.empty += 1; continue; }

    const folder = join(dir, safeSegment(a.entityType), safeSegment(a.entitySourceId));
    await mkdir(folder, { recursive: true });
    const name = safeSegment(`${a.sourceId}-${a.fileName ?? "file"}`);
    const path = join(folder, name);

    try {
      let fetched: { bytes: number; sha256: string; contentType?: string | null };
      if (a.localPath) {
        await stat(a.localPath);
        fetched = await copyLocal(a.localPath, path);
      } else {
        fetched = await download(a.downloadUrl!, path, options.retry);
      }
      const target = options.ledger?.get(Ledger.key(a.entityType, a.entitySourceId)) ?? null;
      const entry: AttachmentIndexEntry = {
        sourceId: a.sourceId, entityType: a.entityType, entitySourceId: a.entitySourceId,
        targetEntityId: target, path, bytes: fetched.bytes, sha256: fetched.sha256,
        contentType: a.contentType ?? fetched.contentType ?? null, at: new Date().toISOString(),
      };
      await appendFile(join(dir, INDEX), JSON.stringify(entry) + "\n", "utf8");
      index.set(a.sourceId, entry);
      report.downloaded += 1;
      report.bytes += fetched.bytes;
    } catch (error) {
      report.failed.push({ sourceId: a.sourceId, reason: (error as Error).message });
    }
  }
  return report;
}

