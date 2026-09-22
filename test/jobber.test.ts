import { describe, it, expect } from "vitest";
import * as map from "../src/adapters/jobber/map.js";
import { jobber, readPage, waitForBudget, readThrottle, JobberClient, JobberGraphQLError } from "../src/adapters/jobber/index.js";
import { load, byId } from "./fixtures.js";

const clients = load("jobber", "clients");
const jobs = load("jobber", "jobs");
const invoices = load("jobber", "invoices");
const payments = load("jobber", "payments");

describe("client names", () => {
  it("uses the person's name for a residential client", () => {
    expect(map.clientName(byId(clients, "Z2lkOi8vSm9iYmVyL0NsaWVudC8x"))).toBe("Dana Whitfield");
  });

  it("uses the company, not the contact, for a commercial client", () => {
    // The contact person leaves; the company keeps paying the invoices.
    expect(map.clientName(byId(clients, "Z2lkOi8vSm9iYmVyL0NsaWVudC8y"))).toBe("Brazos Property Group");
  });

  it("does not produce an empty name when every name field is blank", () => {
    expect(map.clientName(byId(clients, "Z2lkOi8vSm9iYmVyL0NsaWVudC8z"))).toBe("Unnamed client");
  });
});

describe("customers", () => {
  const dana = map.toCustomer(byId(clients, "Z2lkOi8vSm9iYmVyL0NsaWVudC8x"));

  it("takes the email and phone flagged primary, not the first in the list", () => {
    expect(dana.email).toBe("dana.w@example.com");
    // The mobile is second in the array and flagged primary. Taking index 0
    // would call the landline, which is how a technician fails to reach anyone.
    expect(dana.phone).toBe("512-555-0192");
  });

  it("classifies commercial from the company flag", () => {
    expect(dana.type).toBe("residential");
    expect(map.toCustomer(byId(clients, "Z2lkOi8vSm9iYmVyL0NsaWVudC8y")).type).toBe("commercial");
  });

  it("carries tax exemption, which is money", () => {
    expect(map.toCustomer(byId(clients, "Z2lkOi8vSm9iYmVyL0NsaWVudC8y")).taxExempt).toBe(true);
    expect(dana.taxExempt).toBe(false);
  });

  it("flattens custom fields by label and drops the empty ones", () => {
    expect(dana.customFields).toEqual({ "Gate code": "#4417", "Dogs on property": true });
  });

  it("keeps the raw record for later reconciliation", () => {
    expect(dana.sourcePayload).toBeDefined();
    expect(dana.sourceSystem).toBe("jobber");
  });

  it("omits a billing address when the source had none", () => {
    expect(map.toCustomer(byId(clients, "Z2lkOi8vSm9iYmVyL0NsaWVudC8z")).billingAddress).toBeUndefined();
  });
});

describe("jobs and visits", () => {
  const maintenance = map.toJob(byId(jobs, "Z2lkOi8vSm9iYmVyL0pvYi8xMDE="));

  it("orders visits by calendar date, not by the order the API returned them", () => {
    // The fixture returns visit 3 first, as Jobber does after a reschedule.
    // "Visit 2 of 3" is what the customer was told, so the order is the fact.
    expect(maintenance.visits.map((v) => v.sourceId)).toEqual(["v-1", "v-2", "v-3"]);
    expect(maintenance.visits.map((v) => v.sequence)).toEqual([1, 2, 3]);
  });

  it("keeps the source status string rather than guessing at a mapping", () => {
    expect(maintenance.visits[2]?.status).toBe("UPCOMING");
    expect(maintenance.visits[0]?.status).toBe("COMPLETE");
  });

  it("carries the assigned technician per visit, not per job", () => {
    expect(maintenance.visits[1]?.technicianSourceIds).toEqual(["u-2"]);
  });

  it("reads the job total as an amount, not a float", () => {
    expect(maintenance.total).toBe("318.0000");
  });

  it("handles a job with no visits", () => {
    expect(map.toJob(byId(jobs, "Z2lkOi8vSm9iYmVyL0pvYi8xMDI=")).visits).toEqual([]);
  });
});

describe("invoices", () => {
  const invoice = map.toInvoice(byId(invoices, "Z2lkOi8vSm9iYmVyL0ludm9pY2UvNTAx"));

  it("takes totals as the source printed them", () => {
    expect(invoice.subtotal).toBe("318.0000");
    expect(invoice.taxTotal).toBe("26.2400");
    expect(invoice.total).toBe("344.2400");
    expect(invoice.balance).toBe("344.2400");
  });

  it("maps line items with their own totals", () => {
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]?.lineTotal).toBe("258.0000");
    expect(invoice.lines[0]?.priceBookItemSourceId).toBe("ps-1");
    expect(invoice.lines[1]?.priceBookItemSourceId).toBeUndefined();
  });

  it("links the invoice to its job", () => {
    expect(invoice.jobSourceId).toBe("Z2lkOi8vSm9iYmVyL0pvYi8xMDE=");
  });

  it("carries a negative balance rather than clamping it to zero", () => {
    // A credit owed back to a customer is real money.
    expect(map.toInvoice(byId(invoices, "Z2lkOi8vSm9iYmVyL0ludm9pY2UvNTAy")).balance).toBe("-120.0000");
  });
});

