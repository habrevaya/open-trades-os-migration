import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, rm as remove } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Snapshot } from "../src/snapshot/index.js";
import { servicetitan } from "../src/adapters/servicetitan/index.js";
import { canonicalImport } from "../src/adapters/canonical-import/index.js";
import { jobber } from "../src/adapters/jobber/index.js";
import type { SourceAdapter } from "../src/adapters/types.js";
import { transform, CountingSink } from "../src/transform/index.js";
import { buildMapping, type Mapping } from "../src/mapping/index.js";
import { load, failures } from "../src/load/index.js";
import { Ledger } from "../src/load/ledger.js";
import { MemoryTarget, withoutPermissions } from "../src/target/memory.js";
import { TargetError, type Target } from "../src/target/client.js";
import { readTarget } from "../src/target/read.js";
import { reconcile, sourceSide } from "../src/reconcile/index.js";
import type { EntityName } from "../src/canonical/index.js";
import { load as fixture } from "./fixtures.js";
import { readFileSync } from "node:fs";
import { GAPS, type GapCode } from "../src/load/gaps.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "servicetitan");
/** The day these tests run on, so the fixtures' dates stay history and their schedules stay running. */
const NOW = new Date("2025-06-01T15:00:00Z");
const today = () => NOW;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "history-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function extracted(adapter: SourceAdapter, from: string): Promise<Snapshot> {
  const snapshot = await Snapshot.open(join(dir, `snapshot-${randomUUID()}`), adapter.id);
  for await (const p of adapter.extract({ dir: from }, snapshot)) if (p.done) await snapshot.complete(p.entity);
  await snapshot.flush();
  return snapshot;
}

/** A canonical import from records written here, one file per entity. */
async function canonical(files: Partial<Record<EntityName, Record<string, unknown>[]>>): Promise<Snapshot> {
  const from = join(dir, `export-${randomUUID()}`);
  await mkdir(from, { recursive: true });
  for (const [entity, records] of Object.entries(files)) {
    await writeFile(join(from, `${entity}.ndjson`), records!.map((r) => JSON.stringify({ sourceSystem: "legacy", ...r })).join("\n") + "\n");
  }
  return extracted(canonicalImport, from);
}

async function jobberSnapshot(): Promise<Snapshot> {
  const snapshot = await Snapshot.open(join(dir, `jobber-${randomUUID()}`), "jobber");
  const files: [EntityName, string][] = [
    ["user", "users"], ["priceBookItem", "products"], ["customer", "clients"], ["property", "properties"],
    ["estimate", "quotes"], ["job", "jobs"], ["invoice", "invoices"], ["payment", "payments"],
  ];
  for (const [entity, file] of files) await snapshot.append(entity, fixture("jobber", file));
  await snapshot.flush();
  return snapshot;
}

const BASE = {
  customer: [{ sourceId: "C-1", name: "Dana Whitfield" }],
  property: [{ sourceId: "P-1", customerSourceIds: ["C-1"], addressLine1: "4102 Ramsey Ave", city: "Austin", state: "TX", postalCode: "78756" }],
};

async function mappingFor(snapshot: Snapshot, adapter: SourceAdapter): Promise<Mapping> {
  return (await buildMapping(snapshot, adapter)).mapping;
}

function fingerprint(memory: MemoryTarget) {
  return {
    customers: memory.customers.size, properties: memory.properties.size, items: memory.items.size,
    jobs: [...memory.jobs.values()].map((j) => `${j.number}|${j.status}|${j.visits.length}`).sort(),
    estimates: memory.estimates.size,
    invoices: [...memory.invoices.values()].map((i) => `${i.number}|${i.total}|${i.balance}|${i.status}`).sort(),
    payments: [...memory.payments.values()].map((p) => `${p.amount}|${p.unappliedAmount}`).sort(),
  };
}

