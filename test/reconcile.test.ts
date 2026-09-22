import { describe, it, expect } from "vitest";
import { reconcile, renderReconcile, type Side } from "../src/reconcile/index.js";

const side = (over: Partial<Side> = {}): Side => ({
  counts: { customer: 9412, job: 41022, invoice: 38110, payment: 36004 },
  invoiceTotal: "4120611.8000",
  invoiceBalance: "41206.1800",
  paymentTotal: "4079405.6200",
  paymentAllocated: "4079405.6200",
  ...over,
});

describe("reconcile", () => {
  it("matches when every count and total agrees", () => {
    const report = reconcile(side(), side());
    expect(report.matched).toBe(true);
    expect(report.counts).toEqual([]);
    expect(report.money).toEqual([]);
    expect(report.checked).toContain("customer: 9412");
  });

  it("reports a single missing record", () => {
    const report = reconcile(side(), side({ counts: { customer: 9411, job: 41022, invoice: 38110, payment: 36004 } }));
    expect(report.matched).toBe(false);
    expect(report.counts).toEqual([{ entity: "customer", expected: 9412, actual: 9411, delta: -1 }]);
  });

  it("fails on one cent by default", () => {
    // A cent of drift is almost never rounding. It is a whole record.
    const report = reconcile(side(), side({ invoiceBalance: "41206.1900" }));
    expect(report.matched).toBe(false);
    expect(report.money[0]).toMatchObject({ measure: "invoiceBalance", delta: "0.0100" });
  });

  it("honours a tolerance when one is set deliberately", () => {
    expect(reconcile(side(), side({ invoiceBalance: "41206.1900" }), 1).matched).toBe(true);
    expect(reconcile(side(), side({ invoiceBalance: "41206.2000" }), 1).matched).toBe(false);
  });

  it("reports an entity present in the target but not the source", () => {
    const report = reconcile(side({ counts: { customer: 1 } }), side({ counts: { customer: 1, equipment: 40 } }));
    expect(report.counts).toEqual([{ entity: "equipment", expected: 0, actual: 40, delta: 40 }]);
  });

  it("catches a shortfall in a direction a count check cannot see", () => {
    // Same number of invoices, less money. A count-only check passes this,
    // and the contractor finds out when they chase the wrong balance.
    const report = reconcile(side(), side({ invoiceTotal: "4120511.8000" }));
    expect(report.counts).toEqual([]);
    expect(report.money[0]?.delta).toBe("-100.0000");
  });
});

describe("the rendered report", () => {
  it("says what passed when everything matches", () => {
    expect(renderReconcile(reconcile(side(), side()))).toContain("RECONCILED");
  });

  it("says which direction a discrepancy runs", () => {
    const text = renderReconcile(reconcile(side(), side({ counts: { customer: 9400, job: 41022, invoice: 38110, payment: 36004 } })));
    expect(text).toContain("12 missing from target");
    expect(text).toContain("Do not go live");
  });

  it("shows money as dollars, not as scaled strings", () => {
    const text = renderReconcile(reconcile(side(), side({ invoiceTotal: "4120511.8000" })));
    expect(text).toContain("$4,120,611.80");
    expect(text).toContain("-$100.00");
  });
});
