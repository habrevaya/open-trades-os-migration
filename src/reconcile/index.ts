import * as money from "../money/index.js";
import type { EntityName } from "../canonical/index.js";

/**
 * RECONCILE
 *
 * A migration is not done when the records land. It is done when the money
 * matches.
 *
 * This compares what the snapshot said against what the target reports, and
 * the comparison is deliberately narrow: record counts, and four dollar
 * totals. Those are the numbers a contractor can check themselves against a
 * report they already trust, which is the only kind of proof that is worth
 * anything to them.
 *
 * A tolerance exists and defaults to zero. Anyone tempted to raise it should
 * first read the discrepancy, because a cent of drift is almost never rounding
 * and almost always a whole record that went missing.
 */

export interface Side {
  counts: Partial<Record<EntityName, number>>;
  invoiceTotal: string;
  invoiceBalance: string;
  paymentTotal: string;
  paymentAllocated: string;
}

export interface CountDiscrepancy {
  entity: EntityName;
  expected: number;
  actual: number;
  delta: number;
}

export interface MoneyDiscrepancy {
  measure: "invoiceTotal" | "invoiceBalance" | "paymentTotal" | "paymentAllocated";
  expected: string;
  actual: string;
  delta: string;
}

export interface ReconcileReport {
  matched: boolean;
  counts: CountDiscrepancy[];
  money: MoneyDiscrepancy[];
  /** Checks that passed, kept so the report proves what it looked at. */
  checked: string[];
}

const MEASURES = ["invoiceTotal", "invoiceBalance", "paymentTotal", "paymentAllocated"] as const;

export function reconcile(expected: Side, actual: Side, toleranceCents = 0): ReconcileReport {
  const counts: CountDiscrepancy[] = [];
  const checked: string[] = [];

  const entities = new Set<EntityName>([
    ...(Object.keys(expected.counts) as EntityName[]),
    ...(Object.keys(actual.counts) as EntityName[]),
  ]);
  for (const entity of [...entities].sort()) {
    const left = expected.counts[entity] ?? 0;
    const right = actual.counts[entity] ?? 0;
    if (left === right) checked.push(`${entity}: ${left}`);
    else counts.push({ entity, expected: left, actual: right, delta: right - left });
  }

  const tolerance = money.normalize(toleranceCents, { cents: true });
  const moneyDiffs: MoneyDiscrepancy[] = [];
  for (const measure of MEASURES) {
    const delta = money.subtract(actual[measure], expected[measure]);
    if (money.compare(money.abs(delta), tolerance) <= 0) {
      checked.push(`${measure}: ${money.display(expected[measure])}`);
    } else {
      moneyDiffs.push({ measure, expected: expected[measure], actual: actual[measure], delta });
    }
  }

  return {
    matched: counts.length === 0 && moneyDiffs.length === 0,
    counts,
    money: moneyDiffs,
    checked,
  };
}

export function renderReconcile(report: ReconcileReport): string {
  if (report.matched) {
    return ["RECONCILED", "", ...report.checked.map((c) => `  ok  ${c}`)].join("\n");
  }

  const out = ["DISCREPANCIES", ""];
  for (const d of report.counts) {
    const direction = d.delta > 0 ? "more in target" : "missing from target";
    out.push(`  ${d.entity}: expected ${d.expected}, found ${d.actual} (${Math.abs(d.delta)} ${direction})`);
  }
  for (const d of report.money) {
    out.push(`  ${d.measure}: expected ${money.display(d.expected)}, found ${money.display(d.actual)}, off by ${money.display(d.delta)}`);
  }
  out.push("", "  A discrepancy of any size is a record, not a rounding error.");
  out.push("  Do not go live until every line here is explained.");
  if (report.checked.length > 0) {
    out.push("", "  Checks that passed:");
    for (const c of report.checked) out.push(`    ok  ${c}`);
  }
  return out.join("\n");
}
