import { describe, it, expect } from "vitest";
import * as map from "../src/adapters/housecall-pro/map.js";
import { housecallPro, readEnvelope, createHousecallProAdapter } from "../src/adapters/housecall-pro/index.js";
import { load, byId } from "./fixtures.js";

const customers = load("housecall-pro", "customers");
const jobs = load("housecall-pro", "jobs");
const invoices = load("housecall-pro", "invoices");

describe("cents, not dollars", () => {
  it("reads job and invoice totals as integer cents", () => {
    // The single most dangerous difference between this source and Jobber.
    // Read as dollars, 34424 becomes thirty four thousand dollars.
    expect(map.toJob(byId(jobs, "job_4410")).total).toBe("344.2400");
    expect(map.toInvoice(byId(invoices, "inv_991")).total).toBe("344.2400");
  });

  it("derives the subtotal by subtracting tax from the total", () => {
    const invoice = map.toInvoice(byId(invoices, "inv_991"));
    expect(invoice.taxTotal).toBe("26.2400");
    expect(invoice.subtotal).toBe("318.0000");
  });

  it("reads line amounts as cents but quantity as a plain number", () => {
    const invoice = map.toInvoice(byId(invoices, "inv_991"));
    expect(invoice.lines[0]?.quantity).toBe("2.0000");
    expect(invoice.lines[0]?.unitPrice).toBe("129.0000");
    expect(invoice.lines[0]?.lineTotal).toBe("258.0000");
  });

  it("keeps a non-taxable line non-taxable", () => {
    const invoice = map.toInvoice(byId(invoices, "inv_992"));
    expect(invoice.lines[1]?.taxable).toBe(false);
  });
});

describe("splitting a customer into customer and properties", () => {
  const dana = byId(customers, "cus_8f21");

  it("produces one property per address", () => {
    const properties = map.toProperties(dana);
    expect(properties).toHaveLength(2);
    expect(properties.map((p) => p.addressLine1)).toEqual(["4102 Ramsey Ave", "1900 Bluebonnet Ln"]);
  });

  it("links every property back to its customer", () => {
    expect(map.toProperties(dana).every((p) => p.customerSourceIds[0] === "cus_8f21")).toBe(true);
  });

  it("collapses the same address listed as both billing and service", () => {
    // Spacing and case differ between the two entries in the fixture, exactly
    // as they do in a real export. Importing both gives the technician two
    // identical rows to choose between.
    const properties = map.toProperties(byId(customers, "cus_8f22"));
    expect(properties.map((p) => p.addressLine1)).toEqual(["900 Congress Ave", "11200 Metric Blvd"]);
  });

  it("uses the source address id when there is one", () => {
    expect(map.toProperties(dana)[0]?.sourceId).toBe("adr_1");
  });
});

describe("derived property ids", () => {
  const addressA = { street: "900 Congress Ave", city: "Austin", state: "TX", zip: "78701" };

  it("is stable across runs, so a re-run updates rather than duplicates", () => {
    expect(map.propertyId("cus_1", addressA)).toBe(map.propertyId("cus_1", { ...addressA }));
  });

  it("ignores case and whitespace, because exports are not consistent", () => {
    expect(map.propertyId("cus_1", addressA))
      .toBe(map.propertyId("cus_1", { street: "900  Congress Ave", city: "austin", state: "TX", zip: "78701" }));
  });

  it("does not change when the nickname changes", () => {
    // Renaming "Shop" to "Warehouse" must not orphan four years of history.
    expect(map.propertyId("cus_1", { ...addressA, nickname: "Shop" }))
      .toBe(map.propertyId("cus_1", { ...addressA, nickname: "Warehouse" }));
  });

  it("differs between two customers at the same address", () => {
    expect(map.propertyId("cus_1", addressA)).not.toBe(map.propertyId("cus_2", addressA));
  });
});

describe("jobs", () => {
  it("resolves the job's address back to the same derived property id", () => {
    // If this drifts, every job in the migration lands with no address.
    const job = map.toJob(byId(jobs, "job_4411"));
    const properties = map.toProperties(byId(customers, "cus_8f22"));
    expect(job.propertySourceId).toBe(properties[0]?.sourceId);
  });

  it("produces exactly one visit, because the source has one block", () => {
    const job = map.toJob(byId(jobs, "job_4410"));
    expect(job.visits).toHaveLength(1);
    expect(job.visits[0]?.completedAt).toBe("2024-03-14T15:41:00Z");
  });

  it("derives the window end from the arrival window when the source left it null", () => {
    // The customer was told 3:00 to 4:00. Keeping only the start loses the
    // promise that was actually made to them.
    const job = map.toJob(byId(jobs, "job_4411"));
    expect(job.visits[0]?.windowStart).toBe("2025-01-08T15:00:00Z");
    expect(job.visits[0]?.windowEnd).toBe("2025-01-08T16:00:00.000Z");
  });

  it("reads a nested job type object or a plain string", () => {
    expect(map.toJob(byId(jobs, "job_4410")).jobType).toBe("Maintenance");
  });
});

