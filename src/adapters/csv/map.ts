import * as money from "../../money/index.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalJob, CanonicalInvoice, CanonicalPayment,
  CanonicalVisit, CanonicalInvoiceLine, CanonicalUser, CanonicalPriceBookItem,
  CanonicalEstimate, CanonicalAttachment, CanonicalEquipment, CanonicalContact,
  CanonicalRecurringSchedule,
} from "../../canonical/index.js";

/**
 * GENERIC CSV MAPPING
 *
 * The rows reaching this file have already had their headers renamed to the
 * documented column names (docs/generic-csv.md) and their child files joined
 * on: an invoice row carries `lines`, a job row carries `visits`, a payment
 * row carries `allocations`. So everything here is the same kind of pure
 * function as the API adapters' mappings, and is tested the same way.
 *
 * A CSV has no types. Every value is a string, an empty cell means absent,
 * and the few things that are not strings (money, booleans, integers, lists)
 * are parsed here and nowhere else, strictly: a cell that does not parse is a
 * failed record on the report, never a zero.
 */

const SOURCE = "csv";

export type Row = Record<string, unknown>;

export interface CsvSettings {
  /** True when every money column is integer cents rather than dollars. */
  cents: boolean;
  /** How to read an all-numeric date like 03/04/2024. US exports are MDY. */
  dateOrder: "MDY" | "DMY";
}

export const DEFAULT_SETTINGS: CsvSettings = { cents: false, dateOrder: "MDY" };

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const required = (row: Row, column: string, entity: string): string => {
  const value = text(row[column]);
  if (value === undefined) throw new Error(`${entity} row has no ${column}`);
  return value;
};

/** `;` separated, because a comma inside a CSV cell is a quoting accident waiting to happen. */
const listOf = (value: unknown): string[] =>
  (text(value) ?? "").split(";").map((v) => v.trim()).filter((v) => v !== "");

/**
 * Booleans as spreadsheets write them. Anything not recognised throws,
 * because "tax exempt: maybe" read as false is a customer charged tax they
 * do not owe.
 */
export function bool(value: unknown, fallback: boolean): boolean {
  const v = (text(value) ?? "").toLowerCase();
  if (v === "") return fallback;
  if (["true", "yes", "y", "1", "x"].includes(v)) return true;
  if (["false", "no", "n", "0"].includes(v)) return false;
  throw new Error(`Not a yes/no value: ${JSON.stringify(value)}`);
}

export function int(value: unknown): number | undefined {
  const v = text(value);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new Error(`Not a whole number: ${JSON.stringify(value)}`);
  return Number(v);
}

/** Money through src/money, honouring the file-wide cents setting. */
export function amount(value: unknown, settings: CsvSettings): string {
  return money.normalize(text(value) ?? "", { cents: settings.cents });
}

/** Quantities are never cents, whatever the money columns are. */
const quantity = (value: unknown): string => {
  const v = text(value);
  return v === undefined ? "1.0000" : money.normalize(v);
};

/**
 * Dates and timestamps.
 *
 * ISO 8601 passes through untouched. A slashed all-numeric date is read in
 * the configured order and written as YYYY-MM-DD, because that is the one
 * form every later stage and the target agree on. Anything else is refused
 * rather than guessed at: "next Tuesday" in a due date column is real, and
 * so is "3/4" with no year.
 */
export function date(value: unknown, settings: CsvSettings): string | undefined {
  const v = text(value);
  if (v === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return v.replace(" ", "T");
  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/.exec(v);
  if (slashed) {
    const [, a, b, year, hh, mm, ss, meridiem] = slashed;
    const [month, day] = settings.dateOrder === "MDY" ? [a!, b!] : [b!, a!];
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) {
      throw new Error(`Not a ${settings.dateOrder} date: ${JSON.stringify(value)}`);
    }
    const day10 = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (hh === undefined) return day10;
    // Spreadsheet exports from Windows desktop software (FieldEdge among
    // them) write 3:41 PM. That is unambiguous, so it is read; 13:41 PM is
    // not, so it is refused.
    let hour = Number(hh);
    if (meridiem) {
      if (hour < 1 || hour > 12) throw new Error(`Not a 12-hour time: ${JSON.stringify(value)}`);
      const pm = meridiem.toLowerCase() === "p";
      hour = pm ? (hour % 12) + 12 : hour % 12;
    }
    if (hour > 23 || Number(mm) > 59) throw new Error(`Not a time of day: ${JSON.stringify(value)}`);
    return `${day10}T${String(hour).padStart(2, "0")}:${mm}:${ss ?? "00"}`;
  }
  throw new Error(`Not a date this importer can read without guessing: ${JSON.stringify(value)}`);
}

