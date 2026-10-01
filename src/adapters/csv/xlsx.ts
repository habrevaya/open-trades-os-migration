import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * XLSX, READ AS TEXT
 *
 * Several platforms export reports as Excel workbooks and nothing else.
 * ServiceTitan's reports export to XLSX or PDF
 * (https://help.servicetitan.com/docs/run-report.md, "Export a report"), and
 * its pricebook export is a workbook with one sheet per item type. Asking an
 * owner to open eleven workbooks and "Save As CSV" each one is asking them to
 * make eleven chances to lose a column, reorder a date, or have Excel
 * reformat a long id in scientific notation.
 *
 * So workbooks are read directly. Not through a general spreadsheet library,
 * deliberately:
 *
 * - The general readers (SheetJS, ExcelJS, read-excel-file) hand back cell
 *   values as JS numbers and Dates. This toolkit's rule is that money is never
 *   a JS number, and a Date built from a local wall-clock time has already
 *   been given a timezone it did not have. Reading the cell's stored text is
 *   the only way to keep both promises.
 * - SheetJS's npm package is no longer updated on npm; ExcelJS brings ten
 *   transitive dependencies to read what is, underneath, a zip of XML.
 *
 * What is read: the zip (stored or deflated entries, through node:zlib), the
 * workbook's sheet list, shared strings, inline strings, booleans, error
 * values as written (`#N/A`, which then fails loudly wherever it lands), and
 * numbers, of which those styled as dates become ISO 8601 text in the
 * workbook's own date system. Nothing is evaluated: a formula cell is read as
 * the value Excel last calculated and saved.
 *
 * What is not: encrypted workbooks, zip64 archives (over 4 GB), and the old
 * binary .xls format. Each is refused with a message saying to save as CSV.
 */

export interface Sheet {
  name: string;
  rows: string[][];
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** The entries of a zip archive, inflated on demand. */
function unzip(buf: Buffer, path: string): (name: string) => Buffer | undefined {
  const floor = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) {
    if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new Error(`${path} is an old binary .xls workbook or an encrypted one. Open it in Excel and save it as CSV UTF-8 or .xlsx.`);
    }
    throw new Error(`${path} is not an .xlsx workbook (no zip directory). Save it from Excel as CSV UTF-8.`);
  }
  const count = buf.readUInt16LE(eocd + 10);
  const offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    throw new Error(`${path} is a zip64 workbook, which this reader does not open. Save it as CSV UTF-8, or split the report by date range.`);
  }

  const entries = new Map<string, { method: number; flags: number; size: number; local: number }>();
  let at = offset;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== SIG_CENTRAL) throw new Error(`${path}: damaged zip directory`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    entries.set(name.replace(/\\/g, "/"), { method, flags, size, local });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return (name) => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    if (entry.flags & 1) throw new Error(`${path} is password protected. Remove the password in Excel, or save it as CSV.`);
    if (buf.readUInt32LE(entry.local) !== SIG_LOCAL) throw new Error(`${path}: damaged zip entry ${name}`);
    const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
    const data = buf.subarray(start, start + entry.size);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`${path}: entry ${name} uses zip method ${entry.method}, which this reader does not open. Save it as CSV.`);
  };
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/** XML entities, then OOXML's own `_x000D_` escapes for characters XML cannot hold. */
export function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
      e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16))
        : e.startsWith("#") ? String.fromCodePoint(parseInt(e.slice(1), 10))
          : ENTITY[e]!)
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decode(m[1]!) : undefined;
};

/** The text of a string item: every `<t>` run, without phonetic guides. */
function runs(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += decode(m[1] ?? "");
  return out;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => runs(m[1] ?? ""));
}

/** Built-in number formats that are dates or times (ECMA-376 18.8.30). */
const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIMES = new Set([18, 19, 20, 21, 22, 45, 46, 47]);

interface DateStyle { date: boolean; time: boolean }

/**
 * Which cell styles are dates. A number is a date only because its style
 * says so; the same 45366 is a quantity in one cell and 14 March 2024 in the
 * next.
 */
function dateStyles(xml: string | undefined): DateStyle[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1]!, "numFmtId"));
    const code = attr(m[1]!, "formatCode");
    if (code !== undefined) custom.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  return [...xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map((m) => {
    const id = Number(attr(m[1]!, "numFmtId") ?? "0");
    const code = custom.get(id);
    if (code === undefined) return { date: BUILTIN_DATES.has(id), time: BUILTIN_TIMES.has(id) };
    // Quoted literals, escaped characters and [colour]/[$-409] sections are
    // not date tokens. What is left decides it.
    const bare = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "").replace(/_.|\*./g, "");
    const date = /[dmyhs]/i.test(bare) && !/^[#0.,%\s?/E+-]*$/.test(bare);
    return { date, time: date && /[hs]/i.test(bare) };
  });
}

const DAY_MS = 86_400_000;

/**
 * A serial date as ISO text. 1900-system serials count from 1899-12-31 with
 * Lotus 1-2-3's fictitious 29 February 1900 at 60, so every serial from 61
 * on is one day ahead of a plain count; the 1904 system has no such quirk.
 * The result is a wall-clock time, with no zone: Excel stores none.
 */
