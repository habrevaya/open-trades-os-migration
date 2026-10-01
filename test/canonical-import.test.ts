import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Snapshot } from "../src/snapshot/index.js";
import { servicetitan } from "../src/adapters/servicetitan/index.js";
import { canonicalImport } from "../src/adapters/canonical-import/index.js";
import { adapterFor } from "../src/adapters/registry.js";
import type { SourceAdapter } from "../src/adapters/types.js";
import { transform, MemorySink } from "../src/transform/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "servicetitan");

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "import-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function run(adapter: SourceAdapter, from: string) {
  const snapshot = await Snapshot.open(join(dir, "snapshot"), adapter.id);
  for await (const p of adapter.extract({ dir: from }, snapshot)) if (p.done) await snapshot.complete(p.entity);
  await snapshot.flush();
  const sink = new MemorySink();
  const result = await transform(snapshot, adapter, sink);
  return { snapshot, sink, result };
}

async function exportDir(files: Record<string, string>): Promise<string> {
  const from = join(dir, "export");
  await mkdir(from, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(from, name), body);
  return from;
}

describe("a ServiceTitan snapshot the owner produced", () => {
  it("is resolved by --source servicetitan, and connects to nothing", () => {
    expect(adapterFor("servicetitan")).toBe(servicetitan);
    expect(servicetitan.capabilities.hasApi).toBe(false);
    expect(servicetitan.capabilities.knownLimits.join(" ")).toMatch(/never connects to ServiceTitan/);
  });

  it("imports every entity, NDJSON or a JSON array, and profiles clean", async () => {
    const { sink, result } = await run(servicetitan, FIXTURES);
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({
      customer: 2, property: 2, contact: 1, equipment: 1, recurringSchedule: 1, job: 1, invoice: 1, payment: 1,
    });
    expect(result.profile.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(result.profile.totals).toMatchObject({ invoiceTotal: "344.2400", invoiceBalance: "0.0000", paymentAllocated: "344.2400" });
    // Defaults are applied as the schema states them.
    expect(sink.get("customer").find((c) => c["sourceId"] === "ST-C-5002")).toMatchObject({ paymentTermsDays: 0, tags: [], taxExempt: true });
  });

  it("keeps tax as applied, to the tenth of a cent the source recorded", async () => {
    const { sink } = await run(servicetitan, FIXTURES);
    const line = (sink.get("invoice")[0]!["lines"] as Record<string, unknown>[])[0]!;
    expect(line).toMatchObject({ taxRate: "0.0825", taxAmount: "26.235" });
  });

  it("carries a service agreement with its anchor, next date and exceptions", async () => {
    const { sink } = await run(servicetitan, FIXTURES);
    expect(sink.get("recurringSchedule")[0]).toMatchObject({
      kind: "service-agreement", model: "rule", anchorOn: "2023-03-14", nextOccurrenceOn: "2025-09-14",
      equipmentSourceIds: ["ST-E-9001"], exceptions: [{ on: "2025-03-14", kind: "skipped" }],
    });
  });

  it("refuses a record from another source, so two systems' ids cannot collide in one load", async () => {
    const from = await exportDir({
      "customer.ndjson": JSON.stringify({ sourceSystem: "jobber", sourceId: "1", name: "Ada" }) + "\n",
    });
    const { result } = await run(servicetitan, from);
    expect(result.failures).toEqual([
      { entity: "customer", sourceId: "1", error: 'sourceSystem is "jobber"; every record in a ServiceTitan import must say "servicetitan"' },
    ]);
  });

  it("names the field that failed, and refuses a float where money belongs", async () => {
    const from = await exportDir({
      "customer.ndjson": JSON.stringify({ sourceSystem: "servicetitan", sourceId: "C1", name: "Ada" }) + "\n",
      "invoice.ndjson": [
        JSON.stringify({ sourceSystem: "servicetitan", sourceId: "I1", customerSourceId: "C1", status: "Posted", total: 344.24, balance: "0" }),
        "{not json",
      ].join("\n") + "\n",
    });
    const { result } = await run(servicetitan, from);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ entity: "invoice", sourceId: "I1" });
    expect(result.failures[0]!.error).toMatch(/^total: Expected string, received number/);
    expect(result.failures[1]!.error).toBe("line 2 is not valid JSON");
  });

  it("needs a customer file and nothing else", async () => {
    expect(await servicetitan.verify({ dir: await exportDir({ "job.ndjson": "" }) })).toMatchObject({ ok: false });
    expect(await servicetitan.verify({ dir: FIXTURES })).toMatchObject({ ok: true, account: "servicetitan" });
  });

  it("resumes without importing a record twice", async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ sourceSystem: "x", sourceId: `C${i}`, name: `C ${i}` }));
    const from = await exportDir({ "customer.ndjson": lines.join("\n") + "\n" });
    const out = join(dir, "snapshot");
    const first = await Snapshot.open(out, "canonical");
    for await (const p of canonicalImport.extract({ dir: from }, first)) if (p.entity === "customer" && !p.done) break;
    await first.flush();
    expect(first.info.counts.customer).toBe(500);
    const second = await Snapshot.open(out, "canonical");
    for await (const _ of canonicalImport.extract({ dir: from }, second)) { /* drain */ }
    expect(second.info.counts.customer).toBe(1200);
  });

  it("resolves a relative attachment path against the export directory", async () => {
    const from = join(dir, "export");
    await cp(FIXTURES, from, { recursive: true });
    await writeFile(join(from, "attachment.ndjson"), JSON.stringify({
      sourceSystem: "servicetitan", sourceId: "A1", entityType: "equipment", entitySourceId: "ST-E-9001", localPath: "photos/plate.jpg",
    }) + "\n");
    const { sink } = await run(servicetitan, from);
    expect(sink.get("attachment")[0]!["localPath"]).toBe(join(from, "photos/plate.jpg"));
  });
});
