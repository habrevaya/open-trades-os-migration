import * as money from "../money/index.js";
import type { EntityName } from "../canonical/index.js";
import type { Side } from "../reconcile/index.js";
import type { Ledger } from "../load/ledger.js";
import type { Target } from "./client.js";
import type { RouteName } from "./contracts.js";
import { pages } from "./client.js";

/**
 * WHAT THE TARGET ACTUALLY HOLDS
 *
 * Reconcile's other side, read back from OpenTradesOS through the same public
 * API the load wrote through. Not from the ledger: the ledger is what the
 * loader BELIEVES it made, and a reconcile that compared the snapshot with
 * the loader's own notes would prove only that the loader agrees with itself.
 *
 * It counts only records the ledger names, because a real tenant has other
 * data in it (last week's jobs, a customer someone typed in during the
 * migration) and counting those would hide a missing record behind an extra
 * one. Records the target holds that this migration did not make are counted
 * separately and shown, so nobody wonders.
 *
 * Payments are read back through GET /v1/payments, a page under `data` at a
 * time by cursor: their count, what arrived less what was given back, and
 * the money each still holds for the customer. The `totals` and `byMethod`
 * the route returns beside each page are not used: they are the core's
 * banking summary for every payment in the company, not only this
 * migration's, and are computed over at most 500 of them. A refund in the source is a record of its own there and an
 * amount off its payment here, so it counts as present when its payment is.
 */

export interface TargetReading {
  side: Side;
  /** Per entity: records this migration made that the target no longer has. */
  missing: Partial<Record<EntityName, number>>;
  /** Per entity: records in the target this migration did not make. */
  other: Partial<Record<EntityName, number>>;
  notes: string[];
}

const LISTS: { entity: EntityName; route: RouteName; extra?: Record<string, unknown> }[] = [
  { entity: "customer", route: "listCustomers", extra: { includeInactive: true } },
  { entity: "property", route: "listProperties" },
  { entity: "priceBookItem", route: "listPriceBook", extra: { includeInactive: true } },
  { entity: "job", route: "listJobs" },
  { entity: "estimate", route: "listEstimates" },
  { entity: "invoice", route: "listInvoices" },
];

export async function readTarget(target: Target, ledger: Ledger): Promise<TargetReading> {
  const counts: Partial<Record<EntityName, number>> = {};
  const missing: Partial<Record<EntityName, number>> = {};
  const other: Partial<Record<EntityName, number>> = {};
  const notes: string[] = [];

  let invoiceTotal = "0";
  let invoiceBalance = "0";
  let paymentAllocated = "0";

  for (const list of LISTS) {
    const ours = new Set([...ledger.of(list.entity)].map((e) => e.target));
    if (ours.size === 0) continue;
    let found = 0;
    let others = 0;
    for await (const row of pages(target, list.route, list.extra ?? {})) {
      if (!ours.has(String(row["id"]))) { others += 1; continue; }
      found += 1;
      if (list.entity === "invoice") {
        invoiceTotal = money.add(invoiceTotal, String(row["total"] ?? "0"));
        invoiceBalance = money.add(invoiceBalance, String(row["balance"] ?? "0"));
        paymentAllocated = money.add(paymentAllocated, String(row["amountPaid"] ?? "0"));
      }
    }
    counts[list.entity] = found;
    if (found < ours.size) missing[list.entity] = ours.size - found;
    if (others > 0) other[list.entity] = others;
  }

  // Payments, read back. The ledger names each payment this migration
  // recorded, and each refund by the payment it was recorded against.
  const payments = [...ledger.of("payment")];
  let paymentTotal = "0";
  let unapplied = "0";
  if (payments.length > 0) {
    const ours = new Set(payments.map((p) => p.target));
    const found = new Set<string>();
    let others = 0;
    for await (const row of pages(target, "listPayments", {})) {
      const id = String(row["id"]);
      if (!ours.has(id)) { others += 1; continue; }
      found.add(id);
      paymentTotal = money.add(paymentTotal, money.subtract(String(row["amount"] ?? "0"), String(row["refundedAmount"] ?? "0")));
      unapplied = money.add(unapplied, String(row["unappliedAmount"] ?? "0"));
    }
    counts.payment = payments.filter((p) => found.has(p.target)).length;
    const gone = payments.length - counts.payment;
    if (gone > 0) missing.payment = gone;
    if (others > 0) other.payment = others;
    if (!money.isZero(unapplied)) {
      notes.push(`${money.display(unapplied)} of the payments read back is held for customers, applied to no invoice (deposits and credits).`);
    }
  }

  // Recurring schedules carry no externalRef; the ledger's ids are what is ours.
  const scheduleIds = new Set([...ledger.of("recurringSchedule")].map((e) => e.target));
  if (scheduleIds.size > 0) {
    const listed = (await target.call("listRecurringSchedules", {})).schedules;
    counts.recurringSchedule = listed.filter((s) => scheduleIds.has(s.id)).length;
    const gone = scheduleIds.size - counts.recurringSchedule;
    if (gone > 0) missing.recurringSchedule = gone;
    const others = listed.length - counts.recurringSchedule;
    if (others > 0) other.recurringSchedule = others;
  }

  for (const [entity, n] of Object.entries(missing)) {
    notes.push(`${n} ${entity} record(s) the ledger says were created are not in the target. Deleted since, or a different tenant.`);
  }
  for (const [entity, n] of Object.entries(other)) {
    notes.push(`The target also holds ${n} ${entity} record(s) this migration did not create. They are not counted.`);
  }

  return {
    side: {
      counts,
      invoiceTotal: money.normalize(invoiceTotal),
      invoiceBalance: money.normalize(invoiceBalance),
      paymentTotal: money.normalize(paymentTotal),
      // Allocated money is read from the invoices, which can be listed: the
      // sum of what has been paid against the invoices this migration made.
      paymentAllocated: money.normalize(paymentAllocated),
    },
    missing, other, notes,
  };
}
