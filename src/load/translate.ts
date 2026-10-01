import { createHash } from "node:crypto";
import { z } from "zod";
import * as money from "../money/index.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalPriceBookItem, CanonicalJob, CanonicalVisit,
  CanonicalEstimate, CanonicalInvoice, CanonicalInvoiceLine, CanonicalPayment, CanonicalRecurringSchedule,
} from "../canonical/index.js";
import type { InputOf, JobStatus, ExternalRef, RecurrenceModel } from "../target/contracts.js";
import { Uuid } from "../target/contracts.js";
import { computeInvoice, type InvoiceLineInput } from "../target/totals.js";
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
 * total, a tax), what it will compute is predicted here with its own
 * arithmetic and sent back to it as `expectedTotals`, so a document that
 * would load at a different total from the one the customer was sent is
 * refused rather than stored.
 *
 * History is sent as history: the day an invoice was issued, the day the
 * money arrived, when the job was finished, the document's own number and
 * the tax another system charged. The target accepts all of it from a token
 * holding `data:import`, and refuses it (403) from one that does not.
 */

export interface Translated<B> {
  body?: B;
  /** A reference that did not resolve. The record waits on another one. */
  blocked?: string;
  /** Something the record cannot be loaded without, that no setting fixes. */
  invalid?: string;
  /** Deliberately not loaded, with why (a refund, an ended schedule). */
  skipped?: { reason: string; gap?: GapCode };
  warnings: string[];
  gaps: GapCode[];
}

export interface TranslateOptions {
  mapping: Mapping;
  /**
   * Where tax as applied cannot be stated on the lines (the source charged
   * tax on lines it calls untaxable, or on nothing), carry it inside the
   * invoice's adjustment line so the total still matches. Off by default,
   * because that records tax as a line rather than as tax.
   */
  carryTotals?: boolean;
  /**
   * The `source` of every `externalRef` sent. Omitted, no externalRef is
   * sent. See `Ledger.externalSource`.
   */
  externalSource?: string;
  /** The target's today, for refusing to send a date in the future. */
  now?: Date;
}

/** Look up the target id a source record became. */
export type Resolve = (entity: string, sourceId: string) => string | undefined;

const isEmail = (value: string): boolean => z.string().email().safeParse(value).success;

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/** Where a record came from, as the target stores it. */
export function externalRef(options: Pick<TranslateOptions, "externalSource"> | undefined, id: string): ExternalRef | undefined {
  const source = options?.externalSource;
  if (!source || id === "" || id.length > 200) return undefined;
  return { source, id };
}

const withRef = (options: Pick<TranslateOptions, "externalSource"> | undefined, id: string) => {
  const ref = externalRef(options, id);
  return ref ? { externalRef: ref } : {};
};

/** The id a visit is known by in the target: its job's and its own, because a visit id alone is not unique in every source. */
export const visitExternalId = (jobSourceId: string, visitSourceId: string): string => `${jobSourceId}#${visitSourceId}`;

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

/** core history CLOCK_SKEW_MS: an instant this far ahead is not yet the future. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * A business date the target will take. The target refuses the future
 * outright (a post-dated invoice is a draft, money not yet received has not
 * been), so one is left off, the target uses today, and the record says so.
 */
function pastDate(value: string | undefined, what: string, options: TranslateOptions, warnings: string[], gaps: GapCode[]): string | undefined {
  const date = isoDate(value);
  if (!date) return undefined;
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  if (date > today) {
    warnings.push(`${what} ${date} is in the future, which the target refuses; left off`);
    gaps.push("history.future");
    return undefined;
  }
  return date;
}

function pastInstant(value: string | undefined, what: string, options: TranslateOptions, warnings: string[], gaps: GapCode[]): string | undefined {
  const at = isoDateTime(value);
  if (!at) return undefined;
  if (Date.parse(at) - (options.now ?? new Date()).getTime() > CLOCK_SKEW_MS) {
    warnings.push(`${what} ${at} is in the future, which the target refuses; left off`);
    gaps.push("history.future");
    return undefined;
  }
  return at;
}

// Customers