describe("a migrated company keeps its history", () => {
  it("loads a ServiceTitan snapshot with its numbers, dates, tax as charged and schedule", async () => {
    const snapshot = await extracted(servicetitan, FIXTURES);
    const memory = new MemoryTarget({ today });
    const ledger = Ledger.memory("t", "servicetitan");
    const report = await load({ snapshot, adapter: servicetitan, target: memory, ledger, mapping: await mappingFor(snapshot, servicetitan), now: NOW });
    expect(report.aborted).toBeUndefined();
    expect(failures(report)).toBe(0);

    const invoice = memory.invoices.get(ledger.get("invoice:ST-I-66001")!)!;
    expect(invoice).toMatchObject({ number: 66001, issuedOn: "2024-03-14", taxTotal: "26.2400", total: "344.2400", balance: "0.0000", status: "paid" });
    // The tenth of a cent ServiceTitan recorded on the line is the line's.
    expect(invoice.lines[0]).toMatchObject({ taxRate: "0.0825", taxAmount: "26.2400" });

    const job = memory.jobs.get(ledger.get("job:ST-J-88001")!)!;
    expect(job.number).toBe(88001);
    expect(job.completedAt).toBe("2024-03-14T15:41:00.000Z");
    const payment = memory.payments.get(ledger.get("payment:ST-P-4401")!)!;
    expect(payment.receivedAt).toBe("2024-03-14T16:02:00.000Z");

    // Every 6 months is March and September; the target pins to the 15th,
    // and the next one is where the source said, not 2023 replayed.
    const schedule = memory.schedules.get(ledger.get("recurringSchedule:ST-M-301")!)!;
    expect(schedule).toMatchObject({ model: "rule", anchorMonths: [3, 9], startsOn: "2025-09-14", endsOn: "2026-03-13", active: true });
    expect(schedule.exceptions).toEqual([{ date: "2025-03-14", action: "skipped", reason: "Unit replaced under warranty" }]);
    expect(Object.keys(report.gaps)).toEqual(expect.arrayContaining([
      "recurring.agreement_terms", "recurring.assignment", "recurring.anchor_day", "contact.create", "equipment.create",
    ]));
    expect(report.entities.contact).toMatchObject({ skipped: 1 });
    // Nothing is ever counted against a gap the core has closed.
    expect((Object.keys(report.gaps) as GapCode[]).filter((code) => GAPS[code].status === "closed")).toEqual([]);
    expect(report.entities.equipment).toMatchObject({ skipped: 1 });

    // And it reconciles, the schedule counted.
    const expected = sourceSide(await transform(snapshot, servicetitan, new CountingSink()));
    const reading = await readTarget(memory, ledger);
    expect(reconcile(expected, reading.side)).toMatchObject({ matched: true });
    expect(reading.side.counts.recurringSchedule).toBe(1);
  });

  it("records cancelled and untimed visits, and completes a job at the time it was finished", async () => {
    const snapshot = await canonical({
      ...BASE,
      job: [
        {
          sourceId: "J-1", customerSourceId: "C-1", propertySourceId: "P-1", status: "active", summary: "Install",
          visits: [
            { sourceId: "V-1", sequence: 1, windowStart: "2024-02-01T15:00:00Z", windowEnd: "2024-02-01T17:00:00Z", status: "cancelled" },
            { sourceId: "V-2", sequence: 2, status: "unscheduled" },
            { sourceId: "V-3", sequence: 3, windowStart: "2024-02-03T15:00:00Z", windowEnd: "2024-02-03T17:00:00Z", status: "scheduled" },
          ],
        },
        { sourceId: "J-2", customerSourceId: "C-1", propertySourceId: "P-1", status: "completed", summary: "Quote follow up", completedAt: "2023-05-05T20:00:00Z" },
      ],
    });
    const memory = new MemoryTarget({ today });
    const ledger = Ledger.memory("t", "canonical");
    const report = await load({ snapshot, adapter: canonicalImport, target: memory, ledger, mapping: await mappingFor(snapshot, canonicalImport), now: NOW });
    expect(report.aborted).toBeUndefined();

    const job = memory.jobs.get(ledger.get("job:J-1")!)!;
    expect(job.visits.map((v) => [v.status, v.windowStart])).toEqual([
      ["cancelled", "2024-02-01T15:00:00.000Z"], ["unassigned", null], ["unassigned", "2024-02-03T15:00:00.000Z"],
    ]);
    expect(job.visits.map((v) => v.externalRef?.id)).toEqual(["J-1#V-1", "J-1#V-2", "J-1#V-3"]);
    expect(report.gaps).not.toHaveProperty("visit.cancelled");

    const finished = memory.jobs.get(ledger.get("job:J-2")!)!;
    expect(finished).toMatchObject({ status: "completed", completedAt: "2023-05-05T20:00:00.000Z" });
  });

  it("holds a deposit for the customer and records a refund against the payment it gave back", async () => {
    const snapshot = await canonical({
      ...BASE,
      invoice: [{ sourceId: "I-1", customerSourceId: "C-1", number: 501, status: "paid", issuedOn: "2024-01-10", subtotal: "200", total: "200", lines: [{ name: "Repair", unitPrice: "200", lineTotal: "200" }] }],
      payment: [
        { sourceId: "PAY-1", customerSourceId: "C-1", method: "check", status: "completed", amount: "200", receivedAt: "2024-01-12", allocations: [{ invoiceSourceId: "I-1", amount: "200" }] },
        { sourceId: "PAY-2", customerSourceId: "C-1", method: "cash", status: "completed", amount: "75", receivedAt: "2024-02-01", allocations: [] },
        { sourceId: "REF-1", customerSourceId: "C-1", method: "check", status: "completed", amount: "-50", receivedAt: "2024-01-20", allocations: [{ invoiceSourceId: "I-1", amount: "-50" }] },
      ],
    });
    const memory = new MemoryTarget({ today });
    const ledger = Ledger.memory("t", "canonical");
    const report = await load({ snapshot, adapter: canonicalImport, target: memory, ledger, mapping: await mappingFor(snapshot, canonicalImport), now: NOW });
    expect(report.aborted).toBeUndefined();
    expect(report.entities.payment).toMatchObject({ created: 3 });

    const deposit = memory.payments.get(ledger.get("payment:PAY-2")!)!;
    expect(deposit).toMatchObject({ allocations: [], unappliedAmount: "75.0000" });
    const paid = memory.payments.get(ledger.get("payment:PAY-1")!)!;
    expect(paid).toMatchObject({ refundedAmount: "50.0000", status: "partially_refunded" });
    expect(ledger.get("payment:REF-1")).toBe(paid.id);
    // The cheque refund reopens the invoice by what went back.
    expect(memory.invoices.get(ledger.get("invoice:I-1")!)).toMatchObject({ amountPaid: "150.0000", balance: "50.0000" });

    const expected = sourceSide(await transform(snapshot, canonicalImport, new CountingSink()));
    const reading = await readTarget(memory, ledger);
    expect(reading.side.paymentTotal).toBe(expected.paymentTotal);
    expect(reading.side.counts.payment).toBe(3);
  });

  it("does not guess which payment a refund gave back", async () => {
    const pay = (id: string) => ({ sourceId: id, customerSourceId: "C-1", method: "card", status: "completed", amount: "100", receivedAt: "2024-01-12", allocations: [] });
    const snapshot = await canonical({
      ...BASE,
      payment: [pay("PAY-1"), pay("PAY-2"), { ...pay("REF-1"), amount: "-40", receivedAt: "2024-03-01" }],
    });
    const report = await load({
      snapshot, adapter: canonicalImport, target: new MemoryTarget({ today }), ledger: Ledger.memory("t", "canonical"),
      mapping: await mappingFor(snapshot, canonicalImport), now: NOW,
    });
    expect(report.problems).toContainEqual(expect.objectContaining({
      sourceId: "REF-1", outcome: "skipped", reason: expect.stringContaining("any of 2 loaded payments"),
    }));
    expect(report.gaps["payment.refund"]?.count).toBe(1);
  });

  it("gives a document whose number is taken the next one, and says so", async () => {
    const snapshot = await canonical({
      ...BASE,
      invoice: [{ sourceId: "I-1", customerSourceId: "C-1", number: 1001, status: "open", issuedOn: "2024-01-10", total: "10", lines: [{ name: "A", unitPrice: "10", lineTotal: "10" }] }],
    });
    const memory = new MemoryTarget({ today });
    const ledger = Ledger.memory("t", "canonical");
    // The company invoiced here before migrating: 1001 is in use.
    memory.invoices.set("x", { number: 1001 } as never);
    const report = await load({ snapshot, adapter: canonicalImport, target: memory, ledger, mapping: await mappingFor(snapshot, canonicalImport), now: NOW });
    expect(memory.invoices.get(ledger.get("invoice:I-1")!)?.number).toBe(1002);
    expect(report.gaps["document.number_taken"]?.count).toBe(1);
  });

  it("starts a repeating schedule at its next occurrence, and pauses one whose visits are already loaded", async () => {
    const snapshot = await canonical({
      ...BASE,
      recurringSchedule: [
        { sourceId: "R-1", model: "rule", customerSourceId: "C-1", propertySourceId: "P-1", name: "Pool", status: "active", intervalUnit: "week", interval: 1, startsOn: "2021-01-04" },
        { sourceId: "R-2", model: "anchored-to-completion", customerSourceId: "C-1", propertySourceId: "P-1", name: "Pest", status: "active", intervalUnit: "day", interval: 90, anchorOn: "2025-04-20", jobSourceIds: ["J-9"] },
        { sourceId: "R-3", model: "rule", customerSourceId: "C-1", propertySourceId: "P-1", name: "Old", status: "cancelled", intervalUnit: "week", interval: 2 },
        { sourceId: "R-4", model: "rule", customerSourceId: "C-1", propertySourceId: "P-1", name: "Odd", status: "active", intervalUnit: "month", interval: 5, startsOn: "2024-01-01" },
      ],
    });
    const memory = new MemoryTarget({ today });
    const ledger = Ledger.memory("t", "canonical");
    const mapping = await mappingFor(snapshot, canonicalImport);
    const report = await load({ snapshot, adapter: canonicalImport, target: memory, ledger, mapping, now: NOW });

    // Weekly since a Monday in 2021: the first Monday from today, not 230 past visits.
    expect(memory.schedules.get(ledger.get("recurringSchedule:R-1")!)).toMatchObject({ startsOn: "2025-06-02", intervalDays: 7, active: true });
    expect(memory.schedules.get(ledger.get("recurringSchedule:R-2")!)).toMatchObject({
      model: "anchored_to_completion", lastOccurredOn: "2025-04-20", nextDueOn: "2025-07-19", active: false,
    });
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "R-3", outcome: "skipped" }),
      expect.objectContaining({ sourceId: "R-4", outcome: "skipped" }),
    ]));
    expect(Object.keys(report.gaps)).toEqual(expect.arrayContaining(["recurring.inactive", "recurring.rule", "recurring.occurrences"]));

    // The target reads no key on this route; a schedule a crashed run made is found, not made twice.
    const again = await load({ snapshot, adapter: canonicalImport, target: memory, ledger: Ledger.memory("t", "canonical"), mapping, now: NOW });
    expect(again.entities.recurringSchedule).toMatchObject({ created: 0, already: 2 });
    expect(memory.schedules.size).toBe(2);
  });
});