/** Every column named `custom:<label>` becomes a custom field called <label>. */
function customFields(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("custom:")) continue;
    const v = text(value);
    if (v !== undefined) out[key.slice("custom:".length)] = v;
  }
  return out;
}

const base = (row: Row, entity: string) => ({
  sourceSystem: SOURCE,
  sourceId: required(row, "id", entity),
  sourcePayload: row,
});

export function toUser(row: Row, settings: CsvSettings): CanonicalUser {
  void settings;
  return {
    ...base(row, "user"),
    name: text(row["name"]) ?? text(row["email"]) ?? "Unnamed user",
    email: text(row["email"]),
    phone: text(row["phone"]),
    active: bool(row["active"], true),
    role: text(row["role"]),
  };
}

export function toCustomer(row: Row, settings: CsvSettings): CanonicalCustomer {
  const type = (text(row["type"]) ?? "residential").toLowerCase();
  if (type !== "residential" && type !== "commercial") {
    throw new Error(`customer type must be residential or commercial, not ${JSON.stringify(row["type"])}`);
  }
  const billing = {
    line1: text(row["billing_line1"]),
    line2: text(row["billing_line2"]),
    city: text(row["billing_city"]),
    state: text(row["billing_state"]),
    postalCode: text(row["billing_postal_code"]),
    country: text(row["billing_country"]) ?? "US",
  };
  const hasBilling = [billing.line1, billing.line2, billing.city, billing.state, billing.postalCode].some(Boolean);
  void settings;
  return {
    ...base(row, "customer"),
    type,
    name: required(row, "name", "customer"),
    email: text(row["email"]),
    phone: text(row["phone"]),
    billingAddress: hasBilling ? billing : undefined,
    leadSource: text(row["lead_source"]),
    paymentTermsDays: int(row["payment_terms_days"]) ?? 0,
    taxExempt: bool(row["tax_exempt"], false),
    notes: text(row["notes"]),
    tags: listOf(row["tags"]),
    customFields: customFields(row),
  };
}

export function toProperty(row: Row, settings: CsvSettings): CanonicalProperty {
  void settings;
  return {
    ...base(row, "property"),
    customerSourceIds: listOf(row["customer_id"]),
    nickname: text(row["nickname"]),
    addressLine1: text(row["line1"]) ?? "",
    addressLine2: text(row["line2"]),
    city: text(row["city"]) ?? "",
    state: text(row["state"]) ?? "",
    postalCode: text(row["postal_code"]) ?? "",
    country: text(row["country"]) ?? "US",
    latitude: text(row["latitude"]),
    longitude: text(row["longitude"]),
    accessNotes: text(row["access_notes"]),
    customFields: customFields(row),
  };
}

export function toPriceBookItem(row: Row, settings: CsvSettings): CanonicalPriceBookItem {
  const kind = (text(row["kind"]) ?? "service").toLowerCase();
  const kinds = ["service", "material", "equipment", "labor", "fee", "discount"] as const;
  if (!(kinds as readonly string[]).includes(kind)) {
    throw new Error(`price book kind must be one of ${kinds.join(", ")}, not ${JSON.stringify(row["kind"])}`);
  }
  return {
    ...base(row, "price book item"),
    kind: kind as (typeof kinds)[number],
    code: text(row["code"]),
    name: required(row, "name", "price book item"),
    description: text(row["description"]),
    price: amount(row["price"], settings),
    cost: text(row["cost"]) === undefined ? undefined : amount(row["cost"], settings),
    taxable: bool(row["taxable"], true),
    durationMinutes: int(row["duration_minutes"]),
    active: bool(row["active"], true),
  };
}

function toVisit(row: Row, sequence: number, settings: CsvSettings): CanonicalVisit {
  return {
    sourceId: text(row["id"]) ?? `${String(row["job_id"] ?? "")}#${sequence}`,
    sequence,
    windowStart: date(row["start"], settings),
    windowEnd: date(row["end"], settings),
    completedAt: date(row["completed_at"], settings),
    technicianSourceIds: listOf(row["technician_ids"]),
    status: text(row["status"]) ?? (text(row["completed_at"]) ? "completed" : "scheduled"),
    notes: text(row["notes"]),
  };
}