describe("payments", () => {
  it("allocates a payment to the invoice it names", () => {
    const payment = map.toPayment(byId(payments, "Z2lkOi8vSm9iYmVyL1BheW1lbnQvOTAx"));
    expect(payment.amount).toBe("2600.5000");
    expect(payment.allocations).toEqual([
      { invoiceSourceId: "Z2lkOi8vSm9iYmVyL0ludm9pY2UvNTAy", amount: "2600.5000" },
    ]);
  });

  it("keeps a payment with no invoice, because a deposit is still money", () => {
    const deposit = map.toPayment(byId(payments, "Z2lkOi8vSm9iYmVyL1BheW1lbnQvOTAy"));
    expect(deposit.amount).toBe("500.0000");
    expect(deposit.allocations).toEqual([]);
  });
});

describe("paging", () => {
  it("reads nodes and page info from a connection", () => {
    const page = readPage({ clients: { pageInfo: { hasNextPage: true, endCursor: "abc" }, nodes: [{ id: "1" }] } }, "clients");
    expect(page.nodes).toHaveLength(1);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("abc");
  });

  it("reads the edges form too", () => {
    const page = readPage({ clients: { pageInfo: {}, edges: [{ node: { id: "1" } }, { node: { id: "2" } }] } }, "clients");
    expect(page.nodes.map((n) => n["id"])).toEqual(["1", "2"]);
    expect(page.hasNextPage).toBe(false);
  });

  it("says which connection was missing rather than failing on undefined", () => {
    expect(() => readPage({ jobs: {} }, "clients")).toThrow(/clients/);
  });
});

describe("throttling", () => {
  it("does not wait when the bucket covers the next query", () => {
    expect(waitForBudget({ maximumAvailable: 10000, currentlyAvailable: 9000, restoreRate: 500 }, 400)).toBe(0);
  });

  it("waits exactly long enough for the bucket to refill", () => {
    // 100 short at 500 per second is 200ms. Firing early costs a round trip
    // and still leaves you waiting.
    expect(waitForBudget({ maximumAvailable: 10000, currentlyAvailable: 300, restoreRate: 500 }, 400)).toBe(200);
  });

  it("does not wait when there is no throttle information yet", () => {
    expect(waitForBudget(undefined, 400)).toBe(0);
  });

  it("reads the throttle status out of the extensions block", () => {
    expect(readThrottle({ extensions: { cost: { throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 8700, restoreRate: 500 } } } }))
      .toEqual({ maximumAvailable: 10000, currentlyAvailable: 8700, restoreRate: 500 });
    expect(readThrottle({ data: {} })).toBeUndefined();
  });
});

describe("the client", () => {
  const ok = (body: unknown) => async () => ({ status: 200, body, text: "", headers: {} });

  it("surfaces GraphQL errors instead of returning empty data", async () => {
    const client = new JobberClient("t", { transport: ok({ errors: [{ message: "Throttled" }] }) });
    await expect(client.query("query {}", {})).rejects.toThrow(JobberGraphQLError);
  });

  it("waits for the bucket before the next query", async () => {
    const waits: number[] = [];
    let call = 0;
    const client = new JobberClient("t", {
      sleep: async (ms) => { waits.push(ms); },
      transport: async () => {
        call += 1;
        return {
          status: 200,
          body: {
            data: { clients: { nodes: [], pageInfo: {} } },
            extensions: { cost: { actualQueryCost: 400, throttleStatus: { maximumAvailable: 10000, currentlyAvailable: call === 1 ? 300 : 9000, restoreRate: 500 } } },
          },
          text: "", headers: {},
        };
      },
    });

    await client.query("query {}", {});   // first call: no throttle known yet
    await client.query("query {}", {});   // second: bucket was at 300, cost 400
    expect(waits).toEqual([200]);
  });
});

describe("the adapter's declared limits", () => {
  it("tells the operator that recurrence arrives materialized", () => {
    expect(jobber.capabilities.recurrenceModel).toBe("materialized-series");
    expect(jobber.capabilities.knownLimits.join(" ")).toMatch(/recurring/i);
  });

  it("refuses an entity it has no mapping for, by name", () => {
    expect(() => jobber.toCanonical("membership", {})).toThrow(/membership/);
  });
});
