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

export type CanonicalCustomer = z.infer<typeof CanonicalCustomer>;
export type CanonicalVisit = z.infer<typeof CanonicalVisit>;
export type CanonicalInvoiceLine = z.infer<typeof CanonicalInvoiceLine>;
export type CanonicalProperty = z.infer<typeof CanonicalProperty>;
export type CanonicalEquipment = z.infer<typeof CanonicalEquipment>;
export type CanonicalJob = z.infer<typeof CanonicalJob>;
export type CanonicalInvoice = z.infer<typeof CanonicalInvoice>;
export type CanonicalPayment = z.infer<typeof CanonicalPayment>;
export type CanonicalAttachment = z.infer<typeof CanonicalAttachment>;

export const ENTITY_ORDER = [
  "user", "customer", "property", "contact", "equipment", "priceBookItem",
  "estimate", "job", "invoice", "payment", "membership", "attachment",
] as const;
export type EntityName = (typeof ENTITY_ORDER)[number];
