import { createHash } from "node:crypto";
import { z } from "zod";
import * as money from "../money/index.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalPriceBookItem, CanonicalJob, CanonicalVisit,
  CanonicalEstimate, CanonicalInvoice, CanonicalInvoiceLine, CanonicalPayment,
} from "../canonical/index.js";
import type { InputOf, JobStatus } from "../target/contracts.js";
import { Uuid } from "../target/contracts.js";
import {
  norm, guessJobStatus, guessVisitAction, guessInvoiceAction, guessEstimateAction,
  guessPaymentMethod, guessPaymentAction, type Mapping, type VisitAction,
} from "../mapping/index.js";
import type { GapCode } from "./gaps.js";

/**
 * CANONICAL TO REQUEST
 *
 * Pure functions from one canonical record to the body of the request that
 * creates it in OpenTradesOS. No network and no ledger: references arrive
 * already resolved, through `resolve`, so every rule about what a field
 * becomes can be tested against a fixture without a server.
 *
 * The rule throughout is that nothing is invented and nothing is dropped
 * silently. A value the target cannot take is left off and the record
 * carries the gap that lost it. A value the target would refuse outright, and
 * that the record cannot exist without, makes the record invalid with the
 * reason. And where the target recomputes something the source recorded (a
 * total, a tax), the difference is measured here, so the report can say by
 * how much.
 */

export interface Translated<B> {
  body?: B;
  /** A reference that did not resolve. The record waits on another one. */
  blocked?: string;
  /** Something the record cannot be loaded without, that no setting fixes. */
  invalid?: string;
  /** Deliberately not loaded, with why (a cancelled payment, an unmapped user). */
  skipped?: { reason: string; gap?: GapCode };
  warnings: string[];
  gaps: GapCode[];
}

export interface TranslateOptions {
  mapping: Mapping;
  /**
   * Add a clearly named line for tax as applied and for any amount the
   * source's lines do not account for, so the target total matches the
   * source total. Off by default, because it records tax as a line item
   * rather than as tax. See `invoice.tax` in docs/target-api-gaps.md.
   */
  carryTotals: boolean;
}

/** Look up the target id a source record became. */
export type Resolve = (entity: string, sourceId: string) => string | undefined;

const isEmail = (value: string): boolean => z.string().email().safeParse(value).success;

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/**
 * A full address or none. The target's Address requires a street, city,
 * state and postal code together, and a partial one is refused whole.
 */
export function addressOf(a: {
  line1?: string | undefined; line2?: string | undefined; city?: string | undefined;
  state?: string | undefined; postalCode?: string | undefined; country?: string | undefined;
}) {
  if (!present(a.line1) || !present(a.city) || !present(a.state) || !present(a.postalCode)) return undefined;
  return {
    line1: a.line1.trim(),
    ...(present(a.line2) ? { line2: a.line2.trim() } : {}),
    city: a.city.trim(),
    state: a.state.trim(),
    postalCode: a.postalCode.trim(),
    country: (a.country ?? "US").trim().toUpperCase(),
  };
}

/**
 * A timestamp the target accepts: ISO 8601 in UTC with a Z, which is what
 * `z.string().datetime()` requires. A bare date becomes noon UTC on that
 * day, so it stays the same calendar date in every US time zone instead of
 * sliding to the evening before.
 */
export function isoDateTime(value: string | undefined): string | undefined {
  if (!present(value)) return undefined;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T12:00:00.000Z`;
  const parsed = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** A calendar date the target accepts: YYYY-MM-DD. */
export function isoDate(value: string | undefined): string | undefined {
  if (!present(value)) return undefined;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

// Customers

export function customerRequest(c: CanonicalCustomer): Translated<InputOf<"createCustomer">> {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];

  let email = c.email?.trim();
  if (email !== undefined && !isEmail(email)) {
    warnings.push(`email ${JSON.stringify(email)} is not an address the target accepts; left off`);
    gaps.push("customer.contact_invalid");
    email = undefined;
  }
  let phone = c.phone?.trim();
  if (phone !== undefined && phone.length > 40) {
    warnings.push(`phone is ${phone.length} characters, over the target's 40; left off`);
    gaps.push("customer.contact_invalid");
    phone = undefined;
  }

  const billing = c.billingAddress ? addressOf(c.billingAddress) : undefined;
  if (c.billingAddress && !billing) {
    const parts = [c.billingAddress.line1, c.billingAddress.city, c.billingAddress.state, c.billingAddress.postalCode];
    if (parts.some(present)) {
      warnings.push("billing address is incomplete and the target stores a whole one or none; left off");
      gaps.push("customer.billing_incomplete");
    }
  }
  if (present(c.notes)) gaps.push("customer.notes");

  return {
    body: {
      type: c.type,
      name: c.name.trim(),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(billing ? { billingAddress: billing } : {}),
      ...(present(c.leadSource) ? { leadSource: c.leadSource.trim() } : {}),
      paymentTermsDays: c.paymentTermsDays,
      taxExempt: c.taxExempt,
      tags: c.tags,
      customFields: c.customFields,
    },
    warnings, gaps,
  };
}

