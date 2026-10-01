import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse } from "csv-parse";
import type { EntityName } from "../../canonical/index.js";
import type { ExtractContext, SourceAdapter, SourceCapabilities } from "../types.js";
import * as map from "./map.js";
import { DEFAULT_SETTINGS, type CsvSettings, type Row } from "./map.js";

/**
 * GENERIC CSV
 *
 * The universal fallback. Every platform in this industry will give an owner
 * a spreadsheet of their customers, even the ones that give nothing else, and
 * a shop leaving a system with no API at all (FieldEdge, a decade of Excel, a
 * QuickBooks customer list) can still get everything that spreadsheet holds
 * into the same canonical model and through the same loader.
 *
 * The contract is a directory of CSV files with documented column names, one
 * file per entity, every one optional except customers. An export that uses
 * different file names or headers does not need editing: a `columns.json`
 * beside it renames them, and the same export file may be named twice, so a
 * customer list that carries a service address can feed both customers and
 * properties. See docs/generic-csv.md.
 *
 * There is no network here, so `verify` checks the files rather than a
 * credential, and `extract` copies rows into the snapshot rather than paging
 * an API. It still goes through the snapshot, for the same reason the API
 * adapters do: every later stage, and the operator, reads one format.
 */

/** A parent entity, its file, and the child file joined onto it. */
interface FilePlan {
  entity: EntityName;
  file: string;
  child?: { name: string; file: string; foreignKey: string; field: string };
}

const PLAN: FilePlan[] = [
  { entity: "user", file: "users" },
  { entity: "customer", file: "customers" },
  { entity: "property", file: "properties" },
  { entity: "priceBookItem", file: "price_book" },
  {
    entity: "estimate", file: "estimates",
    child: { name: "estimate_lines", file: "estimate_lines", foreignKey: "estimate_id", field: "lines" },
  },
  {
    entity: "job", file: "jobs",
    child: { name: "visits", file: "visits", foreignKey: "job_id", field: "visits" },
  },
  {
    entity: "invoice", file: "invoices",
    child: { name: "invoice_lines", file: "invoice_lines", foreignKey: "invoice_id", field: "lines" },
  },
  {
    entity: "payment", file: "payments",
    child: { name: "payment_allocations", file: "payment_allocations", foreignKey: "payment_id", field: "allocations" },
  },
  { entity: "attachment", file: "attachments" },
];

export const capabilities: SourceCapabilities = {
  entities: PLAN.map((p) => p.entity),
  hasApi: false,
  hasAttachments: true,
  recurrenceModel: "manual-list",
  knownLimits: [
    "Reads files, not an account. What it imports is exactly what the export contained, so an export filtered to active customers produces a migration with no inactive ones.",
    "Child files (invoice lines, visits, payment allocations, estimate lines) are held in memory while their parent file streams. Fine for hundreds of thousands of rows; split a larger export by year.",
    "A spreadsheet has no recurrence. Repeating work arrives as whatever rows were exported, and any schedule has to be rebuilt by a person.",
    "Dates written as 03/04/2024 are read month first unless columns.json says DMY. Anything that is neither ISO nor slashed is refused, not guessed.",
  ],
};

/**
 * columns.json. Every key optional.
 *
 *   files.<name>.file      the export's own file name, if not `<name>.csv`
 *   files.<name>.columns   documented column name -> the export's header
 *   cents                  money columns are integer cents
 *   dateOrder              "MDY" (default) or "DMY"
 *   delimiter              "," (default), ";" or "\t"
 */
export interface ColumnConfig {
  files?: Record<string, { file?: string; columns?: Record<string, string> }>;
  cents?: boolean;
  dateOrder?: "MDY" | "DMY";
  delimiter?: string;
}

export async function readConfig(dir: string, explicit?: string): Promise<ColumnConfig> {
  const path = explicit ?? join(dir, "columns.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as ColumnConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return {};
    throw new Error(`Could not read column mapping ${path}: ${(error as Error).message}`);
  }
}

export function settingsFrom(config: ColumnConfig): CsvSettings {
  return {
    cents: config.cents ?? DEFAULT_SETTINGS.cents,
    dateOrder: config.dateOrder ?? DEFAULT_SETTINGS.dateOrder,
  };
}

function fileFor(dir: string, config: ColumnConfig, name: string): string {
  return resolve(dir, config.files?.[name]?.file ?? `${name}.csv`);
}

/**
 * Rename the export's headers to the documented ones. Columns that are not
 * mapped keep their own header, so `custom:Gate code` works whether it was
 * written that way in the export or mapped to it.
 */
