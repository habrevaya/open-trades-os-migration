import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Snapshot } from "../src/snapshot/index.js";
import { jobber } from "../src/adapters/jobber/index.js";
import { housecallPro } from "../src/adapters/housecall-pro/index.js";
import { transform, CountingSink } from "../src/transform/index.js";
import { buildMapping, type Mapping } from "../src/mapping/index.js";
import { load, renderLoad, failures, type LoadReport } from "../src/load/index.js";
import { Ledger, LedgerMismatchError } from "../src/load/ledger.js";
import { HttpTarget, TargetError, type Target, type CallOptions } from "../src/target/client.js";
import { MemoryTarget } from "../src/target/memory.js";
import { readTarget } from "../src/target/read.js";
import { reconcile, sourceSide } from "../src/reconcile/index.js";
import type { RouteName, InputOf, OutputOf } from "../src/target/contracts.js";
import type { RetryPolicy } from "../src/adapters/http.js";
import type { EntityName } from "../src/canonical/index.js";
import { load as fixture } from "./fixtures.js";
import { startFakeTarget, TOKEN, type FakeTarget } from "./fake-target.js";

const CLIENT_1 = "Z2lkOi8vSm9iYmVyL0NsaWVudC8x";
const CLIENT_2 = "Z2lkOi8vSm9iYmVyL0NsaWVudC8y";
const PROPERTY_11 = "Z2lkOi8vSm9iYmVyL1Byb3BlcnR5LzEx";
const JOB_101 = "Z2lkOi8vSm9iYmVyL0pvYi8xMDE=";
const JOB_102 = "Z2lkOi8vSm9iYmVyL0pvYi8xMDI=";
const INVOICE_501 = "Z2lkOi8vSm9iYmVyL0ludm9pY2UvNTAx";
const INVOICE_502 = "Z2lkOi8vSm9iYmVyL0ludm9pY2UvNTAy";
const RAY = randomUUID();
const NIA = randomUUID();

let dir: string;
let fake: FakeTarget | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "load-")); });
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function jobberSnapshot(): Promise<Snapshot> {
  const snapshot = await Snapshot.open(join(dir, "snapshot"), "jobber");
  const files: [EntityName, string][] = [
    ["user", "users"], ["priceBookItem", "products"], ["customer", "clients"], ["property", "properties"],
    ["estimate", "quotes"], ["job", "jobs"], ["invoice", "invoices"], ["payment", "payments"],
  ];
  for (const [entity, file] of files) await snapshot.append(entity, fixture("jobber", file));
  await snapshot.flush();
  return snapshot;
}

async function hcpSnapshot(): Promise<Snapshot> {
  const snapshot = await Snapshot.open(join(dir, "hcp"), "housecall-pro");
  const files: [EntityName, string][] = [
    ["user", "employees"], ["customer", "customers"], ["estimate", "estimates"], ["job", "jobs"], ["invoice", "invoices"],
  ];
  for (const [entity, file] of files) await snapshot.append(entity, fixture("housecall-pro", file));
  await snapshot.flush();
  return snapshot;
}

async function mappingFor(snapshot: Snapshot, adapter = jobber): Promise<Mapping> {
  const { mapping } = await buildMapping(snapshot, adapter);
  if (mapping.users["u-1"]) mapping.users["u-1"].target = RAY;
  if (mapping.users["u-2"]) mapping.users["u-2"].target = NIA;
  return mapping;
}

function quietRetry(delays: number[] = []): RetryPolicy {
  return { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, sleep: async (ms) => { delays.push(ms); } };
}

const ledgerPath = () => join(dir, "ledger.ndjson");

/**
 * What a target holds, reduced to the facts a duplicate or a skip would
 * change. Two loads that end in the same fingerprint left the target in the
 * same state, whatever ids they were given.
 */
