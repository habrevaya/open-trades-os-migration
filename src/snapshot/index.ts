import { mkdir, readFile, writeFile, readdir, appendFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { EntityName } from "../canonical/index.js";
import type { ExtractContext } from "../adapters/types.js";

/**
 * THE SNAPSHOT
 *
 * A directory of newline-delimited JSON, one file per entity, plus a manifest.
 * Deliberately the dumbest possible format, for three reasons.
 *
 * Append-only NDJSON means a run killed halfway leaves a readable file rather
 * than a truncated JSON array. Every later stage streams it, so a shop with
 * 400,000 invoices does not need 400,000 invoices in memory. And the operator
 * can open it in any text editor and see their own data, which matters more
 * than it sounds: the first question anyone asks during a migration is "is my
 * stuff actually in there", and the answer should not require our software.
 *
 * The snapshot is the audit trail. Nothing deletes from it, ever.
 */

export interface Manifest {
  version: 1;
  source: string;
  account?: string;
  startedAt: string;
  updatedAt: string;
  /** Per-entity counts as extracted. The denominator for every later check. */
  counts: Partial<Record<EntityName, number>>;
  /** Opaque per-entity cursors, so a killed run resumes where it stopped. */
  checkpoints: Partial<Record<EntityName, string>>;
  completed: EntityName[];
  warnings: string[];
}

const MANIFEST = "manifest.json";
const fileFor = (entity: EntityName) => `${entity}.ndjson`;

export class Snapshot implements ExtractContext {
  private manifest: Manifest;
  private dirty = false;

  private constructor(public readonly snapshotDir: string, manifest: Manifest) {
    this.manifest = manifest;
  }

  static async open(dir: string, source: string): Promise<Snapshot> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, MANIFEST);
    let manifest: Manifest;
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as Manifest;
      if (existing.source !== source) {
        // Mixing two sources in one directory produces a snapshot where source
        // ids collide and the load silently merges unrelated customers.
        throw new Error(
          `Snapshot at ${dir} holds a ${existing.source} extraction. ` +
            `Use a different directory for ${source}.`,
        );
      }
      manifest = existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const now = new Date().toISOString();
      manifest = {
        version: 1, source, startedAt: now, updatedAt: now,
        counts: {}, checkpoints: {}, completed: [], warnings: [],
      };
    }
    const snapshot = new Snapshot(dir, manifest);
    await snapshot.flush();
    return snapshot;
  }

  /** Read-only open, for stages that must never mutate the snapshot. */
  static async read(dir: string): Promise<Snapshot> {
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as Manifest;
    return new Snapshot(dir, manifest);
  }

  get source(): string { return this.manifest.source; }
  get info(): Readonly<Manifest> { return this.manifest; }

  async append(entity: EntityName, records: readonly unknown[]): Promise<void> {
    if (records.length === 0) return;
    const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await appendFile(join(this.snapshotDir, fileFor(entity)), body, "utf8");
    this.manifest.counts[entity] = (this.manifest.counts[entity] ?? 0) + records.length;
    this.dirty = true;
  }

  async checkpoint(entity: EntityName, cursor: string): Promise<void> {
    this.manifest.checkpoints[entity] = cursor;
    await this.flush();
  }

  async resume(entity: EntityName): Promise<string | undefined> {
    return this.manifest.checkpoints[entity];
  }

  async complete(entity: EntityName): Promise<void> {
    if (!this.manifest.completed.includes(entity)) this.manifest.completed.push(entity);
    this.dirty = true;
    await this.flush();
  }

  isComplete(entity: EntityName): boolean {
    return this.manifest.completed.includes(entity);
  }

  warn(message: string): void {
    if (!this.manifest.warnings.includes(message)) {
      this.manifest.warnings.push(message);
      this.dirty = true;
    }
  }

  setAccount(account: string): void {
    this.manifest.account = account;
    this.dirty = true;
  }

  log(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  /** Stream an entity file. Never loads the whole thing. */
  async *records<T = unknown>(entity: EntityName): AsyncGenerator<T> {
    const path = join(this.snapshotDir, fileFor(entity));
    try {
      await stat(path);
    } catch {
      return;
    }
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // A partial final line is the expected shape of a killed run, and it
        // should not stop every later stage from reading the 399,999 good
        // records ahead of it.
        this.warn(`${entity}.ndjson line ${lineNumber} is not valid JSON and was skipped`);
      }
    }
  }

  async entities(): Promise<EntityName[]> {
    const files = await readdir(this.snapshotDir).catch(() => [] as string[]);
    return files
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => f.slice(0, -".ndjson".length) as EntityName);
  }

  async flush(): Promise<void> {
    this.manifest.updatedAt = new Date().toISOString();
    await writeFile(join(this.snapshotDir, MANIFEST), JSON.stringify(this.manifest, null, 2) + "\n", "utf8");
    this.dirty = false;
  }

  get hasUnflushedWrites(): boolean { return this.dirty; }
}
