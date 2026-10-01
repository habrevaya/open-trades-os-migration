import * as money from "../../money/index.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalJob, CanonicalInvoice,
  CanonicalPayment, CanonicalVisit, CanonicalInvoiceLine, CanonicalUser,
  CanonicalEstimate,
} from "../../canonical/index.js";

/**
 * HOUSECALL PRO MAPPING
 *
 * Two differences from Jobber shape the whole file, and between them they are
 * most of what makes a second adapter worth writing before a tenth.
 *
 * Money is INTEGER CENTS here, not float dollars. Every amount goes through
 * `money.normalize(value, { cents: true })`, and forgetting that on one field
 * produces an invoice a hundred times too large, which at least fails loudly.
 * Forgetting it in the other direction is the dangerous one.
 *
 * Addresses are EMBEDDED IN THE CUSTOMER as a list, not separate records. So
 * this adapter has to split one source record into a customer plus N
 * properties and mint stable property ids, because there are none to carry
 * over. Every job then has to resolve back to the property it names. That
 * split is where this migration is won or lost.
 */

const SOURCE = "housecall-pro";

const cents = (value: unknown): string => money.normalize(value ?? 0, { cents: true });

const text = (value: unknown): string | undefined => {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Housecall Pro addresses have ids, and they are stable, so the derived
 * property id uses the source id when there is one.
 *
 * When there is not, and there are exports where there is not, the id is
 * derived from the customer id plus the normalized address text. That
 * derivation must be STABLE across runs or a re-run creates a second copy of
 * every property, which defeats the idempotence the whole toolkit rests on.
 * It deliberately does not include the nickname, because renaming "Shop" to
 * "Warehouse" must not orphan four years of job history.
 */
export function propertyId(customerId: string, address: Record<string, unknown>): string {
  const explicit = text(address["id"]);
  if (explicit) return explicit;
  const parts = [
    text(address["street"]) ?? text(address["street_line_2"]) ?? "",
    text(address["city"]) ?? "",
    text(address["state"]) ?? "",
    text(address["zip"]) ?? "",
  ].map((p) => p.toLowerCase().replace(/\s+/g, " ").trim());
  return `derived:${customerId}:${parts.join("|")}`;
}

export function toCustomer(raw: Record<string, unknown>): CanonicalCustomer {
  const first = text(raw["first_name"]);
  const last = text(raw["last_name"]);
  const company = text(raw["company"]) ?? text(raw["company_name"]);
  const person = [first, last].filter(Boolean).join(" ");

  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    type: company && !person ? "commercial" : company ? "commercial" : "residential",
    name: company ?? person ?? text(raw["email"]) ?? "Unnamed customer",
    email: text(raw["email"]),
    phone: text(raw["mobile_number"]) ?? text(raw["home_number"]) ?? text(raw["work_number"]),
    billingAddress: billingFrom(raw),
    leadSource: text(raw["lead_source"]),
    paymentTermsDays: 0,
    taxExempt: raw["tax_exempt"] === true,
    notes: text(raw["notes"]),
    tags: list(raw["tags"]).map((t) => (typeof t === "string" ? t : text(record(t)["name"]) ?? "")).filter(Boolean),
    customFields: {},
  };
}

/**
 * Billing address is the one flagged as such, and failing that the first
 * address on the record. Housecall Pro does not always flag one, and picking
 * nothing would mean invoices with no address on a migration where the source
 * clearly had one.
 */
function billingFrom(raw: Record<string, unknown>) {
  const addresses = list(raw["addresses"]).map(record);
  const chosen = addresses.find((a) => a["type"] === "billing") ?? addresses[0];
  if (!chosen) return undefined;
  return {
    line1: text(chosen["street"]),
    line2: text(chosen["street_line_2"]),
    city: text(chosen["city"]),
    state: text(chosen["state"]),
    postalCode: text(chosen["zip"]),
    country: text(chosen["country"]) ?? "US",
  };
}

