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
});

/**
 * contracts/jobs.ts JobCreate (POST /v1/jobs). `parties` and `coverage` are
 * left out: no source in this toolkit carries them, and an empty object for
 * either is not the same request as an absent one.
 */
export const JobCreate = z.object({
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

/** contracts/jobs.ts updateJob (PATCH /v1/jobs/{id}), status only. */
export const JobUpdate = z.object({
  id: Uuid,
  status: JobStatus.optional(),
});

/** contracts/jobs.ts scheduleVisit (POST /v1/jobs/{id}/visits). */
export const VisitSchedule = VisitInput.extend({
  id: Uuid,
  crewId: Uuid.optional(),
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

const VisitOut = z.object({
  id: Uuid,
  sequence: z.number().int(),
  status: z.string(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  completedAt: z.string().nullable().optional(),
}).passthrough();

const JobOut = z.object({
  id: Uuid,
  number: z.number().int().optional(),
  status: JobStatus,
  visits: z.array(VisitOut).default([]),
}).passthrough();

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
  isOptional: z.boolean().default(false),
  isSelected: z.boolean().default(false),
  costCode: z.string().max(50).optional(),
});

/** contracts/estimates.ts createEstimate (POST /v1/estimates). */
export const EstimateCreate = z.object({
  customerId: Uuid,
  propertyId: Uuid,
  jobId: Uuid.optional(),
  title: z.string().max(200).optional(),
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

/** contracts/billing.ts createInvoice (POST /v1/invoices). */
export const InvoiceCreate = z.object({
  customerId: Uuid,
  payerCustomerId: Uuid.optional(),
  jobId: Uuid.optional(),
  purchaseOrderNumber: z.string().max(100).optional(),
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
    costCode: z.string().max(50).optional(),
  })).min(1),
});

/** contracts/billing.ts voidInvoice and writeOffInvoice. Both demand a reason. */
export const InvoiceEnd = z.object({
  id: Uuid,
  reason: z.string().min(1).max(500),
});

/** contracts/billing.ts recordPayment (POST /v1/payments). */
export const PaymentRecord = z.object({
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
  total: MoneyString,
  balance: MoneyString,
  amountPaid: MoneyString.optional(),
}).passthrough();

const PaymentOut = z.object({
  id: Uuid,
  amount: MoneyString,
  allocations: z.array(z.object({ invoiceId: Uuid, amount: MoneyString })),
}).passthrough();

const EstimateOut = z.object({ id: Uuid, status: z.string() }).passthrough();

/**
 * Every route the toolkit calls. `path` is the contract's own path; the
 * mount prefix (`/api` on the web app) belongs to the base URL.
 */
export const ROUTES = {
  createCustomer: { method: "POST", path: "/v1/customers", input: CustomerCreate, output: withId },
  listCustomers: {
    method: "GET", path: "/v1/customers",
    input: z.object({ ...PageInput, includeInactive: z.boolean().default(false) }),
    output: page(withId),
  },
  createProperty: { method: "POST", path: "/v1/properties", input: PropertyCreate, output: withId },
  linkCustomerToProperty: {
    method: "POST", path: "/v1/properties/{id}/customers", input: PropertyLink,
    output: z.object({ ok: z.literal(true) }).passthrough(),
  },
  listProperties: { method: "GET", path: "/v1/properties", input: z.object(PageInput), output: page(withId) },
  createPriceBookItem: { method: "POST", path: "/v1/pricebook/items", input: PriceBookItemCreate, output: withId },
  setPriceBookItemActive: {
    method: "POST", path: "/v1/pricebook/items/{id}/active", input: PriceBookItemActive, output: withId,
  },
  listPriceBook: {
    method: "GET", path: "/v1/pricebook/items",
    input: z.object({ ...PageInput, includeInactive: z.boolean().default(false) }),
    output: page(withId),
  },
  createJob: { method: "POST", path: "/v1/jobs", input: JobCreate, output: JobOut },
  getJob: { method: "GET", path: "/v1/jobs/{id}", input: z.object({ id: Uuid }), output: JobOut },
  updateJob: { method: "PATCH", path: "/v1/jobs/{id}", input: JobUpdate, output: JobOut },
  scheduleVisit: { method: "POST", path: "/v1/jobs/{id}/visits", input: VisitSchedule, output: VisitOut },
  completeVisit: { method: "POST", path: "/v1/visits/{id}/complete", input: VisitComplete, output: VisitOut },
  listJobs: { method: "GET", path: "/v1/jobs", input: z.object(PageInput), output: page(withId) },
  createEstimate: { method: "POST", path: "/v1/estimates", input: EstimateCreate, output: EstimateOut },
  declineEstimate: { method: "POST", path: "/v1/estimates/{id}/decline", input: EstimateDecline, output: EstimateOut },
  listEstimates: {
    method: "GET", path: "/v1/estimates", input: z.object(PageInput),
    output: page(z.object({ id: Uuid, total: MoneyString }).passthrough()),
  },
  createInvoice: { method: "POST", path: "/v1/invoices", input: InvoiceCreate, output: InvoiceOut },
  voidInvoice: { method: "POST", path: "/v1/invoices/{id}/void", input: InvoiceEnd, output: InvoiceOut },
  writeOffInvoice: { method: "POST", path: "/v1/invoices/{id}/write-off", input: InvoiceEnd, output: InvoiceOut },
  listInvoices: { method: "GET", path: "/v1/invoices", input: z.object(PageInput), output: page(InvoiceOut) },
  recordPayment: { method: "POST", path: "/v1/payments", input: PaymentRecord, output: PaymentOut },
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