export function serialToIso(raw: string, time: boolean, date1904: boolean): string {
  const serial = Number(raw);
  if (!Number.isFinite(serial)) throw new Error(`Not a date serial: ${JSON.stringify(raw)}`);
  const whole = Math.floor(serial);
  const seconds = Math.round((serial - whole) * 86_400);
  let base: number;
  if (date1904) base = Date.UTC(1904, 0, 1);
  else if (whole >= 61) base = Date.UTC(1899, 11, 30);
  else if (whole === 60) throw new Error("29 February 1900 does not exist; Excel's date serial 60 is a known bug");
  else base = Date.UTC(1899, 11, 31);
  const at = new Date(base + whole * DAY_MS + seconds * 1000);
  const day = at.toISOString().slice(0, 10);
  return time || seconds !== 0 ? `${day}T${at.toISOString().slice(11, 19)}` : day;
}

/**
 * A stored number as decimal text, to Excel's own 15 significant digits.
 *
 * Excel saves the shortest text that round-trips its binary double, so a sum
 * that displays as 1234.56 can be stored as 1234.5599999999999. Excel shows
 * and calculates with 15 significant digits, and that is the number the owner
 * saw on screen. The rounding is done on the digits, as text, so no float is
 * involved; exponent notation is expanded the same way.
 */
export function excelNumber(raw: string): string {
  const m = /^(-)?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return raw.trim();
  const sign = m[1] ?? "";
  let digits = `${m[2]}${m[3] ?? ""}`;
  let point = (m[2] ?? "").length + Number(m[4] ?? "0");
  const lead = digits.length - digits.replace(/^0+/, "").length;
  digits = digits.slice(lead);
  point -= lead;
  if (digits === "") return "0";
  if (digits.length > 15) {
    const kept = digits.slice(0, 15).split("").map(Number);
    if (Number(digits[15]) >= 5) {
      let i = 14;
      while (i >= 0) { kept[i]! += 1; if (kept[i]! < 10) break; kept[i] = 0; i -= 1; }
      if (i < 0) { kept.unshift(1); point += 1; }
    }
    digits = kept.join("").slice(0, 16);
  }
  let whole: string;
  let fraction: string;
  if (point <= 0) { whole = "0"; fraction = "0".repeat(-point) + digits; }
  else if (point >= digits.length) { whole = digits + "0".repeat(point - digits.length); fraction = ""; }
  else { whole = digits.slice(0, point); fraction = digits.slice(point); }
  fraction = fraction.replace(/0+$/, "");
  return `${sign}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/** "AB" to 27. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function parseSheet(xml: string, strings: string[], styles: DateStyle[], date1904: boolean): string[][] {
  const rows: string[][] = [];
  const data = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml)?.[1] ?? "";
  for (const row of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(row[1]!, "r") ?? String(rows.length + 1)) - 1;
    const cells: string[] = [];
    let next = 0;
    for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? "";
      const ref = attr(attrs, "r");
      const index = ref ? columnIndex(ref) : next;
      next = index + 1;
      const type = attr(attrs, "t") ?? "n";
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "inlineStr") value = runs(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (v === undefined) value = "";
      else if (type === "s") value = strings[Number(v)] ?? "";
      else if (type === "b") value = v.trim() === "1" ? "TRUE" : "FALSE";
      else if (type === "str" || type === "e" || type === "d") value = decode(v);
      else {
        const style = styles[Number(attr(attrs, "s") ?? "0")];
        value = style?.date ? serialToIso(v, style.time, date1904) : excelNumber(decode(v));
      }
      cells[index] = value;
    }
    for (let i = 0; i < cells.length; i += 1) cells[i] ??= "";
    rows[r] = cells;
  }
  const out: string[][] = [];
  for (let i = 0; i < rows.length; i += 1) out.push(rows[i] ?? []);
  return out;
}

/** Every sheet of a workbook, in workbook order, as rows of text. */
export async function readWorkbook(path: string): Promise<Sheet[]> {
  const entry = unzip(await readFile(path), path);
  const text = (name: string) => entry(name)?.toString("utf8");
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error(`${path} has no xl/workbook.xml; it is not an Excel workbook.`);
  const rels = new Map<string, string>();
  for (const m of (text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, "Id");
    const target = attr(m[1]!, "Target");
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const pr = /<workbookPr\b([^>]*)\/?>/.exec(workbook)?.[1] ?? "";
  const date1904 = ["1", "true"].includes((attr(pr, "date1904") ?? "").toLowerCase());
  const strings = sharedStrings(text("xl/sharedStrings.xml"));
  const styles = dateStyles(text("xl/styles.xml"));

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1]!, "name") ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[1]!, "r:id");
    const target = rid ? rels.get(rid) : undefined;
    const xml = target ? text(target) : undefined;
    if (xml === undefined) continue;
    sheets.push({ name, rows: parseSheet(xml, strings, styles, date1904) });
  }
  return sheets;
}

/**
 * A sheet's rows as records keyed by its header row.
 *
 * The header is the first row with at least two filled cells, so a report
 * title or a "Date range: ..." line above the table is passed over rather
 * than read as headers. Blank rows are dropped. A repeated header gets a
 * suffix (`Total (2)`) instead of silently overwriting the first.
 */
export function records(rows: string[][]): Record<string, string>[] {
  const filled = (row: string[]) => row.filter((c) => c.trim() !== "").length;
  const at = rows.findIndex((row) => filled(row) >= 2);
  if (at < 0) return [];
  const seen = new Map<string, number>();
  const headers = rows[at]!.map((h) => {
    const name = h.trim();
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
  const out: Record<string, string>[] = [];
  for (const row of rows.slice(at + 1)) {
    if (filled(row) === 0) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, i) => { if (h !== "") record[h] = (row[i] ?? "").trim(); });
    out.push(record);
  }
  return out;
}
