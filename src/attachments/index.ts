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
import { TargetError, type Target } from "../target/client.js";
import { AttachableEntity } from "../target/contracts.js";
import { sniff, MAX_ATTACHMENT_BYTES } from "../target/files.js";
import { basename } from "node:path";

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
 * Then, with a target, each file is attached to the record `load` made of
 * its source record, through `POST /v1/attachments` (base64, with an
 * Idempotency-Key per file, so a re-run attaches nothing twice and the target
 * keeps the same bytes on the same record once anyway). What the target will
 * not store is said before anything is sent: a file on equipment, which has
 * no route, one over twenty megabytes, or one whose first bytes are not an
 * image or a PDF (`attachments.unattachable` in docs/target-api-gaps.md).
 * Downloading first is still the right move: the signed URLs and the source
 * account may both be gone by the time the load is reconciled.
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


export interface UploadReport {
  uploaded: number;
  already: number;
  /** The record it belongs to is not in the target (not loaded, or blocked). */
  notLoaded: { sourceId: string; reason: string }[];
  /** What the target will not store, said before sending. */
  unattachable: { sourceId: string; reason: string }[];
  /** Refused by the target. */
  failed: { sourceId: string; reason: string }[];
  /** Set when the run stopped early. Re-running resumes. */
  aborted?: string;
}

/** The file's own name: the downloaded copy carries the source id in front of it. */
function fileNameOf(entry: AttachmentIndexEntry): string {
  const name = basename(entry.path);
  const prefix = `${safeSegment(entry.sourceId)}-`;
  return (name.startsWith(prefix) ? name.slice(prefix.length) : name).slice(0, 255) || "file";
}

/** The target record an attachment belongs to, through the ledger `load` wrote. */
function targetOf(entry: AttachmentIndexEntry, ledger: Ledger, visits: () => Map<string, string>): string | undefined {
  if (entry.entityType === "visit") return visits().get(entry.entitySourceId);
  return ledger.get(Ledger.key(entry.entityType, entry.entitySourceId));
}

/**
 * Attach every downloaded file to its record in the target. Reads the index
 * `fetchAttachments` wrote, so it never touches the source again.
 */
export async function uploadAttachments(dir: string, target: Target, ledger: Ledger, options: { onProgress?: (done: number) => void } = {}): Promise<UploadReport> {
  const report: UploadReport = { uploaded: 0, already: 0, notLoaded: [], unattachable: [], failed: [] };
  const index = await readIndex(dir);
  let visitIndex: Map<string, string> | undefined;
  // A visit's ledger key carries its job; built once, on the first visit asked for.
  const visits = () => {
    visitIndex ??= new Map([...ledger.all()]
      .map((e) => [/#visit:(.+)$/.exec(e.key)?.[1], e.target] as const)
      .filter((pair): pair is readonly [string, string] => pair[0] !== undefined)
      .map(([k, v]) => [k, v]));
    return visitIndex;
  };

  let done = 0;
  for (const entry of index.values()) {
    done += 1;
    options.onProgress?.(done);
    const key = Ledger.key("attachment", entry.sourceId);
    if (ledger.has(key)) { report.already += 1; continue; }
    const entityType = AttachableEntity.safeParse(entry.entityType);
    if (!entityType.success) {
      report.unattachable.push({ sourceId: entry.sourceId, reason: `the target attaches nothing to ${entry.entityType}` });
      continue;
    }
    const entityId = targetOf(entry, ledger, visits);
    if (!entityId) {
      report.notLoaded.push({ sourceId: entry.sourceId, reason: `${entry.entityType} ${entry.entitySourceId} is not in the target` });
      continue;
    }
    if (entry.bytes > MAX_ATTACHMENT_BYTES) {
      report.unattachable.push({ sourceId: entry.sourceId, reason: `${(entry.bytes / 1_048_576).toFixed(1)} MB, over the target's 20 MB` });
      continue;
    }
    const bytes = await readFile(entry.path);
    const type = sniff(bytes);
    if (!type) {
      report.unattachable.push({ sourceId: entry.sourceId, reason: `${fileNameOf(entry)} is not an image or a PDF by its first bytes` });
      continue;
    }
    try {
      const made = await target.call("uploadAttachment", {
        entityType: entityType.data, entityId,
        fileName: fileNameOf(entry),
        contentType: type,
        bytes: bytes.toString("base64"),
      }, { idempotencyKey: ledger.idempotencyKey(key) });
      await ledger.record({ key, target: made.id });
      if (made.alreadyHeld) report.already += 1;
      else report.uploaded += 1;
    } catch (error) {
      if (error instanceof TargetError && !error.retryable && error.status !== 401 && error.status !== 403) {
        report.failed.push({ sourceId: entry.sourceId, reason: error.message });
        continue;
      }
      report.aborted = (error as Error).message;
      break;
    }
  }
  return report;
}
