import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse } from "csv-parse";
import type { EntityName } from "../../canonical/index.js";
import type { ExtractContext, SourceAdapter, SourceCapabilities } from "../types.js";
import * as map from "./map.js";
import { DEFAULT_SETTINGS, type CsvSettings, type Row } from "./map.js";
import { readWorkbook, records } from "./xlsx.js";

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
  { entity: "contact", file: "contacts" },
  { entity: "equipment", file: "equipment" },
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
    entity: "recurringSchedule", file: "recurring_schedules",
    child: { name: "recurring_exceptions", file: "recurring_exceptions", foreignKey: "schedule_id", field: "exceptions" },
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
    "A spreadsheet has no recurrence of its own. Repeating work arrives as whatever rows were exported, unless recurring_schedules.csv states each schedule, model included; nothing is inferred from repeating jobs.",
    "Dates written as 03/04/2024 are read month first unless columns.json says DMY. Anything that is neither ISO nor slashed is refused, not guessed.",
    "Times are carried as written, with no zone, unless --timezone (or \"timezone\" in columns.json) names the zone the export was written in.",
    "Excel workbooks (.xlsx) are read directly, cell text as stored; any file may be .csv or .xlsx.",
  ],
};

/**
 * columns.json. Every key optional.
 *
 *   files.<name>.file      the export's own file name, if not `<name>.csv`.
 *                          A .csv and an .xlsx of the same name are
 *                          interchangeable: whichever exists is read.
 *   files.<name>.sheet     for a workbook: the sheet to read (default the
 *                          first), or a list of sheets read one after the
 *                          other, each row carrying its sheet's name in `_sheet`
 *   files.<name>.columns   documented column name -> the export's header, or
 *                          a list of headers of which the first present wins.
 *                          Headers match exactly, then ignoring case and spacing.
 *   files.<name>.defaults  documented column -> a value for rows that leave it
 *                          empty, for what an export states by being the
 *                          export it is (every row of a membership report is a
 *                          service agreement)
 *   cents                  money columns are integer cents
 *   dateOrder              "MDY" (default) or "DMY"
 *   delimiter              "," (default), ";" or "\t"
 *   timezone               IANA zone the export's times are written in
 */
export interface FileConfig {
  file?: string;
  sheet?: string | string[];
  columns?: Record<string, string | string[]>;
  defaults?: Record<string, string>;
}

export interface ColumnConfig {
  files?: Record<string, FileConfig>;
  cents?: boolean;
  dateOrder?: "MDY" | "DMY";
  delimiter?: string;
  timezone?: string;
}

/**
 * A preset is a columns.json shipped with the toolkit for one source's
 * exports (FieldEdge's, for example). The operator's own columns.json is laid
 * over it, file by file and column by column, so fixing one header an export
 * spells differently does not mean restating the whole preset.
 */
export function mergeConfig(preset: ColumnConfig, own: ColumnConfig): ColumnConfig {
  const files: NonNullable<ColumnConfig["files"]> = { ...(preset.files ?? {}) };
  for (const [name, entry] of Object.entries(own.files ?? {})) {
    const base = files[name] ?? {};
    files[name] = {
      ...base,
      ...entry,
      columns: { ...(base.columns ?? {}), ...(entry.columns ?? {}) },
      defaults: { ...(base.defaults ?? {}), ...(entry.defaults ?? {}) },
    };
  }
  const merged: ColumnConfig = { ...preset, ...own, files };
  return merged;
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
    ...(config.timezone ? { timezone: config.timezone } : {}),
  };
}

/** An unknown zone fails here, in seconds, not on the ten-thousandth row. */
export function checkTimezone(zone: string | undefined): void {
  if (!zone) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`Unknown time zone ${JSON.stringify(zone)}. Use an IANA name such as America/Chicago.`);
  }
}

const SWAP: Record<string, string> = { ".csv": ".xlsx", ".xlsx": ".csv" };

/**
 * Where a file is. The configured name first; failing that the same name
 * with the other extension, because whether an owner kept the workbook or
 * saved it as CSV is not a decision this importer should make them get right.
 *
 * A name with `*` in it is a pattern, for a report too large to run in one
 * go and exported a year at a time: `Invoices*.xlsx` reads `Invoices.xlsx`,
 * `Invoices 2019.xlsx` and `Invoices 2020.csv`, in name order. Where the same
 * file is there as both .xlsx and .csv, the workbook is read and the copy is
 * not, so saving a CSV beside the original does not import everything twice.
 */
