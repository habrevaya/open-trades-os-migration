import { z } from "zod";

/**
 * THE TARGET'S CONTRACTS, MIRRORED
 *
 * These are copies of the request schemas OpenTradesOS publishes in
 * packages/api/src/contracts/*.ts, restricted to the routes a migration
 * calls. They are copies rather than imports, for two reasons that are both
 * permanent rather than convenient.
 *
 * The core's contracts import its route definition helper, which imports the
 * core's domain package, which brings its database layer with it. A tool that
 * has to run on an operator's laptop against any deployment should not carry
 * a Postgres driver to validate a JSON body. And the core is AGPL while this
 * toolkit is Apache 2.0 on purpose, so the shapes are restated, not linked.
 *
 * What keeps the copy honest is that it is used for exactly one thing:
 * refusing a request locally that the server would refuse with a 422. If the
 * two drift, the failure is loud either way (a record dryrun passed and load
 * rejects, with the server's own field path in the report), never silent. When
 * the core changes a contract, this file changes with it, and the file and
 * route each schema mirrors is named beside it so the comparison is quick.
 *
 * Only inputs are mirrored strictly. Outputs are read for the few fields the
 * loader needs (an id, a status, a total) and are otherwise passed through, so
 * a field the core adds to a response never breaks a migration.
 */

export const Uuid = z.string().uuid();

/** contracts/common.ts MoneyString. Four places, a decimal string, never a number. */
export const MoneyString = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Money must be a decimal string with at most 4 places");
export const RateString = z.string().regex(/^-?\d+(\.\d{1,6})?$/, "Rate must be a decimal string with at most 6 places");

/** contracts/common.ts Address. Every part but line2 is required, and country is two letters. */
export const Address = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(50),
  postalCode: z.string().min(1).max(20),
  country: z.string().length(2).default("US"),
});

const PageInput = {
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
};

/**
 * contracts/common.ts RESERVED_SOURCES. The recurring engine tags the jobs it
 * books with this source, and a caller claiming it would make the engine
 * think an occurrence was already booked.
 */
export const RESERVED_SOURCES = ["recurring_schedule"] as const;

/**
 * contracts/common.ts ExternalRef. Where a record came from: the source
 * system and that system's own id. Unique per company per kind of record, so
 * a second create for the same source record is a 409 naming the id it
 * already became, and every list can find a record by it.
 */
export const ExternalRef = z.object({
  source: z.string()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,49}$/, "A source is a lower case name, like jobber or housecall_pro")
    .refine((v) => !(RESERVED_SOURCES as readonly string[]).includes(v), "That source is written by this product itself"),
  id: z.string().min(1).max(200),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

/** contracts/common.ts ExternalLookup. Both together name one record. */
const ExternalLookup = {
  externalSource: z.string().max(50).optional(),
  externalId: z.string().max(200).optional(),
};

/** A source document's own number. Needs `data:import`; refused if taken. */
const DocumentNumber = z.number().int().min(1).max(2_000_000_000);