export function customerRequest(c: CanonicalCustomer, options?: Pick<TranslateOptions, "externalSource">): Translated<InputOf<"createCustomer">> {
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
      ...withRef(options, c.sourceId),
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

export function propertyRequest(p: CanonicalProperty, resolve: Resolve, options?: Pick<TranslateOptions, "externalSource">): Translated<InputOf<"createProperty">> & { plan?: PropertyPlan } {
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
      ...withRef(options, p.sourceId),
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

export function priceBookRequest(i: CanonicalPriceBookItem, options?: Pick<TranslateOptions, "externalSource">): Translated<InputOf<"createPriceBookItem">> {
  const gaps: GapCode[] = [];
  const warnings: string[] = [];
  let code = i.code?.trim();
  if (!code) {
    code = derivedCode(i.name, i.sourceId);
    gaps.push("pricebook.code");
  }
  return {
    body: {
      ...withRef(options, i.sourceId),
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
  /** What the target knows it by: see `visitExternalId`. */
  externalId: string;
  action: Exclude<VisitAction, "skip">;
  /** Both or neither: a visit nobody timed waits unassigned, off the board. */
  windowStart?: string;
  windowEnd?: string;
  estimatedDurationMinutes: number;
  technicianIds: string[];
  completedAt?: string;
  notes?: string;
}

export interface JobPlan {
  /** Visits to exist in the target, in order. */
  visits: VisitPlan[];
  /** Whether the first of them is created with the job. */
  inline: boolean;
  /** The status the job should end in, before invoices and payments move it on. */
  status: JobStatus | null;
  /** When it was finished, sent with the move to completed when no visit carries it. */
  completedAt?: string;
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
      warnings.push(`visit ${visit.sourceId}: technician ${sourceId} has no target technician in mapping.json; left off`);
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
      warnings.push(`visit ${visit.sourceId} is ${visit.status} in the source and mapping.json says to skip it`);
      continue;
    }
    const start = isoDateTime(visit.windowStart);
    let end = isoDateTime(visit.windowEnd);
    if (start && (!end || Date.parse(end) < Date.parse(start))) {
      warnings.push(`visit ${visit.sourceId} has no usable end time; its window is the start time alone`);
      end = start;
    }
    if (!start) end = undefined;
    const completedAt = action === "cancel" ? undefined : isoDateTime(visit.completedAt);
    const completes = action === "complete" || completedAt !== undefined;
    if (completes && !completedAt) {
      if (end) warnings.push(`visit ${visit.sourceId} is complete with no completion time; the window end is used`);
      else warnings.push(`visit ${visit.sourceId} is complete with no completion time and no window; the target will use today`);
    }
    plans.push({
      sourceId: visit.sourceId,
      externalId: visitExternalId(job.sourceId, visit.sourceId),
      action: action === "cancel" ? "cancel" : completes ? "complete" : "schedule",
      ...(start && end ? { windowStart: start, windowEnd: end } : {}),
      estimatedDurationMinutes: start && end ? durationOf(start, end) : 60,
      technicianIds: technicians(visit, mapping, warnings, gaps),
      ...(completes && (completedAt ?? end) ? { completedAt: (completedAt ?? end)! } : {}),
      ...(present(visit.notes) ? { notes: visit.notes.trim() } : {}),
    });
  }
  return plans;
}

export function jobRequest(job: CanonicalJob, resolve: Resolve, options: TranslateOptions): Translated<InputOf<"createJob">> & { plan?: JobPlan } {
  const { mapping } = options;
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

  const visits = visitPlans(job, mapping, warnings, gaps);
  const statusKey = norm(job.status);
  const status = statusKey in mapping.jobStatus ? mapping.jobStatus[statusKey]! : guessJobStatus(job.status);
  if (status === null) warnings.push(`job status ${JSON.stringify(job.status)} has no mapping; left where creation puts it`);
  const target = status === "invoiced" || status === "paid" ? "completed" : status;
  // A completed visit carries the date. With none, the job's own completion
  // time goes with its move to completed.
  const completedAt = target === "completed" && !visits.some((v) => v.action === "complete")
    ? pastInstant(job.completedAt, "completion time", options, warnings, gaps)
    : undefined;

  // The first visit goes in with the job when it can: a timed visit that is
  // going ahead. The inline visit takes no status and needs a window.
  const first = visits[0]?.action !== "cancel" && visits[0]?.windowStart ? visits[0] : undefined;
  return {
    body: {
      ...(job.number !== undefined && job.number >= 1 ? { number: job.number } : {}),
      ...withRef(options, job.sourceId),
      customerId,
      propertyId,
      ...(jobTypeId ? { jobTypeId } : {}),
      summary: job.summary.trim(),
      ...(present(job.description) ? { description: job.description.trim() } : {}),
      ...(present(job.leadSource) ? { leadSource: job.leadSource.trim() } : {}),
      customFields: job.customFields,
      ...(first ? {
        visit: {
          windowStart: first.windowStart!,
          windowEnd: first.windowEnd!,
          estimatedDurationMinutes: first.estimatedDurationMinutes,
          technicianIds: first.technicianIds,
          ...withRef(options, first.externalId),
        },
      } : {}),
    },
    plan: { visits, inline: first !== undefined, status: target, ...(completedAt ? { completedAt } : {}) },
    warnings, gaps,
  };
}

// Lines, shared by estimates and invoices

interface LineBody {
  priceBookItemId?: string;
  name: string;
  description?: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxable: boolean;
  taxRate?: string;
  taxAmount?: string;
  priceAsGiven?: boolean;
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

const asInput = (l: LineBody): InvoiceLineInput => ({
  quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount,
  taxable: l.taxable, taxRate: l.taxRate ?? "0", ...(l.taxAmount === undefined ? {} : { taxAmount: l.taxAmount }),
});

/**
 * A rate as a fraction. Sources write 8.25% as "0.0825" or as "8.25"; no
 * sales tax is a hundred percent, so anything of one or more is a percentage.
 */
export function rateOf(value: string | undefined): string | undefined {
  if (!present(value) || !/^-?\d+(\.\d+)?$/.test(value.trim())) return undefined;
  const v = value.trim();
  if (Number(v) === 0) return undefined;
  const fraction = Math.abs(Number(v)) >= 1 ? money.ratio(money.normalize(v), "100", 6) : v;
  return /^-?\d+(\.\d{1,6})?$/.test(fraction) ? fraction : money.ratio(money.normalize(fraction.slice(0, 12)), "1", 6);
}

export interface TaxPlan {
  /** Per line, what to add to it. Same length as the lines. */
  lines: { taxable?: boolean; taxRate?: string; taxAmount?: string }[];
  /** How it was carried, for the report. */
  how: "line" | "rate" | "apportioned";
}

const ONE_CENT = "0.0100";

/** Whether a stated tax is within rounding of its rate, as core's `statedTax` judges it. */
const withinACent = (net: string, rate: string, stated: string): boolean =>
  money.compare(money.abs(money.subtract(stated, money.multiplyRate(net, rate))), ONE_CENT) < 0;

/**
 * TAX AS ANOTHER SYSTEM CHARGED IT, in the form the target will accept.
 *
 * The target takes a rate and, optionally, an amount per line, and accepts a
 * stated amount only within a cent of what the rate gives on that line's net.
 * Three ways in, in order of how much of the source they keep:
 *
 *   1. The source said, per line, what each was taxed, and those add up to
 *      the invoice's tax. Sent line for line.
 *   2. One rate on every taxable line reproduces the invoice's tax to the
 *      cent under the target's own arithmetic (rounded once per document).
 *      Sent as that rate, which is what nearly every invoice actually was.
 *   3. The nearest rate, with the few cents its products miss by spread
 *      across the taxable lines as stated amounts, each within a cent of
 *      what that rate gives on its line, adding back to exactly the tax.
 *
 * Undefined when none fits: there is no taxable line to carry it, or it is
 * so far from any rate that the target would refuse it.
 */
export function taxPlan(lines: readonly LineBody[], source: readonly CanonicalInvoiceLine[], taxTotal: string): TaxPlan | undefined {
  const target = money.round(taxTotal, 2);
  const nets = lines.map(lineNet);

  // 1. As the source itemised it.
  const stated = source.map((l) => money.normalize(l.taxAmount));
  if (source.length === lines.length && stated.some((t) => !money.isZero(t)) && money.equals(money.round(money.sum(stated), 2), target)) {
    const planned = lines.map((_, i) => {
      if (money.isZero(stated[i]!)) return {};
      const net = nets[i]!;
      const rate = rateOf(source[i]!.taxRate) ?? (money.isZero(net) ? undefined : money.ratio(stated[i]!, net, 6));
      return rate === undefined ? undefined : { taxable: true, taxRate: rate, taxAmount: stated[i]! };
    });
    if (planned.every((p, i) => p !== undefined && (p.taxRate === undefined || withinACent(nets[i]!, p.taxRate, p.taxAmount!)))) {
      return { lines: planned as TaxPlan["lines"], how: "line" };
    }
  }

  const taxable = lines.map((l) => l.taxable);
  const base = money.sum(nets.filter((_, i) => taxable[i]));
  if (money.isZero(base)) return undefined;

  // 2. One rate, as the target would compute it.
  for (const places of [4, 5, 6]) {
    const rate = money.ratio(target, base, places);
    const withRate = lines.map((l, i) => ({ ...asInput(l), ...(taxable[i] ? { taxRate: rate } : {}) }));
    if (money.equals(computeInvoice(withRate).totals.taxTotal, target)) {
      return { lines: lines.map((_, i) => (taxable[i] ? { taxRate: rate } : {})), how: "rate" };
    }
  }

  // 3. The nearest rate, and the cents it misses by spread across the
  // taxable lines, each line's stated tax kept within a cent of the rate.
  const rate = money.ratio(target, base, 6);
  const indexes = lines.map((_, i) => i).filter((i) => taxable[i]);
  const owed = indexes.map((i) => money.multiplyRate(nets[i]!, rate));
  const residual = money.subtract(target, money.sum(owed));
  const spread = money.isZero(residual) ? indexes.map(() => "0") : money.apportion(residual, indexes.map((i) => money.abs(nets[i]!)));
  const planned: TaxPlan["lines"] = lines.map(() => ({}));
  for (const [k, i] of indexes.entries()) {
    const share = money.add(owed[k]!, spread[k]!);
    if (!withinACent(nets[i]!, rate, share)) return undefined;
    planned[i] = { taxRate: rate, taxAmount: share };
  }
  return { lines: planned, how: "apportioned" };
}

// Estimates

export function estimateRequest(e: CanonicalEstimate, resolve: Resolve, options: TranslateOptions): Translated<InputOf<"createEstimate">> & { decline?: boolean } {
  const { mapping } = options;
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

  const sourceOptions = e.options.filter((o) => o.lines.length > 0);
  if (sourceOptions.length === 0) return { invalid: "the estimate has no line items, and the target requires at least one", warnings, gaps };
  if (sourceOptions.length > 5) return { invalid: `the estimate has ${sourceOptions.length} options and the target takes at most 5`, warnings, gaps };

  const action = mapping.estimateStatus[norm(e.status)] ?? guessEstimateAction(e.status);
  const s = norm(e.status);
  if (action === "open" && !["draft", "open", "unknown", "new", ""].includes(s)) gaps.push("estimate.status");
  if (sourceOptions.some((o) => o.lines.some((l) => l.priceBookItemSourceId))) gaps.push("estimate.reprice");

  const built = sourceOptions.map((o) => ({ option: o, lines: o.lines.map((l) => lineBody(l, warnings)) }));

  // One rate for the estimate, found the way an invoice's is, from the
  // first option: the target takes no stated amount on an estimate line.
  let taxRate: string | undefined;
  if (!money.isZero(e.taxTotal)) {
    const plan = taxPlan(built[0]!.lines, [], e.taxTotal);
    if (plan?.how === "rate") taxRate = plan.lines.find((l) => l.taxRate)?.taxRate;
    if (!taxRate) {
      gaps.push("estimate.tax");
      warnings.push(`no single rate on the taxable lines gives the source's tax of ${money.display(e.taxTotal)}; loaded without tax`);
    }
  }

  const issuedOn = pastDate(e.issuedOn, "issue date", options, warnings, gaps);
  const expiresOn = isoDate(e.expiresOn);
  return {
    body: {
      ...(e.number !== undefined && e.number >= 1 ? { number: e.number } : {}),
      ...withRef(options, e.sourceId),
      customerId,
      propertyId,
      ...(jobId ? { jobId } : {}),
      ...(present(e.title) ? { title: e.title.trim().slice(0, 200) } : {}),
      ...(issuedOn ? { issuedOn } : {}),
      ...(expiresOn ? { expiresOn } : {}),
      ...(taxRate ? { taxRate } : {}),
      options: built.map(({ option, lines }) => ({
        name: (option.name.trim() || "Option").slice(0, 100),
        ...(present(option.description) ? { description: option.description.trim() } : {}),
        isRecommended: option.isRecommended,
        lines,
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
  /** What the target will compute, checked by it to the cent. */
  expectedTotal: string;
  expectedTax: string;
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
  const tax = money.normalize(i.taxTotal);
  const lines = i.lines.map((l) => {
    const body = lineBody(l, warnings);
    if (!l.priceBookItemSourceId) return body;
    // Linked AND kept as charged. Without priceAsGiven the target re-prices
    // a linked line at the item's current price.
    const itemId = resolve("priceBookItem", l.priceBookItemSourceId);
    if (!itemId) {
      warnings.push(`line "${body.name}" names price book item ${l.priceBookItemSourceId}, which is not in the target; not linked`);
      gaps.push("invoice.item_unlinked");
      return body;
    }
    return { priceBookItemId: itemId, ...body, priceAsGiven: true };
  });
  const sourceLines = [...i.lines];

  if (lines.length === 0) {
    // The target requires a line. One that names itself for what it is and
    // carries the source's own subtotal is the record, not an invention.
    warnings.push("the source invoice has no line items; loaded as one line carrying its subtotal");
    lines.push({ name: `Migrated from ${label}`, quantity: "1.0000", unitPrice: money.normalize(i.subtotal), discountAmount: "0", taxable: !money.isZero(tax) });
    sourceLines.length = 0;
  }

  // Tax as charged, on the lines.
  let taxCarried = false;
  if (!money.isZero(tax) || sourceLines.some((l) => !money.isZero(money.normalize(l.taxAmount)))) {
    const plan = money.isZero(tax) ? undefined : taxPlan(lines, sourceLines, tax);
    if (plan) {
      plan.lines.forEach((p, n) => Object.assign(lines[n]!, p));
      taxCarried = true;
    } else if (!money.isZero(tax)) {
      if (options.carryTotals !== true) gaps.push("invoice.tax");
      warnings.push(`the source's tax of ${money.display(tax)} cannot be stated on its lines (nothing taxable carries it within a cent)` +
        (options.carryTotals === true ? "; carried in the adjustment" : ""));
    } else {
      warnings.push("the source's lines carry tax but the invoice's tax total is zero; loaded without tax");
    }
  }

  // The total the customer was sent. The canonical shape defaults absent
  // totals to zero, so an invoice whose subtotal, tax and total are all
  // zero has stated none, and is loaded at whatever its lines give.
  const stated = !(money.isZero(i.total) && money.isZero(i.subtotal) && money.isZero(tax));
  const sourceTotal = !money.isZero(i.total) ? money.normalize(i.total) : money.add(money.normalize(i.subtotal), tax);
  const withoutAdjustment = computeInvoice(lines.map(asInput)).totals;

  let adjustment: { name: string; amount: string } | undefined;
  let expectedTotal = withoutAdjustment.total;
  if (stated) {
    // Tax that could not go on the lines is either left out of the target
    // total (and counted against invoice.tax) or carried in the adjustment.
    const carryTax = !taxCarried && !money.isZero(tax) && options.carryTotals === true;
    const wanted = !taxCarried && !money.isZero(tax) && !carryTax ? money.subtract(sourceTotal, tax) : sourceTotal;
    const difference = money.subtract(money.round(wanted, 2), withoutAdjustment.total);
    if (!money.isZero(difference)) {
      const unitemised = money.subtract(difference, carryTax ? tax : "0");
      const name = carryTax
        ? (money.isZero(unitemised) ? `Sales tax as applied on ${label}` : `Unitemised amount and sales tax as applied on ${label}`)
        : money.compare(difference, "0") < 0 ? `Discount on ${label}` : `Not itemised on ${label}`;
      adjustment = { name: name.slice(0, 200), amount: difference };
      warnings.push(`${money.display(difference)} the source's lines do not account for is carried as "${adjustment.name}"`);
    }
    expectedTotal = money.round(wanted, 2);
  }

  const body: InputOf<"createInvoice"> = {
    ...(i.number !== undefined && i.number >= 1 ? { number: i.number } : {}),
    ...withRef(options, i.sourceId),
    customerId,
    ...(jobId ? { jobId } : {}),
    lines,
    ...(adjustment ? { adjustment } : {}),
  };

  // Predicted here with the target's arithmetic, and sent so the target
  // refuses the invoice rather than storing one that disagrees.
  const predicted = computeInvoice([
    ...lines.map(asInput),
    ...(adjustment ? [{
      quantity: "1", taxable: false, taxRate: "0",
      unitPrice: money.compare(adjustment.amount, "0") < 0 ? "0" : adjustment.amount,
      discountAmount: money.compare(adjustment.amount, "0") < 0 ? money.negate(adjustment.amount) : "0",
    }] : []),
  ]).totals;
  if (!money.equals(predicted.total, expectedTotal)) {
    return { invalid: `the lines give ${money.display(predicted.total)} and the source's total is ${money.display(expectedTotal)}, and no adjustment reconciles them`, warnings, gaps };
  }
  body.expectedTotals = { taxTotal: predicted.taxTotal, total: predicted.total };

  const issuedOn = pastDate(i.issuedOn, "issue date", options, warnings, gaps);
  const dueOn = isoDate(i.dueOn);
  const action = options.mapping.invoiceStatus[norm(i.status)] ?? guessInvoiceAction(i.status);
  return {
    body: {
      ...body,
      ...(issuedOn ? { issuedOn } : {}),
      ...(dueOn ? { dueOn } : {}),
      memo: `Migrated from ${label}.`,
    },
    plan: { void: action === "void", writeOff: action === "write_off", expectedTotal: predicted.total, expectedTax: predicted.taxTotal },
    warnings, gaps,
  };
}

// Payments

export function paymentRequest(p: CanonicalPayment, resolve: Resolve, options: TranslateOptions): Translated<InputOf<"recordPayment">> & { refund?: true } {
  const { mapping } = options;
  const warnings: string[] = [];
  const gaps: GapCode[] = [];

  const action = mapping.paymentStatus[norm(p.status)] ?? guessPaymentAction(p.status);
  if (action === "skip") return { skipped: { reason: `payment status ${JSON.stringify(p.status)} is not money received` }, warnings, gaps };
  // A refund is recorded against the payment it gave back, after every
  // payment has loaded: see refundRequest.
  if (money.compare(p.amount, "0") < 0) return { refund: true, warnings, gaps };
  if (money.isZero(p.amount)) return { skipped: { reason: "a payment of $0.00 records nothing" }, warnings, gaps };

  const customerId = resolve("customer", p.customerSourceId);
  if (!customerId) return { blocked: `customer ${p.customerSourceId || "(none)"} is not in the target`, warnings, gaps };

  const allocations: { invoiceId: string; amount: string }[] = [];
  for (const a of p.allocations) {
    const invoiceId = resolve("invoice", a.invoiceSourceId);
    // All or nothing. A payment loaded with some of its allocations would
    // hold the rest as credit the customer does not have.
    if (!invoiceId) return { blocked: `invoice ${a.invoiceSourceId} is not in the target`, warnings, gaps };
    allocations.push({ invoiceId, amount: money.normalize(a.amount) });
  }
  const allocated = money.sum(allocations.map((a) => a.amount));
  if (money.compare(allocated, p.amount) > 0) {
    return { invalid: `allocations total ${money.display(allocated)} but the payment is ${money.display(p.amount)}`, warnings, gaps };
  }
  // Sent as an explicit list, empty included. Omitted, the target would
  // spread the money oldest balance first and a deposit on next month's job
  // would pay an invoice from 2021; empty, it holds the money for the
  // customer, which is what a deposit or a credit is.
  if (money.compare(allocated, p.amount) < 0) {
    warnings.push(`${money.display(money.subtract(p.amount, allocated))} of this payment is applied to nothing and is held for the customer`);
  }

  let receivedAt = pastInstant(p.receivedAt, "received date", options, warnings, gaps);
  if (!receivedAt && !gaps.includes("history.future")) {
    warnings.push(`received date ${JSON.stringify(p.receivedAt)} is unreadable; the target will use today`);
    receivedAt = undefined;
  }

  const methodKey = norm(p.method);
  return {
    body: {
      ...withRef(options, p.sourceId),
      customerId,
      method: mapping.paymentMethods[methodKey] ?? guessPaymentMethod(p.method),
      amount: money.normalize(p.amount),
      ...(receivedAt ? { receivedAt } : {}),
      notes: `Migrated from ${p.sourceSystem} payment ${p.sourceId}.`.slice(0, 1000),
      allocations,
    },
    warnings, gaps,
  };
}

// Recurring schedules

export interface SchedulePlan {
  /** For work counted from completion: the last time it was really done. */
  completedOn?: string;
  exceptions: { date: string; action: "skipped" | "moved" | "cancelled"; movedTo?: string; reason?: string }[];
  /**
   * Paused once created. The source already booked occurrences of it as
   * jobs, which are loaded, and the target cannot be told they belong to
   * this schedule, so left running it would book the same visits again.
   */
  pause: boolean;
}

const MODEL: Record<CanonicalRecurringSchedule["model"], RecurrenceModel> = {
  rule: "rule",
  "materialized-series": "materialized",
  "anchored-to-completion": "anchored_to_completion",
  "manual-list": "manual",
};

const ENDED = ["cancelled", "canceled", "ended", "expired", "inactive", "paused", "completed", "complete", "archived", "terminated", "stopped", "on_hold", "suspended", "lapsed"];

/** FREQ and INTERVAL out of an RRULE, which is all the target's models can use. */
function fromRule(rule: string | undefined): { unit: "day" | "week" | "month" | "year"; interval: number } | undefined {
  if (!present(rule)) return undefined;
  const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i.exec(rule)?.[1]?.toUpperCase();
  if (!freq) return undefined;
  const interval = Number(/INTERVAL=(\d+)/i.exec(rule)?.[1] ?? "1");
  const unit = ({ DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" } as const)[freq as "DAILY"];
  return interval >= 1 ? { unit, interval } : undefined;
}

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/**
 * A schedule as the target takes one, and what it must never do: book the
 * company's history again. The target books from a schedule's start date,
 * not from today, so a weekly rule that started in 2021 would put five years
 * of past visits on the board. A schedule that repeats is therefore started
 * at its next occurrence (the source's, or the first one on or after today
 * on the source's own cadence), and the past it already happened in stays
 * where it was loaded: as jobs.
 */
export function recurringRequest(s: CanonicalRecurringSchedule, resolve: Resolve, options: TranslateOptions): Translated<InputOf<"createRecurringSchedule">> & { plan?: SchedulePlan } {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);

  const customerId = resolve("customer", s.customerSourceId);
  if (!customerId) return { blocked: `customer ${s.customerSourceId || "(none)"} is not in the target`, warnings, gaps };
  if (!present(s.propertySourceId)) {
    return { invalid: "the schedule names no property, and every recurring schedule in the target belongs to one", warnings, gaps };
  }
  const propertyId = resolve("property", s.propertySourceId);
  if (!propertyId) return { blocked: `property ${s.propertySourceId} is not in the target`, warnings, gaps };

  const endsOn = isoDate(s.endsOn);
  if (ENDED.includes(norm(s.status)) || (endsOn !== undefined && endsOn < today)) {
    return {
      skipped: { reason: `the schedule is ${endsOn !== undefined && endsOn < today ? `ended (${endsOn})` : s.status} in the source; the target cannot create one that is not running`, gap: "recurring.inactive" },
      warnings, gaps,
    };
  }

  const model = MODEL[s.model];
  const cadence = s.intervalUnit && s.interval ? { unit: s.intervalUnit, interval: s.interval } : fromRule(s.rule);
  let intervalDays: number | undefined;
  let anchorMonths: number[] | undefined;
  if (cadence && (cadence.unit === "day" || cadence.unit === "week")) {
    intervalDays = cadence.interval * (cadence.unit === "week" ? 7 : 1);
  } else if (cadence) {
    const months = cadence.interval * (cadence.unit === "year" ? 12 : 1);
    if (model === "rule" && 12 % months === 0) {
      // Every 3, 4, 6 or 12 months is a set of months in the year. The
      // target pins those to the 15th, a day it does not let a caller choose.
      const from = isoDate(s.nextOccurrenceOn ?? s.anchorOn ?? s.startsOn);
      const first = from ? Number(from.slice(5, 7)) : undefined;
      if (first !== undefined) {
        anchorMonths = Array.from({ length: 12 / months }, (_, k) => ((first - 1 + k * months) % 12) + 1).sort((a, b) => a - b);
        if (from!.slice(8, 10) !== "15") {
          gaps.push("recurring.anchor_day");
          warnings.push(`occurrences fall on day ${from!.slice(8, 10)} in the source; the target pins months to the 15th`);
        }
      }
    }
  }

  if (model === "rule" && intervalDays === undefined && anchorMonths === undefined) {
    return { skipped: { reason: `the rule ${JSON.stringify(s.rule ?? `every ${s.interval ?? "?"} ${s.intervalUnit ?? "?"}`)} is not one the target can repeat (days, weeks, or months that divide a year)`, gap: "recurring.rule" }, warnings, gaps };
  }
  if (model === "anchored_to_completion" && intervalDays === undefined) {
    return { skipped: { reason: "work counted from completion needs a number of days, and the source gives months", gap: "recurring.rule" }, warnings, gaps };
  }

  const next = isoDate(s.nextOccurrenceOn);
  const anchor = pastDate(s.anchorOn, "last completion", options, warnings, gaps);
  let startsOn: string;
  let completedOn: string | undefined;
  if (model === "anchored_to_completion") {
    startsOn = isoDate(s.startsOn) ?? anchor ?? next ?? today;
    completedOn = anchor;
  } else if (model === "rule" && intervalDays !== undefined) {
    // On the source's cadence, from its start, to the first date not past.
    startsOn = next ?? isoDate(s.startsOn) ?? anchor ?? today;
    if (startsOn < today) {
      const behind = Math.ceil((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 864e5 / intervalDays);
      startsOn = addDays(startsOn, behind * intervalDays);
    }
  } else if (model === "rule") {
    startsOn = next !== undefined && next > today ? next : today;
  } else {
    // Materialized and manual series generate nothing in the target: their
    // dates are the jobs that were loaded. The schedule is the record of them.
    startsOn = isoDate(s.startsOn) ?? anchor ?? next ?? today;
  }
  if (endsOn !== undefined && endsOn < startsOn) {
    return { skipped: { reason: `the schedule ends on ${endsOn}, before its next occurrence`, gap: "recurring.inactive" }, warnings, gaps };
  }

  let jobTypeId: string | undefined;
  if (present(s.jobType)) {
    const mapped = options.mapping.jobTypes[s.jobType];
    if (mapped && Uuid.safeParse(mapped).success) jobTypeId = mapped;
    else gaps.push("job.job_type");
  }
  if (s.kind === "service-agreement" || s.price !== undefined || present(s.billingFrequency) || s.visitsPerTerm !== undefined) {
    gaps.push("recurring.agreement_terms");
  }
  if (s.technicianSourceIds.length > 0 || s.equipmentSourceIds.length > 0) gaps.push("recurring.assignment");

  const repeats = model === "rule" || model === "anchored_to_completion";
  const booked = s.jobSourceIds.length > 0;
  if (booked) {
    gaps.push("recurring.occurrences");
    if (repeats) warnings.push(`${s.jobSourceIds.length} occurrence(s) already loaded as jobs; the schedule is created paused so it does not book them again. Resume it once the board is checked.`);
  }

  const exceptions: SchedulePlan["exceptions"] = [];
  for (const e of s.exceptions) {
    const date = isoDate(e.on);
    if (!date) continue;
    const movedTo = isoDate(e.movedTo);
    exceptions.push({
      date, action: e.kind,
      ...(e.kind === "moved" && movedTo ? { movedTo } : {}),
      ...(present(e.notes) ? { reason: e.notes.trim().slice(0, 500) } : {}),
    });
  }

  return {
    body: {
      label: s.name.trim().slice(0, 200) || "Recurring work",
      customerId,
      propertyId,
      summary: (s.description?.trim() || s.name.trim() || "Recurring work").slice(0, 500),
      model,
      startsOn,
      ...(endsOn ? { endsOn } : {}),
      ...(intervalDays !== undefined ? { intervalDays } : {}),
      ...(anchorMonths ? { anchorMonths } : {}),
      ...(jobTypeId ? { jobTypeId } : {}),
    },
    plan: { ...(completedOn ? { completedOn } : {}), exceptions, pause: booked && repeats },
    warnings, gaps,
  };
}

// Refunds

/** How money went back, in the target's words for a refund paid by hand. */
export function refundMethodOf(method: string, mapping: Mapping): "cash" | "check" | "ach" | "credit" | "other" {
  const m = mapping.paymentMethods[norm(method)] ?? guessPaymentMethod(method);
  return m === "cash" || m === "check" || m === "ach" || m === "credit" ? m : "other";
}

export interface RefundCandidate {
  id: string;
  amount: string;
  refundedAmount: string;
  receivedAt: string;
  allocations: { invoiceId: string; amount: string }[];
}

/**
 * WHICH PAYMENT A REFUND GAVE BACK.
 *
 * A source records a refund as a negative payment and, nearly always, does
 * not say which payment it refunds. The target records a refund against the
 * payment. Guessing would be inventing, so the refund is attached only where
 * the answer is forced: exactly one of this customer's loaded payments was
 * received on or before it, still has the amount left to give back, and paid
 * every invoice the refund names. Anything else is reported, not loaded.
 */
export function refundRequest(
  p: CanonicalPayment, resolve: Resolve, candidates: readonly RefundCandidate[], options: TranslateOptions,
): Translated<InputOf<"recordRefund">> {
  const warnings: string[] = [];
  const gaps: GapCode[] = [];
  const amount = money.abs(money.normalize(p.amount));
  if (money.isZero(amount)) return { skipped: { reason: "a payment of $0.00 records nothing" }, warnings, gaps };

  const invoices: string[] = [];
  for (const a of p.allocations) {
    const id = resolve("invoice", a.invoiceSourceId);
    if (!id) return { blocked: `invoice ${a.invoiceSourceId} is not in the target`, warnings, gaps };
    invoices.push(id);
  }
  const refundedAt = pastInstant(p.receivedAt, "refund date", options, warnings, gaps);
  const fits = candidates.filter((c) =>
    money.compare(money.subtract(c.amount, c.refundedAmount), amount) >= 0 &&
    (refundedAt === undefined || Date.parse(c.receivedAt) <= Date.parse(refundedAt)) &&
    invoices.every((id) => c.allocations.some((a) => a.invoiceId === id && money.compare(a.amount, "0") > 0)));
  if (fits.length !== 1) {
    return {
      skipped: {
        reason: fits.length === 0
          ? `a refund of ${money.display(amount)} that no loaded payment of this customer can have given back`
          : `a refund of ${money.display(amount)} that any of ${fits.length} loaded payments could have given back; the source does not say which`,
        gap: "payment.refund",
      },
      warnings, gaps,
    };
  }
  return {
    body: {
      id: fits[0]!.id,
      amount,
      method: refundMethodOf(p.method, options.mapping),
      ...(refundedAt ? { refundedAt } : {}),
      reason: `Refunded in ${p.sourceSystem} (${p.sourceSystem} payment ${p.sourceId}).`.slice(0, 500),
    },
    warnings, gaps,
  };
}
