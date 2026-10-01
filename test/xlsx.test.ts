import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { readWorkbook, records, excelNumber, serialToIso } from "../src/adapters/csv/xlsx.js";
import { renamer, mergeConfig } from "../src/adapters/csv/index.js";
import { splitAddress, paymentId } from "../src/adapters/csv/map.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "xlsx-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A zip, written by hand: one entry stored, the rest deflated. */
function zip(entries: Record<string, string>, lie?: { declare: number }): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(entries).forEach(([name, text], i) => {
    const raw = Buffer.from(text, "utf8");
    const method = i === 0 ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(lie && i > 0 ? lie.declare : raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const WORKBOOK = (date1904: boolean) => `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Report &amp; more" sheetId="1" r:id="rId7"/></sheets></workbook>`;
const RELS = `<Relationships><Relationship Id="rId7" Type="worksheet" Target="/xl/worksheets/data.xml"/></Relationships>`;
const STYLES = `<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="[$-409]m/d/yy\\ h:mm\\ AM/PM;@"/>
<numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
const STRINGS = `<sst><si><t>Customer ID</t></si><si><r><t>Customer </t></r><r><rPr><b/></rPr><t>Name</t></r><rPh><t>ignored</t></rPh></si>
<si><t xml:space="preserve">  O&apos;Brien &amp; Sons_x000D_</t></si></sst>`;
const SHEET = `<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Customers</t></is></c></row>
<row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="C3" t="inlineStr"><is><t>Paid</t></is></c>
<c r="D3" t="inlineStr"><is><t>Since</t></is></c><c r="E3" t="inlineStr"><is><t>Last call</t></is></c><c r="F3" t="inlineStr"><is><t>Balance</t></is></c>
<c r="G3" t="inlineStr"><is><t>Check</t></is></c></row>
<row r="4"><c r="A4"><v>41001</v></c><c r="B4" t="s"><v>2</v></c><c r="C4" t="b"><v>1</v></c><c r="D4" s="1"><v>45365</v></c>
<c r="E4" s="2"><v>45365.6875</v></c><c r="F4" s="3"><v>1234.5599999999999</v></c><c r="G4" t="e"><v>#N/A</v></c></row>
<row r="5"/>
<row r="6"><c r="A6"><v>4.1002E4</v></c><c r="C6" t="b"><v>0</v></c><c r="F6" t="str"><f>SUM(F4)</f><v>12</v></c></row>
</sheetData></worksheet>`;

async function workbook(date1904 = false): Promise<string> {
  const path = join(dir, "report.xlsx");
  await writeFile(path, zip({
    "xl/workbook.xml": WORKBOOK(date1904), "xl/_rels/workbook.xml.rels": RELS, "xl/styles.xml": STYLES,
    "xl/sharedStrings.xml": STRINGS, "xl/worksheets/data.xml": SHEET,
  }));
  return path;
}

describe("reading an .xlsx as text", () => {
  it("reads strings, booleans, errors, dates and money as the cells hold them", async () => {
    const [sheet] = await readWorkbook(await workbook());
    expect(sheet!.name).toBe("Report & more");
    expect(records(sheet!.rows)).toEqual([
      {
        "Customer ID": "41001", "Customer Name": "O'Brien & Sons", Paid: "TRUE", Since: "2024-03-14",
        "Last call": "2024-03-14T16:30:00", Balance: "1234.56", Check: "#N/A",
      },
      { "Customer ID": "41002", "Customer Name": "", Paid: "FALSE", Since: "", "Last call": "", Balance: "12", Check: "" },
    ]);
  });

  it("counts dates from 1904 when the workbook says so", async () => {
    const [sheet] = await readWorkbook(await workbook(true));
    expect(records(sheet!.rows)[0]).toMatchObject({ Since: "2028-03-15" });
  });

  it("refuses what it cannot read, saying what to do instead", async () => {
    const path = join(dir, "old.xlsx");
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    await expect(readWorkbook(path)).rejects.toThrow(/save it as CSV/i);
    await writeFile(path, "Customer ID,Name\n1,Ada\n");
    await expect(readWorkbook(path)).rejects.toThrow(/not an \.xlsx workbook/);
  });

  it("writes a stored number to Excel's 15 digits, without a float", () => {
    expect(excelNumber("1234.5599999999999")).toBe("1234.56");
    expect(excelNumber("899.53000000000009")).toBe("899.53");
    expect(excelNumber("0.30000000000000004")).toBe("0.3");
    expect(excelNumber("9.9999999999999995E-3")).toBe("0.01");
    expect(excelNumber("-1.5E+3")).toBe("-1500");
    expect(excelNumber("123456789012")).toBe("123456789012");
    expect(excelNumber("0")).toBe("0");
  });

  it("reads serial dates across Lotus's 29 February 1900", () => {
    expect(serialToIso("59", false, false)).toBe("1900-02-28");
    expect(serialToIso("61", false, false)).toBe("1900-03-01");
    expect(serialToIso("45365.5", false, false)).toBe("2024-03-14T12:00:00");
    expect(serialToIso("45365", true, false)).toBe("2024-03-14T00:00:00");
    expect(() => serialToIso("60", false, false)).toThrow(/does not exist/);
  });
});

describe("the column mapping, made forgiving where it is safe to be", () => {
  it("takes the first header present from a list, and matches ignoring case and spacing", () => {
    const rename = renamer({ files: { jobs: { columns: { name: ["Equipment name", "Name"], status: "Job Status" }, defaults: { model: "rule" } } } }, "jobs");
    expect(rename({ "Equipment  Name": "Condenser", "JOB STATUS": "Completed", Other: "kept" }))
      .toEqual({ Other: "kept", name: "Condenser", status: "Completed", model: "rule" });
    expect(rename({ Name: "Furnace", model: "manual-list" })).toMatchObject({ name: "Furnace", model: "manual-list" });
  });

  it("lays an override's defaults over a preset's", () => {
    const merged = mergeConfig({ files: { a: { defaults: { kind: "x", model: "rule" } } } }, { files: { a: { defaults: { model: "manual-list" } } } });
    expect(merged.files?.["a"]?.defaults).toEqual({ kind: "x", model: "manual-list" });
  });

  it("splits a one-line US address, and keeps anything else whole", () => {
    expect(splitAddress("900 Congress Ave, Suite 400, Austin, TX 78701-1234, USA")).toEqual({
      line1: "900 Congress Ave", line2: "Suite 400", city: "Austin", state: "TX", postalCode: "78701-1234",
    });
    expect(splitAddress("12 High St, Leeds LS1 4AP")).toEqual({ line1: "12 High St, Leeds LS1 4AP" });
  });

  it("derives a payment id from what the row says when the report has none", () => {
    expect(paymentId({ id: "P1" })).toBe("P1");
    expect(paymentId({ customer_id: "41001", invoice_id: "71001", received_at: "2024-03-14", amount: "344.24", method: "Credit Card" }))
      .toBe("derived:|41001|71001|2024-03-14|344.24|credit card");
  });
});

describe("a workbook that lies about its size", () => {
  it("refuses an entry that inflates past the size its directory declared, without inflating it all", async () => {
    // 64 MiB of one byte deflates to about 64 KiB: a small bomb, declared as 100 bytes.
    const bomb = zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "a".repeat(64 * 1024 * 1024) }, { declare: 100 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const path = join(dir, "bomb.xlsx");
    await writeFile(path, bomb);
    await expect(readWorkbook(path)).rejects.toThrow(/would unpack to more than/);
  });

  it("refuses an entry whose declared size is beyond any real report", async () => {
    const huge = zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>" }, { declare: 0xfffffff0 });
    const path = join(dir, "huge.xlsx");
    await writeFile(path, huge);
    await expect(readWorkbook(path)).rejects.toThrow(/would unpack to more than/);
  });
});