describe("customers", () => {
  it("prefers the mobile number", () => {
    expect(map.toCustomer(byId(customers, "cus_8f21")).phone).toBe("5125550192");
  });

  it("treats a record with a company name as commercial", () => {
    expect(map.toCustomer(byId(customers, "cus_8f22")).type).toBe("commercial");
    expect(map.toCustomer(byId(customers, "cus_8f22")).name).toBe("Brazos Property Group");
  });

  it("picks the billing address for billing", () => {
    expect(map.toCustomer(byId(customers, "cus_8f21")).billingAddress?.postalCode).toBe("78756");
  });
});

describe("page envelopes", () => {
  it("reads the named collection", () => {
    expect(readEnvelope({ customers: [{ id: "1" }], page: 2, total_pages: 5 }, "customers"))
      .toEqual({ records: [{ id: "1" }], page: 2, totalPages: 5 });
  });

  it("reads a data envelope when the endpoint uses one", () => {
    expect(readEnvelope({ data: [{ id: "1" }] }, "customers").records).toHaveLength(1);
  });

  it("computes total pages from total items when the field is absent", () => {
    expect(readEnvelope({ jobs: [{ id: "1" }], total_items: 250, page_size: 100 }, "jobs").totalPages).toBe(3);
  });

  it("treats an empty response as one page rather than looping forever", () => {
    expect(readEnvelope({ jobs: [] }, "jobs")).toEqual({ records: [], page: 1, totalPages: 1 });
  });
});

describe("extraction", () => {
  /** A context that records what was written, standing in for a snapshot. */
  function harness() {
    const written: { entity: string; ids: string[] }[] = [];
    const logs: string[] = [];
    return {
      written, logs,
      ctx: {
        snapshotDir: "/tmp/none",
        append: async (entity: string, records: readonly unknown[]) => {
          written.push({ entity, ids: records.map((r) => String((r as Record<string, unknown>)["id"])) });
        },
        checkpoint: async () => {},
        resume: async () => undefined,
        log: (m: string) => { logs.push(m); },
      },
    };
  }

  it("detects a record that appears on two pages and warns instead of staying silent", async () => {
    // Page-number paging against a live account: a record created mid-run
    // shifts everything after it, so page 2 repeats what page 1 already had
    // and some other record is skipped entirely. The adapter cannot prevent
    // that. It can refuse to import the duplicate and say so.
    const pages: Record<string, Record<string, unknown>[][]> = {
      "/customers": [[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]],
    };
    const h = harness();
    const adapter = createHousecallProAdapter({
      transport: async (url) => {
        const path = new URL(url).pathname;
        const page = Number(new URL(url).searchParams.get("page") ?? 1);
        const collection = path.slice(1);
        const all = pages[path] ?? [[]];
        return {
          status: 200,
          body: { [collection]: all[page - 1] ?? [], page, total_pages: all.length },
          text: "", headers: {},
        };
      },
    });

    for await (const _ of adapter.extract({ key: "k" }, h.ctx)) { /* drain */ }

    const customerWrites = h.written.filter((w) => w.entity === "customer").flatMap((w) => w.ids);
    expect(customerWrites).toEqual(["a", "b", "c"]);
    expect(h.logs.join(" ")).toMatch(/more than one page/);
  });

  it("resumes from the checkpointed page rather than starting over", async () => {
    // An extraction that dies on page 40 of 50 must not re-pull the first 39.
    const requested: number[] = [];
    const h = harness();
    const adapter = createHousecallProAdapter({
      transport: async (url) => {
        const page = Number(new URL(url).searchParams.get("page") ?? 1);
        const path = new URL(url).pathname;
        if (path === "/customers") requested.push(page);
        return {
          status: 200,
          body: { [path.slice(1)]: page <= 3 ? [{ id: `p${page}` }] : [], page, total_pages: 3 },
          text: "", headers: {},
        };
      },
    });

    const ctx = { ...h.ctx, resume: async (entity: string) => (entity === "customer" ? "3" : undefined) };
    for await (const _ of adapter.extract({ key: "k" }, ctx)) { /* drain */ }
    expect(requested).toEqual([3]);
  });
});

describe("the adapter's declared limits", () => {
  it("declares that properties are derived from customers", () => {
    expect(housecallPro.capabilities.derivedFrom).toEqual({ property: "customer" });
  });

  it("warns that amounts are cents", () => {
    expect(housecallPro.capabilities.knownLimits.join(" ")).toMatch(/cents/i);
  });
});
