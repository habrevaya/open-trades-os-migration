import { z } from "zod";

/**
 * THE CANONICAL MODEL
 *
 * Every adapter maps its source into this shape, and one loader writes this
 * shape into OpenTradesOS. Adding a source means writing an extractor and a
 * mapping. It never means touching the loader.
 *
 * Three fields appear on every record and carry the whole design:
 *
 *   sourceSystem + sourceId  make the load idempotent. Re-running an import
 *                            updates rather than duplicates, so a botched run
 *                            is re-runnable instead of a restore from backup.
 *   sourcePayload            keeps the raw record. When reconciliation finds a
 *                            discrepancy six months later, this is the only
 *                            thing that answers what the source actually said.
 */
export const Provenance = z.object({
  sourceSystem: z.string(),
  sourceId: z.string(),
  sourcePayload: z.record(z.unknown()).optional(),
});

/** Money as a decimal string. Never a JS number. Floats lose cents. */
export const Money = z.string().regex(/^-?\d+(\.\d{1,4})?$/);

export const CanonicalCustomer = Provenance.extend({
  type: z.enum(["residential", "commercial"]).default("residential"),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  billingAddress: z.object({
    line1: z.string().optional(), line2: z.string().optional(),
    city: z.string().optional(), state: z.string().optional(),
    postalCode: z.string().optional(), country: z.string().default("US"),
  }).optional(),
  leadSource: z.string().optional(),
  paymentTermsDays: z.number().int().default(0),
  taxExempt: z.boolean().default(false),
  notes: z.string().optional(),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).default({}),
});

/**
 * Separate from customer, always. Most sources collapse these into one record
 * with an address, so the adapter's job is often to SPLIT a source record into
 * a customer plus one or more properties. That split is where migration
 * quality is won or lost.
 */