/**
 * A job's visits come from visits.csv when there is one. Without it, a job
 * row may carry a single visit in `visit_start` / `visit_end` columns, which
 * is how most one-file exports describe an appointment.
 */
export function toJob(row: Row, settings: CsvSettings): CanonicalJob {
  const joined = Array.isArray(row["visits"]) ? (row["visits"] as Row[]) : [];
  const inline: Row[] = text(row["visit_start"])
    ? [{
        id: `${String(row["id"] ?? "")}#1`, start: row["visit_start"], end: row["visit_end"],
        completed_at: row["completed_at"], technician_ids: row["technician_ids"],
        status: row["visit_status"],
      }]
    : [];
  const visits = (joined.length > 0 ? joined : inline)
    .slice()
    .sort((a, b) => String(date(a["start"], settings) ?? "").localeCompare(String(date(b["start"], settings) ?? "")))
    .map((v, i) => toVisit(v, i + 1, settings));

  return {
    ...base(row, "job"),
    customerSourceId: required(row, "customer_id", "job"),
    propertySourceId: text(row["property_id"]) ?? "",
    number: int(row["number"]),
    status: text(row["status"]) ?? "unknown",
    summary: text(row["summary"]) ?? `Job ${text(row["number"]) ?? ""}`.trim(),
    description: text(row["description"]),
    jobType: text(row["job_type"]),
    leadSource: text(row["lead_source"]),
    total: text(row["total"]) === undefined ? undefined : amount(row["total"], settings),
    completedAt: date(row["completed_at"], settings),
    visits,
    customFields: customFields(row),
  };
}

function toLine(row: Row, settings: CsvSettings): CanonicalInvoiceLine {
  const qty = quantity(row["quantity"]);
  const unitPrice = amount(row["unit_price"], settings);
  return {
    name: text(row["name"]) ?? "Line item",
    description: text(row["description"]),
    quantity: qty,
    unitPrice,
    taxable: bool(row["taxable"], true),
    taxRate: text(row["tax_rate"]) ?? "0",
    taxAmount: amount(row["tax_amount"], settings),
    lineTotal: text(row["line_total"]) === undefined ? money.multiply(qty, unitPrice) : amount(row["line_total"], settings),
    priceBookItemSourceId: text(row["price_book_item_id"]),
  };
}

export function toInvoice(row: Row, settings: CsvSettings): CanonicalInvoice {
  const lines = (Array.isArray(row["lines"]) ? (row["lines"] as Row[]) : []).map((l) => toLine(l, settings));
  const total = amount(row["total"], settings);
  const taxTotal = amount(row["tax_total"], settings);
  // An absent balance is not a zero balance. Read as "nothing is owed" it
  // would silently clear every open receivable in the file.
  if (text(row["balance"]) === undefined) {
    throw new Error("invoice row has no balance; open receivables cannot be inferred from a blank");
  }
  return {
    ...base(row, "invoice"),
    customerSourceId: required(row, "customer_id", "invoice"),
    jobSourceId: text(row["job_id"]),
    number: int(row["number"]),
    status: text(row["status"]) ?? "unknown",
    issuedOn: date(row["issued_on"], settings),
    dueOn: date(row["due_on"], settings),
    subtotal: text(row["subtotal"]) === undefined ? money.subtract(total, taxTotal) : amount(row["subtotal"], settings),
    taxTotal,
    total,
    balance: amount(row["balance"], settings),
    lines,
  };
}

/**
 * A payment's allocations come from payment_allocations.csv when there is
 * one. Otherwise an `invoice_id` on the payment row means the whole amount
 * went to that invoice, and no `invoice_id` means it went to none: a deposit
 * or an account credit, which is real money and is carried as such.
 */
export function toPayment(row: Row, settings: CsvSettings): CanonicalPayment {
  const amt = amount(row["amount"], settings);
  const joined = Array.isArray(row["allocations"]) ? (row["allocations"] as Row[]) : [];
  const invoiceId = text(row["invoice_id"]);
  const allocations = joined.length > 0
    ? joined.map((a) => ({ invoiceSourceId: required(a, "invoice_id", "payment allocation"), amount: amount(a["amount"], settings) }))
    : invoiceId ? [{ invoiceSourceId: invoiceId, amount: amt }] : [];
  const received = date(row["received_at"], settings);
  if (!received) throw new Error("payment row has no received_at");
  return {
    ...base(row, "payment"),
    customerSourceId: required(row, "customer_id", "payment"),
    method: text(row["method"]) ?? "unknown",
    status: text(row["status"]) ?? "completed",
    amount: amt,
    receivedAt: received,
    allocations,
  };
}