function fingerprint(memory: MemoryTarget) {
  return {
    customers: [...memory.customers.values()].map((c) => c["name"]).sort(),
    properties: memory.properties.size,
    links: [...memory.properties.values()].reduce((n, p) => n + p.customers.length, 0),
    items: [...memory.items.values()].map((i) => i["code"]).sort(),
    jobs: [...memory.jobs.values()].map((j) => ({
      summary: j.summary, status: j.status,
      visits: j.visits.map((v) => `${v.windowStart}|${v.status}|${v.completedAt ?? ""}`).sort(),
    })).sort((a, b) => a.summary.localeCompare(b.summary)),
    estimates: [...memory.estimates.values()].map((e) => `${String(e["title"])}|${String(e["status"])}`).sort(),
    invoices: [...memory.invoices.values()].map((i) => `${i.memo}|${i.total}|${i.balance}|${i.status}`).sort(),
    payments: [...memory.payments.values()].map((p) => p.amount).sort(),
  };
}

describe("load into a fake OpenTradesOS, over HTTP", () => {
  it("loads every record whose references resolve, and names the ones that do not", async () => {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    const ledger = await Ledger.open(ledgerPath(), fake.url, "jobber");
    const report = await load({
      snapshot, adapter: jobber, ledger, mapping: await mappingFor(snapshot),
      target: new HttpTarget(fake.url, TOKEN, { retry: quietRetry() }),
    });

    expect(report.aborted).toBeUndefined();
    expect(report.entities.user).toMatchObject({ mapped: 2 });
    expect(report.entities.customer).toMatchObject({ created: 3 });
    expect(report.entities.property).toMatchObject({ created: 2 });
    expect(report.entities.priceBookItem).toMatchObject({ created: 2 });
    expect(report.entities.estimate).toMatchObject({ created: 2 });
    expect(report.entities.job).toMatchObject({ created: 1, blocked: 1 });
    expect(report.entities.invoice).toMatchObject({ created: 2 });
    expect(report.entities.payment).toMatchObject({ created: 2, skipped: 0 });

    // Job 102 names a customer that was never extracted. It waits, by name,
    // rather than loading with nobody to bill.
    expect(report.problems).toContainEqual(expect.objectContaining({
      entity: "job", sourceId: JOB_102, outcome: "blocked",
      reason: expect.stringContaining("Z2lkOi8vSm9iYmVyL0NsaWVudC85OTk="),
    }));
    // The deposit is held for the customer, not spread over old invoices.
    const deposit = [...fake.memory.payments.values()].find((p) => p.amount === "500.0000")!;
    expect(deposit).toMatchObject({ allocations: [], unappliedAmount: "500.0000" });
    expect(Object.keys(report.gaps)).not.toContain("payment.unapplied");
    expect(renderLoad(report)).toContain("WAITING ON A RECORD THAT DID NOT LOAD");
  });

  it("remaps every reference through the ledger", async () => {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    const ledger = await Ledger.open(ledgerPath(), fake.url, "jobber");
    await load({
      snapshot, adapter: jobber, ledger, mapping: await mappingFor(snapshot),
      target: new HttpTarget(fake.url, TOKEN, { retry: quietRetry() }),
    });
    const { memory } = fake;

    const job = memory.jobs.get(ledger.get(`job:${JOB_101}`)!)!;
    expect(job.customerId).toBe(ledger.get(`customer:${CLIENT_1}`));
    expect(job.propertyId).toBe(ledger.get(`property:${PROPERTY_11}`));
    // Three visits in calendar order, the two finished ones completed at the
    // source's own times, technicians mapped to target users.
    expect(job.visits.map((v) => v.windowStart)).toEqual([
      "2023-03-14T14:00:00.000Z", "2023-09-20T14:00:00.000Z", "2024-09-18T14:00:00.000Z",
    ]);
    expect(job.visits.map((v) => v.completedAt)).toEqual([
      "2023-03-14T15:41:00.000Z", "2023-09-20T15:12:00.000Z", null,
    ]);
    expect(job.visits.map((v) => v.technicianIds)).toEqual([[RAY], [NIA], [RAY]]);
    expect(job.visits[1]!.technicianNotes).toBe("Replaced capacitor");

    const invoice501 = memory.invoices.get(ledger.get(`invoice:${INVOICE_501}`)!)!;
    expect(invoice501.jobId).toBe(job.id);
    // As it was sent: its number, its day, its tax, its total.
    expect(invoice501).toMatchObject({
      number: 2201, issuedOn: "2023-09-21", memo: "Migrated from jobber invoice #2201.",
      taxTotal: "26.2400", total: "344.2400", balance: "344.2400",
    });
    expect(invoice501.externalRef).toEqual({ source: ledger.externalSource, id: INVOICE_501 });
    // Lines Jobber's API cut off at the page boundary are one adjustment.
    const invoice502 = memory.invoices.get(ledger.get(`invoice:${INVOICE_502}`)!)!;
    expect(invoice502.lines.at(-1)).toMatchObject({ name: "Not itemised on jobber invoice #2202", origin: "manual", unitPrice: "590.0000" });
    expect(invoice502).toMatchObject({ total: "2480.5000", balance: "-120.0000" });
    // Linked to the price book and kept at the price it was sold at.
    expect(invoice501.lines[0]).toMatchObject({ priceBookItemId: ledger.get("priceBookItem:ps-1"), unitPrice: "129.0000" });

    const payment = [...memory.payments.values()][0]!;
    expect(payment.customerId).toBe(ledger.get(`customer:${CLIENT_2}`));
    expect(payment.allocations).toEqual([{ invoiceId: ledger.get(`invoice:${INVOICE_502}`), amount: "2600.5000" }]);
    expect(payment.receivedAt).toBe("2022-11-04T12:00:00.000Z");

    // A property shared by two customers in the source would be linked to
    // both; this one is not, so it has exactly its owner.
    expect(memory.properties.get(ledger.get(`property:${PROPERTY_11}`)!)!.customers).toEqual([
      { customerId: ledger.get(`customer:${CLIENT_1}`), role: "owner", isPrimary: true },
    ]);
    // The rejected quote is recorded as declined, and its line's discount
    // travels as the line's own discount rather than a changed price.
    const declined = [...memory.estimates.values()].find((e) => e["title"] === "Duct cleaning")!;
    expect(declined["status"]).toBe("declined");
    expect((declined["options"] as { lines: { unitPrice: string; discountAmount: string }[] }[])[0]!.lines[0])
      .toMatchObject({ unitPrice: "500.0000", discountAmount: "50.0000" });
  });

  it("creates nothing on a second run", async () => {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    const mapping = await mappingFor(snapshot);
    const target = new HttpTarget(fake.url, TOKEN, { retry: quietRetry() });
    await load({ snapshot, adapter: jobber, target, mapping, ledger: await Ledger.open(ledgerPath(), fake.url, "jobber") });
    const before = fingerprint(fake.memory);
    const requests = fake.log.length;

    const again = await load({ snapshot, adapter: jobber, target, mapping, ledger: await Ledger.open(ledgerPath(), fake.url, "jobber") });

    expect(fingerprint(fake.memory)).toEqual(before);
    expect(fake.log.slice(requests).filter((r) => r.method !== "GET")).toEqual([]);
    expect(again.entities.customer).toMatchObject({ created: 0, already: 3 });
    expect(again.entities.invoice).toMatchObject({ created: 0, already: 2 });
  });

  it("is still idempotent when the ledger is lost, because the target honours the key", async () => {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    const mapping = await mappingFor(snapshot);
    const target = new HttpTarget(fake.url, TOKEN, { retry: quietRetry() });
    await load({ snapshot, adapter: jobber, target, mapping, ledger: await Ledger.open(ledgerPath(), fake.url, "jobber") });
    const before = fingerprint(fake.memory);

    // Lose the ledger entirely: the worst case of a crash between the target
    // writing and us recording, and of an operator deleting the wrong folder.
    await rm(ledgerPath());

    await load({ snapshot, adapter: jobber, target, mapping, ledger: await Ledger.open(ledgerPath(), fake.url, "jobber") });
    expect(fingerprint(fake.memory)).toEqual(before);

    // Every create carried a key, and the same record carried the same key.
    const creates = fake.log.filter((r) => r.method === "POST" && /\/v1\/(customers|properties|jobs|invoices|payments|estimates|pricebook\/items)$/.test(r.path));
    expect(creates.every((r) => r.idempotencyKey?.startsWith("otsm-"))).toBe(true);
    const keys = new Set(creates.map((r) => r.idempotencyKey));
    expect(keys.size).toBe(creates.length / 2);
  });

  it("reports a record the contract refuses, with the field, and never sends it", async () => {
    fake = await startFakeTarget();
    const snapshot = await hcpSnapshot();
    const report = await load({
      snapshot, adapter: housecallPro, mapping: await mappingFor(snapshot, housecallPro),
      ledger: await Ledger.open(ledgerPath(), fake.url, "housecall-pro"),
      target: new HttpTarget(fake.url, TOKEN, { retry: quietRetry() }),
    });

    // cus_8f23's only address has no street, city or postal code.
    const refused = report.problems.find((p) => p.entity === "property" && p.outcome === "invalid");
    expect(refused?.sourceId).toBe("adr_9");
    expect(refused?.issues?.map((i) => i.path)).toEqual(expect.arrayContaining(["address.line1", "address.city", "address.postalCode"]));
    expect(fake.memory.calls.get("createProperty")).toBe(4);
    // The one 422 is the permission check, which the target refuses by design.
    expect(fake.log.filter((r) => r.status === 422)).toEqual([expect.objectContaining({ method: "POST", path: "/api/v1/invoices" })]);

    // Everything that does not depend on it loads, including the job whose
    // property id was derived from an address with no id of its own.
    expect(report.entities.job).toMatchObject({ created: 3 });
    expect(report.entities.invoice).toMatchObject({ created: 2 });
    expect(report.entities.estimate).toMatchObject({ created: 1 });
    expect(failures(report)).toBe(1);
  });

  it("rides out 429s, honouring Retry-After, and backs off on a 503", async () => {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    const delays: number[] = [];
    const retries: string[] = [];
    const retry = { ...quietRetry(delays), onRetry: (i: { reason: string }) => { retries.push(i.reason); } };

    fake.failNext(429, 2, "3");
    const report = await load({
      snapshot, adapter: jobber, mapping: await mappingFor(snapshot),
      ledger: await Ledger.open(ledgerPath(), fake.url, "jobber"),
      target: new HttpTarget(fake.url, TOKEN, { retry }),
      concurrency: 1,
    });

    expect(report.aborted).toBeUndefined();
    expect(retries).toEqual(["HTTP 429", "HTTP 429"]);
    expect(delays).toEqual([3000, 3000]);
    expect(report.entities.customer).toMatchObject({ created: 3 });

    const more = new HttpTarget(fake.url, TOKEN, { retry });
    fake.failNext(503, 1);
    const page = await more.call("listCustomers", { limit: 10 });
    expect(page.data).toHaveLength(3);
    expect(retries.at(-1)).toBe("HTTP 503");
  });

  it("stops when the target keeps refusing, rather than marking every record failed", async () => {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    fake.failNext(503, 100);
    const report = await load({
      snapshot, adapter: jobber, mapping: await mappingFor(snapshot),
      ledger: await Ledger.open(ledgerPath(), fake.url, "jobber"),
      target: new HttpTarget(fake.url, TOKEN, { retry: quietRetry() }),
    });
    expect(report.aborted).toContain("503");
    expect(report.problems.filter((p) => p.outcome === "rejected")).toEqual([]);
  });

  it("stops at once on a refused token", async () => {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    const report = await load({
      snapshot, adapter: jobber, mapping: await mappingFor(snapshot),
      ledger: await Ledger.open(ledgerPath(), fake.url, "jobber"),
      target: new HttpTarget(fake.url, "ots_wrong", { retry: quietRetry() }),
    });
    expect(report.aborted).toContain("refused the token");
    expect(fake.memory.customers.size).toBe(0);
  });
});

