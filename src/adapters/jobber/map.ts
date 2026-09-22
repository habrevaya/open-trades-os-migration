import * as money from "../../money/index.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalJob, CanonicalInvoice,
  CanonicalPayment, CanonicalVisit,
} from "../../canonical/index.js";

/**
 * JOBBER MAPPING
 *
 * Pure functions from Jobber's GraphQL shapes into the canonical model. No
 * network, no clock, no configuration. Everything here is exercised against
 * fixtures in test/jobber.test.ts, which is the only reason any of it can be
 * trusted without a live account to point at.
 *
 * Where a field's meaning was inferred from Jobber's published schema rather
 * than observed in a real export, the comment says so. Those are the lines to
 * check first when a real migration disagrees with this file.
 */

const SOURCE = "jobber";

/** Jobber returns amounts as Float dollars, which is a float in the wire JSON. */
const amount = (value: unknown): string => money.normalize(value ?? 0);

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A GraphQL connection: `{ nodes: [...] }`, or `{ edges: [{ node }] }`. */
export function nodes(connection: unknown): unknown[] {
  const conn = record(connection);
  if (Array.isArray(conn["nodes"])) return conn["nodes"] as unknown[];
  return list(conn["edges"]).map((edge) => record(edge)["node"]).filter((n) => n !== undefined);
}

/**
 * A client's display name.
 *
 * Jobber carries `companyName`, `firstName` and `lastName` independently and
 * lets all three be set. A commercial client with a contact person named on it
 * must migrate as the COMPANY, with the person as a contact, or every invoice
 * ends up addressed to the office manager who left in 2021.
 */
export function clientName(raw: Record<string, unknown>): string {
  const company = text(raw["companyName"]);
  const first = text(raw["firstName"]);
  const last = text(raw["lastName"]);
  const person = [first, last].filter(Boolean).join(" ");
  if (raw["isCompany"] === true) return company ?? person ?? "Unnamed client";
  return person || company || "Unnamed client";
}

/** Jobber allows several emails and phones per client, each flagged primary. */
function primary(entries: unknown[], key: string): string | undefined {
  const parsed = entries.map(record);
  const flagged = parsed.find((e) => e["primary"] === true);
  return text((flagged ?? parsed[0] ?? {})[key]);
}

function address(raw: unknown) {
  const a = record(raw);
  const street1 = text(a["street1"]) ?? text(a["street"]);
  return {
    line1: street1,
    line2: text(a["street2"]),
    city: text(a["city"]),
    state: text(a["province"]) ?? text(a["state"]),
    postalCode: text(a["postalCode"]),
    country: text(a["country"]) ?? "US",
  };
}

export function toCustomer(raw: Record<string, unknown>): CanonicalCustomer {
  const emails = list(raw["emails"]);
  const phones = list(raw["phones"]);
  const billing = address(raw["billingAddress"]);
  const hasBilling = Object.values(billing).some((v) => v !== undefined && v !== "US");

  return CanonicalCustomerLike({
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    type: raw["isCompany"] === true ? "commercial" : "residential",
    name: clientName(raw),
    email: primary(emails, "address"),
    phone: primary(phones, "number"),
    billingAddress: hasBilling ? billing : undefined,
    leadSource: text(record(raw["clientProperties"])["source"]) ?? text(raw["source"]),
    // Jobber does not expose net terms on the client in the public schema, so
    // this defaults to due-on-receipt and the operator sets it during `map`
    // rather than the toolkit inventing a term nobody agreed to.
    paymentTermsDays: 0,
    taxExempt: raw["isTaxExempt"] === true,
    notes: text(raw["note"]) ?? text(raw["notes"]),
    tags: list(raw["tags"]).map((t) => (typeof t === "string" ? t : text(record(t)["label"]) ?? "")).filter(Boolean),
    customFields: customFields(raw["customFields"]),
  });
}

/** Keeps the object literal honest against the schema's optional fields. */
function CanonicalCustomerLike(value: CanonicalCustomer): CanonicalCustomer { return value; }

/**
 * Jobber custom fields arrive as a list of `{ label, valueText|valueNumeric|... }`.
 * Flattened to label-keyed values, because that is what an operator recognises
 * when they are asked where a field should land.
 */
export function customFields(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of list(raw)) {
    const field = record(entry);
    const label = text(field["label"]) ?? text(field["name"]);
    if (!label) continue;
    const value =
      field["valueText"] ?? field["valueNumeric"] ?? field["valueBoolean"] ??
      field["valueDate"] ?? field["valueLink"] ?? field["value"];
    if (value !== undefined && value !== null && value !== "") out[label] = value;
  }
  return out;
}

/**
 * Jobber properties already exist as their own records, so unlike several
 * sources this adapter does not have to split anything. It does have to keep
 * the link: a property belongs to exactly one client in Jobber, but the
 * canonical model allows several, because the target supports a property
 * shared by an owner and a property manager.
 */
export function toProperty(raw: Record<string, unknown>): CanonicalProperty {
  const a = address(raw["address"]);
  const clientId = String(record(raw["client"])["id"] ?? raw["clientId"] ?? "");
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceIds: clientId ? [clientId] : [],
    nickname: text(raw["name"]),
    addressLine1: a.line1 ?? "",
    addressLine2: a.line2,
    city: a.city ?? "",
    state: a.state ?? "",
    postalCode: a.postalCode ?? "",
    country: a.country ?? "US",
    latitude: text(record(raw["address"])["latitude"]) ?? numberText(record(raw["address"])["latitude"]),
    longitude: text(record(raw["address"])["longitude"]) ?? numberText(record(raw["address"])["longitude"]),
    customFields: customFields(raw["customFields"]),
  };
}

const numberText = (v: unknown): string | undefined => (typeof v === "number" ? String(v) : undefined);

