import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Snapshot } from "../src/snapshot/index.js";
import { csv, renamer } from "../src/adapters/csv/index.js";
import * as map from "../src/adapters/csv/map.js";
import { transform, MemorySink } from "../src/transform/index.js";
import type { EntityName } from "../src/canonical/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "csv");
const settings = map.DEFAULT_SETTINGS;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "csv-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function extract(from: string, out = join(dir, "snapshot")): Promise<{ snapshot: Snapshot; logs: string[] }> {
  const snapshot = await Snapshot.open(out, "csv");
  const logs: string[] = [];
  const ctx = Object.assign(snapshot, { log: (m: string) => { logs.push(m); } });
  for await (const progress of csv.extract({ dir: from }, ctx)) {
    if (progress.done) await snapshot.complete(progress.entity);
  }
  await snapshot.flush();
  return { snapshot, logs };
}

async function canonical(snapshot: Snapshot) {
  const sink = new MemorySink();
  const result = await transform(snapshot, csv, sink);
  return { sink, result };
}

describe("cells", () => {
  it("reads money the way spreadsheets write it", () => {
    expect(map.amount("$1,234.50", settings)).toBe("1234.5000");
    expect(map.amount("(120.00)", settings)).toBe("-120.0000");
    expect(map.amount("12500", { ...settings, cents: true })).toBe("125.0000");
  });

  it("refuses a yes/no it cannot read rather than calling it no", () => {
    expect(map.bool("Y", false)).toBe(true);
    expect(map.bool("", true)).toBe(true);
    expect(() => map.bool("maybe", false)).toThrow(/yes\/no/);
  });

  it("reads slashed dates in the configured order and refuses to guess at anything else", () => {
    expect(map.date("03/04/2024", settings)).toBe("2024-03-04");
    expect(map.date("03/04/2024", { ...settings, dateOrder: "DMY" })).toBe("2024-04-03");
    expect(map.date("3/14/2023 15:41", settings)).toBe("2023-03-14T15:41:00");
    expect(map.date("2023-09-20T14:00:00Z", settings)).toBe("2023-09-20T14:00:00Z");
    expect(() => map.date("14/03/2023", settings)).toThrow(/MDY/);
    expect(() => map.date("next Tuesday", settings)).toThrow(/without guessing/);
  });

  it("reads a 12-hour time and refuses one that cannot be", () => {
    expect(map.date("3/14/2023 3:41 PM", settings)).toBe("2023-03-14T15:41:00");
    expect(map.date("3/14/2023 12:05 am", settings)).toBe("2023-03-14T00:05:00");
    expect(map.date("3/14/2023 12:05 PM", settings)).toBe("2023-03-14T12:05:00");
    expect(() => map.date("3/14/2023 13:41 PM", settings)).toThrow(/12-hour/);
  });

  it("will not read a blank balance as nothing owed", () => {
    expect(() => map.toInvoice({ id: "I-9", customer_id: "C-1", total: "10.00" }, settings)).toThrow(/no balance/);
  });
});

