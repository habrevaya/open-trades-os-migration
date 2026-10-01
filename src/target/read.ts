import * as money from "../money/index.js";
import type { EntityName } from "../canonical/index.js";
import type { Side } from "../reconcile/index.js";
import type { Ledger } from "../load/ledger.js";
import type { Target } from "./client.js";
import type { RouteName, InputOf } from "./contracts.js";

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
 * Payments cannot be read back: the API has no list of them. Their count and
 * total come from what the target confirmed when each was recorded, and the
 * report says so rather than presenting them as verified.
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

async function* everything(target: Target, route: RouteName, extra: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
  let cursor: string | undefined;
  for (;;) {
    const page = await target.call(route, { limit: 200, ...extra, ...(cursor ? { cursor } : {}) } as InputOf<typeof route>) as {
      data: Record<string, unknown>[]; nextCursor: string | null; hasMore: boolean;
    };
    for (const row of page.data) yield row;
    if (!page.hasMore || !page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

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
    for await (const row of everything(target, list.route, list.extra ?? {})) {
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

  const payments = [...ledger.of("payment")];
  if (payments.length > 0) {
    counts.payment = payments.length;
    notes.push(
      `Payments are counted and totalled from what the target confirmed when each was recorded. ` +
        `The API has no way to list them (read.payments in docs/target-api-gaps.md), so these two numbers are not read back.`,
    );
  }
  const paymentTotal = money.sum(payments.map((p) => p.amount ?? "0"));

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