const page = <T extends z.ZodTypeAny>(item: T) => z.object({
  data: z.array(item),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const withId = z.object({ id: Uuid }).passthrough();

// contracts/customers.ts

export const CustomerType = z.enum(["residential", "commercial"]);

/** contracts/customers.ts CustomerCreate (POST /v1/customers). */
export const CustomerCreate = z.object({
  type: CustomerType.default("residential"),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  billingAddress: Address.optional(),
  leadSource: z.string().max(100).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  taxExempt: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).default({}),
  property: z.object({
    nickname: z.string().max(100).optional(),
    address: Address,
    accessNotes: z.string().max(2000).optional(),
  }).optional(),
  externalRef: ExternalRef.optional(),
});

// contracts/properties.ts

export const PropertyRole = z.enum(["owner", "tenant", "manager", "billing"]);

/** contracts/properties.ts PropertyCreate (POST /v1/properties). */
export const PropertyCreate = z.object({
  nickname: z.string().max(100).optional(),
  address: Address,
  squareFeet: z.string().optional(),
  yearBuilt: z.string().optional(),
  gateCode: z.string().max(50).optional(),
  accessNotes: z.string().max(2000).optional(),
  hazardNotes: z.string().max(2000).optional(),
  hasDog: z.boolean().default(false),
  customFields: z.record(z.unknown()).default({}),
  customerId: Uuid.optional(),
  customerRole: PropertyRole.default("owner"),
  externalRef: ExternalRef.optional(),
});

/** contracts/properties.ts linkCustomerToProperty (POST /v1/properties/{id}/customers). */
export const PropertyLink = z.object({
  id: Uuid,
  customerId: Uuid,
  role: PropertyRole.default("owner"),
  isPrimary: z.boolean().default(true),
  startedOn: z.string().date().optional(),
  endedOn: z.string().date().optional(),
});

// contracts/pricebook.ts

export const ItemKind = z.enum(["service", "material", "equipment", "labor", "fee", "discount"]);

/** contracts/pricebook.ts createPriceBookItem (POST /v1/pricebook/items). */
export const PriceBookItemCreate = z.object({
  kind: ItemKind.default("service"),
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  categoryId: Uuid.optional(),
  price: MoneyString,
  cost: MoneyString.optional(),
  taxable: z.boolean().default(true),
  taxClass: z.string().max(50).optional(),
  laborMinutes: z.number().int().min(0).max(10000).optional(),
  warrantyMonths: z.number().int().min(0).max(600).optional(),
  externalRef: ExternalRef.optional(),
});

/** contracts/pricebook.ts setPriceBookItemActive (POST /v1/pricebook/items/{id}/active). */
export const PriceBookItemActive = z.object({
  id: Uuid,
  active: z.boolean(),
  reason: z.string().max(500).optional(),
});

// contracts/jobs.ts

export const JobStatus = z.enum([
  "lead", "estimating", "scheduled", "in_progress", "on_hold",
  "completed", "invoiced", "paid", "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatus>;

const VisitInput = z.object({
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  estimatedDurationMinutes: z.number().int().min(5).max(1440).default(60),
  technicianIds: z.array(Uuid).default([]),
  externalRef: ExternalRef.optional(),
});

/**
 * contracts/jobs.ts JobCreate (POST /v1/jobs). `parties` and `coverage` are
 * left out: no source in this toolkit carries them, and an empty object for
 * either is not the same request as an absent one.
 */
export const JobCreate = z.object({
  number: DocumentNumber.optional(),
  externalRef: ExternalRef.optional(),
  customerId: Uuid,
  propertyId: Uuid,
  jobTypeId: Uuid.optional(),
  summary: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  customerComplaint: z.string().max(5000).optional(),
  equipmentId: Uuid.optional(),
  leadSource: z.string().max(100).optional(),
  purchaseOrderNumber: z.string().max(100).optional(),
  costCode: z.string().max(50).optional(),
  priority: z.number().int().min(0).max(2).optional(),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).default({}),
  parentJobId: Uuid.optional(),
  isWarranty: z.boolean().optional(),
  visit: VisitInput.optional(),
});

/**
 * contracts/jobs.ts updateJob (PATCH /v1/jobs/{id}), status only. A
 * `completedAt` goes with the move to completed and at no other time, and one
 * more than a week back needs `data:import`.
 */
export const JobUpdate = z.object({
  id: Uuid,
  status: JobStatus.optional(),
  completedAt: z.string().datetime().optional(),
});

/**
 * contracts/jobs.ts scheduleVisit (POST /v1/jobs/{id}/visits). The window is
 * both ends or neither (neither is a visit nobody has timed, kept unassigned
 * and off the board), and `status: "cancelled"` records a visit that was
 * called off without dispatching anybody. Honours the Idempotency-Key.
 */
export const VisitSchedule = z.object({
  id: Uuid,
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  estimatedDurationMinutes: z.number().int().min(5).max(1440).default(60),
  technicianIds: z.array(Uuid).default([]),
  crewId: Uuid.optional(),
  status: z.literal("cancelled").optional(),
  externalRef: ExternalRef.optional(),
});

/** contracts/jobs.ts completeVisit (POST /v1/visits/{id}/complete). */
export const VisitComplete = z.object({
  id: Uuid,
  completedOfflineAt: z.string().datetime().optional(),
  technicianNotes: z.string().max(10000).optional(),
});

/**
 * services/jobs.ts REACHABLE. A job's status is a lifecycle the core
 * enforces, so the loader walks it rather than setting it, and has to know
 * the map to find the walk.
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  lead: ["lead", "estimating", "scheduled", "cancelled"],
  estimating: ["estimating", "lead", "scheduled", "cancelled"],
  scheduled: ["scheduled", "in_progress", "on_hold", "completed", "cancelled"],
  in_progress: ["in_progress", "on_hold", "completed", "cancelled"],
  on_hold: ["on_hold", "scheduled", "in_progress", "cancelled"],
  completed: ["completed", "in_progress", "invoiced", "cancelled"],
  invoiced: ["invoiced", "paid", "completed"],
  paid: ["paid"],
  cancelled: ["cancelled"],
};

/** The shortest walk from one status to another, or undefined when none exists. */
export function statusPath(from: JobStatus, to: JobStatus): JobStatus[] | undefined {
  if (from === to) return [];
  const previous = new Map<JobStatus, JobStatus>();
  const queue: JobStatus[] = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const next of JOB_TRANSITIONS[at]) {
      if (next === from || previous.has(next)) continue;
      previous.set(next, at);
      if (next === to) {
        const path: JobStatus[] = [to];
        let step = at;
        while (step !== from) { path.unshift(step); step = previous.get(step)!; }
        return path;
      }
      queue.push(next);
    }
  }
  return undefined;
}