/** One customer becomes one customer and as many properties as it has addresses. */
export function toProperties(raw: Record<string, unknown>): CanonicalProperty[] {
  const customerId = String(raw["id"] ?? "");
  const seen = new Set<string>();
  const out: CanonicalProperty[] = [];

  for (const entry of list(raw["addresses"]).map(record)) {
    const id = propertyId(customerId, entry);
    // The same address can appear twice on one customer, flagged both billing
    // and service. That is one place, and importing it twice gives the
    // technician two identical rows to pick between.
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      sourceSystem: SOURCE,
      sourceId: id,
      sourcePayload: entry,
      customerSourceIds: [customerId],
      nickname: text(entry["nickname"]) ?? text(entry["name"]),
      addressLine1: text(entry["street"]) ?? "",
      addressLine2: text(entry["street_line_2"]),
      city: text(entry["city"]) ?? "",
      state: text(entry["state"]) ?? "",
      postalCode: text(entry["zip"]) ?? "",
      country: text(entry["country"]) ?? "US",
      customFields: {},
    });
  }
  return out;
}

/**
 * A Housecall Pro job is one scheduled block, so it produces exactly one
 * visit. That is not a simplification: the source genuinely has no concept of
 * a job spanning several appointments, and inventing extra visits to make the
 * shapes match would fabricate history.
 *
 * The arrival window is carried because it is a promise made to a customer.
 * `scheduled_start` alone says the technician is coming at 9:00; the window
 * says the customer was told 8:00 to 10:00, and those are different facts.
 */
export function toVisit(raw: Record<string, unknown>): CanonicalVisit {
  const schedule = record(raw["schedule"]);
  const start = text(schedule["scheduled_start"]);
  const end = text(schedule["scheduled_end"]);
  const windowMinutes = Number(schedule["arrival_window"] ?? 0);

  return {
    sourceId: String(raw["id"] ?? ""),
    sequence: 1,
    windowStart: start,
    windowEnd: end ?? (start && Number.isFinite(windowMinutes) && windowMinutes > 0
      ? new Date(new Date(start).getTime() + windowMinutes * 60_000).toISOString()
      : undefined),
    completedAt: text(record(raw["work_timestamps"])["completed_at"]),
    technicianSourceIds: list(raw["assigned_employees"]).map((e) => String(record(e)["id"] ?? "")).filter(Boolean),
    status: text(raw["work_status"]) ?? "unknown",
    notes: text(raw["note"]) ?? text(raw["description"]),
  };
}

export function toJob(raw: Record<string, unknown>): CanonicalJob {
  const customerId = String(record(raw["customer"])["id"] ?? raw["customer_id"] ?? "");
  const addr = record(raw["address"]);
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceId: customerId,
    propertySourceId: propertyId(customerId, addr),
    number: intOrUndefined(raw["invoice_number"] ?? raw["job_number"]),
    status: text(raw["work_status"]) ?? "unknown",
    summary: text(raw["description"]) ?? text(record(raw["job_fields"])["job_type"]) ?? "Job",
    description: text(raw["note"]),
    jobType: text(record(record(raw["job_fields"])["job_type"])["name"]) ?? text(record(raw["job_fields"])["job_type"]),
    leadSource: text(record(raw["lead_source"])["name"]) ?? text(raw["lead_source"]),
    total: cents(raw["total_amount"]),
    completedAt: text(record(raw["work_timestamps"])["completed_at"]),
    visits: [toVisit(raw)],
    customFields: {},
  };
}

const intOrUndefined = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
};

/** Line items, in cents, shared by invoices and estimate options. */
function lineItems(value: unknown): CanonicalInvoiceLine[] {
  return list(value).map(record).map((li) => {
    const quantity = money.normalize(li["quantity"] ?? 1);
    const unitPrice = cents(li["unit_price"] ?? li["amount"]);
    return {
      name: text(li["name"]) ?? "Line item",
      description: text(li["description"]),
      quantity,
      unitPrice,
      taxable: li["taxable"] !== false,
      taxRate: "0",
      taxAmount: "0.0000",
      lineTotal: li["total"] === undefined ? money.multiply(quantity, unitPrice) : cents(li["total"]),
      priceBookItemSourceId: text(li["price_book_item_uuid"]) ?? text(li["service_item_id"]),
    };
  });
}

/**
 * Housecall Pro does not separate job from invoice the way Jobber does: an
 * invoice is largely a view over the job's line items and totals. The invoice
 * is still materialized here, because receivables have to exist as documents
 * for the balance to mean anything, and `outstanding_balance` is the number a
 * contractor will check first on the morning after the cutover.
 */