export async function locate(dir: string, config: ColumnConfig, name: string): Promise<string[]> {
  const configured = config.files?.[name]?.file ?? `${name}.csv`;
  if (configured.includes("*")) {
    const ext = extname(configured);
    const stem = SWAP[ext.toLowerCase()] ? configured.slice(0, -ext.length) : configured;
    const folder = resolve(dir, dirname(stem));
    const pattern = new RegExp(`^${basename(stem).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}\\.(csv|xlsx)$`, "i");
    let names: string[] = [];
    try { names = await readdir(folder); } catch { return []; }
    const matched = names.filter((n) => pattern.test(n)).sort();
    const stems = new Set(matched.filter((n) => /\.xlsx$/i.test(n)).map((n) => n.slice(0, -5).toLowerCase()));
    const chosen = matched.filter((n) => !(/\.csv$/i.test(n) && stems.has(n.slice(0, -4).toLowerCase())));
    const files: string[] = [];
    for (const n of chosen) if (await exists(join(folder, n))) files.push(join(folder, n));
    return files;
  }
  const primary = resolve(dir, configured);
  if (await exists(primary)) return [primary];
  const ext = extname(primary).toLowerCase();
  const swapped = SWAP[ext];
  if (swapped) {
    const other = primary.slice(0, -ext.length) + swapped;
    if (await exists(other)) return [other];
  }
  return [];
}

/** Every file's rows, one file after another. */
async function* rowsOfAll(paths: string[], config: ColumnConfig, name: string): AsyncGenerator<{ row: Row; path: string }> {
  for (const path of paths) for await (const row of rows(path, config, name)) yield { row, path };
}

const loose = (header: string): string => header.toLowerCase().replace(/[\s_]+/g, " ").trim();

/**
 * Rename the export's headers to the documented ones. Columns that are not
 * mapped keep their own header, so `custom:Gate code` works whether it was
 * written that way in the export or mapped to it.
 */
export function renamer(config: ColumnConfig, name: string): (row: Record<string, string>) => Row {
  const file = config.files?.[name] ?? {};
  const mapping = Object.entries(file.columns ?? {}).map(([documented, theirs]) =>
    [documented, (Array.isArray(theirs) ? theirs : [theirs]).filter((t) => t !== "")] as const);
  const defaults = Object.entries(file.defaults ?? {});
  return (row) => {
    // Exact header first; then the same header ignoring case and spacing,
    // because "Equipment name" in the documentation and "Equipment Name" in
    // the file are the same column and nobody should have to notice.
    const byLoose = new Map<string, string>();
    for (const header of Object.keys(row)) if (!byLoose.has(loose(header))) byLoose.set(loose(header), header);
    const find = (theirs: readonly string[]): string | undefined => {
      for (const t of theirs) if (t in row) return t;
      for (const t of theirs) { const h = byLoose.get(loose(t)); if (h !== undefined) return h; }
      return undefined;
    };
    const resolved = mapping.map(([documented, theirs]) => [documented, find(theirs)] as const);
    const used = new Set(resolved.map(([, h]) => h).filter((h): h is string => h !== undefined));
    const out: Row = {};
    // Unmapped headers first, under their own names...
    for (const [header, value] of Object.entries(row)) {
      if (!used.has(header)) out[header] = value;
    }
    // ...then the mapping, which wins, because it is the operator saying so.
    // One export header may feed several documented columns: a customer
    // number is both the property's id and the customer it belongs to.
    for (const [documented, header] of resolved) {
      if (header !== undefined) out[documented] = row[header];
    }
    for (const [documented, value] of defaults) {
      const current = out[documented];
      if (current === undefined || (typeof current === "string" && current.trim() === "")) out[documented] = value;
    }
    return out;
  };
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/**
 * Stream a CSV, or read a workbook, as renamed rows. A BOM, CRLF and ragged
 * rows are all ordinary.
 */
export async function* rows(path: string, config: ColumnConfig, name: string): AsyncGenerator<Row> {
  const rename = renamer(config, name);
  if (extname(path).toLowerCase() === ".xlsx") {
    const sheets = await readWorkbook(path);
    const wanted = config.files?.[name]?.sheet;
    const names = wanted === undefined ? [] : Array.isArray(wanted) ? wanted : [wanted];
    const chosen = names.length === 0
      ? sheets.slice(0, 1)
      : names.map((n) => sheets.find((s) => loose(s.name) === loose(n))).filter((s) => s !== undefined);
    if (chosen.length === 0) {
      throw new Error(`${basename(path)} has no sheet named ${names.join(" or ")}; it has ${sheets.map((s) => s.name).join(", ") || "none"}.`);
    }
    for (const sheet of chosen) {
      for (const record of records(sheet.rows)) {
        yield rename(names.length > 0 ? { ...record, _sheet: sheet.name } : record);
      }
    }
    return;
  }
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
    ...(stamped?.timezone ? { timezone: stamped.timezone } : {}),
  };
}

