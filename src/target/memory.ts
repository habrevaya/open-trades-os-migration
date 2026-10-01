import { createHash, randomUUID } from "node:crypto";
import * as money from "../money/index.js";
import { ROUTES, JOB_TRANSITIONS, type RouteName, type InputOf, type OutputOf, type JobStatus, type ExternalRef } from "./contracts.js";
import { TargetError, type CallOptions, type Target } from "./client.js";
import { computeInvoice, TaxAsAppliedError } from "./totals.js";
import { sniff, MAX_ATTACHMENT_BYTES } from "./files.js";

/**
 * A SCRATCH TENANT, IN MEMORY
 *
 * `dryrun` loads into this, not into anything real. It runs the identical
 * loader against it (same translation, same ledger logic, same order), so a
 * dry run that passes has exercised every request load would send, and its
 * reconcile is a prediction of the real one.
 *
 * It mirrors the behaviour of the core's services that a migration depends
 * on, as they are written in packages/api/src/services, and is deliberately
 * no cleverer than that:
 *
 *   - input is validated with the mirrored contract, and refused with the
 *     same 422 field list the dispatcher returns;
 *   - creates honour an Idempotency-Key, scoped by entity type, checked
 *     before anything else, adding a visit included (services/jobs.ts
 *     addVisit reads it since 0a77904); recurring schedules do not;
 *   - an `externalRef` already claimed for that kind of record is a 409
 *     naming the id it became, as services/provenance.ts assertUnclaimed
 *     says it, and every list finds records by it;
 *   - HISTORY NEEDS `data:import` (core history, services/history.ts): a
 *     business date more than seven days back, a document number, a line's
 *     stated tax or `priceAsGiven` are a 403 "Missing permission:
 *     data:import" for a token without it, a date in the future is a 422,
 *     and nothing posts into a closed period;
 *   - invoice totals are computed from the lines exactly as core's
 *     `computeInvoice` does it (four places per line, rounded once to two
 *     per document), a stated tax more than a cent from its rate is a 422,
 *     an adjustment becomes a manual line, and `expectedTotals` that differ
 *     to the cent refuse the invoice;
 *   - a payment with allocations omitted is spread oldest balance first,
 *     an empty list holds the money unapplied;
 *   - job status moves only along the core's lifecycle, and `completedAt`
 *     goes with the move to completed and nowhere else.
 *
 * The tests' fake HTTP server serves this same object, so the behaviour the
 * loader is tested against and the behaviour dryrun predicts with cannot
 * drift apart from each other. They can drift from the core, and when they do
 * the remedy is to change this file to match it.
 */

interface MemoryVisit {
  id: string; jobId: string; sequence: number; status: string;
  windowStart: string | null; windowEnd: string | null; completedAt: string | null;
  technicianIds: string[]; technicianNotes: string | null; externalRef: ExternalRef | null;
}

interface VisitIn {
  windowStart?: string; windowEnd?: string; technicianIds: string[]; status?: "cancelled"; externalRef?: ExternalRef;
}

interface MemoryJob {
  id: string; number: number; status: JobStatus; customerId: string; propertyId: string;
  summary: string; jobTypeId: string | null; completedAt: string | null; visits: MemoryVisit[];
  externalRef: ExternalRef | null;
}

interface MemoryLine {
  name: string; quantity: string; unitPrice: string; discountAmount: string; taxable: boolean;
  taxRate: string; taxAmount: string; lineTotal: string; priceBookItemId: string | null; origin: "job" | "manual";
}

interface MemoryInvoice {
  id: string; number: number; status: string; customerId: string; jobId: string | null;
  issuedOn: string; dueOn: string | null; memo: string | null;
  subtotal: string; discountTotal: string; taxTotal: string; total: string; amountPaid: string; balance: string;
  lines: MemoryLine[]; externalRef: ExternalRef | null;
}

interface MemoryPayment {
  id: string; customerId: string; method: string; status: string; amount: string; receivedAt: string;
  allocations: { invoiceId: string; amount: string }[]; unappliedAmount: string; refundedAmount: string;
  notes: string | null; externalRef: ExternalRef | null; ledgerTransactionId: string;
}

export interface MemoryPerson {
  membershipId: string; userId: string; name: string | null; email: string; role: string; active: boolean;
  technicianId: string | null; displayName: string | null; technicianActive: boolean | null;
}

export interface MemoryJobType { id: string; name: string; code: string | null; defaultDurationMinutes: number; requiredSkills: string[]; active: boolean }

interface MemorySchedule {
  id: string; label: string; customerId: string; propertyId: string; summary: string;
  model: "rule" | "materialized" | "anchored_to_completion" | "manual";
  startsOn: string; endsOn: string | null; intervalDays: number | null; anchorMonths: number[];
  jobTypeId: string | null; lastOccurredOn: string | null; nextDueOn: string | null; active: boolean;
  exceptions: { date: string; action: string; movedTo?: string; reason?: string }[];
}

export interface MemoryTargetOptions {
  /** The server's clock. */
  today?: () => Date;
  /**
   * What the token may do beyond writing the records themselves. A
   * migration's token is given `data:import` by the owner; leave it out to
   * see what a token without it is refused.
   */
  permissions?: readonly string[];
  /** The last day the books are closed through, if any. */
  closedThrough?: string;
}