/** Estimate lines carry an `option` column; lines with none share one option. */
export function toEstimate(row: Row, settings: CsvSettings): CanonicalEstimate {
  const lines = Array.isArray(row["lines"]) ? (row["lines"] as Row[]) : [];
  const byOption = new Map<string, CanonicalInvoiceLine[]>();
  for (const line of lines) {
    const option = text(line["option"]) ?? "Estimate";
    const bucket = byOption.get(option) ?? [];
    byOption.set(option, bucket);
    bucket.push(toLine(line, settings));
  }
  const total = amount(row["total"], settings);
  const taxTotal = amount(row["tax_total"], settings);
  return {
    ...base(row, "estimate"),
    customerSourceId: required(row, "customer_id", "estimate"),
    propertySourceId: text(row["property_id"]),
    jobSourceId: text(row["job_id"]),
    number: int(row["number"]),
    status: text(row["status"]) ?? "unknown",
    title: text(row["title"]),
    issuedOn: date(row["issued_on"], settings),
    expiresOn: date(row["expires_on"], settings),
    subtotal: text(row["subtotal"]) === undefined ? money.subtract(total, taxTotal) : amount(row["subtotal"], settings),
    taxTotal,
    total,
    options: [...byOption.entries()].map(([name, optionLines], i) => ({
      name, isRecommended: i === 0, lines: optionLines,
    })),
  };
}

const ATTACHABLE = ["job", "visit", "customer", "property", "equipment", "estimate", "invoice"] as const;

export function toAttachment(row: Row, settings: CsvSettings): CanonicalAttachment {
  void settings;
  const entityType = (text(row["entity_type"]) ?? "").toLowerCase();
  if (!(ATTACHABLE as readonly string[]).includes(entityType)) {
    throw new Error(`attachment entity_type must be one of ${ATTACHABLE.join(", ")}, not ${JSON.stringify(row["entity_type"])}`);
  }
  const url = text(row["url"]);
  const path = text(row["path"]);
  if (!url && !path) throw new Error("attachment row has neither a url nor a path");
  return {
    ...base(row, "attachment"),
    entityType: entityType as (typeof ATTACHABLE)[number],
    entitySourceId: required(row, "entity_id", "attachment"),
    fileName: text(row["file_name"]),
    contentType: text(row["content_type"]),
    downloadUrl: url,
    localPath: path,
  };
}

/**
 * Equipment belongs to a property. The serial follows the furnace, not the
 * owner.
 *
 * An `id` column is optional here, unlike everywhere else, because the
 * equipment reports most systems export (FieldEdge's Equipment List among
 * them) have none. Without one the id is derived from the property and what
 * identifies the unit: manufacturer, model and serial, or the name when there
 * is no serial. It is stable across re-exports of the same data and changes
 * when any of those are edited, which is the honest answer for a file with
 * no key; two identical units without serials at one property collide, and
 * `profile` reports the duplicate rather than this guessing them apart.
 */
export function equipmentId(row: Row): string {
  const explicit = text(row["id"]);
  if (explicit) return explicit;
  const norm = (v: unknown) => (text(v) ?? "").toLowerCase().replace(/\s+/g, " ");
  const serial = norm(row["serial_number"]);
  const parts = [
    norm(row["property_id"]), norm(row["category"]), norm(row["manufacturer"]), norm(row["model"]),
    serial, serial === "" ? norm(row["name"]) : "",
  ];
  return `derived:${parts.join("|")}`;
}

export function toEquipment(row: Row, settings: CsvSettings): CanonicalEquipment {
  const category = text(row["category"]) ?? text(row["name"]);
  if (!category) throw new Error("equipment row has neither a category nor a name");
  const attributes: Record<string, unknown> = { ...customFields(row) };
  const name = text(row["name"]);
  if (name && name !== category) attributes["name"] = name;
  return {
    sourceSystem: SOURCE,
    sourceId: equipmentId(row),
    sourcePayload: row,
    propertySourceId: required(row, "property_id", "equipment"),
    category,
    manufacturer: text(row["manufacturer"]),
    model: text(row["model"]),
    serialNumber: text(row["serial_number"]),
    installedOn: date(row["installed_on"], settings),
    warrantyPartsExpiresOn: date(row["warranty_parts_expires_on"], settings),
    warrantyLaborExpiresOn: date(row["warranty_labor_expires_on"], settings),
    attributes,
  };
}