/**
 * Dies after the target has committed the Nth write and before the loader
 * hears about it, which is the worst moment a process can die: the target
 * has the record and the ledger does not.
 */
class CrashingTarget implements Target {
  readonly description = "crashing";
  private count = 0;
  constructor(private readonly inner: Target, private readonly after: number) {}
  async call<N extends RouteName>(name: N, input: InputOf<N>, options?: CallOptions): Promise<OutputOf<N>> {
    const result = await this.inner.call(name, input, options);
    this.count += 1;
    if (this.count === this.after) throw new Error(`simulated crash after call ${this.after} (${name})`);
    return result;
  }
}

describe("crash and resume", () => {
  it("ends in the same state whichever call the process dies after", async () => {
    const snapshot = await jobberSnapshot();
    const mapping = await mappingFor(snapshot);

    const clean = new MemoryTarget();
    await load({ snapshot, adapter: jobber, mapping, target: clean, ledger: Ledger.memory("clean", "jobber"), concurrency: 1 });
    const expected = fingerprint(clean);
    // Every call that succeeds, which is every call but the permission
    // check: the target refuses that one by design.
    const total = [...clean.calls.values()].reduce((a, b) => a + b, 0) - 1;
    expect(total).toBeGreaterThan(15);

    for (let crashAt = 1; crashAt <= total; crashAt += 1) {
      const memory = new MemoryTarget();
      const path = join(dir, `ledger-${crashAt}.ndjson`);
      const first = await load({
        snapshot, adapter: jobber, mapping, concurrency: 1,
        target: new CrashingTarget(memory, crashAt), ledger: await Ledger.open(path, "memory", "jobber"),
      });
      expect(first.aborted, `crash at ${crashAt}`).toContain("simulated crash");

      // A process killed mid-append leaves half a line. It must not matter.
      await appendFile(path, '{"type":"entry","key":"customer:', "utf8");

      const second = await load({
        snapshot, adapter: jobber, mapping, concurrency: 1,
        target: memory, ledger: await Ledger.open(path, "memory", "jobber"),
      });
      expect(second.aborted, `resume after ${crashAt}`).toBeUndefined();
      expect(fingerprint(memory), `crash at call ${crashAt}`).toEqual(expected);
    }
  });

  it("adopts a visit the target made before the crash instead of adding it twice", async () => {
    const snapshot = await jobberSnapshot();
    const mapping = await mappingFor(snapshot);
    const memory = new MemoryTarget();
    const path = ledgerPath();

    // Die right after the first scheduleVisit lands: the visit exists in the
    // target, the ledger has never heard of it, and the target does not
    // deduplicate visits by key.
    let crashed = false;
    const target: Target = {
      description: "crash on schedule",
      async call(name, input, options) {
        const result = await memory.call(name, input, options);
        if (name === "scheduleVisit" && !crashed) { crashed = true; throw new Error("simulated crash"); }
        return result;
      },
    };
    await load({ snapshot, adapter: jobber, mapping, target, ledger: await Ledger.open(path, "memory", "jobber"), concurrency: 1 });
    await load({ snapshot, adapter: jobber, mapping, target: memory, ledger: await Ledger.open(path, "memory", "jobber"), concurrency: 1 });

    const job = [...memory.jobs.values()][0]!;
    expect(job.visits).toHaveLength(3);
    expect(memory.calls.get("scheduleVisit")).toBe(2);
    expect(memory.calls.get("getJob")).toBeGreaterThan(0);
  });
});