/** core history LATE_ENTRY_DAYS and CLOCK_SKEW_MS. */
const LATE_ENTRY_DAYS = 7;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

const TABLE: Record<string, string> = {
  customer: "customer", property: "property", price_book_item: "price book item", job: "job",
  visit: "visit", estimate: "estimate", invoice: "invoice", payment: "payment",
};

export class MemoryTarget implements Target {
  readonly description = "a scratch tenant in memory";

  readonly customers = new Map<string, Record<string, unknown>>();
  readonly properties = new Map<string, Record<string, unknown> & { customers: { customerId: string; role: string; isPrimary: boolean }[] }>();
  readonly items = new Map<string, Record<string, unknown>>();
  readonly jobs = new Map<string, MemoryJob>();
  readonly visits = new Map<string, MemoryVisit>();
  readonly estimates = new Map<string, Record<string, unknown>>();
  readonly invoices = new Map<string, MemoryInvoice>();
  readonly payments = new Map<string, MemoryPayment>();
  readonly schedules = new Map<string, MemorySchedule>();
  readonly attachments = new Map<string, { id: string; entityType: string; entityId: string; fileName: string; storageKey: string; contentType: string; sizeBytes: number; kind: string; phase: string | null; createdAt: string }>();
  readonly people: MemoryPerson[] = [];
  readonly jobTypes: MemoryJobType[] = [];

  /** How many times each route was called, for tests that count side effects. */
  readonly calls = new Map<RouteName, number>();

  private readonly idempotency = new Map<string, string>();
  private readonly claimed = new Map<string, string>();
  private readonly today: () => Date;
  private readonly permissions: Set<string>;
  private readonly closedThrough: string | undefined;

  constructor(options: MemoryTargetOptions = {}) {
    this.today = options.today ?? (() => new Date());
    this.permissions = new Set(options.permissions ?? ["data:import"]);
    this.closedThrough = options.closedThrough;
  }

  /** Someone who works here, as GET /v1/people lists them. Returns their technician id, if any. */
  addPerson(person: { name: string; email: string; technician?: boolean; active?: boolean; role?: string }): string | null {
    const technicianId = person.technician === false ? null : randomUUID();
    this.people.push({
      membershipId: randomUUID(), userId: randomUUID(), name: person.name, email: person.email,
      role: person.role ?? "technician", active: person.active ?? true, technicianId,
      displayName: technicianId ? person.name : null, technicianActive: technicianId ? (person.active ?? true) : null,
    });
    return technicianId;
  }

  addJobType(name: string, code: string | null = null): string {
    const id = randomUUID();
    this.jobTypes.push({ id, name, code, defaultDurationMinutes: 60, requiredSkills: [], active: true });
    return id;
  }