export function renamer(config: ColumnConfig, name: string): (row: Record<string, string>) => Row {
  const mapping = Object.entries(config.files?.[name]?.columns ?? {});
  const used = new Set(mapping.map(([, theirs]) => theirs));
  return (row) => {
    const out: Row = {};
    // Unmapped headers first, under their own names...
    for (const [header, value] of Object.entries(row)) {
      if (!used.has(header)) out[header] = value;
    }
    // ...then the mapping, which wins, because it is the operator saying so.
    // One export header may feed several documented columns: a customer
    // number is both the property's id and the customer it belongs to.
    for (const [documented, theirs] of mapping) {
      if (theirs in row) out[documented] = row[theirs];
    }
    return out;
  };
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Stream a CSV as renamed rows. A BOM, CRLF and ragged rows are all ordinary. */
export async function* rows(path: string, config: ColumnConfig, name: string): AsyncGenerator<Row> {
  const rename = renamer(config, name);
  const parser = createReadStream(path).pipe(parse({
    columns: true,
    bom: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    delimiter: config.delimiter ?? ",",
  }));
  for await (const record of parser) yield rename(record as Record<string, string>);
}

const BATCH = 500;

/**
 * The settings travel ON EACH ROW in the snapshot, under `_csv`.
 *
 * `profile`, `dryrun` and `load` run in later processes that never see
 * columns.json, and a snapshot read with the wrong cents setting is a
 * hundredfold error on every amount. Stamping the row makes the snapshot
 * mean the same thing wherever it is read, which is what it is for.
 */
function settingsOf(row: Row): CsvSettings {
  const stamped = row["_csv"] as Partial<CsvSettings> | undefined;
  return {
    cents: stamped?.cents ?? DEFAULT_SETTINGS.cents,
    dateOrder: stamped?.dateOrder ?? DEFAULT_SETTINGS.dateOrder,
  };
}

export function createCsvAdapter(): SourceAdapter {
  return {
    id: "csv",
    displayName: "Generic CSV",
    capabilities,

    /**
     * `credentials` here are a directory and an optional column mapping,
     * passed through the same parameter an API adapter takes a token in,
     * because to this adapter that is exactly what they are: what it needs
     * to reach the data.
     */
    async verify(credentials) {
      const dir = credentials["dir"];
      if (!dir) return { ok: false, error: "No directory. Pass --from <dir>." };
      try {
        const config = await readConfig(dir, credentials["columns"]);
        const customers = fileFor(dir, config, "customers");
        if (!(await exists(customers))) {
          return { ok: false, error: `No customer file at ${customers}. Every other file is optional; this one is not.` };
        }
        return { ok: true, account: basename(resolve(dir)) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },

    async *extract(credentials, ctx: ExtractContext) {
      const dir = credentials["dir"] ?? ".";
      const config = await readConfig(dir, credentials["columns"]);
      const stamp = settingsFrom(config);

      for (const plan of PLAN) {
        const path = fileFor(dir, config, plan.file);
        if (!(await exists(path))) {
          yield { entity: plan.entity, count: 0, done: true };
          continue;
        }

        /**
         * Children are read whole before the parent streams. The alternative
         * is requiring the export sorted by parent id, which no export is, and
         * a line attached to the wrong invoice is worse than memory.
         */
        const children = new Map<string, Row[]>();
        if (plan.child) {
          const childPath = fileFor(dir, config, plan.child.file);
          if (await exists(childPath)) {
            for await (const child of rows(childPath, config, plan.child.name)) {
              const parent = String(child[plan.child.foreignKey] ?? "").trim();
              if (parent === "") {
                ctx.log(`${plan.child.name}: a row names no ${plan.child.foreignKey} and belongs to nothing`);
                continue;
              }
              const bucket = children.get(parent) ?? [];
              children.set(parent, bucket);
              bucket.push(child);
            }
          }
        }

        // Resuming means skipping rows already appended. The file is local and
        // re-reading it is cheap; appending a row twice is not, because the
        // profile then reports a duplicate source id that never existed.
        const done = Number(await ctx.resume(plan.entity) ?? 0);
        let index = 0;
        let count = done;
        let batch: Row[] = [];

        for await (const row of rows(path, config, plan.file)) {
          index += 1;
          if (index <= done) continue;
          row["_csv"] = stamp;
          // A file path in the export means a file beside the export. Made
          // absolute now, while the directory is known, because nothing that
          // reads the snapshot later knows where the export was.
          if (plan.entity === "attachment" && typeof row["path"] === "string" && row["path"].trim() !== "") {
            row["path"] = resolve(dir, row["path"].trim());
          }
          if (plan.child) {
            const id = String(row["id"] ?? "").trim();
            row[plan.child.field] = children.get(id) ?? [];
            children.delete(id);
          }
          batch.push(row);
          if (batch.length >= BATCH) {
            await ctx.append(plan.entity, batch);
            count += batch.length;
            batch = [];
            await ctx.checkpoint(plan.entity, String(index));
            yield { entity: plan.entity, count, done: false };
          }
        }
        if (batch.length > 0) {
          await ctx.append(plan.entity, batch);
          count += batch.length;
          await ctx.checkpoint(plan.entity, String(index));
        }

        // Children left over name a parent that is not in the parent file. Each
        // one is a line of an invoice nobody exported, and it is said out loud.
        if (plan.child && children.size > 0) {
          const orphans = [...children.values()].reduce((n, b) => n + b.length, 0);
          ctx.log(`${plan.child.name}: ${orphans} row(s) name a ${plan.entity} that is not in ${basename(path)}`);
        }
        yield { entity: plan.entity, count, done: true };
      }
    },

    toCanonical(entity, raw) {
      const row = raw as Row;
      const settings = settingsOf(row);
      switch (entity) {
        case "user": return map.toUser(row, settings);
        case "customer": return map.toCustomer(row, settings);
        case "property": return map.toProperty(row, settings);
        case "priceBookItem": return map.toPriceBookItem(row, settings);
        case "estimate": return map.toEstimate(row, settings);
        case "job": return map.toJob(row, settings);
        case "invoice": return map.toInvoice(row, settings);
        case "payment": return map.toPayment(row, settings);
        case "attachment": return map.toAttachment(row, settings);
        default:
          throw new Error(`Generic CSV adapter has no canonical mapping for "${entity}"`);
      }
    },
  };
}

export const csv: SourceAdapter = createCsvAdapter();