describe("the import permission", () => {
  it("stops before the first write when the token may not record history, and says what to do", async () => {
    const snapshot = await jobberSnapshot();
    const memory = new MemoryTarget({ permissions: withoutPermissions("data:import") });
    const report = await load({ snapshot, adapter: jobber, target: memory, ledger: Ledger.memory("t", "jobber"), mapping: await mappingFor(snapshot, jobber) });
    expect(report.aborted).toMatch(/missing permission: data:import\..*only an owner can give it/);
    expect(memory.customers.size).toBe(0);
    expect(memory.invoices.size).toBe(0);
    expect([...memory.calls.keys()]).toEqual(["getAppSelf"]);
  });

  it("asks by reading, every run, and a token that loses it mid-migration is stopped by name", async () => {
    const snapshot = await jobberSnapshot();
    const mapping = await mappingFor(snapshot, jobber);
    const ledger = Ledger.memory("t", "jobber");
    const memory = new MemoryTarget();
    const first = await load({ snapshot, adapter: jobber, target: memory, ledger, mapping });
    // No probe: every invoice created is one the snapshot holds.
    expect(memory.calls.get("createInvoice")).toBe(first.entities.invoice?.created);
    expect(memory.invoices.size).toBe(first.entities.invoice?.created);
    await load({ snapshot, adapter: jobber, target: memory, ledger, mapping });
    expect(memory.calls.get("getAppSelf")).toBe(2);

    // Skip the check on a fresh ledger, against a token without it: the
    // first historical write is refused and the run stops, naming why.
    const refused = await load({
      snapshot, adapter: jobber, target: new MemoryTarget({ permissions: withoutPermissions("data:import") }),
      ledger: Ledger.memory("u", "jobber"), mapping, preflight: false,
    });
    expect(refused.aborted).toContain("data:import");
  });

  it("is the target's rule: a week back is ordinary, older is history, the future and a closed period are refused", async () => {
    const memory = new MemoryTarget({ today, permissions: withoutPermissions("data:import"), closedThrough: "2025-03-31" });
    const customer = await memory.call("createCustomer", { name: "A" });
    const pay = (receivedAt: string) => memory.call("recordPayment", { customerId: customer.id, method: "cash", amount: "1", receivedAt, allocations: [] });
    await expect(pay("2025-05-28T12:00:00Z")).resolves.toMatchObject({ unappliedAmount: "1.0000" });
    await expect(pay("2025-05-01T12:00:00Z")).rejects.toMatchObject({ status: 403, message: "Missing permission: data:import" });
    await expect(pay("2025-06-03T12:00:00Z")).rejects.toMatchObject({ status: 422 });

    const owner = new MemoryTarget({ today, closedThrough: "2025-03-31" });
    const c = await owner.call("createCustomer", { name: "A" });
    await expect(owner.call("recordPayment", { customerId: c.id, method: "cash", amount: "1", receivedAt: "2025-03-01T12:00:00Z", allocations: [] }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("closed through 2025-03-31") });
    await expect(owner.call("createInvoice", { customerId: c.id, lines: [{ name: "A", unitPrice: "1", taxRate: "0.1", taxAmount: "0.5" }] }))
      .rejects.toMatchObject({ status: 422, issues: [expect.objectContaining({ path: "lines.0.taxAmount" })] });
    await expect(owner.call("createInvoice", { customerId: c.id, lines: [{ name: "A", unitPrice: "1" }], expectedTotals: { total: "2" } }))
      .rejects.toMatchObject({ status: 422, issues: [expect.objectContaining({ path: "expectedTotals.total" })] });
  });
});