  async call<N extends RouteName>(name: N, rawInput: InputOf<N>, options: CallOptions = {}): Promise<OutputOf<N>> {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    const parsed = ROUTES[name].input.safeParse(rawInput);
    if (!parsed.success) {
      throw new TargetError(422, `${name}: Request did not match the schema`,
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    // Typed loosely inside: every branch below reads the fields its own route
    // declares, and the parse above is what makes that safe.
    const input = parsed.data as Record<string, unknown>;
    const result = this.handle(name, input, options.idempotencyKey);
    return structuredClone(result) as OutputOf<N>;
  }

  // History: core history and services/history.ts

  private todayDate(): string {
    return this.today().toISOString().slice(0, 10);
  }

  private requireImport(): void {
    if (!this.permissions.has("data:import")) throw new TargetError(403, "Missing permission: data:import");
  }

  private future(field: string, shown: string): never {
    throw new TargetError(422, `${field} is in the future`, [{ path: field, message: `${shown} has not happened yet. Record it when it does.` }]);
  }

  /** admitDate: a calendar date, read in the company's zone (UTC here). Returns whether it is history. */
  private admitDate(date: string, field: string): boolean {
    const age = daysBetween(date, this.todayDate());
    if (age < 0) this.future(field, date);
    if (age > LATE_ENTRY_DAYS) { this.requireImport(); return true; }
    return false;
  }

  private admitInstant(at: string, field: string): boolean {
    if (Date.parse(at) - this.today().getTime() > CLOCK_SKEW_MS) this.future(field, at);
    return this.admitDate(at.slice(0, 10), field);
  }

  /** services/history.ts assertPeriodOpen: nothing posts into a closed period, whoever asks. */
  private assertPeriodOpen(date: string): void {
    if (this.closedThrough !== undefined && date <= this.closedThrough) {
      throw new TargetError(409, `The books are closed through ${this.closedThrough}, so nothing can be posted on ${date}. ` +
        "Reopen the period if it really has to change, or record the correction today.");
    }
  }

  // Idempotency and provenance

  private seen(entity: string, key: string | undefined): string | undefined {
    return key ? this.idempotency.get(`${entity}:${key}`) : undefined;
  }

  private remember(entity: string, key: string | undefined, id: string): void {
    if (key) this.idempotency.set(`${entity}:${key}`, id);
  }

  /** services/provenance.ts assertUnclaimed. */
  private assertUnclaimed(table: string, ref: unknown): void {
    if (!ref) return;
    const { source, id } = ref as ExternalRef;
    const existing = this.claimed.get(`${table}|${source}|${id}`);
    if (existing) throw new TargetError(409, `${source} ${TABLE[table] ?? table} ${id} is already here, as ${existing}.`);
  }

  private claim(table: string, ref: unknown, id: string): ExternalRef | null {
    if (!ref) return null;
    const { source, id: sourceId } = ref as ExternalRef;
    this.claimed.set(`${table}|${source}|${sourceId}`, id);
    return { source, id: sourceId };
  }

  /** services/jobs.ts claimNumber: the one asked for, or one more than the highest in use. */
  private claimNumber(records: Iterable<{ number?: unknown }>, requested: unknown, what: string): number {
    const used = [...records].map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
    if (requested === undefined) return Math.max(1000, ...used) + 1;
    this.requireImport();
    if (used.includes(Number(requested))) throw new TargetError(409, `${what} number ${String(requested)} is already taken.`);
    return Number(requested);
  }

  private need<T>(map: Map<string, T>, id: unknown, what: string): T {
    const found = map.get(String(id));
    if (!found) throw new TargetError(404, `${what} not found`);
    return found;
  }

  private stamp() {
    const now = this.today().toISOString();
    return { createdAt: now, updatedAt: now };
  }

  private handle(name: RouteName, input: Record<string, unknown>, key: string | undefined): unknown {
    switch (name) {
      case "createCustomer": {
        const existing = this.seen("customer", key);
        if (existing) return this.customers.get(existing);
        this.assertUnclaimed("customer", input["externalRef"]);
        const id = randomUUID();
        const customer = { id, ...input, externalRef: this.claim("customer", input["externalRef"], id), ...this.stamp() };
        this.customers.set(id, customer);
        this.remember("customer", key, id);
        return customer;
      }
      case "listCustomers": return this.page(this.external([...this.customers.values()], input), input);

      case "createProperty": {
        const existing = this.seen("property", key);
        if (existing) return this.properties.get(existing);
        if (input["customerId"] !== undefined) this.need(this.customers, input["customerId"], "Customer");
        this.assertUnclaimed("property", input["externalRef"]);
        const id = randomUUID();
        const { customerId, customerRole, externalRef, ...rest } = input as { customerId?: string; customerRole?: string; externalRef?: unknown };
        const property = {
          id, ...rest, externalRef: this.claim("property", externalRef, id), ...this.stamp(),
          customers: customerId ? [{ customerId, role: customerRole ?? "owner", isPrimary: true }] : [],
        };
        this.properties.set(id, property);
        this.remember("property", key, id);
        return property;
      }
      case "linkCustomerToProperty": {
        const property = this.need(this.properties, input["id"], "Property");
        this.need(this.customers, input["customerId"], "Customer");
        // An open link for the same customer and role is updated, not doubled,
        // which is what services/properties.ts link() does.
        const found = property.customers.find((c) => c.customerId === input["customerId"] && c.role === input["role"]);
        if (found) found.isPrimary = Boolean(input["isPrimary"]);
        else property.customers.push({ customerId: String(input["customerId"]), role: String(input["role"]), isPrimary: Boolean(input["isPrimary"]) });
        return { ok: true };
      }
      case "listProperties": return this.page(this.external([...this.properties.values()], input), input);

      case "createPriceBookItem": {
        const existing = this.seen("price_book_item", key);
        if (existing) return this.items.get(existing);
        this.assertUnclaimed("price_book_item", input["externalRef"]);
        const id = randomUUID();
        const item = {
          id, versionId: randomUUID(), version: 1, active: true, ...input,
          externalRef: this.claim("price_book_item", input["externalRef"], id), ...this.stamp(),
        };
        this.items.set(id, item);
        this.remember("price_book_item", key, id);
        return item;
      }
      case "setPriceBookItemActive": {
        const item = this.need(this.items, input["id"], "Price book item");
        item["active"] = input["active"];
        return item;
      }
      case "listPriceBook": {
        const all = [...this.items.values()].filter((i) => input["includeInactive"] === true || i["active"] !== false);
        return this.page(this.external(all, input), input);
      }

      case "createJob": {
        const existing = this.seen("job", key);
        if (existing) return this.jobView(this.jobs.get(existing)!);
        this.need(this.customers, input["customerId"], "Customer");
        this.need(this.properties, input["propertyId"], "Property");
        const visit = input["visit"] as VisitIn | undefined;
        this.assertUnclaimed("job", input["externalRef"]);
        this.assertUnclaimed("visit", visit?.externalRef);
        const number = this.claimNumber(this.jobs.values(), input["number"], "Job");
        const id = randomUUID();
        const job: MemoryJob = {
          id, number, status: visit ? "scheduled" : "lead",
          customerId: String(input["customerId"]), propertyId: String(input["propertyId"]),
          summary: String(input["summary"]), jobTypeId: (input["jobTypeId"] as string | undefined) ?? null,
          completedAt: null, visits: [], externalRef: this.claim("job", input["externalRef"], id),
        };
        this.jobs.set(id, job);
        if (visit) this.addVisit(job, visit);
        this.remember("job", key, id);
        return this.jobView(job);
      }
      case "getJob": return this.jobView(this.need(this.jobs, input["id"], "Job"));
      case "updateJob": {
        const job = this.need(this.jobs, input["id"], "Job");
        const to = input["status"] as JobStatus | undefined;
        if (to !== undefined && !JOB_TRANSITIONS[job.status].includes(to)) {
          throw new TargetError(409, `A job cannot move from "${job.status}" to "${to}".`);
        }
        // services/jobs.ts update: the time goes with the move to completed.
        let completedAt: string | null = null;
        if (input["completedAt"] !== undefined) {
          if (to !== "completed" || job.status === "completed" || job.completedAt !== null) {
            throw new TargetError(422, "completedAt goes with the move to completed", [{
              path: "completedAt", message: 'Send it with status "completed", on a job that is not already completed.',
            }]);
          }
          completedAt = String(input["completedAt"]);
          this.admitInstant(completedAt, "completedAt");
        }
        if (to !== undefined) {
          if (to === "completed" && job.completedAt === null) job.completedAt = completedAt ?? this.today().toISOString();
          job.status = to;
        }
        return this.jobView(job);
      }
      case "scheduleVisit": {
        const job = this.need(this.jobs, input["id"], "Job");
        const existing = this.seen("visit", key);
        if (existing) return this.visits.get(existing);
        this.assertUnclaimed("visit", input["externalRef"]);
        // services/jobs.ts addVisit: both ends of the window or neither.
        if ((input["windowStart"] === undefined) !== (input["windowEnd"] === undefined)) {
          throw new TargetError(422, "A window has both ends or neither", [{
            path: input["windowStart"] === undefined ? "windowStart" : "windowEnd",
            message: "Send windowStart and windowEnd together, or neither for a visit with no time yet.",
          }]);
        }
        if (input["windowStart"] !== undefined && Date.parse(String(input["windowEnd"])) < Date.parse(String(input["windowStart"]))) {
          throw new TargetError(422, "The window ends before it starts", [{ path: "windowEnd", message: "windowEnd is before windowStart." }]);
        }
        const visit = this.addVisit(job, input as unknown as VisitIn);
        this.remember("visit", key, visit.id);
        return visit;
      }
      case "completeVisit": {
        const visit = this.need(this.visits, input["id"], "Visit");
        if (visit.status !== "completed" && visit.status !== "completed_after_cancellation") {
          visit.status = visit.status === "cancelled" ? "completed_after_cancellation" : "completed";
          // Any completedOfflineAt is accepted: work that happened is never refused.
          visit.completedAt = (input["completedOfflineAt"] as string | undefined) ?? this.today().toISOString();
          if (input["technicianNotes"] !== undefined) visit.technicianNotes = String(input["technicianNotes"]);
          const job = this.jobs.get(visit.jobId)!;
          const open = job.visits.filter((v) => ["unassigned", "scheduled", "dispatched", "en_route", "working"].includes(v.status));
          if (open.length === 0) { job.status = "completed"; job.completedAt = visit.completedAt; }
        }
        return { ...visit, raisedDispatchException: false };
      }
      case "listJobs": return this.page(this.external([...this.jobs.values()].map((j) => this.jobView(j)), input), input);
      case "listJobTypes":
        return { data: this.jobTypes.filter((t) => input["includeInactive"] === true || t.active) };

      case "createEstimate": {
        const existing = this.seen("estimate", key);
        if (existing) return this.estimates.get(existing);
        this.need(this.customers, input["customerId"], "Customer");
        this.need(this.properties, input["propertyId"], "Property");
        if (input["jobId"] !== undefined) this.need(this.jobs, input["jobId"], "Job");
        const issuedOn = (input["issuedOn"] as string | undefined) ?? this.todayDate();
        if (input["issuedOn"] !== undefined) this.admitDate(issuedOn, "issuedOn");
        this.assertUnclaimed("estimate", input["externalRef"]);
        const number = this.claimNumber(this.estimates.values(), input["number"], "Estimate");
        const docRate = String(input["taxRate"] ?? "0");
        const options = (input["options"] as { name: string; lines: { quantity: string; unitPrice: string; discountAmount: string; taxable: boolean; taxRate?: string; isOptional: boolean; isSelected: boolean }[] }[])
          .map((o) => {
            const counted = o.lines.filter((l) => !l.isOptional || l.isSelected);
            const totals = computeInvoice(counted.map((l) => ({ ...l, taxRate: l.taxable ? (l.taxRate ?? docRate) : "0" })));
            return { ...o, ...totals.totals };
          });
        const id = randomUUID();
        const { externalRef, ...rest } = input;
        const estimate = {
          id, status: "draft", ...rest, number, issuedOn, options,
          total: options[0]?.total ?? "0.0000", externalRef: this.claim("estimate", externalRef, id), ...this.stamp(),
        };
        this.estimates.set(id, estimate);
        this.remember("estimate", key, id);
        return estimate;
      }
      case "declineEstimate": {
        const estimate = this.need(this.estimates, input["id"], "Estimate");
        estimate["status"] = "declined";
        return estimate;
      }
      case "listEstimates": return this.page(this.external([...this.estimates.values()], input), input);

      case "createInvoice": return this.createInvoice(input, key);
      case "voidInvoice": {
        const invoice = this.need(this.invoices, input["id"], "Invoice");
        if (!money.isZero(invoice.amountPaid)) throw new TargetError(409, "An invoice with payments against it cannot be voided");
        invoice.status = "void";
        invoice.balance = "0.0000";
        return invoice;
      }
      case "writeOffInvoice": {
        const invoice = this.need(this.invoices, input["id"], "Invoice");
        invoice.status = "written_off";
        invoice.balance = "0.0000";
        return invoice;
      }
      case "getInvoice": return this.need(this.invoices, input["id"], "Invoice");
      case "listInvoices": return this.page(this.external([...this.invoices.values()], input), input);

      case "recordPayment": return this.recordPayment(input, key);
      case "listPayments": {
        let all = [...this.payments.values()]
          .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id));
        if (input["customerId"] !== undefined) all = all.filter((p) => p.customerId === input["customerId"]);
        if (input["invoiceId"] !== undefined) all = all.filter((p) => p.allocations.some((a) => a.invoiceId === input["invoiceId"]));
        if (input["unappliedOnly"] === true) all = all.filter((p) => money.compare(p.unappliedAmount, "0") > 0);
        return this.page(this.external(all, input).map((p) => this.paymentRow(p)), input);
      }

      // services/billing.ts recordRefund: out of held money first, then
      // reopening what the payment paid, newest allocation first.
      case "recordRefund": {
        const existing = this.seen("payment_refund", key);
        if (existing) return this.paymentRow(this.payments.get(existing)!);
        const refundedAt = (input["refundedAt"] as string | undefined) ?? this.today().toISOString();
        if (input["refundedAt"] !== undefined) this.admitInstant(refundedAt, "refundedAt");
        const payment = this.need(this.payments, input["id"], "Payment");
        const amount = money.normalize(input["amount"]);
        if (money.compare(amount, "0") <= 0) {
          throw new TargetError(422, "A refund is a positive amount", [{ path: "amount", message: "Send how much went back, as a positive amount." }]);
        }
        const left = money.subtract(payment.amount, payment.refundedAmount);
        if (money.compare(amount, left) > 0) throw new TargetError(409, `Only ${left} of that payment is left to refund.`);
        const held = payment.unappliedAmount;
        const fromHeld = money.compare(amount, held) <= 0 ? amount : held;
        let fromApplied = money.subtract(amount, fromHeld);
        const net = new Map<string, string>();
        for (const a of payment.allocations) net.set(a.invoiceId, money.add(net.get(a.invoiceId) ?? "0", a.amount));
        const order = [...new Set([...payment.allocations].reverse().map((a) => a.invoiceId))];
        for (const invoiceId of order) {
          if (money.compare(fromApplied, "0") <= 0) break;
          const applied = net.get(invoiceId) ?? "0";
          if (money.compare(applied, "0") <= 0) continue;
          const take = money.compare(fromApplied, applied) <= 0 ? fromApplied : applied;
          const invoice = this.need(this.invoices, invoiceId, "Invoice");
          if (invoice.status === "void" || invoice.status === "written_off") {
            throw new TargetError(409, `Invoice ${invoice.number} is ${invoice.status.replace("_", " ")}, so the money this payment put on it cannot be reopened there.`);
          }
          payment.allocations.push({ invoiceId, amount: money.negate(take) });
          invoice.amountPaid = money.subtract(invoice.amountPaid, take);
          invoice.balance = money.add(invoice.balance, take);
          invoice.status = money.compare(invoice.amountPaid, "0") > 0 ? "partially_paid" : "open";
          fromApplied = money.subtract(fromApplied, take);
        }
        this.assertPeriodOpen(refundedAt.slice(0, 10));
        payment.unappliedAmount = money.subtract(payment.unappliedAmount, fromHeld);
        payment.refundedAmount = money.add(payment.refundedAmount, amount);
        payment.status = money.compare(payment.refundedAmount, payment.amount) >= 0 ? "refunded" : "partially_refunded";
        this.remember("payment_refund", key, payment.id);
        return this.paymentRow(payment);
      }

      // services/files.ts upload: the type is decided from the bytes.
      case "uploadAttachment": {
        const entityType = String(input["entityType"]);
        const records: Record<string, Map<string, unknown>> = {
          customer: this.customers, property: this.properties, job: this.jobs, visit: this.visits,
          estimate: this.estimates, invoice: this.invoices,
        };
        this.need(records[entityType]!, input["entityId"], entityType);
        const bytes = Buffer.from(String(input["bytes"]), "base64");
        if (bytes.length > MAX_ATTACHMENT_BYTES) throw new TargetError(413, "That file is over 20 MB.");
        const type = sniff(bytes);
        if (!type) throw new TargetError(415, `${String(input["fileName"])} is not a type this product stores.`);
        const storageKey = createHash("sha256").update(bytes).digest("hex");
        const existing = [...this.attachments.values()].find((a) => a.entityId === input["entityId"] && a.storageKey === storageKey);
        if (existing) return { ...existing, alreadyHeld: true };
        const attachment = {
          id: randomUUID(), entityType, entityId: String(input["entityId"]), fileName: String(input["fileName"]),
          kind: String(input["kind"] ?? (type.startsWith("image/") ? "photo" : "document")), storageKey,
          contentType: type, sizeBytes: bytes.length, phase: (input["phase"] as string | undefined) ?? null,
          createdAt: this.today().toISOString(),
        };
        this.attachments.set(attachment.id, attachment);
        return { ...attachment, alreadyHeld: false };
      }

      case "listPeople": {
        const email = (input["email"] as string | undefined)?.toLowerCase();
        return { people: this.people.filter((p) => email === undefined || p.email.toLowerCase() === email) };
      }

      // services/recurring.ts. No idempotency key is read on create.
      case "createRecurringSchedule": {
        const anchors = (input["anchorMonths"] as number[] | undefined) ?? [];
        const intervalDays = (input["intervalDays"] as number | null | undefined) ?? null;
        const model = input["model"] as MemorySchedule["model"];
        if (model === "rule" && anchors.length === 0 && !intervalDays) {
          throw new TargetError(409, "A rule needs either a number of days between visits or the months to pin them to.");
        }
        if (model === "anchored_to_completion" && !intervalDays) {
          throw new TargetError(409, "Work measured from the last completion needs to know how many days.");
        }
        const startsOn = String(input["startsOn"]);
        const endsOn = (input["endsOn"] as string | null | undefined) ?? null;
        if (endsOn && endsOn < startsOn) throw new TargetError(409, "That schedule ends before it starts.");
        this.need(this.properties, input["propertyId"], "Property");
        const schedule: MemorySchedule = {
          id: randomUUID(), label: String(input["label"]), customerId: String(input["customerId"]),
          propertyId: String(input["propertyId"]), summary: String(input["summary"]), model, startsOn, endsOn,
          intervalDays, anchorMonths: anchors, jobTypeId: (input["jobTypeId"] as string | null | undefined) ?? null,
          lastOccurredOn: null, nextDueOn: null, active: true, exceptions: [],
        };
        schedule.nextDueOn = nextDue(schedule);
        this.schedules.set(schedule.id, schedule);
        return { id: schedule.id, label: schedule.label, nextDueOn: schedule.nextDueOn };
      }
      case "listRecurringSchedules":
        return { schedules: [...this.schedules.values()].map((s) => ({ ...s, customerName: null, exceptions: s.exceptions.length })) };
      case "recordRecurringCompletion": {
        const schedule = this.need(this.schedules, input["id"], "Recurring schedule");
        const completedOn = String(input["completedOn"]);
        if (schedule.lastOccurredOn && completedOn < schedule.lastOccurredOn) {
          throw new TargetError(409, `This schedule was last completed on ${schedule.lastOccurredOn}. Recording ${completedOn} would pull every future occurrence backwards.`);
        }
        schedule.lastOccurredOn = completedOn;
        schedule.nextDueOn = nextDue(schedule);
        return { id: schedule.id, lastOccurredOn: completedOn, nextDueOn: schedule.nextDueOn };
      }
      case "exceptRecurringOccurrence": {
        const schedule = this.need(this.schedules, input["id"], "Recurring schedule");
        const found = schedule.exceptions.find((e) => e.date === input["date"]);
        const exception = {
          date: String(input["date"]), action: String(input["action"]),
          ...(input["movedTo"] ? { movedTo: String(input["movedTo"]) } : {}),
          ...(input["reason"] ? { reason: String(input["reason"]) } : {}),
        };
        if (found) Object.assign(found, exception);
        else schedule.exceptions.push(exception);
        return { id: schedule.id, exceptions: schedule.exceptions.length, nextDueOn: schedule.nextDueOn };
      }
      case "setRecurringScheduleActive": {
        const schedule = this.need(this.schedules, input["id"], "Recurring schedule");
        schedule.active = Boolean(input["active"]);
        return { id: schedule.id, active: schedule.active };
      }
      default: {
        const unreachable: never = name;
        throw new TargetError(404, `No route ${String(unreachable)}`);
      }
    }
  }

