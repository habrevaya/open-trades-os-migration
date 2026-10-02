import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Snapshot } from "../src/snapshot/index.js";
import { servicetitanReports, SERVICETITAN_COLUMNS } from "../src/adapters/servicetitan/reports.js";
import { adapterFor } from "../src/adapters/registry.js";
import { locate } from "../src/adapters/csv/index.js";
import { transform, MemorySink, CountingSink } from "../src/transform/index.js";
import { buildMapping } from "../src/mapping/index.js";
import { load, failures } from "../src/load/index.js";
import { Ledger } from "../src/load/ledger.js";
import { MemoryTarget } from "../src/target/memory.js";
import { readTarget } from "../src/target/read.js";
import { reconcile, sourceSide } from "../src/reconcile/index.js";

/**
 * fixtures/servicetitan-reports is synthetic, shaped like the reports
 * docs/servicetitan.md tells an owner to export: a Customer List with its
 * title above the table, Jobs with the report's total line at the foot,
 * Invoices exported a year per file, and Technicians saved as CSV. The
 * workbooks were written by openpyxl 3.1.5, a writer this toolkit did not
 * make, so the reader is tested against someone else's XLSX.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "servicetitan-reports");
const NOW = new Date("2026-10-01T15:00:00Z");

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "st-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function run(from: string, extra: Record<string, string> = { timezone: "America/Chicago" }) {
  const snapshot = await Snapshot.open(join(dir, `snapshot-${Math.random().toString(36).slice(2)}`), servicetitanReports.id);
  const logs: string[] = [];
  const ctx = Object.assign(snapshot, { log: (m: string) => { logs.push(m); } });
  for await (const p of servicetitanReports.extract({ dir: from, ...extra }, ctx)) if (p.done) await snapshot.complete(p.entity);
  await snapshot.flush();
  const sink = new MemorySink();
  const result = await transform(snapshot, servicetitanReports, sink);
  return { snapshot, sink, result, logs };
}

async function copy(): Promise<string> {
  const from = join(dir, "export");
  await cp(FIXTURES, from, { recursive: true });
  return from;
}

const findings = (result: Awaited<ReturnType<typeof run>>["result"]) => result.profile.findings.map((f) => f.code);

describe("ServiceTitan from the owner's own report exports", () => {
  it("is its own source, and connects to nothing", async () => {
    expect(adapterFor("servicetitan-csv")).toBe(servicetitanReports);
    expect(servicetitanReports.capabilities.hasApi).toBe(false);
    expect(await servicetitanReports.verify({ dir: FIXTURES })).toMatchObject({ ok: true });
    expect(await servicetitanReports.verify({ dir: FIXTURES, timezone: "America/Austin" })).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown time zone/) });
  });

  it("reads every report, workbook or CSV, with nothing unreadable and no join left open", async () => {
    const { sink, result, logs } = await run(FIXTURES);
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({
      user: 2, customer: 3, property: 4, priceBookItem: 4, equipment: 2, estimate: 2, job: 4,
      recurringSchedule: 1, invoice: 4, payment: 4,
    });
    expect(result.profile.findings.filter((f) => f.severity !== "info").map((f) => f.code)).toEqual(["recurringSchedule.no_next_occurrence"]);
    expect(sink.get("invoice").every((i) => i["sourceSystem"] === "servicetitan")).toBe(true);
    // The Jobs report's own total line is not a job.
    expect(logs).toContain("Jobs.xlsx: row 5 is the report's total line; not a record");
  });

  it("finds the header under a report's title, and splits a one-line address only when it is unmistakable", async () => {
    const { sink } = await run(FIXTURES);
    expect(sink.get("customer").find((c) => c["sourceId"] === "41002")).toMatchObject({
      name: "Brazos Property Group", type: "commercial", phone: "(512) 555-0199",
      billingAddress: { line1: "900 Congress Ave", line2: "Suite 400", city: "Austin", state: "TX", postalCode: "78701" },
      customFields: { "Do not mail": "No" },
    });
    expect(sink.get("property").find((p) => p["sourceId"] === "51003")).toMatchObject({
      customerSourceIds: ["41002"], nickname: "Brazos - Lamar", addressLine1: "2200 S Lamar Blvd", city: "Austin", postalCode: "78704",
    });
  });

  it("joins jobs, invoices, lines, payments and estimates on ServiceTitan's own ids", async () => {
    const { sink } = await run(FIXTURES);
    expect(sink.get("job").find((j) => j["sourceId"] === "61002")).toMatchObject({
      customerSourceId: "41002", propertySourceId: "51003", number: 61002, jobType: "Repair", leadSource: "Referral",
      status: "Completed", total: "1234.5600", completedAt: "2025-01-09",
    });
    const invoice = sink.get("invoice").find((i) => i["sourceId"] === "71002")!;
    expect(invoice).toMatchObject({ customerSourceId: "41002", jobSourceId: "61002", number: 71002, issuedOn: "2025-01-09", dueOn: "2025-02-08" });
    expect(sink.get("invoice").find((i) => i["sourceId"] === "71004")!["jobSourceId"]).toBeUndefined();
    expect(sink.get("estimate").find((e) => e["sourceId"] === "81002")).toMatchObject({
      customerSourceId: "41003", propertySourceId: "51004", jobSourceId: "61003", status: "Sold", subtotal: "9875.0000", total: "9875.0000",
    });
    expect(sink.get("payment").find((p) => (p["allocations"] as { invoiceSourceId: string }[])[0]?.invoiceSourceId === "71002")).toMatchObject({
      customerSourceId: "41002", method: "Check", amount: "1049.4600", allocations: [{ invoiceSourceId: "71002", amount: "1049.4600" }],
    });
  });

  it("reads money to the cent, as the owner saw it, with tax as charged", async () => {
    const { sink, result } = await run(FIXTURES);
    const invoice = sink.get("invoice").find((i) => i["sourceId"] === "71002")!;
    expect(invoice).toMatchObject({ subtotal: "1140.4700", taxTotal: "94.0900", total: "1234.5600", balance: "185.1000" });
    // Item Price is the line's total; the unit price is that over the quantity.
    // 899.5300000000001 is how Excel stored it, 899.53 what it showed.
    expect(invoice["lines"]).toEqual([
      expect.objectContaining({ name: "Water heater element", quantity: "2.0000", unitPrice: "120.4700", lineTotal: "240.9400", taxable: true }),
      expect.objectContaining({ name: "Labor - repair", quantity: "4.0000", unitPrice: "224.8825", lineTotal: "899.5300", description: "Hourly labor" }),
    ]);
    expect(result.profile.totals).toMatchObject({
      invoiceTotal: "11642.8000", invoiceBalance: "5060.1000", paymentTotal: "6582.7000", paymentAllocated: "6582.7000",
    });
  });

  it("puts a time of day in the company's time zone, and leaves a calendar date alone", async () => {
    const zoned = await run(FIXTURES);
    const visit = (sink: MemorySink, id: string) => (sink.get("job").find((j) => j["sourceId"] === id)!["visits"] as { windowStart: string; technicianSourceIds: string[] }[])[0]!;
    // 9:00 in Austin in March is daylight time, 13:30 in January is not.
    expect(visit(zoned.sink, "61001")).toMatchObject({ windowStart: "2024-03-14T14:00:00.000Z", technicianSourceIds: ["Nia Osei"] });
    expect(visit(zoned.sink, "61002").windowStart).toBe("2025-01-09T19:30:00.000Z");
    expect(zoned.sink.get("job").find((j) => j["sourceId"] === "61001")!["completedAt"]).toBe("2024-03-14");
    expect(zoned.sink.get("payment").map((p) => p["receivedAt"]).sort()).toEqual([
      "2024-03-14T21:05:00.000Z", "2025-02-02", "2025-06-10", "2025-07-01T13:00:00.000Z",
    ]);
    const plain = await run(FIXTURES, {});
    expect(visit(plain.sink, "61001").windowStart).toBe("2024-03-14T09:00:00");
  });

  it("reads the pricebook export's Services, Materials and Equipment sheets as one price book", async () => {
    const { sink } = await run(FIXTURES);
    const items = Object.fromEntries(sink.get("priceBookItem").map((i) => [i["code"], i]));
    expect(items["TUNE-01"]).toMatchObject({ sourceId: "3001", kind: "service", name: "Precision Tune-Up", description: "21-point tune-up", price: "189.0000", taxable: true, active: true });
    expect(items["LAB-HR"]).toMatchObject({ price: "224.8825", active: false });
    expect(items["FLT-1625"]).toMatchObject({ sourceId: "4001", kind: "material", cost: "11.5000", price: "43.0000", description: "MERV 11" });
    expect(items["HP-TRN-3T"]).toMatchObject({ sourceId: "5001", kind: "equipment", cost: "6200.0000", taxable: false });
  });

  it("carries equipment, memberships and technicians", async () => {
    const { sink } = await run(FIXTURES);
    expect(sink.get("equipment").find((e) => e["serialNumber"] === "3019E54321")).toMatchObject({
      propertySourceId: "51001", category: "Air Conditioner", manufacturer: "Carrier", model: "24ACC636A003", installedOn: "2019-04-02",
      attributes: { name: "Condenser", "Equipment code": "AC-CARR-3T", Cost: "2100" },
    });
    expect(sink.get("recurringSchedule")[0]).toMatchObject({
      sourceId: "91001", kind: "service-agreement", model: "materialized-series", customerSourceId: "41001", propertySourceId: "51001",
      name: "Comfort Club", status: "Active", startsOn: "2024-03-14", customFields: { "Next billing date": "2025-08-01", "Sold by": "Nia Osei" },
    });
    expect(sink.get("user").map((u) => u["sourceId"]).sort()).toEqual(["Marcus Bell", "Nia Osei"]);
  });

  it("flags in profile every record whose id is not in the other reports", async () => {
    const from = await copy();
    // A later year's invoices whose job was never exported, a location of a
    // customer outside the customer report, a payment for an invoice outside
    // the invoice reports, and one more payment on an invoice already paid.
    await writeFile(join(from, "Invoices 2026.csv"),
      "Invoice ID,Invoice #,Job ID,Customer ID,Invoice Status,Invoice Date,Total,Balance\n" +
      "71005,71005,69999,41001,Posted,2026-01-05,100.00,100.00\n" +
      "71006,71006,,49999,Posted,2026-01-06,50.00,50.00\n");
    await writeFile(join(from, "Locations more.csv"), "Location ID,Customer ID,Location Address\n59999,49999,\"1 Main St, Austin, TX 78701\"\n");
    await writeFile(join(from, "Applied Payments more.csv"),
      "Payment Type,Payment Method,Amount,Invoice ID,Customer ID,Paid On\n" +
      "Cash,Cash,20.00,79999,41001,2026-01-07\n" +
      "Cash,Cash,10.00,71001,41001,2024-03-15\n");
    const { result } = await run(from);
    expect(findings(result)).toEqual(expect.arrayContaining([
      "invoice.orphan_job", "invoice.orphan_customer", "property.orphan_customer", "payment.orphan_invoice",
      "invoice.payments_do_not_match_balance",
    ]));
    const finding = (code: string) => result.profile.findings.find((f) => f.code === code)!;
    expect(finding("invoice.orphan_job")).toMatchObject({ severity: "warning", count: 1, sample: ["71005"] });
    expect(finding("invoice.orphan_customer")).toMatchObject({ severity: "error", count: 1, sample: ["71006"] });
    expect(finding("invoice.payments_do_not_match_balance")).toMatchObject({ count: 1, sample: ["71001"] });
  });

  it("reads a year per file in name order, and a CSV saved beside its workbook once", async () => {
    const from = await copy();
    await writeFile(join(from, "Invoices 2024.csv"), "Invoice ID,Customer ID,Total,Balance\n99999,41001,1.00,1.00\n");
    const files = await locate(from, SERVICETITAN_COLUMNS, "invoices");
    expect(files.map((f) => f.slice(from.length + 1))).toEqual(["Invoices 2024.xlsx", "Invoices 2025.xlsx"]);
  });

  it("lets columns.json fix a header the preset only assumed", async () => {
    const from = await copy();
    await writeFile(join(from, "columns.json"), JSON.stringify({ files: { jobs: { columns: { summary: "Job Type", status: "" } } } }));
    const { sink } = await run(from);
    expect(sink.get("job").find((j) => j["sourceId"] === "61003")).toMatchObject({ summary: "Install", status: "unknown" });
  });

  it("goes all the way through extract, map and a dry run into an in-memory OpenTradesOS, and reconciles", async () => {
    const { snapshot } = await run(FIXTURES);
    const mapping = (await buildMapping(snapshot, servicetitanReports)).mapping;
    const memory = new MemoryTarget({ today: () => NOW });
    const ledger = Ledger.memory("t", servicetitanReports.id);
    const report = await load({ snapshot, adapter: servicetitanReports, target: memory, ledger, mapping, now: NOW, dryRun: true });
    expect(failures(report)).toBe(0);
    expect(report.aborted).toBeUndefined();
    expect(memory.customers.size).toBe(3);
    expect(memory.invoices.size).toBe(4);
    expect(memory.estimates.size).toBe(2);
    const expected = sourceSide(await transform(snapshot, servicetitanReports, new CountingSink()));
    const reading = await readTarget(memory, ledger);
    expect(reconcile(expected, reading.side)).toMatchObject({ matched: true });
  });
});
