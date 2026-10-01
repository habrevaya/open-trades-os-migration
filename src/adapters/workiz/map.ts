import * as money from "../../money/index.js";
import { wallClock } from "../time.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalJob, CanonicalInvoice, CanonicalUser, CanonicalVisit,
} from "../../canonical/index.js";

/**
 * WORKIZ MAPPING
 *
 * Field names and types are from Workiz's published OpenAPI document,
 * https://developer.workiz.com/api.json (the `Job` and `teamAllResponse`
 * schemas), read 2026-10-01.
 *
 * Workiz's public API is built around the job. There is no client, invoice
 * or payment collection to read: the client's name, phones, email and the
 * service address are copied onto every job, and the money is the job's
 * total and amount due. So this adapter reads jobs and splits each one into
 * up to four canonical records: the job, the customer it names, the property
 * it was done at, and the receivable it left. Customers and properties are
 * written once each at extract time (see `index.ts`), from the most recently
 * scheduled job that names them, because the API lists jobs newest first and
 * the newest copy of a phone number is the one most likely to ring.
 *
 * Money arrives as decimal dollar strings ("175"), sometimes as JSON
 * numbers. Both go through src/money and never through arithmetic.
 */

const SOURCE = "workiz";

export type Raw = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Raw =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};

const dollars = (value: unknown): string => money.normalize(text(value) ?? "0");

/** A job's client. Zero and blank both mean the job names none. */
export function clientId(job: Raw): string | undefined {
  const id = text(job["ClientId"]);
  return id === undefined || id === "0" ? undefined : id;
}

/**
 * Workiz addresses have no id. The derived one must be STABLE across runs,
 * or a re-run creates a second copy of every property, so it is built from
 * the client and the normalised address and nothing else: not the job, and
 * not anything a dispatcher might retype.
 */