// Properties

export interface PropertyPlan {
  /** Customers beyond the first, linked after the create. Target ids. */
  links: string[];
}

export function propertyRequest(p: CanonicalProperty, resolve: Resolve): Translated<InputOf<"createProperty">> & { plan?: PropertyPlan } {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];
  const owners: string[] = [];
  for (const sourceId of p.customerSourceIds) {
    const id = resolve("customer", sourceId);
    if (!id) return { blocked: `customer ${sourceId} is not in the target`, warnings, gaps };
    owners.push(id);
  }
  if (present(p.latitude) || present(p.longitude)) gaps.push("property.coordinates");

  return {
    body: {
      ...(present(p.nickname) ? { nickname: p.nickname.trim() } : {}),
      // Sent as the source has it, blanks included, so a property with no
      // street fails with the target's own field path rather than ours.
      address: addressOf({
        line1: p.addressLine1, line2: p.addressLine2, city: p.city, state: p.state,
        postalCode: p.postalCode, country: p.country,
      }) ?? {
        line1: p.addressLine1, city: p.city, state: p.state, postalCode: p.postalCode,
        country: (p.country || "US").toUpperCase(),
      },
      ...(present(p.accessNotes) ? { accessNotes: p.accessNotes.trim() } : {}),
      customFields: p.customFields,
      ...(owners[0] ? { customerId: owners[0], customerRole: "owner" as const } : {}),
    },
    plan: { links: owners.slice(1) },
    warnings, gaps,
  };
}

// Price book

/**
 * A code for an item that has none. The name, made safe, plus six hex
 * characters of the source id, so two items called "Service call" do not
 * collide and the same item gets the same code on every run.
 */
export function derivedCode(name: string, sourceId: string): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ITEM";
  const hash = createHash("sha256").update(sourceId).digest("hex").slice(0, 6).toUpperCase();
  return `${slug}-${hash}`;
}

export function priceBookRequest(i: CanonicalPriceBookItem): Translated<InputOf<"createPriceBookItem">> {
  const gaps: GapCode[] = [];
  const warnings: string[] = [];
  let code = i.code?.trim();
  if (!code) {
    code = derivedCode(i.name, i.sourceId);
    gaps.push("pricebook.code");
  }
  return {
    body: {
      kind: i.kind,
      code,
      name: i.name.trim(),
      ...(present(i.description) ? { description: i.description.trim() } : {}),
      price: i.price,
      ...(i.cost === undefined ? {} : { cost: i.cost }),
      taxable: i.taxable,
      ...(i.durationMinutes === undefined ? {} : { laborMinutes: i.durationMinutes }),
    },
    warnings, gaps,
  };
}

// Jobs and visits

export interface VisitPlan {
  sourceId: string;
  action: Exclude<VisitAction, "skip">;
  windowStart: string;
  windowEnd: string;
  estimatedDurationMinutes: number;
  technicianIds: string[];
  completedAt?: string;
  notes?: string;
}

export interface JobPlan {
  /** Visits to exist in the target, in order. The first is created with the job. */
  visits: VisitPlan[];
  /** The status the job should end in, before invoices and payments move it on. */
  status: JobStatus | null;
}

function durationOf(start: string, end: string): number {
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  return minutes >= 5 && minutes <= 1440 ? minutes : 60;
}

function technicians(visit: CanonicalVisit, mapping: Mapping, warnings: string[], gaps: GapCode[]): string[] {
  const out: string[] = [];
  for (const sourceId of visit.technicianSourceIds) {
    const target = mapping.users[sourceId]?.target;
    if (target && Uuid.safeParse(target).success) out.push(target);
    else {
      warnings.push(`visit ${visit.sourceId}: technician ${sourceId} has no target user in mapping.json; left off`);
      gaps.push("user.unmapped");
    }
  }
  return out;
}