export function toInvoice(raw: Record<string, unknown>): CanonicalInvoice {
  const customerId = String(record(raw["customer"])["id"] ?? raw["customer_id"] ?? "");
  const lines = lineItems(raw["line_items"]);

  const total = cents(raw["total_amount"]);
  const tax = cents(raw["tax_amount"]);
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceId: customerId,
    jobSourceId: text(raw["job_id"]) ?? text(raw["id"]),
    number: intOrUndefined(raw["invoice_number"]),
    status: text(raw["invoice_status"]) ?? text(raw["work_status"]) ?? "unknown",
    issuedOn: text(raw["invoice_date"]) ?? text(raw["created_at"]),
    dueOn: text(raw["due_at"]) ?? text(raw["due_date"]),
    subtotal: money.subtract(total, tax),
    taxTotal: tax,
    total,
    balance: cents(raw["outstanding_balance"] ?? raw["balance"]),
    lines,
  };
}

export function toPayment(raw: Record<string, unknown>): CanonicalPayment {
  const amount = cents(raw["amount"]);
  const invoiceId = text(raw["invoice_id"]) ?? text(record(raw["invoice"])["id"]) ?? text(raw["job_id"]);
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceId: String(record(raw["customer"])["id"] ?? raw["customer_id"] ?? ""),
    method: text(raw["payment_method"]) ?? text(raw["type"]) ?? "unknown",
    status: text(raw["status"]) ?? "completed",
    amount,
    receivedAt: text(raw["paid_at"]) ?? text(raw["created_at"]) ?? "",
    allocations: invoiceId ? [{ invoiceSourceId: invoiceId, amount }] : [],
  };
}

/** Employees. Housecall Pro has no deactivated flag in the list response we have seen. */
export function toUser(raw: Record<string, unknown>): CanonicalUser {
  const name = [text(raw["first_name"]), text(raw["last_name"])].filter(Boolean).join(" ");
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    name: name || text(raw["email"]) || "Unnamed employee",
    email: text(raw["email"]),
    phone: text(raw["mobile_number"]),
    active: raw["is_active"] !== false,
    role: text(raw["role"]),
  };
}

/**
 * Estimates.
 *
 * Housecall Pro puts the options, and the approval, on the estimate's
 * `options` array, each with its own line items and an `approval_status`.
 * The shape here is read from the published API reference and has not yet
 * been checked against a real export, so these are the lines to look at
 * first when a real one disagrees.
 *
 * Status is lifted from the options, because that is where the customer's
 * decision lives: an estimate with one approved option is approved, whatever
 * the estimate's own `work_status` says about scheduling.
 */
export function toEstimate(raw: Record<string, unknown>): CanonicalEstimate {
  const customerId = String(record(raw["customer"])["id"] ?? raw["customer_id"] ?? "");
  const options = list(raw["options"]).map(record);
  const approvals = options.map((o) => (text(o["approval_status"]) ?? "").toLowerCase());
  const status = approvals.includes("approved") ? "approved"
    : approvals.length > 0 && approvals.every((a) => a === "declined") ? "declined"
    : text(raw["work_status"]) ?? "unknown";

  const address = record(raw["address"]);
  const totals = options.map((o) => cents(o["total_amount"]));
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceId: customerId,
    propertySourceId: Object.keys(address).length > 0 ? propertyId(customerId, address) : undefined,
    number: intOrUndefined(raw["estimate_number"]),
    status,
    title: text(raw["description"]) ?? text(raw["note"]),
    issuedOn: text(raw["created_at"]),
    // The approved option's total when there is one, because that is the
    // number the customer agreed to. Summing every option would add the
    // repair to the replacement.
    total: totals[approvals.indexOf("approved")] ?? totals[0] ?? "0.0000",
    subtotal: totals[approvals.indexOf("approved")] ?? totals[0] ?? "0.0000",
    taxTotal: "0.0000",
    options: options.map((o, i) => ({
      name: text(o["name"]) ?? `Option ${i + 1}`,
      isRecommended: approvals[i] === "approved",
      lines: lineItems(o["line_items"]),
    })),
  };
}