export function propertyId(job: Raw): string {
  const parts = [job["Address"], job["Unit"], job["City"], job["State"], job["PostalCode"]]
    .map((p) => (text(p) ?? "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim());
  return `derived:${clientId(job) ?? ""}:${parts.join("|")}`;
}

/** The job's own wall-clock time, converted with the job's own time zone. */
const at = (job: Raw, field: string): string | undefined =>
  wallClock(text(job[field]), text(job["Timezone"]));

export function toCustomer(job: Raw): CanonicalCustomer {
  const id = clientId(job);
  if (!id) throw new Error("job names no client (ClientId is empty)");
  const company = text(job["Company"]);
  const person = [text(job["FirstName"]), text(job["LastName"])].filter(Boolean).join(" ");
  const phone = text(job["Phone"]);
  const ext = text(job["PhoneExt"]);
  const second = text(job["SecondPhone"]);
  const secondExt = text(job["SecondPhoneExt"]);
  return {
    sourceSystem: SOURCE,
    sourceId: id,
    sourcePayload: job,
    type: company ? "commercial" : "residential",
    name: company ?? (person || text(job["Email"]) || "Unnamed client"),
    email: text(job["Email"]),
    phone: phone ? (ext ? `${phone} x${ext}` : phone) : undefined,
    // Workiz holds no billing address separately from the job's service
    // address, and copying the service address here would assert a fact the
    // source does not.
    billingAddress: undefined,
    leadSource: text(job["JobSource"]),
    paymentTermsDays: 0,
    taxExempt: false,
    notes: undefined,
    tags: [],
    customFields: {
      ...(company && person ? { "Contact name": person } : {}),
      ...(second ? { "Second phone": secondExt ? `${second} x${secondExt}` : second } : {}),
    },
  };
}

export function toProperty(job: Raw): CanonicalProperty {
  const id = clientId(job);
  if (!id) throw new Error("job names no client (ClientId is empty)");
  return {
    sourceSystem: SOURCE,
    sourceId: propertyId(job),
    sourcePayload: job,
    customerSourceIds: [id],
    addressLine1: text(job["Address"]) ?? "",
    addressLine2: text(job["Unit"]),
    city: text(job["City"]) ?? "",
    state: text(job["State"]) ?? "",
    postalCode: text(job["PostalCode"]) ?? "",
    country: text(job["Country"]) ?? "US",
    latitude: text(job["Latitude"]),
    longitude: text(job["Longitude"]),
    customFields: {},
  };
}

/**
 * One job, one visit: a Workiz job is one scheduled block from JobDateTime
 * to JobEndDateTime with a team on it. The completion time is not in the
 * API (LastStatusUpdate is when the status last changed, to anything), so
 * it is left absent rather than borrowed.
 */
export function toVisit(job: Raw): CanonicalVisit {
  return {
    sourceId: String(job["UUID"] ?? ""),
    sequence: 1,
    windowStart: at(job, "JobDateTime"),
    windowEnd: at(job, "JobEndDateTime"),
    technicianSourceIds: list(job["Team"]).map((t) => text(record(t)["id"]) ?? "").filter((t) => t !== ""),
    status: text(job["Status"]) ?? "unknown",
    notes: undefined,
  };
}

export function toJob(job: Raw): CanonicalJob {
  const id = text(job["UUID"]);
  if (!id) throw new Error("job has no UUID");
  const customer = clientId(job);
  if (!customer) throw new Error("job names no client (ClientId is empty)");
  const serial = Number(job["SerialId"]);
  const custom: Record<string, unknown> = {};
  for (const [label, field] of [
    ["Sub-status", "SubStatus"], ["Service area", "ServiceArea"], ["Referral company", "ReferralCompany"],
    ["Created by", "CreatedBy"], ["Time zone", "Timezone"],
  ] as const) {
    const v = text(job[field]);
    if (v !== undefined) custom[label] = v;
  }
  const tags = list(job["Tags"]).map(text).filter((t): t is string => t !== undefined);
  if (tags.length > 0) custom["Tags"] = tags;

  return {
    sourceSystem: SOURCE,
    sourceId: id,
    sourcePayload: job,
    customerSourceId: customer,
    propertySourceId: propertyId(job),
    number: Number.isInteger(serial) && serial > 0 ? serial : undefined,
    status: text(job["Status"]) ?? "unknown",
    summary: text(job["JobType"]) ?? `Job ${text(job["SerialId"]) ?? ""}`.trim(),
    description: text(job["JobNotes"]),
    jobType: text(job["JobType"]),
    leadSource: text(job["JobSource"]),
    total: dollars(job["JobTotalPrice"]),
    completedAt: undefined,
    visits: [toVisit(job)],
    customFields: custom,
  };
}

/**
 * The receivable a job left, or nothing.
 *
 * Workiz exposes no invoice collection, only the job's total and amount
 * due, so an invoice is materialised from those when either is non-zero:
 * open receivables have to exist as documents for a balance to mean
 * anything. Returned as an array because a job with no money on it produces
 * no invoice at all.
 *
 * The total is carried as the subtotal with no tax split. Workiz also sends
 * `SubTotal`, and the difference between it and `JobTotalPrice` could be
 * tax, a discount, or both; the published schema does not say, so it is not
 * guessed at. It stays in the payload.
 */
export function toInvoices(job: Raw): CanonicalInvoice[] {
  const id = text(job["UUID"]);
  const customer = clientId(job);
  if (!id || !customer) return [];
  const total = dollars(job["JobTotalPrice"]);
  const due = dollars(job["JobAmountDue"]);
  if (money.isZero(total) && money.isZero(due)) return [];
  return [{
    sourceSystem: SOURCE,
    sourceId: id,
    sourcePayload: job,
    customerSourceId: customer,
    jobSourceId: id,
    number: undefined,
    status: text(job["Status"]) ?? "unknown",
    issuedOn: undefined,
    dueOn: at(job, "PaymentDueDate"),
    subtotal: total,
    taxTotal: "0.0000",
    total,
    balance: due,
    lines: [],
  }];
}

export function toUser(raw: Raw): CanonicalUser {
  return {
    sourceSystem: SOURCE,
    sourceId: String(raw["id"] ?? ""),
    sourcePayload: raw,
    name: text(raw["name"]) ?? text(raw["email"]) ?? "Unnamed team member",
    email: text(raw["email"]),
    phone: undefined,
    active: raw["active"] !== false,
    role: text(raw["role"]),
  };
}