export function visitPlans(job: CanonicalJob, mapping: Mapping, warnings: string[], gaps: GapCode[]): VisitPlan[] {
  const plans: VisitPlan[] = [];
  for (const visit of [...job.visits].sort((a, b) => a.sequence - b.sequence)) {
    const action = mapping.visitStatus[norm(visit.status)] ?? guessVisitAction(visit.status);
    if (action === "skip") {
      gaps.push("visit.cancelled");
      warnings.push(`visit ${visit.sourceId} is ${visit.status} in the source and was not loaded`);
      continue;
    }
    const start = isoDateTime(visit.windowStart);
    if (!start) {
      gaps.push("visit.unscheduled");
      warnings.push(`visit ${visit.sourceId} has no start time and cannot exist in the target`);
      continue;
    }
    let end = isoDateTime(visit.windowEnd);
    if (!end || Date.parse(end) < Date.parse(start)) {
      warnings.push(`visit ${visit.sourceId} has no usable end time; its window is the start time alone`);
      end = start;
    }
    const completedAt = isoDateTime(visit.completedAt);
    const completes = action === "complete" || completedAt !== undefined;
    if (completes && !completedAt) {
      warnings.push(`visit ${visit.sourceId} is complete with no completion time; the window end is used`);
    }
    plans.push({
      sourceId: visit.sourceId,
      action: completes ? "complete" : "schedule",
      windowStart: start,
      windowEnd: end,
      estimatedDurationMinutes: durationOf(start, end),
      technicianIds: technicians(visit, mapping, warnings, gaps),
      ...(completes ? { completedAt: completedAt ?? end } : {}),
      ...(present(visit.notes) ? { notes: visit.notes.trim() } : {}),
    });
  }
  return plans;
}

export function jobRequest(job: CanonicalJob, resolve: Resolve, mapping: Mapping): Translated<InputOf<"createJob">> & { plan?: JobPlan } {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];

  const customerId = resolve("customer", job.customerSourceId);
  if (!customerId) return { blocked: `customer ${job.customerSourceId || "(none)"} is not in the target`, warnings, gaps };
  if (!present(job.propertySourceId)) {
    return { invalid: "the job names no property, and every job in the target belongs to one", warnings, gaps };
  }
  const propertyId = resolve("property", job.propertySourceId);
  if (!propertyId) return { blocked: `property ${job.propertySourceId} is not in the target`, warnings, gaps };

  let jobTypeId: string | undefined;
  if (present(job.jobType)) {
    const mapped = mapping.jobTypes[job.jobType];
    if (mapped && Uuid.safeParse(mapped).success) jobTypeId = mapped;
    else gaps.push("job.job_type");
  }
  if (job.number !== undefined) gaps.push("job.number");

  const visits = visitPlans(job, mapping, warnings, gaps);
  const statusKey = norm(job.status);
  const status = statusKey in mapping.jobStatus ? mapping.jobStatus[statusKey]! : guessJobStatus(job.status);
  if (status === null) warnings.push(`job status ${JSON.stringify(job.status)} has no mapping; left where creation puts it`);
  if (job.completedAt && !visits.some((v) => v.action === "complete") && status === "completed") gaps.push("job.completed_at");

  const first = visits[0];
  return {
    body: {
      customerId,
      propertyId,
      ...(jobTypeId ? { jobTypeId } : {}),
      summary: job.summary.trim(),
      ...(present(job.description) ? { description: job.description.trim() } : {}),
      ...(present(job.leadSource) ? { leadSource: job.leadSource.trim() } : {}),
      customFields: job.customFields,
      ...(first ? {
        visit: {
          windowStart: first.windowStart,
          windowEnd: first.windowEnd,
          estimatedDurationMinutes: first.estimatedDurationMinutes,
          technicianIds: first.technicianIds,
        },
      } : {}),
    },
    plan: { visits, status: status === "invoiced" || status === "paid" ? "completed" : status },
    warnings, gaps,
  };
}

// Lines, shared by estimates and invoices

interface LineBody {
  name: string;
  description?: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxable: boolean;
}

/**
 * A canonical line as the target takes one. Where the source's line total is
 * below quantity times price, the difference is the line's own discount and
 * travels as `discountAmount`, which is what the source printed. A line total
 * above it cannot be expressed and is reported.
 */
export function lineBody(line: CanonicalInvoiceLine, warnings: string[]): LineBody {
  const gross = money.multiply(line.quantity, line.unitPrice);
  let discount = "0";
  const difference = money.subtract(gross, line.lineTotal);
  if (money.compare(difference, "0") > 0) discount = money.normalize(difference);
  else if (money.compare(difference, "0") < 0) {
    warnings.push(`line "${line.name}" totals ${money.display(line.lineTotal)}, more than quantity times price; the target will compute ${money.display(gross)}`);
  }
  return {
    name: (line.name.trim() || "Line item").slice(0, 200),
    ...(present(line.description) ? { description: line.description.trim() } : {}),
    quantity: money.normalize(line.quantity),
    unitPrice: money.normalize(line.unitPrice),
    discountAmount: discount,
    taxable: line.taxable,
  };
}