export function toContact(row: Row, settings: CsvSettings): CanonicalContact {
  void settings;
  const first = text(row["first_name"]);
  const last = text(row["last_name"]);
  const name = text(row["name"]) ?? ([first, last].filter(Boolean).join(" ") || text(row["email"]));
  if (!name) throw new Error("contact row has no name, first_name, last_name or email");
  return {
    ...base(row, "contact"),
    customerSourceId: required(row, "customer_id", "contact"),
    propertySourceId: text(row["property_id"]),
    name,
    firstName: first,
    lastName: last,
    email: text(row["email"]),
    phone: text(row["phone"]),
    mobile: text(row["mobile"]),
    role: text(row["role"]),
    isPrimary: bool(row["primary"], false),
    active: bool(row["active"], true),
    notes: text(row["notes"]),
  };
}

const MODELS = ["rule", "materialized-series", "anchored-to-completion", "manual-list"] as const;
const UNITS = ["day", "week", "month", "year"] as const;
const EXCEPTIONS = ["skipped", "moved", "cancelled"] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T | undefined {
  const v = text(value)?.toLowerCase();
  if (v === undefined) return undefined;
  const singular = v.endsWith("s") && (allowed as readonly string[]).includes(v.slice(0, -1)) ? v.slice(0, -1) : v;
  if (!(allowed as readonly string[]).includes(singular)) {
    throw new Error(`${what} must be one of ${allowed.join(", ")}, not ${JSON.stringify(value)}`);
  }
  return singular as T;
}

/**
 * A recurring schedule or service agreement, one row each, with skipped,
 * moved and cancelled occurrences joined on from recurring_exceptions.csv.
 *
 * `model` is required and never defaulted: docs/recurring-schedules.md rule 1
 * is that an adapter never silently invents a schedule, and choosing the
 * model is the decision that rule is about.
 */
export function toRecurringSchedule(row: Row, settings: CsvSettings): CanonicalRecurringSchedule {
  const model = oneOf(row["model"], MODELS, "recurring schedule model");
  if (!model) throw new Error(`recurring schedule row has no model; it must say which of ${MODELS.join(", ")} the source used`);
  const kind = (text(row["kind"]) ?? "recurring-job").toLowerCase();
  if (kind !== "recurring-job" && kind !== "service-agreement") {
    throw new Error(`recurring schedule kind must be recurring-job or service-agreement, not ${JSON.stringify(row["kind"])}`);
  }
  const interval = int(row["interval"]);
  if (interval !== undefined && interval < 1) throw new Error(`interval must be at least 1, not ${interval}`);
  const exceptions = (Array.isArray(row["exceptions"]) ? (row["exceptions"] as Row[]) : []).map((e) => {
    const on = date(e["on"], settings);
    if (!on) throw new Error("recurring exception row has no date in on");
    const exceptionKind = oneOf(e["kind"], EXCEPTIONS, "recurring exception kind");
    if (!exceptionKind) throw new Error("recurring exception row has no kind");
    return {
      on,
      kind: exceptionKind,
      movedTo: date(e["moved_to"], settings),
      notes: text(e["notes"]),
    };
  });
  return {
    ...base(row, "recurring schedule"),
    kind,
    model,
    customerSourceId: required(row, "customer_id", "recurring schedule"),
    propertySourceId: text(row["property_id"]),
    name: text(row["name"]) ?? text(row["job_type"]) ?? "Recurring work",
    description: text(row["description"]),
    status: text(row["status"]) ?? "active",
    rule: text(row["rule"]),
    intervalUnit: oneOf(row["interval_unit"], UNITS, "interval_unit"),
    interval,
    anchorOn: date(row["anchor_on"], settings),
    startsOn: date(row["starts_on"], settings),
    endsOn: date(row["ends_on"], settings),
    nextOccurrenceOn: date(row["next_occurrence_on"], settings),
    visitsPerTerm: int(row["visits_per_term"]),
    price: text(row["price"]) === undefined ? undefined : amount(row["price"], settings),
    billingFrequency: text(row["billing_frequency"]),
    jobType: text(row["job_type"]),
    technicianSourceIds: listOf(row["technician_ids"]),
    equipmentSourceIds: listOf(row["equipment_ids"]),
    jobSourceIds: listOf(row["job_ids"]),
    exceptions,
    customFields: customFields(row),
  };
}