  /** services/billing.ts create, in the order it checks things. */
  private createInvoice(input: Record<string, unknown>, key: string | undefined): MemoryInvoice {
    const existing = this.seen("invoice", key);
    if (existing) return this.invoices.get(existing)!;

    const issuedOn = (input["issuedOn"] as string | undefined) ?? this.todayDate();
    if (input["issuedOn"] !== undefined) this.admitDate(issuedOn, "issuedOn");

    type LineIn = {
      priceBookItemId?: string; name: string; quantity: string; unitPrice: string; discountAmount: string; taxable: boolean;
      taxRate?: string; taxAmount?: string; priceAsGiven?: boolean;
    };
    const given = input["lines"] as LineIn[];
    if (given.some((l) => l.taxRate !== undefined || l.taxAmount !== undefined || l.priceAsGiven)) this.requireImport();

    const resolved = given.map((line) => {
      // A linked line is re-priced from the item's current version unless kept as given.
      const item = line.priceBookItemId && !line.priceAsGiven ? this.items.get(line.priceBookItemId) : undefined;
      return {
        name: item ? String(item["name"]) : line.name,
        quantity: line.quantity,
        unitPrice: item ? money.normalize(item["price"]) : line.unitPrice,
        discountAmount: line.discountAmount,
        taxable: item ? item["taxable"] !== false : line.taxable,
        taxRate: line.taxRate ?? "0",
        ...(line.taxAmount === undefined ? {} : { taxAmount: line.taxAmount }),
        priceBookItemId: line.priceBookItemId ?? null,
        origin: "job" as "job" | "manual",
      };
    });

    const adjustment = input["adjustment"] as { name: string; amount: string } | undefined;
    if (adjustment) {
      if (money.isZero(adjustment.amount)) {
        throw new TargetError(422, "An adjustment of nothing is not an adjustment", [{ path: "adjustment.amount", message: "Send a non-zero amount, or leave the adjustment off." }]);
      }
      const negative = money.compare(adjustment.amount, "0") < 0;
      resolved.push({
        name: adjustment.name, quantity: "1",
        unitPrice: negative ? "0" : adjustment.amount,
        discountAmount: negative ? money.negate(adjustment.amount) : "0",
        taxable: false, taxRate: "0", priceBookItemId: null, origin: "manual",
      });
    }

    let computed: ReturnType<typeof computeInvoice>;
    try {
      computed = computeInvoice(resolved);
    } catch (error) {
      if (error instanceof TaxAsAppliedError) {
        throw new TargetError(422, "A line's tax is not what its rate gives", [{ path: `lines.${error.line}.taxAmount`, message: error.message }]);
      }
      throw error;
    }

    const expected = input["expectedTotals"] as Partial<Record<"subtotal" | "discountTotal" | "taxTotal" | "total", string>> | undefined;
    if (expected) {
      const wrong = (["subtotal", "discountTotal", "taxTotal", "total"] as const)
        .filter((f) => expected[f] !== undefined && !money.equals(money.round(expected[f]!, 2), computed.totals[f]));
      if (wrong.length > 0) {
        throw new TargetError(422, "The invoice does not add up to the totals expected", wrong.map((f) => ({
          path: `expectedTotals.${f}`, message: `Expected ${money.round(expected[f]!, 2)}; the lines give ${computed.totals[f]}.`,
        })));
      }
    }

    // The customer and job are only looked for once the arithmetic has
    // passed, as in the core, where they are foreign keys on the insert.
    this.need(this.customers, input["customerId"], "Customer");
    const job = input["jobId"] === undefined ? undefined : this.need(this.jobs, input["jobId"], "Job");
    this.assertUnclaimed("invoice", input["externalRef"]);
    const number = this.claimNumber(this.invoices.values(), input["number"], "Invoice");
    this.assertPeriodOpen(issuedOn);

    const id = randomUUID();
    const { totals } = computed;
    const invoice: MemoryInvoice = {
      id, number, status: "open",
      customerId: String(input["customerId"]), jobId: job?.id ?? null,
      issuedOn, dueOn: (input["dueOn"] as string | undefined) ?? null,
      memo: (input["memo"] as string | undefined) ?? null,
      subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, total: totals.total,
      amountPaid: "0.0000", balance: totals.total,
      lines: resolved.map((r, i) => ({
        name: r.name, quantity: r.quantity, unitPrice: money.normalize(r.unitPrice), discountAmount: money.normalize(r.discountAmount),
        taxable: r.taxable, taxRate: r.taxRate, taxAmount: computed.lines[i]!.taxAmount, lineTotal: computed.lines[i]!.lineTotal,
        priceBookItemId: r.priceBookItemId, origin: r.origin,
      })),
      externalRef: this.claim("invoice", input["externalRef"], id),
    };
    this.invoices.set(id, invoice);
    // Raising an invoice moves its job to invoiced directly, outside the
    // lifecycle check, as services/billing.ts create() does.
    if (job) job.status = "invoiced";
    this.remember("invoice", key, id);
    return invoice;
  }

