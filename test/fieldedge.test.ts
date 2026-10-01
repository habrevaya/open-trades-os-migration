import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Snapshot } from "../src/snapshot/index.js";
import { fieldedge, FIELDEDGE_COLUMNS } from "../src/adapters/fieldedge/index.js";
import { mergeConfig } from "../src/adapters/csv/index.js";
import { transform, MemorySink } from "../src/transform/index.js";
import * as money from "../src/money/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fieldedge");

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "fe-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function run(from: string) {
  const snapshot = await Snapshot.open(join(dir, "snapshot"), "fieldedge");
  const logs: string[] = [];
  const ctx = Object.assign(snapshot, { log: (m: string) => { logs.push(m); } });
  for await (const p of fieldedge.extract({ dir: from }, ctx)) if (p.done) await snapshot.complete(p.entity);
  await snapshot.flush();
  const sink = new MemorySink();
  const result = await transform(snapshot, fieldedge, sink);
  return { snapshot, sink, result, logs };
}

describe("FieldEdge's five exports", () => {
  it("finds the customer list by FieldEdge's own file name", async () => {
    expect(await fieldedge.verify({ dir: FIXTURES })).toMatchObject({ ok: true });
  });

  it("reads every report into the canonical model with nothing unreadable and no orphan", async () => {
    const { sink, result } = await run(FIXTURES);
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({ customer: 3, property: 3, equipment: 2, estimate: 1, job: 2, invoice: 2 });
    expect(result.profile.findings.filter((f) => f.code.endsWith("orphan_customer") || f.code.endsWith("orphan_property"))).toEqual([]);
    expect(sink.get("customer").every((c) => c["sourceSystem"] === "fieldedge")).toBe(true);
  });

  it("joins customers across reports by name, the only key the exports share", async () => {
    const { sink } = await run(FIXTURES);
    const job = sink.get("job").find((j) => j["sourceId"] === "10421")!;
    expect(job).toMatchObject({ customerSourceId: "Whitfield, Dana", propertySourceId: "Whitfield, Dana", summary: "Spring tune-up (1:00)" });
    expect(sink.get("property").find((p) => p["sourceId"] === "Brazos Property Group")).toMatchObject({
      addressLine1: "900 Congress Ave", addressLine2: "Suite 400", postalCode: "78701",
    });
  });

  it("reads the dispatch time as written, 12-hour clock included", async () => {
    const { sink } = await run(FIXTURES);
    const job = sink.get("job").find((j) => j["sourceId"] === "10422")!;
    expect((job["visits"] as { windowStart: string; technicianSourceIds: string[] }[])[0]).toMatchObject({
      windowStart: "2026-10-02T13:30:00", technicianSourceIds: ["Nia Osei"],
    });
    // Columns whose format is undocumented are carried, not interpreted.
    expect(sink.get("job").find((j) => j["sourceId"] === "10421")!["customFields"]).toMatchObject({
      Complete: "3/14/2024 10:41 AM", Arrival: "3/14/2024 9:12 AM",
    });
  });

  it("reads invoice money exactly, with the Due column as the balance", async () => {
    const { sink, result } = await run(FIXTURES);
    expect(sink.get("invoice").find((i) => i["sourceId"] === "INV-5490")).toMatchObject({
      total: "1234.5600", balance: "185.1000", issuedOn: "2024-01-09", dueOn: "2024-02-08", jobSourceId: "10388",
    });
    expect(result.profile.totals.invoiceTotal).toBe(money.add("344.24", "1234.56"));
    expect(result.profile.totals.invoiceBalance).toBe("185.1000");
  });

  it("carries equipment with serials, and warranty columns as text until their meaning is known", async () => {
    const { sink } = await run(FIXTURES);
    const condenser = sink.get("equipment").find((e) => e["serialNumber"] === "3019E54321")!;
    expect(condenser).toMatchObject({
      propertySourceId: "Whitfield, Dana", category: "Air Conditioner", manufacturer: "Carrier",
      model: "24ACC636A003", installedOn: "2019-04-02",
      attributes: { name: "Condenser", "Parts warranty": "10 years", "Labor warranty": "1 year", "Replace date": "4/2/2034" },
    });
    expect(condenser["warrantyPartsExpiresOn"]).toBeUndefined();
    expect(condenser["sourceId"]).toBe("derived:whitfield, dana|air conditioner|carrier|24acc636a003|3019e54321|");
  });

  it("lets the operator's columns.json map a column the preset leaves alone", async () => {
    const from = join(dir, "export");
    await cp(FIXTURES, from, { recursive: true });
    await writeFile(join(from, "EquipmentList.csv"),
      "Customer,Equip. Name,Manufacturer,Model,Serial #,Equip. Type,Install,Parts Warranty,Labor Warranty\n" +
      "\"Whitfield, Dana\",Attic furnace,Carrier,59SC5A060E17,2419A12345,Furnace,4/2/2019,4/2/2029,4/2/2020\n");
    await writeFile(join(from, "columns.json"), JSON.stringify({
      files: { equipment: { columns: { warranty_parts_expires_on: "Parts Warranty", warranty_labor_expires_on: "Labor Warranty" } } },
    }));
    const { sink } = await run(from);
    expect(sink.get("equipment")[0]).toMatchObject({
      warrantyPartsExpiresOn: "2029-04-02", warrantyLaborExpiresOn: "2020-04-02", serialNumber: "2419A12345",
    });
  });

  it("merges an override into the preset column by column", () => {
    const merged = mergeConfig(FIELDEDGE_COLUMNS, { files: { customers: { columns: { email: "E-mail" } } }, dateOrder: "DMY" });
    expect(merged.files?.["customers"]?.file).toBe("CustomerList.csv");
    expect(merged.files?.["customers"]?.columns).toMatchObject({ email: "E-mail", name: "Name" });
    expect(merged.dateOrder).toBe("DMY");
  });

  it("lists what the exports cannot carry", () => {
    const fields = fieldedge.capabilities.unsupported?.map((u) => u.field) ?? [];
    expect(fields).toContain("payments");
    expect(fields).toContain("Parts Warranty, Labor Warranty");
  });
});