const lineNet = (l: LineBody): string => money.subtract(money.multiply(l.quantity, l.unitPrice), l.discountAmount);

// Estimates

export function estimateRequest(e: CanonicalEstimate, resolve: Resolve, mapping: Mapping): Translated<InputOf<"createEstimate">> & { decline?: boolean } {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];
  const customerId = resolve("customer", e.customerSourceId);
  if (!customerId) return { blocked: `customer ${e.customerSourceId || "(none)"} is not in the target`, warnings, gaps };
  if (!present(e.propertySourceId)) {
    return { invalid: "the estimate names no property, and every estimate in the target belongs to one", warnings, gaps };
  }
  const propertyId = resolve("property", e.propertySourceId);
  if (!propertyId) return { blocked: `property ${e.propertySourceId} is not in the target`, warnings, gaps };
  let jobId: string | undefined;
  if (present(e.jobSourceId)) {
    jobId = resolve("job", e.jobSourceId);
    if (!jobId) return { blocked: `job ${e.jobSourceId} is not in the target`, warnings, gaps };
  }

  const options = e.options.filter((o) => o.lines.length > 0);
  if (options.length === 0) return { invalid: "the estimate has no line items, and the target requires at least one", warnings, gaps };
  if (options.length > 5) return { invalid: `the estimate has ${options.length} options and the target takes at most 5`, warnings, gaps };

  const action = mapping.estimateStatus[norm(e.status)] ?? guessEstimateAction(e.status);
  const s = norm(e.status);
  if (action === "open" && !["draft", "open", "unknown", "new", ""].includes(s)) gaps.push("estimate.status");
  if (e.number !== undefined) gaps.push("estimate.number");
  if (present(e.issuedOn)) gaps.push("estimate.dates");
  if (!money.isZero(e.taxTotal)) gaps.push("estimate.tax");
  if (options.some((o) => o.lines.some((l) => l.priceBookItemSourceId))) gaps.push("invoice.reprice");

  const expiresOn = isoDate(e.expiresOn);
  return {
    body: {
      customerId,
      propertyId,
      ...(jobId ? { jobId } : {}),
      ...(present(e.title) ? { title: e.title.trim().slice(0, 200) } : {}),
      ...(expiresOn ? { expiresOn } : {}),
      options: options.map((o) => ({
        name: (o.name.trim() || "Option").slice(0, 100),
        ...(present(o.description) ? { description: o.description.trim() } : {}),
        isRecommended: o.isRecommended,
        lines: o.lines.map((l) => lineBody(l, warnings)),
      })),
    },
    decline: action === "decline",
    warnings, gaps,
  };
}

// Invoices

export interface InvoicePlan {
  void: boolean;
  writeOff: boolean;
  /** What the target will compute, so the report can say how far it is from the source. */
  expectedTotal: string;
}