describe("the ledger", () => {
  it("refuses to resume a load into a different target", async () => {
    await Ledger.open(ledgerPath(), "https://scratch.example.com/api", "jobber");
    await expect(Ledger.open(ledgerPath(), "https://ots.example.com/api", "jobber")).rejects.toBeInstanceOf(LedgerMismatchError);
  });

  it("derives a stable, header-safe key per record, the same with or without the file", async () => {
    const ledger = await Ledger.open(ledgerPath(), "t", "csv", "export-a");
    const key = ledger.idempotencyKey("customer:C-1");
    expect(key).toMatch(/^otsm-[0-9a-f]{16}-[0-9a-f]{40}$/);
    expect((await Ledger.open(ledgerPath(), "t", "csv", "export-a")).idempotencyKey("customer:C-1")).toBe(key);
    expect(Ledger.memory("t", "csv", "export-a").idempotencyKey("customer:C-1")).toBe(key);
    // Two spreadsheets that both number their customers from C-1 never share a key.
    expect(Ledger.memory("t", "csv", "export-b").idempotencyKey("customer:C-1")).not.toBe(key);
  });
});

describe("reconcile against the target", () => {
  async function loaded(carryTotals: boolean): Promise<{ report: LoadReport; reconciled: ReturnType<typeof reconcile>; notes: string[] }> {
    fake = await startFakeTarget();
    const snapshot = await jobberSnapshot();
    const ledger = await Ledger.open(ledgerPath(), fake.url, "jobber");
    const target = new HttpTarget(fake.url, TOKEN, { retry: quietRetry() });
    const report = await load({ snapshot, adapter: jobber, ledger, target, mapping: await mappingFor(snapshot), carryTotals });
    const reading = await readTarget(target, ledger);
    const expected = sourceSide(await transform(snapshot, jobber, new CountingSink()));
    return { report, reconciled: reconcile(expected, reading.side), notes: reading.notes };
  }

  it("reads the target back, payments included, and says exactly what does not match", async () => {
    const { reconciled, notes } = await loaded(false);
    expect(reconciled.matched).toBe(false);
    // Job 102 is blocked. Nothing else is short: the tax, the lines Jobber
    // cut off and the deposit all landed.
    expect(reconciled.counts).toEqual([expect.objectContaining({ entity: "job", expected: 2, actual: 1 })]);
    expect(reconciled.money).toEqual([]);
    expect(notes.join(" ")).toContain("$500.00 of the payments read back is held for customers");
  });

  it("matches every dollar total to the cent", async () => {
    const { reconciled } = await loaded(true);
    for (const measure of ["invoiceTotal", "invoiceBalance", "paymentTotal", "paymentAllocated"]) {
      expect(reconciled.money.find((m) => m.measure === measure), measure).toBeUndefined();
    }
  });
});

describe("a target that answers 409", () => {
  it("records the refusal against the record and carries on", async () => {
    const snapshot = await jobberSnapshot();
    const memory = new MemoryTarget();
    const target: Target = {
      description: "refuses one customer",
      async call(name, input, options) {
        if (name === "createCustomer" && (input as { name?: string }).name === "Brazos Property Group") {
          throw new TargetError(409, "createCustomer: a customer with that name exists");
        }
        return memory.call(name, input, options);
      },
    };
    const report = await load({ snapshot, adapter: jobber, target, mapping: await mappingFor(snapshot), ledger: Ledger.memory("x", "jobber") });
    expect(report.problems).toContainEqual(expect.objectContaining({ entity: "customer", sourceId: CLIENT_2, outcome: "rejected" }));
    // Everything that depended on that customer waits, by name.
    expect(report.problems).toContainEqual(expect.objectContaining({ entity: "invoice", sourceId: INVOICE_502, outcome: "blocked" }));
    expect(report.entities.customer).toMatchObject({ created: 2, rejected: 1 });
  });
});
