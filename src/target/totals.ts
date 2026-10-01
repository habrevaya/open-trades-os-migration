import * as money from "../money/index.js";

/**
 * THE TARGET'S INVOICE ARITHMETIC
 *
 * Core's ledger `computeInvoice`, restated so that the loader can predict to
 * the cent what the target will compute from the lines it sends, and so the
 * in-memory target computes the same thing. Kept apart from both so neither
 * imports the other.
 */

/**
 * core ledger TaxAsAppliedError: a stated tax not within rounding of its
 * own rate on the line's net.
 */
export class TaxAsAppliedError extends Error {
  constructor(public readonly line: number, expected: string, given: string) {
    super(`Line ${line + 1} states tax of ${given}, and its rate on its taxable amount is ${expected}. ` +
      "A stated tax may differ from that by rounding, never by more.");
    this.name = "TaxAsAppliedError";
  }
}

export interface InvoiceLineInput {
  quantity: string; unitPrice: string; discountAmount?: string; taxable: boolean; taxRate: string; taxAmount?: string;
}

export interface InvoiceTotals { subtotal: string; discountTotal: string; taxTotal: string; total: string }

/**
 * core ledger computeInvoice, line for line. Products at four places, half
 * away from zero; tax summed at four places and the document rounded once to
 * two. The loader uses the same function to predict what it will be told.
 */
export function computeInvoice(lines: readonly InvoiceLineInput[]): {
  lines: { taxAmount: string; lineTotal: string }[]; totals: InvoiceTotals;
} {
  const computed = lines.map((line, index) => {
    const gross = money.multiply(line.unitPrice, line.quantity);
    const discount = money.normalize(line.discountAmount ?? "0");
    const net = money.subtract(gross, discount);
    const owed = line.taxable ? money.multiplyRate(net, line.taxRate) : "0.0000";
    let tax = owed;
    if (line.taxAmount !== undefined) {
      const stated = money.normalize(line.taxAmount);
      if (!line.taxable) {
        if (!money.isZero(stated)) throw new TaxAsAppliedError(index, owed, stated);
      } else if (money.compare(money.abs(money.subtract(stated, owed)), "0.01") >= 0) {
        throw new TaxAsAppliedError(index, owed, stated);
      }
      tax = stated;
    }
    return { gross, discount, net, tax };
  });
  const subtotal = money.round(money.sum(computed.map((l) => l.gross)), 2);
  const discountTotal = money.round(money.sum(computed.map((l) => l.discount)), 2);
  const taxTotal = money.round(money.sum(computed.map((l) => l.tax)), 2);
  const total = money.round(money.add(money.subtract(subtotal, discountTotal), taxTotal), 2);
  return {
    lines: computed.map((l) => ({ taxAmount: money.round(l.tax, 2), lineTotal: money.round(l.net, 2) })),
    totals: { subtotal, discountTotal, taxTotal, total },
  };
}