  /** services/billing.ts pay. */
  private recordPayment(input: Record<string, unknown>, key: string | undefined): MemoryPayment | Record<string, unknown> {
    const existing = this.seen("payment", key);
    if (existing) return this.paymentResult(this.payments.get(existing)!);
    this.need(this.customers, input["customerId"], "Customer");
    const receivedAt = (input["receivedAt"] as string | undefined) ?? this.today().toISOString();
    if (input["receivedAt"] !== undefined) this.admitInstant(receivedAt, "receivedAt");

    const amount = money.normalize(input["amount"]);
    const given = input["allocations"] as { invoiceId: string; amount: string }[] | undefined;
    let allocations = (given ?? []).slice();
    if (given === undefined) {
      // Omitted is oldest balance first. An EMPTY list is "apply it to nothing".
      let remaining = amount;
      const open = [...this.invoices.values()]
        .filter((i) => i.customerId === input["customerId"] && (i.status === "open" || i.status === "partially_paid"))
        .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || a.issuedOn.localeCompare(b.issuedOn) || a.number - b.number);
      for (const invoice of open) {
        if (money.compare(remaining, "0") <= 0) break;
        const applied = money.compare(remaining, invoice.balance) < 0 ? remaining : invoice.balance;
        if (money.compare(applied, "0") > 0) {
          allocations.push({ invoiceId: invoice.id, amount: applied });
          remaining = money.subtract(remaining, applied);
        }
      }
    }
    allocations = allocations.map((a) => ({ invoiceId: a.invoiceId, amount: money.normalize(a.amount) }));
    const allocated = money.sum(allocations.map((a) => a.amount));
    if (money.compare(allocated, amount) > 0) {
      throw new TargetError(409, `Allocations total ${allocated} but the payment is ${amount}`);
    }
    this.assertUnclaimed("payment", input["externalRef"]);
    this.assertPeriodOpen(receivedAt.slice(0, 10));
    for (const allocation of allocations) {
      const invoice = this.need(this.invoices, allocation.invoiceId, "Invoice");
      invoice.amountPaid = money.add(invoice.amountPaid, allocation.amount);
      invoice.balance = money.subtract(invoice.total, invoice.amountPaid);
      const settled = money.compare(invoice.balance, "0") <= 0;
      invoice.status = settled ? "paid" : "partially_paid";
      if (settled && invoice.jobId) this.jobs.get(invoice.jobId)!.status = "paid";
    }
    const id = randomUUID();
    const payment: MemoryPayment = {
      id, customerId: String(input["customerId"]), method: String(input["method"]), status: "succeeded",
      amount, receivedAt, allocations, unappliedAmount: money.subtract(amount, allocated), refundedAmount: "0.0000",
      notes: (input["notes"] as string | undefined) ?? null,
      externalRef: this.claim("payment", input["externalRef"], id), ledgerTransactionId: randomUUID(),
    };
    this.payments.set(id, payment);
    this.remember("payment", key, id);
    return this.paymentResult(payment);
  }

  private paymentRow(p: MemoryPayment) {
    const { ledgerTransactionId: _ignored, ...row } = p;
    return { ...row, currency: "USD", feeAmount: "0.0000", tipAmount: "0.0000", surchargeAmount: "0.0000", processor: "manual" };
  }

  private paymentResult(p: MemoryPayment) {
    return { id: p.id, amount: p.amount, allocations: p.allocations, unappliedAmount: p.unappliedAmount, ledgerTransactionId: p.ledgerTransactionId };
  }

  private addVisit(job: MemoryJob, input: VisitIn): MemoryVisit {
    const visit: MemoryVisit = {
      id: randomUUID(), jobId: job.id, sequence: job.visits.length + 1,
      status: input.status === "cancelled" ? "cancelled"
        : input.technicianIds.length > 0 && input.windowStart ? "scheduled" : "unassigned",
      windowStart: input.windowStart ?? null, windowEnd: input.windowEnd ?? null, completedAt: null,
      technicianIds: input.technicianIds, technicianNotes: null, externalRef: null,
    };
    visit.externalRef = this.claim("visit", input.externalRef, visit.id);
    job.visits.push(visit);
    this.visits.set(visit.id, visit);
    return visit;
  }

  private jobView(job: MemoryJob) {
    return { ...job, visits: job.visits.map((v) => ({ ...v })) };
  }

  /** The `externalSource` and `externalId` filters every list takes. */
  private external<T>(all: T[], input: Record<string, unknown>): T[] {
    const source = input["externalSource"] as string | undefined;
    const id = input["externalId"] as string | undefined;
    if (source === undefined && id === undefined) return all;
    return all.filter((row) => {
      const ref = (row as { externalRef?: ExternalRef | null }).externalRef;
      return ref != null && (source === undefined || ref.source === source) && (id === undefined || ref.id === id);
    });
  }

  /** Cursor pagination, as every list in the core does it. The cursor is opaque to callers. */
  private page<T>(all: T[], input: Record<string, unknown>) {
    const start = Number(input["cursor"] ?? 0) || 0;
    const limit = Number(input["limit"] ?? 50);
    const data = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return { data, nextCursor: hasMore ? String(start + limit) : null, hasMore };
  }
}

/** core recurrence nextOccurrence, for the models the API can create, from the day after `after`. */
function nextDue(s: MemorySchedule): string | null {
  if (s.model === "manual" || s.model === "materialized") return null;
  if (s.model === "anchored_to_completion") {
    const anchor = s.lastOccurredOn ?? addDays(s.startsOn, -(s.intervalDays ?? 0));
    const next = addDays(anchor, s.intervalDays ?? 0);
    return next < s.startsOn ? s.startsOn : next;
  }
  if (s.anchorMonths.length > 0) {
    const year = Number(s.startsOn.slice(0, 4));
    for (let y = year; y <= year + 1; y++) {
      for (const month of [...s.anchorMonths].sort((a, b) => a - b)) {
        const date = `${y}-${String(month).padStart(2, "0")}-15`;
        if (date >= s.startsOn) return date;
      }
    }
    return null;
  }
  return s.startsOn;
}