export const CanonicalProperty = Provenance.extend({
  customerSourceIds: z.array(z.string()),
  nickname: z.string().optional(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string().default("US"),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  accessNotes: z.string().optional(),
  customFields: z.record(z.unknown()).default({}),
});

/** Belongs to the property. The serial follows the furnace, not the owner. */
export const CanonicalEquipment = Provenance.extend({
  propertySourceId: z.string(),
  category: z.string(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  installedOn: z.string().optional(),
  warrantyPartsExpiresOn: z.string().optional(),
  warrantyLaborExpiresOn: z.string().optional(),
  attributes: z.record(z.unknown()).default({}),
});

/**
 * A person at a customer who is not the customer: the tenant who lets the
 * technician in, the property manager who approves the quote, the accounts
 * payable clerk who pays the invoice.
 *
 * The customer keeps its own email and phone. Contacts are everyone else, and
 * the one flagged primary is usually who the customer's email and phone were
 * copied from, so a migration that drops contacts drops the only way to reach
 * the right person at most commercial accounts.
 */
export const CanonicalContact = Provenance.extend({
  customerSourceId: z.string(),
  propertySourceId: z.string().optional(),
  name: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  /** As the source names it: BILLING, JOB, Property Manager, Tenant. Not normalised. */
  role: z.string().optional(),
  isPrimary: z.boolean().default(false),
  active: z.boolean().default(true),
  notes: z.string().optional(),
});

/**
 * A recurring schedule or service agreement. See docs/recurring-schedules.md,
 * whose rules this shape exists to enforce.
 *
 * `model` says which of the four recurrence models the source used, because
 * the same "every six months" means different things under each. A rule
 * carries its rule; an anchored schedule carries what it is anchored to; a
 * materialized series carries the jobs that already exist. Nothing here is
 * inferred by an adapter: a field the source did not state is absent, and
 * `profile` says so.
 *
 * `kind` separates a maintenance agreement (a contract, often prepaid, with a
 * term and a number of visits) from a plain repeating job. Both repeat; only
 * one is money already collected for work not yet done.
 */
export const RecurrenceException = z.object({
  on: z.string(),
  kind: z.enum(["skipped", "moved", "cancelled"]),
  movedTo: z.string().optional(),
  notes: z.string().optional(),
});

export const CanonicalRecurringSchedule = Provenance.extend({
  kind: z.enum(["recurring-job", "service-agreement"]).default("recurring-job"),
  model: z.enum(["rule", "materialized-series", "anchored-to-completion", "manual-list"]),
  customerSourceId: z.string(),
  propertySourceId: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  status: z.string(),
  /** The rule as the source wrote it (an RRULE, or the source's own words). Never rewritten. */
  rule: z.string().optional(),
  intervalUnit: z.enum(["day", "week", "month", "year"]).optional(),
  interval: z.number().int().positive().optional(),
  /** What the interval counts from. For anchored-to-completion, the last completion. */
  anchorOn: z.string().optional(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  nextOccurrenceOn: z.string().optional(),
  visitsPerTerm: z.number().int().optional(),
  price: Money.optional(),
  billingFrequency: z.string().optional(),
  jobType: z.string().optional(),
  technicianSourceIds: z.array(z.string()).default([]),
  equipmentSourceIds: z.array(z.string()).default([]),
  /** Occurrences the source already materialized as jobs. */
  jobSourceIds: z.array(z.string()).default([]),
  exceptions: z.array(RecurrenceException).default([]),
  customFields: z.record(z.unknown()).default({}),
});

export const CanonicalVisit = z.object({
  sourceId: z.string(),
  sequence: z.number().int().default(1),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
  completedAt: z.string().optional(),
  technicianSourceIds: z.array(z.string()).default([]),
  status: z.string(),
  notes: z.string().optional(),
});

/**
 * A job has many visits. Sources that model a job as one calendar block will
 * produce a single visit here, and that is fine. Sources that model recurring
 * work as an infinite series need the adapter to decide what to materialize:
 * see docs/recurring-schedules.md, which is the hardest part of this toolkit.
 */
export const CanonicalJob = Provenance.extend({
  customerSourceId: z.string(),
  propertySourceId: z.string(),
  number: z.number().int().optional(),
  status: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  jobType: z.string().optional(),
  leadSource: z.string().optional(),
  equipmentSourceId: z.string().optional(),
  total: Money.optional(),
  completedAt: z.string().optional(),
  visits: z.array(CanonicalVisit).default([]),
  customFields: z.record(z.unknown()).default({}),
});

export const CanonicalInvoiceLine = z.object({
  name: z.string(),
  description: z.string().optional(),
  quantity: Money.default("1"),
  unitPrice: Money.default("0"),
  taxable: z.boolean().default(true),
  /** The rate AS APPLIED on the source document. Never recomputed. */
  taxRate: z.string().default("0"),
  taxAmount: Money.default("0"),
  lineTotal: Money.default("0"),
  priceBookItemSourceId: z.string().optional(),
});

export const CanonicalInvoice = Provenance.extend({
  customerSourceId: z.string(),
  jobSourceId: z.string().optional(),
  number: z.number().int().optional(),
  status: z.string(),
  issuedOn: z.string().optional(),
  dueOn: z.string().optional(),
  subtotal: Money.default("0"),
  taxTotal: Money.default("0"),
  total: Money.default("0"),
  balance: Money.default("0"),
  lines: z.array(CanonicalInvoiceLine).default([]),
});

/**
 * Allocations are the part that decides whether a migration reconciles.
 * A payment can be split across invoices and an invoice can take many
 * payments. Sources that only give you a payment with one invoice id are
 * lying to you about deposits and overpayments.
 */
export const CanonicalPayment = Provenance.extend({
  customerSourceId: z.string(),
  method: z.string(),
  status: z.string(),
  amount: Money,
  receivedAt: z.string(),
  allocations: z.array(z.object({
    invoiceSourceId: z.string(),
    amount: Money,
  })).default([]),
});

export const CanonicalAttachment = Provenance.extend({
  entityType: z.enum(["job", "visit", "customer", "property", "equipment", "estimate", "invoice"]),
  entitySourceId: z.string(),
  fileName: z.string().optional(),
  contentType: z.string().optional(),
  /** Often a short-lived signed URL, which is why attachments are a separate pass. */
  downloadUrl: z.string().optional(),
  localPath: z.string().optional(),
});

/**
 * A person who did work in the source system: a technician, an office user,
 * somebody who left in 2019 and still appears on four hundred visits.
 *
 * Carried so that visits can name who was there, not so that accounts can be
 * created. Logins are a decision about who may see a company's data, and a
 * migration tool minting them from a spreadsheet is exactly the wrong place
 * for that decision to be made. The operator maps each of these to a person
 * who already exists in the target, during `map`.
 */
export const CanonicalUser = Provenance.extend({
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  active: z.boolean().default(true),
  role: z.string().optional(),
});

/**
 * A price book entry as the source holds it today.
 *
 * Today matters: no source in this toolkit exposes price history, so this is
 * the CURRENT price. Historical invoice lines carry their own unit price and
 * must never be re-priced from this record, which is why invoice lines keep
 * `priceBookItemSourceId` as a reference and never as a price lookup.
 */
export const CanonicalPriceBookItem = Provenance.extend({
  kind: z.enum(["service", "material", "equipment", "labor", "fee", "discount"]).default("service"),
  code: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  price: Money.default("0"),
  cost: Money.optional(),
  taxable: z.boolean().default(true),
  durationMinutes: z.number().int().optional(),
  active: z.boolean().default(true),
});

/**
 * An estimate, quote or proposal. One or more options, each a whole scope of
 * work with its own lines, because "repair for $400 or replace for $6,200" is
 * one document with two answers, not two documents.
 *
 * Sources that have a single scope produce a single option. Lines reuse the
 * invoice line shape on purpose: an approved option becomes invoice lines,
 * and two line shapes would be two places for a tax rate to drift.
 */
export const CanonicalEstimateOption = z.object({
  name: z.string(),
  description: z.string().optional(),
  isRecommended: z.boolean().default(false),
  lines: z.array(CanonicalInvoiceLine).default([]),
});

export const CanonicalEstimate = Provenance.extend({
  customerSourceId: z.string(),
  propertySourceId: z.string().optional(),
  jobSourceId: z.string().optional(),
  number: z.number().int().optional(),
  status: z.string(),
  title: z.string().optional(),
  issuedOn: z.string().optional(),
  expiresOn: z.string().optional(),
  subtotal: Money.default("0"),
  taxTotal: Money.default("0"),
  total: Money.default("0"),
  options: z.array(CanonicalEstimateOption).default([]),
});

export type CanonicalCustomer = z.infer<typeof CanonicalCustomer>;
export type CanonicalVisit = z.infer<typeof CanonicalVisit>;
export type CanonicalInvoiceLine = z.infer<typeof CanonicalInvoiceLine>;
export type CanonicalProperty = z.infer<typeof CanonicalProperty>;
export type CanonicalEquipment = z.infer<typeof CanonicalEquipment>;
export type CanonicalJob = z.infer<typeof CanonicalJob>;
export type CanonicalInvoice = z.infer<typeof CanonicalInvoice>;
export type CanonicalPayment = z.infer<typeof CanonicalPayment>;
export type CanonicalAttachment = z.infer<typeof CanonicalAttachment>;
export type CanonicalUser = z.infer<typeof CanonicalUser>;
export type CanonicalPriceBookItem = z.infer<typeof CanonicalPriceBookItem>;
export type CanonicalEstimate = z.infer<typeof CanonicalEstimate>;
export type CanonicalEstimateOption = z.infer<typeof CanonicalEstimateOption>;
export type CanonicalContact = z.infer<typeof CanonicalContact>;
export type CanonicalRecurringSchedule = z.infer<typeof CanonicalRecurringSchedule>;

export const ENTITY_ORDER = [
  "user", "customer", "property", "contact", "equipment", "priceBookItem",
  "estimate", "job", "recurringSchedule", "invoice", "payment", "membership", "attachment",
] as const;

/** The schema for each entity a record can be checked against, where there is one. */
export const SCHEMAS: Partial<Record<(typeof ENTITY_ORDER)[number], z.ZodTypeAny>> = {
  user: CanonicalUser,
  customer: CanonicalCustomer,
  property: CanonicalProperty,
  contact: CanonicalContact,
  equipment: CanonicalEquipment,
  priceBookItem: CanonicalPriceBookItem,
  estimate: CanonicalEstimate,
  job: CanonicalJob,
  recurringSchedule: CanonicalRecurringSchedule,
  invoice: CanonicalInvoice,
  payment: CanonicalPayment,
  attachment: CanonicalAttachment,
};
export type EntityName = (typeof ENTITY_ORDER)[number];