describe("finding what was loaded, by where it came from", () => {
  it("rebuilds a lost ledger from the target and sends nothing twice", async () => {
    const snapshot = await jobberSnapshot();
    const mapping = await mappingFor(snapshot, jobber);
    const memory = new MemoryTarget();
    const path = join(dir, "ledger.ndjson");
    await load({ snapshot, adapter: jobber, target: memory, mapping, ledger: await Ledger.open(path, "t", "jobber") });
    const before = fingerprint(memory);
    const writes = () => [...memory.calls.entries()].filter(([n]) => !/^(list|get)/.test(n)).reduce((a, [, n]) => a + n, 0);
    const written = writes();

    await remove(path);
    const ledger = await Ledger.open(path, "t", "jobber");
    const report = await load({ snapshot, adapter: jobber, target: memory, mapping, ledger, rebuild: true });

    expect(report.rebuilt).toMatchObject({ customer: 3, property: 2, priceBookItem: 2, job: 1, estimate: 2, invoice: 2, payment: 2 });
    expect(fingerprint(memory)).toEqual(before);
    // Asking what the token may do is a read; nothing is written.
    expect(writes() - written).toBe(0);
    expect(report.entities.customer).toMatchObject({ created: 0, already: 3 });
    // Visits are found again on their job, by externalRef.
    const job = [...memory.jobs.values()][0]!;
    expect(job.visits.map((v) => ledger.get(`job:Z2lkOi8vSm9iYmVyL0pvYi8xMDE=#visit:${v.externalRef!.id.split("#")[1]}`))).toEqual(job.visits.map((v) => v.id));
  });

  it("adopts the record a 409 names when the target has no record of the key", async () => {
    const snapshot = await jobberSnapshot();
    const mapping = await mappingFor(snapshot, jobber);
    const memory = new MemoryTarget();
    await load({ snapshot, adapter: jobber, target: memory, mapping, ledger: Ledger.memory("t", "jobber") });
    const before = fingerprint(memory);

    // A target that forgot every key (or a run under keys it never saw).
    const forgetful: Target = { description: "forgetful", call: (name, input) => memory.call(name, input, {}) };
    const report = await load({ snapshot, adapter: jobber, target: forgetful, mapping, ledger: Ledger.memory("t", "jobber") });
    expect(report.aborted).toBeUndefined();
    expect(fingerprint(memory)).toEqual(before);
    expect(report.entities.invoice).toMatchObject({ created: 0, already: 2 });
    expect(report.entities.payment).toMatchObject({ created: 0, already: 2 });
  });

  it("stops before the first write when the token could not see what it made, which is a scope narrower than all", async () => {
    const snapshot = await jobberSnapshot();
    const memory = new MemoryTarget({ scopes: { customer: "own", invoice: "crew" } });
    const report = await load({ snapshot, adapter: jobber, target: memory, mapping: await mappingFor(snapshot, jobber), ledger: Ledger.memory("t", "jobber"), concurrency: 1 });
    expect(report.aborted).toMatch(/scope narrower than "all" on: customer \(own\), invoice \(crew\)/);
    expect(memory.customers.size).toBe(0);
  });

  it("names the source every record is sent under, stable for an account", () => {
    expect(Ledger.memory("t", "housecall-pro", "acct").externalSource).toMatch(/^housecall-pro\.[0-9a-f]{8}$/);
    expect(Ledger.memory("t", "csv", "a").externalSource).not.toBe(Ledger.memory("t", "csv", "b").externalSource);
    expect(() => new TargetError(409, "x")).not.toThrow();
  });
});

describe("the list of gaps", () => {
  it("is the same list in the code and in docs/target-api-gaps.md, each closed one saying what closed it", () => {
    const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "target-api-gaps.md"), "utf8");
    for (const [code, gap] of Object.entries(GAPS)) {
      const named = doc.includes(`\`${code}\``) || (code.startsWith("recurring.") && doc.includes("`recurring.*`"));
      expect(named, code).toBe(true);
      if (gap.status !== "open") expect((gap as { now?: string }).now, code).toBeTruthy();
    }
  });
});
