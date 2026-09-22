import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshot } from "../src/snapshot/index.js";
import { transform, MemorySink, derivations } from "../src/transform/index.js";
import { jobber } from "../src/adapters/jobber/index.js";
import { housecallPro } from "../src/adapters/housecall-pro/index.js";
import { renderProfile } from "../src/profile/index.js";
import { load } from "./fixtures.js";
import type { EntityName } from "../src/canonical/index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pipe-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function seed(source: string, files: Partial<Record<EntityName, string>>): Promise<Snapshot> {
  const snapshot = await Snapshot.open(dir, source);
  for (const [entity, file] of Object.entries(files)) {
    await snapshot.append(entity as EntityName, load(source, file));
  }
  await snapshot.flush();
  return snapshot;
}

describe("derivations", () => {
  it("reads each entity from its own file by default", () => {
    expect(derivations(jobber).find((d) => d.to === "property")).toEqual({ from: "property", to: "property" });
  });

  it("reads properties out of the customer file where the source embeds them", () => {
    expect(derivations(housecallPro).find((d) => d.to === "property")).toEqual({ from: "customer", to: "property" });
  });

  it("orders customers before the jobs that name them", () => {
    const order = derivations(jobber).map((d) => d.to);
    expect(order.indexOf("customer")).toBeLessThan(order.indexOf("job"));
    expect(order.indexOf("invoice")).toBeLessThan(order.indexOf("payment"));
  });
});

describe("transform, end to end over a Jobber snapshot", () => {
  it("produces canonical records and a profile in one pass", async () => {
    const snapshot = await seed("jobber", {
      customer: "clients", job: "jobs", invoice: "invoices", payment: "payments",
    });
    const sink = new MemorySink();
    const result = await transform(snapshot, jobber, sink);

    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({ customer: 3, job: 2, invoice: 2, payment: 2 });
    expect(sink.get("customer")[0]?.["name"]).toBe("Dana Whitfield");
  });

  it("totals the money across the snapshot", async () => {
    const snapshot = await seed("jobber", { customer: "clients", invoice: "invoices", payment: "payments" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());

    // 344.24 + 2480.50
    expect(profile.totals.invoiceTotal).toBe("2824.7400");
    // 344.24 + (-120.00): the credit reduces what is owed, it is not ignored.
    expect(profile.totals.invoiceBalance).toBe("224.2400");
    expect(profile.totals.paymentTotal).toBe("3100.5000");
    // The 500 deposit is not applied to any invoice.
    expect(profile.totals.paymentUnallocated).toBe("500.0000");
  });

  it("reports a job whose customer is not in the snapshot", async () => {
    const snapshot = await seed("jobber", { customer: "clients", job: "jobs" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());

    const orphan = profile.findings.find((f) => f.code === "job.orphan_customer");
    expect(orphan?.severity).toBe("error");
    expect(orphan?.count).toBe(1);
    expect(orphan?.sample).toContain("Z2lkOi8vSm9iYmVyL0pvYi8xMDI=");
  });

  it("reports a customer with no way to contact them", async () => {
    const snapshot = await seed("jobber", { customer: "clients" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());
    expect(profile.findings.find((f) => f.code === "customer.no_contact")?.count).toBe(1);
  });

  it("reports the credit balance rather than hiding it", async () => {
    const snapshot = await seed("jobber", { invoice: "invoices" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());
    expect(profile.findings.find((f) => f.code === "invoice.negative_balance")?.count).toBe(1);
  });

  it("reports a payment allocated to an invoice that was not extracted", async () => {
    const snapshot = await seed("jobber", { payment: "payments" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());
    expect(profile.findings.find((f) => f.code === "payment.orphan_invoice")?.count).toBe(1);
  });

  it("puts errors above warnings above information", async () => {
    const snapshot = await seed("jobber", { customer: "clients", job: "jobs", invoice: "invoices", payment: "payments" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());
    const severities = profile.findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) =>
      ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]));
  });

  it("records date spans so the operator sees how far back the data goes", async () => {
    const snapshot = await seed("jobber", { invoice: "invoices" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());
    const invoices = profile.entities.find((e) => e.entity === "invoice");
    expect(invoices?.earliest).toBe("2022-11-03");
    expect(invoices?.latest).toBe("2023-09-21");
  });
});

describe("transform, end to end over a Housecall Pro snapshot", () => {
  it("fans one customer file out into customers and properties", async () => {
    const snapshot = await seed("housecall-pro", { customer: "customers", job: "jobs", invoice: "invoices" });
    const sink = new MemorySink();
    const result = await transform(snapshot, housecallPro, sink);

    expect(result.counts.customer).toBe(3);
    // Three customers: 2 addresses, then 3 of which 2 collapse, then 1.
    expect(result.counts.property).toBe(5);
  });

  it("resolves every job to a property that exists", async () => {
    // The whole risk of a derived id: if the two derivations disagree, every
    // job lands with no address and nobody notices until dispatch.
    const snapshot = await seed("housecall-pro", { customer: "customers", job: "jobs" });
    const sink = new MemorySink();
    const { profile } = await transform(snapshot, housecallPro, sink);

    expect(profile.findings.find((f) => f.code === "job.orphan_property")).toBeUndefined();
    const propertyIds = new Set(sink.get("property").map((p) => p["sourceId"]));
    for (const job of sink.get("job")) expect(propertyIds.has(job["propertySourceId"])).toBe(true);
  });

  it("reports the property with no usable address", async () => {
    const snapshot = await seed("housecall-pro", { customer: "customers" });
    const { profile } = await transform(snapshot, housecallPro, new MemorySink());
    expect(profile.findings.find((f) => f.code === "property.incomplete_address")?.count).toBe(1);
  });

  it("reconciles invoice totals in cents against the source", async () => {
    const snapshot = await seed("housecall-pro", { invoice: "invoices" });
    const { profile } = await transform(snapshot, housecallPro, new MemorySink());
    expect(profile.totals.invoiceTotal).toBe("2824.7400");
    expect(profile.totals.invoiceBalance).toBe("2480.5000");
  });
});

describe("resilience", () => {
  it("collects a bad record instead of failing the whole run", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    await snapshot.append("invoice", [
      { id: "good", amounts: { total: 10 }, client: { id: "c" }, lineItems: { nodes: [] } },
      { id: "bad", amounts: { total: "not a number" }, client: { id: "c" } },
      { id: "also-good", amounts: { total: 20 }, client: { id: "c" }, lineItems: { nodes: [] } },
    ]);
    await snapshot.flush();

    const result = await transform(snapshot, jobber, new MemorySink());
    // Ten years of data contains rows nothing can make sense of. Stopping at
    // the first means fixing them one per overnight run, for a week.
    expect(result.counts.invoice).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sourceId).toBe("bad");
  });

  it("does not list an unmapped entity as ten thousand failures", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    await snapshot.append("estimate", [{ id: "q1" }, { id: "q2" }, { id: "q3" }]);
    await snapshot.flush();
    const result = await transform(snapshot, jobber, new MemorySink());
    expect(result.failures).toEqual([]);
    expect(result.counts.estimate).toBeUndefined();
  });
});

describe("the rendered report", () => {
  it("leads with findings and shows money as dollars", async () => {
    const snapshot = await seed("jobber", { customer: "clients", job: "jobs", invoice: "invoices", payment: "payments" });
    const { profile } = await transform(snapshot, jobber, new MemorySink());
    const text = renderProfile(profile);

    expect(text).toContain("$2,824.74");
    expect(text).toContain("FINDINGS");
    expect(text).toContain("job.orphan_customer");
    expect(text).not.toContain("2824.7400");
  });
});