export function invoiceRequest(i: CanonicalInvoice, resolve: Resolve, options: TranslateOptions): Translated<InputOf<"createInvoice">> & { plan?: InvoicePlan } {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];
  const customerId = resolve("customer", i.customerSourceId);
  if (!customerId) return { blocked: `customer ${i.customerSourceId || "(none)"} is not in the target`, warnings, gaps };
  let jobId: string | undefined;
  if (present(i.jobSourceId)) {
    jobId = resolve("job", i.jobSourceId);
    if (!jobId) return { blocked: `job ${i.jobSourceId} is not in the target`, warnings, gaps };
  }

  const label = `${i.sourceSystem}${i.number === undefined ? "" : ` invoice #${i.number}`}`;
  const lines = i.lines.map((l) => lineBody(l, warnings));
  if (i.lines.some((l) => l.priceBookItemSourceId)) gaps.push("invoice.reprice");

  if (lines.length === 0) {
    // The target requires a line. One that names itself for what it is and
    // carries the source's own subtotal is the record, not an invention.
    warnings.push("the source invoice has no line items; loaded as one line carrying its subtotal");
    lines.push({ name: `Migrated from ${label}`, quantity: "1.0000", unitPrice: money.normalize(i.subtotal), discountAmount: "0", taxable: false });
  }

  const lineSum = money.sum(lines.map(lineNet));
  const unaccounted = money.subtract(i.subtotal, lineSum);
  if (!money.isZero(unaccounted)) {
    if (options.carryTotals) {
      lines.push({ name: `Not itemised on ${label}`, quantity: "1.0000", unitPrice: money.normalize(unaccounted), discountAmount: "0", taxable: false });
      warnings.push(`added a line of ${money.display(unaccounted)} the source's lines do not account for`);
    } else {
      gaps.push("invoice.totals");
      warnings.push(`the source's lines total ${money.display(lineSum)} against a subtotal of ${money.display(i.subtotal)}`);
    }
  }
  if (!money.isZero(i.taxTotal)) {
    if (options.carryTotals) {
      lines.push({ name: `Sales tax as applied on ${label}`, quantity: "1.0000", unitPrice: money.normalize(i.taxTotal), discountAmount: "0", taxable: false });
    } else {
      gaps.push("invoice.tax");
    }
  }
  if (i.number !== undefined) gaps.push("invoice.number");
  if (present(i.issuedOn)) gaps.push("invoice.issued_on");
  gaps.push("ledger.dates");

  const action = options.mapping.invoiceStatus[norm(i.status)] ?? guessInvoiceAction(i.status);
  const issued = isoDate(i.issuedOn);
  const dueOn = isoDate(i.dueOn);
  return {
    body: {
      customerId,
      ...(jobId ? { jobId } : {}),
      ...(dueOn ? { dueOn } : {}),
      memo: `Migrated from ${label}${issued ? `, issued ${issued}` : ""}.`,
      lines,
    },
    plan: { void: action === "void", writeOff: action === "write_off", expectedTotal: money.sum(lines.map(lineNet)) },
    warnings, gaps,
  };
}

// Payments

export function paymentRequest(p: CanonicalPayment, resolve: Resolve, mapping: Mapping): Translated<InputOf<"recordPayment">> {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];

  const action = mapping.paymentStatus[norm(p.status)] ?? guessPaymentAction(p.status);
  if (action === "skip") return { skipped: { reason: `payment status ${JSON.stringify(p.status)} is not money received` }, warnings, gaps };
  if (money.compare(p.amount, "0") <= 0) {
    return { skipped: { reason: `a payment of ${money.display(p.amount)} is a refund or reversal`, gap: "payment.refund" }, warnings, gaps };
  }
  // The dangerous one. Sent with no allocations, the target spreads the money
  // across the customer's oldest open invoices, which turns a deposit on next
  // month's job into a payment of an invoice from 2021.
  if (p.allocations.length === 0) {
    return { skipped: { reason: `${money.display(p.amount)} is not applied to any invoice (a deposit or credit), and the target cannot hold unapplied money`, gap: "payment.unapplied" }, warnings, gaps };
  }

  const customerId = resolve("customer", p.customerSourceId);
  if (!customerId) return { blocked: `customer ${p.customerSourceId || "(none)"} is not in the target`, warnings, gaps };

  const allocations: { invoiceId: string; amount: string }[] = [];
  for (const a of p.allocations) {
    const invoiceId = resolve("invoice", a.invoiceSourceId);
    // All or nothing. A payment loaded with some of its allocations would
    // post the rest as applied to nothing, or worse, oldest first.
    if (!invoiceId) return { blocked: `invoice ${a.invoiceSourceId} is not in the target`, warnings, gaps };
    allocations.push({ invoiceId, amount: money.normalize(a.amount) });
  }
  const allocated = money.sum(allocations.map((a) => a.amount));
  if (money.compare(allocated, p.amount) > 0) {
    return { invalid: `allocations total ${money.display(allocated)} but the payment is ${money.display(p.amount)}`, warnings, gaps };
  }
  if (money.compare(allocated, p.amount) < 0) {
    warnings.push(`${money.display(money.subtract(p.amount, allocated))} of this payment is applied to nothing and stays unapplied`);
  }

  const receivedAt = isoDateTime(p.receivedAt);
  if (!receivedAt) warnings.push(`received date ${JSON.stringify(p.receivedAt)} is unreadable; the target will use today`);
  gaps.push("ledger.dates");

  const methodKey = norm(p.method);
  return {
    body: {
      customerId,
      method: mapping.paymentMethods[methodKey] ?? guessPaymentMethod(p.method),
      amount: money.normalize(p.amount),
      ...(receivedAt ? { receivedAt } : {}),
      notes: `Migrated from ${p.sourceSystem} payment ${p.sourceId}.`,
      allocations,
    },
    warnings, gaps,
  };
}