/**
 * Visit status.
 *
 * Jobber's `visitStatus` and the target's visit states do not line up, and the
 * gap is not cosmetic. Jobber has no equivalent of "completed after
 * cancellation", so a visit that was cancelled in the office and worked anyway
 * arrives here as completed with a cancellation in its history. The canonical
 * status is kept as the SOURCE string and translated during transform, where
 * the operator can see the mapping, rather than being flattened here.
 */
export function toVisit(raw: Record<string, unknown>, sequence: number): CanonicalVisit {
  const assigned = nodes(raw["assignedUsers"]).map((u) => String(record(u)["id"] ?? "")).filter(Boolean);
  return {
    sourceId: String(raw["id"] ?? ""),
    sequence,
    windowStart: text(raw["startAt"]),
    windowEnd: text(raw["endAt"]),
    completedAt: text(raw["completedAt"]),
    technicianSourceIds: assigned,
    status: text(raw["visitStatus"]) ?? text(raw["status"]) ?? "unknown",
    notes: text(raw["instructions"]) ?? text(raw["notes"]),
  };
}

export function toJob(raw: Record<string, unknown>): CanonicalJob {
  const visits = nodes(raw["visits"])
    .map(record)
    // Jobber returns visits in creation order, which for a rescheduled visit is
    // not chronological order. Sequence has to come from the calendar, because
    // "visit 3 of 6" on a maintenance plan is what the customer was told.
    .sort((a, b) => String(a["startAt"] ?? "").localeCompare(String(b["startAt"] ?? "")))
    .map((v, index) => toVisit(v, index + 1));

  const total = record(raw["total"]);
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceId: String(record(raw["client"])["id"] ?? ""),
    propertySourceId: String(record(raw["property"])["id"] ?? ""),
    number: intOrUndefined(raw["jobNumber"]),
    status: text(raw["jobStatus"]) ?? "unknown",
    summary: text(raw["title"]) ?? `Job ${raw["jobNumber"] ?? ""}`.trim(),
    description: text(raw["instructions"]) ?? text(raw["description"]),
    jobType: text(raw["jobType"]),
    leadSource: text(raw["source"]),
    total: raw["total"] === undefined ? amount(total["total"]) : amount(raw["total"]),
    completedAt: text(raw["completedAt"]),
    visits,
    customFields: customFields(raw["customFields"]),
  };
}

const intOrUndefined = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
};

/**
 * Invoice totals are taken as the source printed them and never recomputed.
 *
 * It is tempting to derive the subtotal from the lines, and it is wrong. A
 * five-year-old invoice carries the tax rate that applied then, a discount
 * that may no longer exist, and occasionally an adjustment made by hand.
 * Recomputing produces a number that is arithmetically defensible and does not
 * match what the customer paid, which is the only number that matters.
 */
export function toInvoice(raw: Record<string, unknown>): CanonicalInvoice {
  const amounts = record(raw["amounts"]);
  const lines = nodes(raw["lineItems"]).map(record).map((li) => {
    const quantity = money.normalize(li["quantity"] ?? 1);
    const unitPrice = amount(li["unitPrice"] ?? li["unitCost"]);
    return {
      name: text(li["name"]) ?? "Line item",
      description: text(li["description"]),
      quantity,
      unitPrice,
      taxable: li["taxable"] !== false,
      taxRate: "0",
      taxAmount: "0.0000",
      lineTotal: li["totalPrice"] === undefined ? money.multiply(quantity, unitPrice) : amount(li["totalPrice"]),
      priceBookItemSourceId: text(record(li["linkedProductOrService"])["id"]),
    };
  });

  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceId: String(record(raw["client"])["id"] ?? ""),
    jobSourceId: text(record(nodes(raw["jobs"])[0])["id"]),
    number: intOrUndefined(raw["invoiceNumber"]),
    status: text(raw["invoiceStatus"]) ?? "unknown",
    issuedOn: text(raw["issuedDate"]) ?? text(raw["createdAt"]),
    dueOn: text(raw["dueDate"]),
    subtotal: amount(amounts["subtotal"]),
    taxTotal: amount(amounts["taxAmount"] ?? amounts["total_tax"]),
    total: amount(amounts["total"]),
    balance: amount(amounts["invoiceBalance"] ?? amounts["balance"]),
    lines,
  };
}

/**
 * Payments and their allocations.
 *
 * Jobber's payment record names the invoice it was applied to. A payment with
 * no invoice is a deposit or an account credit, and it must still migrate: a
 * customer who paid a 50% deposit on a job that has not started has money with
 * the contractor, and dropping it because there is no invoice to hang it on is
 * how a migration loses real dollars.
 */
export function toPayment(raw: Record<string, unknown>): CanonicalPayment {
  const total = amount(raw["amount"] ?? record(raw["amounts"])["total"]);
  const invoiceId = text(record(raw["invoice"])["id"]);
  const explicit = nodes(raw["appliedToInvoices"]).map(record).map((entry) => ({
    invoiceSourceId: String(record(entry["invoice"])["id"] ?? entry["invoiceId"] ?? ""),
    amount: amount(entry["amount"]),
  })).filter((a) => a.invoiceSourceId !== "");

  const allocations = explicit.length > 0
    ? explicit
    : invoiceId
      ? [{ invoiceSourceId: invoiceId, amount: total }]
      : [];

  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    customerSourceId: String(record(raw["client"])["id"] ?? ""),
    method: text(raw["paymentType"]) ?? text(raw["method"]) ?? "unknown",
    status: text(raw["paymentStatus"]) ?? "completed",
    amount: total,
    receivedAt: text(raw["entryDate"]) ?? text(raw["createdAt"]) ?? "",
    allocations,
  };
}