const ExternalRefOut = z.object({ source: z.string(), id: z.string() }).nullable().optional();

const VisitOut = z.object({
  id: Uuid,
  sequence: z.number().int(),
  status: z.string(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  completedAt: z.string().nullable().optional(),
  externalRef: ExternalRefOut,
}).passthrough();

const JobOut = z.object({
  id: Uuid,
  number: z.number().int().optional(),
  status: JobStatus,
  visits: z.array(VisitOut).default([]),
  externalRef: ExternalRefOut,
}).passthrough();

/** Any record a list returns, read for its id and where it came from. */
const Row = z.object({ id: Uuid, externalRef: ExternalRefOut }).passthrough();

// contracts/estimates.ts

const LineInput = z.object({
  priceBookItemId: Uuid.optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  quantity: MoneyString.default("1"),
  unitPrice: MoneyString,
  unitCost: MoneyString.optional(),
  discountAmount: MoneyString.default("0"),
  taxable: z.boolean().default(true),
  /** This line's own rate, where it differs from the estimate's. */
  taxRate: RateString.optional(),
  isOptional: z.boolean().default(false),
  isSelected: z.boolean().default(false),
  costCode: z.string().max(50).optional(),
});

/** contracts/estimates.ts createEstimate (POST /v1/estimates). */
export const EstimateCreate = z.object({
  number: DocumentNumber.optional(),
  externalRef: ExternalRef.optional(),
  customerId: Uuid,
  propertyId: Uuid,
  jobId: Uuid.optional(),
  title: z.string().max(200).optional(),
  /** The day it was written. More than a week back needs `data:import`. */
  issuedOn: z.string().date().optional(),
  expiresOn: z.string().date().optional(),
  taxRate: RateString.default("0"),
  options: z.array(z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    isRecommended: z.boolean().default(false),
    lines: z.array(LineInput).min(1),
  })).min(1).max(5),
});

/** contracts/estimates.ts declineEstimate (POST /v1/estimates/{id}/decline). */
export const EstimateDecline = z.object({
  id: Uuid,
  reason: z.string().max(1000).optional(),
});

// contracts/billing.ts