describe("the standard layout", () => {
  it("extracts every file, joining child rows onto their parents", async () => {
    const { snapshot } = await extract(join(FIXTURES, "standard"));
    expect(snapshot.info.counts).toMatchObject({
      user: 2, customer: 3, property: 3, priceBookItem: 2, estimate: 1, job: 2, invoice: 2, payment: 3, attachment: 2,
    });

    const { sink, result } = await canonical(snapshot);
    const invoice = sink.get("invoice").find((i) => i["sourceId"] === "I-1")!;
    expect((invoice["lines"] as unknown[])).toHaveLength(2);
    expect(invoice["issuedOn"]).toBe("2023-09-21");

    const job = sink.get("job").find((j) => j["sourceId"] === "J-1")!;
    // Visits come back in calendar order, not file order.
    expect((job["visits"] as { sourceId: string }[]).map((v) => v.sourceId)).toEqual(["V-1", "V-2"]);

    // The undecidable customer is reported, not loaded as "not tax exempt".
    expect(result.failures).toEqual([{ entity: "customer", sourceId: "C-300", error: 'Not a yes/no value: "maybe"' }]);
  });

  it("carries a property shared by two customers, a split payment and a deposit", async () => {
    const { snapshot } = await extract(join(FIXTURES, "standard"));
    const { sink, result } = await canonical(snapshot);
    expect(sink.get("property").find((p) => p["sourceId"] === "P-2")!["customerSourceIds"]).toEqual(["C-200", "C-100"]);
    expect(result.profile.totals.paymentUnallocated).toBe("500.0000");
    expect(result.profile.totals.invoiceBalance).toBe("-120.0000");
  });

  it("stamps the file settings on every row, so later stages read amounts the same way", async () => {
    const { snapshot } = await extract(join(FIXTURES, "mapped"));
    const rows: Record<string, unknown>[] = [];
    for await (const row of snapshot.records<Record<string, unknown>>("invoice")) rows.push(row);
    expect(rows[0]!["_csv"]).toEqual({ cents: true, dateOrder: "DMY" });
  });

  it("resolves an attachment's path against the export directory", async () => {
    const from = join(dir, "export");
    await mkdir(from);
    await writeFile(join(from, "customers.csv"), "id,name\nC-1,Ada\n");
    await writeFile(join(from, "attachments.csv"), "id,entity_type,entity_id,path\nA-1,customer,C-1,photos/a.jpg\n");
    const { snapshot } = await extract(from);
    const { sink } = await canonical(snapshot);
    expect(sink.get("attachment")[0]!["localPath"]).toBe(join(from, "photos/a.jpg"));
  });
});

describe("equipment, contacts and recurring schedules", () => {
  it("extracts them, with exceptions joined onto their schedule", async () => {
    const { snapshot } = await extract(join(FIXTURES, "standard"));
    expect(snapshot.info.counts).toMatchObject({ contact: 2, equipment: 2, recurringSchedule: 2 });
    const { sink } = await canonical(snapshot);

    const furnace = sink.get("equipment").find((e) => e["sourceId"] === "E-1")!;
    expect(furnace).toMatchObject({
      propertySourceId: "P-1", category: "Furnace", manufacturer: "Carrier", serialNumber: "2419A12345",
      installedOn: "2019-04-02", warrantyPartsExpiresOn: "2029-04-02", warrantyLaborExpiresOn: "2020-04-02",
      attributes: { name: "Attic furnace", "Filter size": "16x25x1" },
    });

    const contact = sink.get("contact").find((c) => c["sourceId"] === "K-1")!;
    expect(contact).toMatchObject({ customerSourceId: "C-200", name: "Marisol Vega", role: "Property Manager", isPrimary: true });

    const plan = sink.get("recurringSchedule").find((r) => r["sourceId"] === "R-1")!;
    expect(plan).toMatchObject({
      kind: "service-agreement", model: "rule", rule: "FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=14",
      intervalUnit: "month", interval: 6, anchorOn: "2023-03-14", nextOccurrenceOn: "2025-09-14",
      price: "189.0000", equipmentSourceIds: ["E-1"], jobSourceIds: ["J-1"],
    });
    expect(plan["exceptions"]).toEqual([
      { on: "2024-09-14", kind: "moved", movedTo: "2024-09-20", notes: "Customer travelling" },
      { on: "2025-03-14", kind: "skipped", movedTo: undefined, notes: "Unit replaced under warranty" },
    ]);
  });

  it("derives a stable id for equipment exported without one", async () => {
    const { snapshot } = await extract(join(FIXTURES, "standard"));
    const { sink } = await canonical(snapshot);
    const valve = sink.get("equipment").find((e) => e["propertySourceId"] === "P-3")!;
    expect(valve["sourceId"]).toBe("derived:p-3|backflow preventer|watts|lf009m2-qt||");
    expect(map.equipmentId({ property_id: "P-3", category: "Backflow preventer", manufacturer: "Watts", model: "LF009M2-QT" }))
      .toBe(valve["sourceId"]);
  });

  it("reports a schedule with nothing to anchor it and no next date", async () => {
    const { snapshot } = await extract(join(FIXTURES, "standard"));
    const { result } = await canonical(snapshot);
    const codes = result.profile.findings.map((f) => f.code);
    expect(result.profile.findings.find((f) => f.code === "recurringSchedule.no_anchor")?.sample).toEqual(["R-2"]);
    expect(codes).toContain("recurringSchedule.no_next_occurrence");
    expect(codes).not.toContain("equipment.orphan_property");
  });

  it("refuses a schedule that does not say which recurrence model it is", () => {
    // Choosing the model is the decision docs/recurring-schedules.md says an
    // adapter must never make silently.
    expect(() => map.toRecurringSchedule({ id: "R-9", customer_id: "C-1" }, settings)).toThrow(/no model/);
    expect(() => map.toRecurringSchedule({ id: "R-9", customer_id: "C-1", model: "weekly-ish" }, settings)).toThrow(/must be one of/);
  });
});

