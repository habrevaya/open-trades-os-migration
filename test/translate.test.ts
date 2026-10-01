import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  customerRequest, propertyRequest, priceBookRequest, jobRequest, invoiceRequest, paymentRequest,
  estimateRequest, isoDateTime, isoDate, derivedCode, type Resolve,
} from "../src/load/translate.js";
import { emptyMapping, guessJobStatus, guessPaymentMethod, guessVisitAction, check } from "../src/mapping/index.js";
import { statusPath, validate } from "../src/target/contracts.js";
import { apiBase, requestFor, HttpTarget, TargetError } from "../src/target/client.js";
import * as jobberMap from "../src/adapters/jobber/map.js";
import * as hcpMap from "../src/adapters/housecall-pro/map.js";
import { load, byId } from "./fixtures.js";
import type { CanonicalInvoice, CanonicalJob, CanonicalPayment } from "../src/canonical/index.js";

const ids = new Map<string, string>();
const resolve: Resolve = (entity, sourceId) => {
  if (sourceId.startsWith("missing")) return undefined;
  const key = `${entity}:${sourceId}`;
  if (!ids.has(key)) ids.set(key, randomUUID());
  return ids.get(key);
};
const mapping = emptyMapping("jobber");

const invoice = (over: Partial<CanonicalInvoice> = {}): CanonicalInvoice => ({
  sourceSystem: "jobber", sourceId: "inv-1", customerSourceId: "c-1", number: 2201, status: "awaiting_payment",
  issuedOn: "2023-09-21", subtotal: "318.0000", taxTotal: "26.2400", total: "344.2400", balance: "344.2400",
  lines: [
    { name: "Visit", quantity: "2", unitPrice: "129", taxable: true, taxRate: "0", taxAmount: "0", lineTotal: "258" },
    { name: "Filter", quantity: "4", unitPrice: "15", taxable: true, taxRate: "0", taxAmount: "0", lineTotal: "60" },
  ],
  ...over,
});

describe("dates for the target", () => {
  it("writes UTC with a Z, which is the only form the contract accepts", () => {
    expect(isoDateTime("2024-03-14T09:00:00-05:00")).toBe("2024-03-14T14:00:00.000Z");
    expect(isoDateTime("2023-03-14T15:41:00")).toBe("2023-03-14T15:41:00.000Z");
  });

  it("keeps a bare date on its calendar day in every US time zone", () => {
    expect(isoDateTime("2022-11-04")).toBe("2022-11-04T12:00:00.000Z");
    expect(isoDate("2023-10-21T00:00:00Z")).toBe("2023-10-21");
    expect(isoDateTime("not a date")).toBeUndefined();
  });
});