export const PaymentMethod = z.enum(["card", "card_present", "ach", "cash", "check", "financing", "credit", "other"]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

/**
 * contracts/billing.ts createInvoice (POST /v1/invoices).
 *
 * `issuedOn` more than a week back, `number`, and a line's `taxRate`,
 * `taxAmount` or `priceAsGiven` all need `data:import`. A stated `taxAmount`
 * must be within a cent of the line's rate on its net. `expectedTotals` is a
 * cross check: any total that differs from what the lines give, to the cent,
 * refuses the invoice with a 422 naming the field.
 */
export const InvoiceCreate = z.object({
  number: DocumentNumber.optional(),
  externalRef: ExternalRef.optional(),
  customerId: Uuid,
  payerCustomerId: Uuid.optional(),
  jobId: Uuid.optional(),
  purchaseOrderNumber: z.string().max(100).optional(),
  issuedOn: z.string().date().optional(),
  dueOn: z.string().date().optional(),
  memo: z.string().max(2000).optional(),
  lines: z.array(z.object({
    priceBookItemId: Uuid.optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    quantity: MoneyString.default("1"),
    unitPrice: MoneyString,
    discountAmount: MoneyString.default("0"),
    taxable: z.boolean().default(true),
    taxRate: RateString.optional(),
    taxAmount: MoneyString.optional(),
    priceAsGiven: z.boolean().optional(),
    costCode: z.string().max(50).optional(),
  })).min(1),
  adjustment: z.object({
    name: z.string().min(1).max(200),
    amount: MoneyString,
  }).optional(),
  expectedTotals: z.object({
    subtotal: MoneyString.optional(),
    discountTotal: MoneyString.optional(),
    taxTotal: MoneyString.optional(),
    total: MoneyString.optional(),
  }).optional(),
});

/** contracts/billing.ts voidInvoice and writeOffInvoice. Both demand a reason. */
export const InvoiceEnd = z.object({
  id: Uuid,
  reason: z.string().min(1).max(500),
});

/**
 * contracts/billing.ts recordPayment (POST /v1/payments). Omitted
 * `allocations` applies oldest balance first; an EMPTY list applies nothing,
 * and whatever is not applied is held for the customer as `unappliedAmount`.
 * `receivedAt` more than a week back needs `data:import`.
 */
export const PaymentRecord = z.object({
  externalRef: ExternalRef.optional(),
  customerId: Uuid,
  method: PaymentMethod,
  amount: MoneyString,
  tipAmount: MoneyString.default("0"),
  feeAmount: MoneyString.optional(),
  surchargeAmount: MoneyString.optional(),
  receivedAt: z.string().datetime().optional(),
  checkNumber: z.string().max(50).optional(),
  notes: z.string().max(1000).optional(),
  allocations: z.array(z.object({ invoiceId: Uuid, amount: MoneyString })).optional(),
  processorPaymentId: z.string().max(200).optional(),
});

const InvoiceOut = z.object({
  id: Uuid,
  number: z.number().int().optional(),
  status: z.string(),
  issuedOn: z.string().nullable().optional(),
  taxTotal: MoneyString.optional(),
  total: MoneyString,
  balance: MoneyString,
  amountPaid: MoneyString.optional(),
  externalRef: ExternalRefOut,
}).passthrough();

const Allocation = z.object({ invoiceId: Uuid, amount: MoneyString });

const PaymentOut = z.object({
  id: Uuid,
  amount: MoneyString,
  allocations: z.array(Allocation),
  unappliedAmount: MoneyString.optional(),
}).passthrough();

/** contracts/billing.ts Payment, as GET /v1/payments returns it. */
const PaymentRow = z.object({
  id: Uuid,
  customerId: Uuid,
  method: z.string(),
  status: z.string(),
  amount: MoneyString,
  refundedAmount: MoneyString.optional(),
  receivedAt: z.string(),
  allocations: z.array(Allocation),
  unappliedAmount: MoneyString,
  externalRef: ExternalRefOut,
}).passthrough();

const EstimateOut = z.object({ id: Uuid, status: z.string(), externalRef: ExternalRefOut }).passthrough();

/** contracts/billing.ts recordRefund: how money went back outside a processor. */
export const RefundMethod = z.enum(["cash", "check", "ach", "credit", "other"]);
export type RefundMethod = z.infer<typeof RefundMethod>;

/** contracts/files.ts AttachableEntity. */
export const AttachableEntity = z.enum(["customer", "property", "job", "visit", "estimate", "invoice"]);
export type AttachableEntity = z.infer<typeof AttachableEntity>;

// contracts/people.ts and contracts/jobs.ts: what the target already has

/** contracts/people.ts listPeople (GET /v1/people). */
const PersonOut = z.object({
  membershipId: Uuid,
  userId: Uuid,
  name: z.string().nullable(),
  email: z.string(),
  role: z.string(),
  active: z.boolean(),
  technicianId: Uuid.nullable(),
  displayName: z.string().nullable(),
  technicianActive: z.boolean().nullable(),
}).passthrough();

const JobTypeOut = z.object({
  id: Uuid,
  name: z.string(),
  code: z.string().nullable(),
  active: z.boolean(),
}).passthrough();

// contracts/recurring.ts

export const RecurrenceModel = z.enum(["rule", "materialized", "anchored_to_completion", "manual"]);
export type RecurrenceModel = z.infer<typeof RecurrenceModel>;

/**
 * contracts/recurring.ts createRecurringSchedule (POST /v1/recurring-schedules).
 * No externalRef and no number: a schedule is found again by what it is.
 */
export const RecurringScheduleCreate = z.object({
  label: z.string().min(1).max(200),
  customerId: Uuid,
  propertyId: Uuid,
  summary: z.string().min(1).max(500),
  model: RecurrenceModel,
  startsOn: z.string().date(),
  endsOn: z.string().date().nullable().optional(),
  intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  anchorMonths: z.array(z.number().int().min(1).max(12)).optional(),
  jobTypeId: Uuid.nullable().optional(),
  estimatedDurationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  horizonMonths: z.number().int().min(1).max(60).optional(),
});

const RecurringScheduleOut = z.object({
  id: Uuid,
  label: z.string(),
  customerId: Uuid.nullable(),
  propertyId: Uuid.nullable(),
  summary: z.string(),
  model: RecurrenceModel,
  startsOn: z.string(),
  lastOccurredOn: z.string().nullable(),
  nextDueOn: z.string().nullable(),
  active: z.boolean(),
}).passthrough();

// contracts/apps.ts: what the token may do

/** contracts/apps.ts ScopeValue. Which of a kind of record a token reaches. */
export const ScopeValue = z.enum(["own", "crew", "business_unit", "location", "all"]);
export type ScopeValue = z.infer<typeof ScopeValue>;

/**
 * contracts/apps.ts getAppSelf (GET /v1/apps/me). The app behind the token,
 * exactly the permissions the install granted, and the scope in force on
 * every scoped resource, the unnamed ones included. Read leniently: a scope
 * value this toolkit does not know is still a scope that is not `all`.
 */
const AppSelfOut = z.object({
  appId: Uuid,
  name: z.string(),
  publisher: z.string().nullable(),
  organizationId: Uuid,
  permissions: z.array(z.string()),
  scopes: z.record(z.string()),
}).passthrough();
export type AppSelf = z.infer<typeof AppSelfOut>;

/** contracts/billing.ts listPayments totals: for the window, never for the page. */
const PaymentTotals = z.object({
  gross: MoneyString, fees: MoneyString, refunded: MoneyString, net: MoneyString,
});

/**
 * Every route the toolkit calls. `path` is the contract's own path; the
 * mount prefix (`/api` on the web app) belongs to the base URL.
 * `permissions` is what the contract declares the route needs, which is
 * what the load's preflight asks the token for and what the in-memory
 * target refuses without.
 */
export const ROUTES = {
  getAppSelf: { method: "GET", path: "/v1/apps/me", permissions: [], input: z.object({}), output: AppSelfOut },
  createCustomer: { method: "POST", path: "/v1/customers", permissions: ["customer:write"], input: CustomerCreate, output: withId },
  listCustomers: {
    method: "GET", path: "/v1/customers", permissions: ["customer:read"],
    input: z.object({ ...PageInput, includeInactive: z.boolean().default(false), ...ExternalLookup }),
    output: page(Row),
  },
  createProperty: { method: "POST", path: "/v1/properties", permissions: ["property:write"], input: PropertyCreate, output: withId },
  linkCustomerToProperty: {
    method: "POST", path: "/v1/properties/{id}/customers", permissions: ["property:write"], input: PropertyLink,
    output: z.object({ ok: z.literal(true) }).passthrough(),
  },
  listProperties: {
    method: "GET", path: "/v1/properties", permissions: ["property:read"], input: z.object({ ...PageInput, ...ExternalLookup }), output: page(Row),
  },
  createPriceBookItem: { method: "POST", path: "/v1/pricebook/items", permissions: ["pricebook:write"], input: PriceBookItemCreate, output: withId },
  setPriceBookItemActive: {
    method: "POST", path: "/v1/pricebook/items/{id}/active", permissions: ["pricebook:write"], input: PriceBookItemActive, output: withId,
  },
  listPriceBook: {
    method: "GET", path: "/v1/pricebook/items", permissions: ["pricebook:read"],
    input: z.object({ ...PageInput, includeInactive: z.boolean().default(false), ...ExternalLookup }),
    output: page(Row),
  },
  createJob: { method: "POST", path: "/v1/jobs", permissions: ["job:write"], input: JobCreate, output: JobOut },
  getJob: { method: "GET", path: "/v1/jobs/{id}", permissions: ["job:read"], input: z.object({ id: Uuid }), output: JobOut },
  updateJob: { method: "PATCH", path: "/v1/jobs/{id}", permissions: ["job:write"], input: JobUpdate, output: JobOut },
  scheduleVisit: { method: "POST", path: "/v1/jobs/{id}/visits", permissions: ["visit:write"], input: VisitSchedule, output: VisitOut },
  completeVisit: { method: "POST", path: "/v1/visits/{id}/complete", permissions: ["job:complete"], input: VisitComplete, output: VisitOut },
  listJobs: { method: "GET", path: "/v1/jobs", permissions: ["job:read"], input: z.object({ ...PageInput, ...ExternalLookup }), output: page(Row) },
  listJobTypes: {
    method: "GET", path: "/v1/job-types", permissions: ["job:read"], input: z.object({ includeInactive: z.boolean().default(false) }),
    output: z.object({ data: z.array(JobTypeOut) }),
  },
  createEstimate: { method: "POST", path: "/v1/estimates", permissions: ["estimate:write"], input: EstimateCreate, output: EstimateOut },
  declineEstimate: { method: "POST", path: "/v1/estimates/{id}/decline", permissions: ["estimate:write"], input: EstimateDecline, output: EstimateOut },
  listEstimates: {
    method: "GET", path: "/v1/estimates", permissions: ["estimate:read"], input: z.object({ ...PageInput, ...ExternalLookup }),
    output: page(z.object({ id: Uuid, status: z.string(), total: MoneyString, externalRef: ExternalRefOut }).passthrough()),
  },
  createInvoice: { method: "POST", path: "/v1/invoices", permissions: ["invoice:write"], input: InvoiceCreate, output: InvoiceOut },
  voidInvoice: { method: "POST", path: "/v1/invoices/{id}/void", permissions: ["invoice:void"], input: InvoiceEnd, output: InvoiceOut },
  writeOffInvoice: { method: "POST", path: "/v1/invoices/{id}/write-off", permissions: ["invoice:writeoff"], input: InvoiceEnd, output: InvoiceOut },
  getInvoice: { method: "GET", path: "/v1/invoices/{id}", permissions: ["invoice:read"], input: z.object({ id: Uuid }), output: InvoiceOut },
  listInvoices: {
    method: "GET", path: "/v1/invoices", permissions: ["invoice:read"], input: z.object({ ...PageInput, ...ExternalLookup }), output: page(InvoiceOut),
  },
  recordPayment: { method: "POST", path: "/v1/payments", permissions: ["payment:collect"], input: PaymentRecord, output: PaymentOut },
  listPayments: {
    method: "GET", path: "/v1/payments", permissions: ["payment:read"],
    input: z.object({
      ...PageInput,
      customerId: Uuid.optional(),
      invoiceId: Uuid.optional(),
      unappliedOnly: z.boolean().default(false),
      ...ExternalLookup,
    }),
    /**
     * A page of payments under `data`, by cursor, and beside it totals and a
     * per-method split for the whole filtered window. The totals are the
     * core's banking summary: they cover every payment in the company, not
     * only this migration's, and the core computes them over at most 500
     * rows, so reconcile never reads them and sums the pages instead.
     */
    output: page(PaymentRow).extend({
      totals: PaymentTotals.optional(),
      byMethod: z.array(z.object({ method: z.string(), count: z.number(), gross: MoneyString, net: MoneyString })).optional(),
    }),
  },
  recordRefund: {
    method: "POST", path: "/v1/payments/{id}/refunds", permissions: ["payment:refund"],
    input: z.object({
      id: Uuid,
      amount: MoneyString,
      method: RefundMethod,
      refundedAt: z.string().datetime().optional(),
      checkNumber: z.string().max(50).optional(),
      reason: z.string().min(1).max(500),
    }),
    output: PaymentRow,
  },
  uploadAttachment: {
    method: "POST", path: "/v1/attachments", permissions: ["document:write"],
    input: z.object({
      entityType: AttachableEntity,
      entityId: Uuid,
      fileName: z.string().min(1).max(255),
      contentType: z.string().max(100).optional(),
      bytes: z.string().min(4).max(28 * 1024 * 1024),
      kind: z.enum(["photo", "document", "signature", "other"]).optional(),
      phase: z.enum(["before", "during", "after"]).optional(),
    }),
    output: z.object({ id: Uuid, entityType: AttachableEntity, entityId: Uuid, alreadyHeld: z.boolean() }).passthrough(),
  },
  listPeople: {
    method: "GET", path: "/v1/people", permissions: ["user:read"], input: z.object({ email: z.string().max(320).optional() }),
    output: z.object({ people: z.array(PersonOut) }),
  },
  createRecurringSchedule: {
    method: "POST", path: "/v1/recurring-schedules", permissions: ["job:write"], input: RecurringScheduleCreate,
    output: z.object({ id: Uuid, label: z.string(), nextDueOn: z.string().nullable() }).passthrough(),
  },
  listRecurringSchedules: {
    method: "GET", path: "/v1/recurring-schedules", permissions: ["job:read"], input: z.object({}),
    output: z.object({ schedules: z.array(RecurringScheduleOut) }),
  },
  recordRecurringCompletion: {
    method: "POST", path: "/v1/recurring-schedules/{id}/completed", permissions: ["job:write"],
    input: z.object({ id: Uuid, completedOn: z.string().date() }),
    output: z.object({ id: Uuid, lastOccurredOn: z.string(), nextDueOn: z.string().nullable() }).passthrough(),
  },
  exceptRecurringOccurrence: {
    method: "POST", path: "/v1/recurring-schedules/{id}/exceptions", permissions: ["job:write"],
    input: z.object({
      id: Uuid,
      date: z.string().date(),
      action: z.enum(["skipped", "moved", "cancelled"]),
      movedTo: z.string().date().optional(),
      reason: z.string().max(500).optional(),
    }),
    output: z.object({ id: Uuid }).passthrough(),
  },
  setRecurringScheduleActive: {
    method: "POST", path: "/v1/recurring-schedules/{id}/active", permissions: ["job:write"],
    input: z.object({ id: Uuid, active: z.boolean() }),
    output: z.object({ id: Uuid, active: z.boolean() }).passthrough(),
  },
} as const;

export type RouteName = keyof typeof ROUTES;
export type InputOf<N extends RouteName> = z.input<(typeof ROUTES)[N]["input"]>;
export type OutputOf<N extends RouteName> = z.infer<(typeof ROUTES)[N]["output"]>;

/** The field paths a 422 would carry, computed locally. */
export function validate<N extends RouteName>(name: N, input: unknown):
  | { ok: true }
  | { ok: false; issues: { path: string; message: string }[] } {
  const parsed = ROUTES[name].input.safeParse(input);
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}

/** What the contract says a route needs. */
export function routePermissions(name: RouteName): readonly string[] {
  return ROUTES[name].permissions;
}

/** contracts/apps.ts: the scoped resources GET /v1/apps/me reports on. */
export const SCOPED_RESOURCES = ["job", "visit", "customer", "estimate", "invoice", "timesheet", "servicereport", "conversation"] as const;
