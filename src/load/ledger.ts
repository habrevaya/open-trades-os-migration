import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/**
 * THE LOAD LEDGER
 *
 * Source id to target id, one line per thing the target confirmed it holds,
 * appended the moment it confirms it. This file is what makes `load`
 * resumable: a run killed at 2am and started again over coffee reads it,
 * skips everything already there, and resolves every reference through it.
 *
 * It sits beside the snapshot, in the same dumb format and for the same
 * reasons: append-only NDJSON survives being killed mid-write, a partial last
 * line is skipped rather than fatal, and the operator can open it and see
 * which customer became which.
 *
 * The ledger is not the only guard against duplicates, and must not be. The
 * window between the target creating a record and this file recording it is
 * small and real: the process can die inside it. Every create therefore
 * carries an Idempotency-Key derived from the source record, so the re-run
 * sends the same request and the target hands back what it already made,
 * and an `externalRef` naming the source record, which the target holds once
 * per company and answers a repeat of with a 409 naming what it became. Even
 * if this whole file is lost, `load --rebuild-ledger` reads it back out of
 * the target by that externalRef.
 *
 * One ledger belongs to one target. Loading the same snapshot into a scratch
 * tenant and then into production must not share ids, because a production
 * load that "resumes" from scratch-tenant ids would skip everything and
 * reference records that do not exist there.
 */

interface Header {
  type: "header";
  version: 1;
  target: string;
  source: string;
  /**
   * Part of every idempotency key, derived from the source system and the
   * source account, never random.
   *
   * Derived so that losing this file is survivable: a re-run with no ledger
   * sends the same keys, and the target hands back what it already made
   * instead of making it again. The account is in it so that two exports
   * whose ids overlap (two spreadsheets that both start at C-1, two
   * companies merging into one tenant) never share a key. Keys are not a
   * secret and do not need to be: the core looks them up inside the tenant's
   * row level security, so another company's key never matches.
   */
  namespace: string;
  createdAt: string;
}

export interface LedgerEntry {
  type: "entry";
  /** `<entity>:<sourceId>`, or a sub-step such as `job:<id>#visit:<visitId>`. */
  key: string;
  /** The target's id, or "done" for a step that produces none. */
  target: string;
  /** Amounts the target reported at write time, for reconcile where it cannot read them back. */
  amount?: string;
  at: string;
}

export class LedgerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerMismatchError";
  }
}

export class Ledger {
  private readonly entries = new Map<string, LedgerEntry>();
  private constructor(
    private readonly path: string | undefined,
    readonly header: Header,
    private readonly onWrite?: (entries: LedgerEntry[]) => void,
  ) {}

  /** A ledger on disk. Created on first use, refused if it belongs to another target or source. */
  static async open(path: string, target: string, source: string, account = ""): Promise<Ledger> {
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const lines = text.split("\n").filter((l) => l.trim() !== "");
    let header: Header | undefined;
    const parsed: LedgerEntry[] = [];
    for (const line of lines) {
      let value: Header | LedgerEntry;
      try { value = JSON.parse(line) as Header | LedgerEntry; } catch { continue; } // a killed run's last line
      if (value.type === "header") header = value;
      else if (value.type === "entry") parsed.push(value);
    }

    if (header) {
      if (header.target !== target) {
        throw new LedgerMismatchError(
          `The ledger at ${path} records a load into ${header.target}, not ${target}. ` +
            `Use --ledger to give this target its own file.`,
        );
      }
      if (header.source !== source) {
        throw new LedgerMismatchError(`The ledger at ${path} is for a ${header.source} snapshot, not ${source}.`);
      }
    } else {
      header = Ledger.newHeader(target, source, account);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(header) + "\n", "utf8");
    }

    const ledger = new Ledger(path, header);
    for (const entry of parsed) ledger.entries.set(entry.key, entry);
    return ledger;
  }

  /** A ledger that lives only as long as the process. What dryrun uses. */
  static memory(target: string, source: string, account = "", onWrite?: (entries: LedgerEntry[]) => void): Ledger {
    return new Ledger(undefined, Ledger.newHeader(target, source, account), onWrite);
  }

  private static newHeader(target: string, source: string, account: string): Header {
    return {
      type: "header", version: 1, target, source,
      namespace: createHash("sha256").update(`${source}|${account}`).digest("hex").slice(0, 16),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * The `source` of every externalRef this load sends: the source system
   * and eight characters of the namespace, `jobber.3fa9c2d1`.
   *
   * Not the bare system name, because the target holds a source id once per
   * company and two exports whose ids overlap (two spreadsheets that both
   * start at C-1, two companies merging into one tenant) would otherwise
   * adopt each other's records. The same snapshot account always gives the
   * same source, so a run with no ledger finds what an earlier one loaded.
   */
  get externalSource(): string {
    const system = this.header.source.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[^a-z0-9]+/, "").slice(0, 40) || "source";
    return `${system}.${this.header.namespace.slice(0, 8)}`;
  }

  static key(entity: string, sourceId: string): string {
    return `${entity}:${sourceId}`;
  }

  get(key: string): string | undefined {
    return this.entries.get(key)?.target;
  }

  entry(key: string): LedgerEntry | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Top-level entries for one entity, for reconcile. */
  *of(entity: string): Generator<LedgerEntry> {
    const prefix = `${entity}:`;
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix) && !key.includes("#")) yield entry;
    }
  }

  /**
   * The Idempotency-Key for a ledger key. Hashed, because source ids are
   * arbitrary strings (Jobber's are base64 with `=` in them) and a header is
   * not the place to discover which characters a proxy rejects.
   */
  idempotencyKey(key: string): string {
    const digest = createHash("sha256").update(`${this.header.namespace}|${key}`).digest("hex").slice(0, 40);
    return `otsm-${this.header.namespace}-${digest}`;
  }

  /**
   * Record what the target confirmed. Several entries go in one append, so a
   * job and its first visit, created by one request, land together.
   */
  async record(...entries: { key: string; target: string; amount?: string }[]): Promise<void> {
    if (entries.length === 0) return;
    const at = new Date().toISOString();
    const lines = entries.map((e): LedgerEntry => ({ type: "entry", key: e.key, target: e.target, ...(e.amount === undefined ? {} : { amount: e.amount }), at }));
    for (const line of lines) this.entries.set(line.key, line);
    if (this.path) await appendFile(this.path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    this.onWrite?.(lines);
  }

  get size(): number { return this.entries.size; }
}

/** Where a snapshot's ledger lives by default: beside it, one file per target host. */
export function defaultLedgerPath(snapshotDir: string, target: string): string {
  const host = new URL(target).host.replace(/[^A-Za-z0-9.-]/g, "_");
  return `${snapshotDir.replace(/\/+$/, "")}/load/${host}.ledger.ndjson`;
}