describe("customers", () => {
  it("drops an email the target would refuse instead of losing the customer", () => {
    const t = customerRequest({
      sourceSystem: "csv", sourceId: "C-1", type: "residential", name: "Luis Ortega", email: "not-an-email",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    expect(t.body).not.toHaveProperty("email");
    expect(t.gaps).toContain("customer.contact_invalid");
    expect(validate("createCustomer", t.body).ok).toBe(true);
  });

  it("leaves off a partial billing address, which the target stores whole or not at all", () => {
    const t = customerRequest({
      sourceSystem: "csv", sourceId: "C-1", type: "residential", name: "A", billingAddress: { city: "Austin", country: "US" },
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {}, notes: "Gate sticks",
    });
    expect(t.body).not.toHaveProperty("billingAddress");
    expect(t.gaps).toEqual(expect.arrayContaining(["customer.billing_incomplete", "customer.notes"]));
  });

  it("maps a Jobber client onto a body the contract accepts", () => {
    const t = customerRequest(jobberMap.toCustomer(byId(load("jobber", "clients"), "Z2lkOi8vSm9iYmVyL0NsaWVudC8y")));
    expect(t.body).toMatchObject({
      type: "commercial", name: "Brazos Property Group", taxExempt: true,
      billingAddress: { line1: "900 Congress Ave", line2: "Suite 400", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    });
    expect(validate("createCustomer", t.body).ok).toBe(true);
  });
});

describe("properties", () => {
  it("waits for every customer it belongs to, and links the second one after", () => {
    expect(propertyRequest({
      sourceSystem: "csv", sourceId: "P-1", customerSourceIds: ["missing-1"], addressLine1: "1 A St",
      city: "Austin", state: "TX", postalCode: "78701", country: "US", customFields: {},
    }, resolve).blocked).toContain("missing-1");

    const t = propertyRequest({
      sourceSystem: "csv", sourceId: "P-2", customerSourceIds: ["C-200", "C-100"], addressLine1: "900 Congress Ave",
      city: "Austin", state: "TX", postalCode: "78701", country: "us", latitude: "30.1", customFields: {},
    }, resolve);
    expect(t.body?.customerId).toBe(resolve("customer", "C-200"));
    expect(t.body?.address.country).toBe("US");
    expect(t.plan?.links).toEqual([resolve("customer", "C-100")]);
    expect(t.gaps).toContain("property.coordinates");
  });
});

describe("price book", () => {
  it("derives a stable code for an item that has none", () => {
    expect(derivedCode("Filter, 16x25x1", "ps-2")).toBe(derivedCode("Filter, 16x25x1", "ps-2"));
    expect(derivedCode("Filter, 16x25x1", "ps-2")).toMatch(/^FILTER-16X25X1-[0-9A-F]{6}$/);
    expect(derivedCode("Service call", "a")).not.toBe(derivedCode("Service call", "b"));
    const t = priceBookRequest(jobberMap.toPriceBookItem(byId(load("jobber", "products"), "ps-2")));
    expect(t.body).toMatchObject({ kind: "material", price: "15.0000", taxable: true });
    expect(t.gaps).toEqual(["pricebook.code"]);
  });
});

describe("jobs", () => {
  const job = (over: Partial<CanonicalJob> = {}): CanonicalJob => ({
    sourceSystem: "jobber", sourceId: "j-1", customerSourceId: "c-1", propertySourceId: "p-1",
    status: "active", summary: "Maintenance", customFields: {}, visits: [], ...over,
  });

  it("schedules the first visit inline and plans the rest, skipping what cannot exist", () => {
    const t = jobRequest(job({
      visits: [
        { sourceId: "v1", sequence: 1, windowStart: "2023-03-14T14:00:00Z", windowEnd: "2023-03-14T16:00:00Z", completedAt: "2023-03-14T15:41:00Z", status: "COMPLETE", technicianSourceIds: [] },
        { sourceId: "v2", sequence: 2, windowStart: "2023-04-14T14:00:00Z", status: "CANCELLED", technicianSourceIds: [] },
        { sourceId: "v3", sequence: 3, status: "UNSCHEDULED", technicianSourceIds: [] },
        { sourceId: "v4", sequence: 4, windowStart: "2024-09-18T14:00:00Z", status: "UPCOMING", technicianSourceIds: ["u-9"] },
      ],
    }), resolve, mapping);

    expect(t.body?.visit).toEqual({
      windowStart: "2023-03-14T14:00:00.000Z", windowEnd: "2023-03-14T16:00:00.000Z",
      estimatedDurationMinutes: 120, technicianIds: [],
    });
    expect(t.plan?.visits.map((v) => [v.sourceId, v.action])).toEqual([["v1", "complete"], ["v4", "schedule"]]);
    // No end time: the window is the start alone, not an invented hour.
    expect(t.plan?.visits[1]).toMatchObject({ windowEnd: "2024-09-18T14:00:00.000Z", estimatedDurationMinutes: 60 });
    expect(t.gaps).toEqual(expect.arrayContaining(["visit.cancelled", "visit.unscheduled", "user.unmapped"]));
    expect(validate("createJob", t.body).ok).toBe(true);
  });

  it("will not load a job with nowhere to do it", () => {
    expect(jobRequest(job({ propertySourceId: "" }), resolve, mapping).invalid).toContain("property");
    expect(jobRequest(job({ customerSourceId: "missing-c" }), resolve, mapping).blocked).toContain("missing-c");
  });

  it("guesses statuses and lets the mapping file overrule them", () => {
    expect(guessJobStatus("requires_invoicing")).toBe("completed");
    expect(guessJobStatus("needs scheduling")).toBe("lead");
    expect(guessJobStatus("something odd")).toBeNull();
    expect(guessVisitAction("canceled")).toBe("skip");
    const overruled = { ...mapping, jobStatus: { active: "on_hold" as const } };
    expect(jobRequest(job(), resolve, overruled).plan?.status).toBe("on_hold");
  });

  it("walks the target's lifecycle, never through a forbidden step", () => {
    expect(statusPath("lead", "completed")).toEqual(["scheduled", "completed"]);
    expect(statusPath("scheduled", "scheduled")).toEqual([]);
    expect(statusPath("paid", "scheduled")).toBeUndefined();
  });
});

describe("invoices", () => {
  it("keeps the source's number and date in the memo, and reports the tax it cannot carry", () => {
    const t = invoiceRequest(invoice(), resolve, { mapping, carryTotals: false });
    expect(t.body?.memo).toBe("Migrated from jobber invoice #2201, issued 2023-09-21.");
    expect(t.body?.lines).toHaveLength(2);
    expect(t.plan?.expectedTotal).toBe("318.0000");
    expect(t.gaps).toEqual(expect.arrayContaining(["invoice.tax", "invoice.number", "invoice.issued_on", "ledger.dates"]));
  });

  it("carries tax and unitemised amounts as named lines only when asked", () => {
    const t = invoiceRequest(invoice({ subtotal: "400.0000", total: "426.2400" }), resolve, { mapping, carryTotals: true });
    expect(t.body?.lines.map((l) => [l.name, l.unitPrice])).toEqual([
      ["Visit", "129.0000"], ["Filter", "15.0000"],
      ["Not itemised on jobber invoice #2201", "82.0000"],
      ["Sales tax as applied on jobber invoice #2201", "26.2400"],
    ]);
    expect(t.plan?.expectedTotal).toBe("426.2400");
    expect(t.gaps).not.toContain("invoice.tax");
  });

  it("carries a line's own discount as a discount, not as a different price", () => {
    const t = invoiceRequest(invoice({
      lines: [{ name: "Labor", quantity: "3", unitPrice: "100", taxable: true, taxRate: "0", taxAmount: "0", lineTotal: "270" }],
      subtotal: "270", taxTotal: "0", total: "270",
    }), resolve, { mapping, carryTotals: false });
    expect(t.body?.lines[0]).toMatchObject({ quantity: "3.0000", unitPrice: "100.0000", discountAmount: "30.0000" });
    expect(t.gaps).not.toContain("invoice.totals");
  });

  it("never links a historical line to the price book, which would re-price it", () => {
    const t = invoiceRequest(invoice({
      lines: [{ name: "Tune up", quantity: "1", unitPrice: "99", taxable: true, taxRate: "0", taxAmount: "0", lineTotal: "99", priceBookItemSourceId: "ps-1" }],
      subtotal: "99", taxTotal: "0", total: "99",
    }), resolve, { mapping, carryTotals: false });
    expect(t.body?.lines[0]).not.toHaveProperty("priceBookItemId");
    expect(t.gaps).toContain("invoice.reprice");
  });

  it("loads an invoice with no lines as one line carrying its subtotal", () => {
    const t = invoiceRequest(invoice({ lines: [], subtotal: "125", taxTotal: "0", total: "125", number: 88001 }), resolve, { mapping, carryTotals: false });
    expect(t.body?.lines).toEqual([{ name: "Migrated from jobber invoice #88001", quantity: "1.0000", unitPrice: "125.0000", discountAmount: "0", taxable: false }]);
  });

  it("waits for its job rather than loading unlinked", () => {
    expect(invoiceRequest(invoice({ jobSourceId: "missing-job" }), resolve, { mapping, carryTotals: false }).blocked).toContain("missing-job");
  });
});

describe("payments", () => {
  const payment = (over: Partial<CanonicalPayment> = {}): CanonicalPayment => ({
    sourceSystem: "jobber", sourceId: "pay-1", customerSourceId: "c-1", method: "CREDIT_CARD", status: "completed",
    amount: "100.0000", receivedAt: "2024-01-02", allocations: [{ invoiceSourceId: "inv-1", amount: "100" }], ...over,
  });

  it("never sends a payment without allocations, which the target would apply to the oldest invoice", () => {
    const t = paymentRequest(payment({ allocations: [] }), resolve, mapping);
    expect(t.body).toBeUndefined();
    expect(t.skipped?.gap).toBe("payment.unapplied");
  });

  it("loads all of a payment's allocations or none of them", () => {
    const t = paymentRequest(payment({ allocations: [{ invoiceSourceId: "inv-1", amount: "60" }, { invoiceSourceId: "missing-inv", amount: "40" }] }), resolve, mapping);
    expect(t.blocked).toContain("missing-inv");
  });

  it("refuses allocations larger than the payment, and skips refunds and failures", () => {
    expect(paymentRequest(payment({ allocations: [{ invoiceSourceId: "inv-1", amount: "150" }] }), resolve, mapping).invalid).toContain("$150.00");
    expect(paymentRequest(payment({ amount: "-20" }), resolve, mapping).skipped?.gap).toBe("payment.refund");
    expect(paymentRequest(payment({ status: "FAILED" }), resolve, mapping).skipped?.reason).toContain("FAILED");
  });

  it("maps the method and keeps the day it arrived", () => {
    const t = paymentRequest(payment(), resolve, mapping);
    expect(t.body).toMatchObject({ method: "card", amount: "100.0000", receivedAt: "2024-01-02T12:00:00.000Z" });
    expect(guessPaymentMethod("BANK_TRANSFER")).toBe("ach");
    expect(guessPaymentMethod("Cheque")).toBe("check");
    expect(guessPaymentMethod("barter")).toBe("other");
  });
});

describe("estimates", () => {
  it("loads a Jobber quote as a draft and says what the status lost", () => {
    const quote = jobberMap.toEstimate(byId(load("jobber", "quotes"), "Z2lkOi8vSm9iYmVyL1F1b3RlLzMx"));
    const t = estimateRequest(quote, resolve, mapping);
    expect(t.body?.options).toHaveLength(1);
    expect(t.decline).toBe(false);
    expect(t.gaps).toEqual(expect.arrayContaining(["estimate.status", "estimate.number", "estimate.tax"]));
    expect(validate("createEstimate", t.body).ok).toBe(true);
  });

  it("keeps every Housecall Pro option, approved one recommended", () => {
    const estimate = hcpMap.toEstimate(byId(load("housecall-pro", "estimates"), "est_501"));
    expect(estimate.status).toBe("approved");
    expect(estimate.total).toBe("6200.0000");
    expect(estimate.propertySourceId).toBe("adr_2");
    const t = estimateRequest(estimate, resolve, mapping);
    expect(t.body?.options.map((o) => [o.name, o.isRecommended])).toEqual([["Repair", false], ["Replace", true]]);
  });
});

describe("users", () => {
  it("keeps deactivated people, who still appear on years of visits", () => {
    const users = load("jobber", "users").map((u) => jobberMap.toUser(u));
    expect(users.map((u) => [u.name, u.active])).toEqual([["Ray Ortiz", true], ["Nia Osei", false]]);
    expect(hcpMap.toUser(load("housecall-pro", "employees")[0]!)).toMatchObject({ name: "Ray Ortiz", role: "field tech" });
  });

  it("flags a target id that is not an id", () => {
    const m = emptyMapping("jobber");
    m.users["u-1"] = { name: "Ray", target: "Ray Ortiz" };
    expect(check(m).invalidTargets).toEqual(["users.u-1: Ray Ortiz"]);
  });
});

describe("requests on the wire", () => {
  it("finds the API from whichever address was pasted", () => {
    expect(apiBase("https://ots.example.com")).toBe("https://ots.example.com/api");
    expect(apiBase("https://ots.example.com/api/")).toBe("https://ots.example.com/api");
    expect(apiBase("https://ots.example.com/api/v1")).toBe("https://ots.example.com/api");
    expect(apiBase("https://example.com/ots/api")).toBe("https://example.com/ots/api");
  });

  it("puts path parameters in the path and nowhere else", () => {
    const id = randomUUID();
    expect(requestFor("scheduleVisit", { id, windowStart: "a", windowEnd: "b" })).toEqual({
      method: "POST", path: `/v1/jobs/${id}/visits`, body: JSON.stringify({ windowStart: "a", windowEnd: "b" }),
    });
    expect(requestFor("listCustomers", { limit: 200, includeInactive: true })).toEqual({
      method: "GET", path: "/v1/customers?limit=200&includeInactive=true",
    });
  });

  it("carries the token, the key and the server's field list", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const target = new HttpTarget("https://ots.example.com", "ots_abc", {
      transport: async (url, init) => {
        seen.push({ url, headers: init.headers });
        return { status: 422, headers: {}, text: "", body: { error: "Request did not match the schema", status: 422, issues: [{ path: "name", message: "Required" }] } };
      },
    });
    const error = await target.call("createCustomer", { name: "" }, { idempotencyKey: "otsm-k" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TargetError);
    expect((error as TargetError).issues).toEqual([{ path: "name", message: "Required" }]);
    expect(seen[0]).toMatchObject({
      url: "https://ots.example.com/api/v1/customers",
      headers: { authorization: "Bearer ots_abc", "idempotency-key": "otsm-k", "content-type": "application/json" },
    });
  });
});