/**
 * A report's own total line ("Total", "Grand Total") at the foot of the
 * table. It names no record and is not one; read as a row it would be an
 * unreadable record on every run.
 */
function isTotalsRow(row: Row): boolean {
  const label = (v: unknown) => typeof v === "string" && /^(grand\s+)?totals?:?$/i.test(v.trim());
  if (typeof row["id"] === "string" && row["id"].trim() !== "") return label(row["id"]);
  return Object.entries(row).some(([k, v]) => !k.startsWith("_") && label(v));
}

export interface CsvAdapterOptions {
  id?: string;
  displayName?: string;
  /** Written as `sourceSystem` on every canonical record. Defaults to the id. */
  sourceSystem?: string;
  /** Built-in columns.json for one source's exports; the operator's own is laid over it. */
  preset?: ColumnConfig;
  capabilities?: SourceCapabilities;
}

export function createCsvAdapter(options: CsvAdapterOptions = {}): SourceAdapter {
  const id = options.id ?? "csv";
  const sourceSystem = options.sourceSystem ?? id;
  const configFor = async (credentials: Record<string, string | undefined>): Promise<ColumnConfig> => {
    const dir = credentials["dir"] ?? ".";
    const own = await readConfig(dir, credentials["columns"]);
    const config = options.preset ? mergeConfig(options.preset, own) : own;
    // --timezone on the command line beats columns.json: it is the more
    // deliberate of the two.
    if (credentials["timezone"]) config.timezone = credentials["timezone"];
    checkTimezone(config.timezone);
    return config;
  };
  const stampSource = (produced: unknown): unknown => {
    if (sourceSystem === "csv") return produced;
    const restamp = (r: unknown) => (r && typeof r === "object" ? { ...(r as Record<string, unknown>), sourceSystem } : r);
    return Array.isArray(produced) ? produced.map(restamp) : restamp(produced);
  };
  return {
    id,
    displayName: options.displayName ?? "Generic CSV",
    capabilities: options.capabilities ?? capabilities,

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
        const config = await configFor(credentials);
        const customers = await locate(dir, config, "customers");
        if (customers.length === 0) {
          const wanted = resolve(dir, config.files?.["customers"]?.file ?? "customers.csv");
          return { ok: false, error: `No customer file at ${wanted} (.csv or .xlsx). Every other file is optional; this one is not.` };
        }
        return { ok: true, account: basename(resolve(dir)) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },

    async *extract(credentials, ctx: ExtractContext) {
      const dir = credentials["dir"] ?? ".";
      const config = await configFor(credentials);
      const stamp = settingsFrom(config);

      for (const plan of PLAN) {
        const paths = await locate(dir, config, plan.file);
        if (paths.length === 0) {
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
          {
            for await (const { row: child } of rowsOfAll(await locate(dir, config, plan.child.file), config, plan.child.name)) {
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

        for await (const { row, path } of rowsOfAll(paths, config, plan.file)) {
          index += 1;
          if (index <= done) continue;
          if (isTotalsRow(row)) {
            ctx.log(`${basename(path)}: row ${index} is the report's total line; not a record`);
            continue;
          }
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
          ctx.log(`${plan.child.name}: ${orphans} row(s) name a ${plan.entity} that is not in ${paths.map((p) => basename(p)).join(", ")}`);
        }
        yield { entity: plan.entity, count, done: true };
      }
    },

    toCanonical(entity, raw) {
      return stampSource(mapRow(entity, raw as Row));
    },
  };
}

function mapRow(entity: EntityName, row: Row): unknown {
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
    case "equipment": return map.toEquipment(row, settings);
    case "contact": return map.toContact(row, settings);
    case "recurringSchedule": return map.toRecurringSchedule(row, settings);
    default:
      throw new Error(`Generic CSV adapter has no canonical mapping for "${entity}"`);
  }
}

export const csv: SourceAdapter = createCsvAdapter();