describe("a mapped export", () => {
  it("renames headers, and one header may feed two columns", () => {
    const rename = renamer({ files: { properties: { columns: { id: "Customer #", customer_id: "Customer #", line1: "Street" } } } }, "properties");
    expect(rename({ "Customer #": "FE-1", Street: "77 Ranch Rd", Other: "x" }))
      .toEqual({ id: "FE-1", customer_id: "FE-1", line1: "77 Ranch Rd", Other: "x" });
  });

  it("reads one export file as both customers and properties, in cents, with semicolons", async () => {
    const { snapshot } = await extract(join(FIXTURES, "mapped"));
    const { sink, result } = await canonical(snapshot);
    expect(result.failures).toEqual([]);
    expect(sink.get("customer").map((c) => c["name"])).toEqual(["Hill Country Dental", "Maple Street HOA"]);
    expect(sink.get("property")[0]).toMatchObject({ sourceId: "FE-1", customerSourceIds: ["FE-1"], city: "Dripping Springs" });
    expect(sink.get("invoice")[0]).toMatchObject({ total: "125.0000", balance: "125.0000", issuedOn: "2024-03-04" });
  });
});

describe("extraction", () => {
  async function write(files: Record<string, string>): Promise<string> {
    const from = join(dir, "export");
    await mkdir(from, { recursive: true });
    for (const [name, body] of Object.entries(files)) await writeFile(join(from, name), body);
    return from;
  }

  it("needs a customer file and nothing else", async () => {
    expect(await csv.verify({ dir: await write({ "jobs.csv": "id\n" }) })).toMatchObject({ ok: false });
    expect(await csv.verify({ dir: await write({ "customers.csv": "id,name\n" }) })).toMatchObject({ ok: true, account: "export" });
  });

  it("says out loud when a child row names a parent that was not exported", async () => {
    const from = await write({
      "customers.csv": "id,name\nC-1,Ada\n",
      "invoices.csv": "id,customer_id,total,balance\nI-1,C-1,10,0\n",
      "invoice_lines.csv": "invoice_id,name,unit_price\nI-1,Labor,10\nI-404,Ghost,99\n",
    });
    const { logs } = await extract(from);
    expect(logs).toContain("invoice_lines: 1 row(s) name a invoice that is not in invoices.csv");
  });

  it("resumes without appending a row twice", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => `C-${i},Customer ${i}`).join("\n");
    const from = await write({ "customers.csv": `id,name\n${rows}\n` });
    const out = join(dir, "snapshot");

    // Stop after the first batch is checkpointed, as a killed run would.
    const first = await Snapshot.open(out, "csv");
    for await (const progress of csv.extract({ dir: from }, first)) {
      if (progress.entity === "customer" && !progress.done) break;
    }
    await first.flush();
    expect(first.info.counts.customer).toBe(500);

    const { snapshot } = await extract(from, out);
    expect(snapshot.info.counts.customer).toBe(1200);
    const ids = new Set<string>();
    for await (const row of snapshot.records<{ id: string }>("customer" as EntityName)) ids.add(row.id);
    expect(ids.size).toBe(1200);
  });
});
