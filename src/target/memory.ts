import { randomUUID } from "node:crypto";
import * as money from "../money/index.js";
import { ROUTES, JOB_TRANSITIONS, type RouteName, type InputOf, type OutputOf, type JobStatus } from "./contracts.js";
import { TargetError, type CallOptions, type Target } from "./client.js";

/**
 * A SCRATCH TENANT, IN MEMORY
 *
 * `dryrun` loads into this, not into anything real. It runs the identical
 * loader against it (same translation, same ledger logic, same order), so a
 * dry run that passes has exercised every request load would send, and its
 * reconcile is a prediction of the real one: the tax that will not carry,
 * the deposits with nowhere to go, all visible before anyone touches
 * production.
 *
 * It mirrors the behaviour of the core's services that a migration depends
 * on, as they are written in packages/api/src/services, and is deliberately
 * no cleverer than that:
 *
 *   - input is validated with the mirrored contract, and refused with the
 *     same 422 field list the dispatcher returns;
 *   - creates honour an Idempotency-Key, scoped by entity type, exactly where
 *     the core does, and scheduling a visit does NOT, because the core's
 *     addVisit never reads it;
 *   - invoice totals are computed from the lines and tax is always zero, as
 *     the core does today, and the issue date is today;
 *   - a payment with no allocations is spread oldest balance first;
 *   - job status moves only along the core's lifecycle.
 *
 * The tests' fake HTTP server serves this same object, so the behaviour the
 * loader is tested against and the behaviour dryrun predicts with cannot
 * drift apart from each other. They can drift from the core, and when they do
 * the remedy is to change this file to match it.
 */

interface MemoryVisit {
  id: string; jobId: string; sequence: number; status: string;
  windowStart: string | null; windowEnd: string | null; completedAt: string | null;
  technicianIds: string[]; technicianNotes: string | null;
}

interface MemoryJob {
  id: string; number: number; status: JobStatus; customerId: string; propertyId: string;
  summary: string; visits: MemoryVisit[];
}

interface MemoryInvoice {
  id: string; number: number; status: string; customerId: string; jobId: string | null;
  issuedOn: string; dueOn: string | null; memo: string | null;
  subtotal: string; taxTotal: string; total: string; amountPaid: string; balance: string;
  lines: { name: string; quantity: string; unitPrice: string; discountAmount: string; lineTotal: string; taxable: boolean }[];
}

export class MemoryTarget implements Target {
  readonly description = "a scratch tenant in memory";

  readonly customers = new Map<string, Record<string, unknown>>();
  readonly properties = new Map<string, Record<string, unknown> & { customers: { customerId: string; role: string; isPrimary: boolean }[] }>();
  readonly items = new Map<string, Record<string, unknown>>();
  readonly jobs = new Map<string, MemoryJob>();
  readonly visits = new Map<string, MemoryVisit>();
  readonly estimates = new Map<string, Record<string, unknown>>();
  readonly invoices = new Map<string, MemoryInvoice>();
  readonly payments = new Map<string, { id: string; amount: string; customerId: string; receivedAt: string; allocations: { invoiceId: string; amount: string }[] }>();

  /** How many times each route was called, for tests that count side effects. */
  readonly calls = new Map<RouteName, number>();

  private readonly idempotency = new Map<string, string>();
  private readonly numbers = { job: 1000, invoice: 1000, estimate: 1000 };

  constructor(private readonly today = () => new Date()) {}

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
    const key = options.idempotencyKey;
    const result = this.handle(name, input, key);
    return structuredClone(result) as OutputOf<N>;
  }

  private seen(entity: string, key: string | undefined): string | undefined {
    return key ? this.idempotency.get(`${entity}:${key}`) : undefined;
  }

  private remember(entity: string, key: string | undefined, id: string): void {
    if (key) this.idempotency.set(`${entity}:${key}`, id);
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
        const id = randomUUID();
        const customer = { id, ...input, ...this.stamp() };
        this.customers.set(id, customer);
        this.remember("customer", key, id);
        return customer;
      }
      case "listCustomers": return this.page([...this.customers.values()], input);

      case "createProperty": {
        const existing = this.seen("property", key);
        if (existing) return this.properties.get(existing);
        if (input["customerId"] !== undefined) this.need(this.customers, input["customerId"], "Customer");
        const id = randomUUID();
        const { customerId, customerRole, ...rest } = input as { customerId?: string; customerRole?: string };
        const property = {
          id, ...rest, ...this.stamp(),
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
      case "listProperties": return this.page([...this.properties.values()], input);

      case "createPriceBookItem": {
        const existing = this.seen("price_book_item", key);
        if (existing) return this.items.get(existing);
        const id = randomUUID();
        const item = { id, versionId: randomUUID(), version: 1, active: true, ...input, ...this.stamp() };
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
        return this.page(all, input);
      }

      case "createJob": {
        const existing = this.seen("job", key);
        if (existing) return this.jobView(this.jobs.get(existing)!);
        this.need(this.customers, input["customerId"], "Customer");
        this.need(this.properties, input["propertyId"], "Property");
        const id = randomUUID();
        const visit = input["visit"] as { windowStart: string; windowEnd: string; technicianIds: string[] } | undefined;
        const job: MemoryJob = {
          id, number: ++this.numbers.job, status: visit ? "scheduled" : "lead",
          customerId: String(input["customerId"]), propertyId: String(input["propertyId"]),
          summary: String(input["summary"]), visits: [],
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
        if (to !== undefined) {
          if (!JOB_TRANSITIONS[job.status].includes(to)) {
            throw new TargetError(409, `A job cannot move from "${job.status}" to "${to}".`);
          }
          job.status = to;
        }
        return this.jobView(job);
      }
      // No idempotency here, on purpose: services/jobs.ts addVisit does not
      // read the key, so a retried call adds a second visit. The loader has to
      // cope with that, and the tests prove that it does.
      case "scheduleVisit": {
        const job = this.need(this.jobs, input["id"], "Job");
        return this.addVisit(job, input as unknown as { windowStart: string; windowEnd: string; technicianIds: string[] });
      }
      case "completeVisit": {
        const visit = this.need(this.visits, input["id"], "Visit");
        if (visit.status !== "completed" && visit.status !== "completed_after_cancellation") {
          visit.status = visit.status === "cancelled" ? "completed_after_cancellation" : "completed";
          visit.completedAt = (input["completedOfflineAt"] as string | undefined) ?? this.today().toISOString();
          if (input["technicianNotes"] !== undefined) visit.technicianNotes = String(input["technicianNotes"]);
          const job = this.jobs.get(visit.jobId)!;
          const open = job.visits.filter((v) => ["unassigned", "scheduled", "dispatched", "en_route", "working"].includes(v.status));
          if (open.length === 0) job.status = "completed";
        }
        return visit;
      }
      case "listJobs": return this.page([...this.jobs.values()].map((j) => this.jobView(j)), input);

      case "createEstimate": {
        const existing = this.seen("estimate", key);
        if (existing) return this.estimates.get(existing);
        this.need(this.customers, input["customerId"], "Customer");
        this.need(this.properties, input["propertyId"], "Property");
        if (input["jobId"] !== undefined) this.need(this.jobs, input["jobId"], "Job");
        const options = (input["options"] as { name: string; lines: { quantity: string; unitPrice: string; discountAmount: string }[] }[])
          .map((o) => ({ ...o, total: money.sum(o.lines.map((l) => money.subtract(money.multiply(l.quantity, l.unitPrice), l.discountAmount))) }));
        const id = randomUUID();
        const estimate = { id, number: ++this.numbers.estimate, status: "draft", ...input, options, total: options[0]?.total ?? "0.0000", ...this.stamp() };
        this.estimates.set(id, estimate);
        this.remember("estimate", key, id);
        return estimate;
      }
      case "declineEstimate": {
        const estimate = this.need(this.estimates, input["id"], "Estimate");
        estimate["status"] = "declined";
        return estimate;
      }
      case "listEstimates": return this.page([...this.estimates.values()], input);

      case "createInvoice": {
        const existing = this.seen("invoice", key);
        if (existing) return this.invoices.get(existing);
        this.need(this.customers, input["customerId"], "Customer");
        const job = input["jobId"] === undefined ? undefined : this.need(this.jobs, input["jobId"], "Job");
        const lines = (input["lines"] as { name: string; quantity: string; unitPrice: string; discountAmount: string; taxable: boolean }[])
          .map((l) => ({ ...l, lineTotal: money.subtract(money.multiply(l.quantity, l.unitPrice), l.discountAmount) }));
        const subtotal = money.sum(lines.map((l) => l.lineTotal));
        const id = randomUUID();
        const invoice: MemoryInvoice = {
          id, number: ++this.numbers.invoice, status: "open",
          customerId: String(input["customerId"]), jobId: job?.id ?? null,
          // The core stamps today. Whatever the source said is not accepted.
          issuedOn: this.today().toISOString().slice(0, 10),
          dueOn: (input["dueOn"] as string | undefined) ?? null,
          memo: (input["memo"] as string | undefined) ?? null,
          subtotal, taxTotal: "0.0000", total: subtotal, amountPaid: "0.0000", balance: subtotal, lines,
        };
        this.invoices.set(id, invoice);
        // Raising an invoice moves its job to invoiced directly, outside the
        // lifecycle check, as services/billing.ts create() does.
        if (job) job.status = "invoiced";
        this.remember("invoice", key, id);
        return invoice;
      }
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
      case "listInvoices": return this.page([...this.invoices.values()], input);

      case "recordPayment": {
        const existing = this.seen("payment", key);
        if (existing) return this.payments.get(existing);
        this.need(this.customers, input["customerId"], "Customer");
        const amount = String(input["amount"]);
        let allocations = ((input["allocations"] as { invoiceId: string; amount: string }[] | undefined) ?? []).slice();
        if (allocations.length === 0) {
          // Oldest balance first, which is what the core does with a payment
          // that names no invoice. It is why the loader never sends one.
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
        for (const allocation of allocations) {
          const invoice = this.need(this.invoices, allocation.invoiceId, "Invoice");
          invoice.amountPaid = money.add(invoice.amountPaid, allocation.amount);
          invoice.balance = money.subtract(invoice.total, invoice.amountPaid);
          const settled = money.compare(invoice.balance, "0") <= 0;
          invoice.status = settled ? "paid" : "partially_paid";
          if (settled && invoice.jobId) this.jobs.get(invoice.jobId)!.status = "paid";
        }
        const id = randomUUID();
        const payment = {
          id, amount: money.normalize(amount), customerId: String(input["customerId"]),
          receivedAt: (input["receivedAt"] as string | undefined) ?? this.today().toISOString(),
          allocations, ledgerTransactionId: randomUUID(),
        };
        this.payments.set(id, payment);
        this.remember("payment", key, id);
        return payment;
      }
      default: {
        const unreachable: never = name;
        throw new TargetError(404, `No route ${String(unreachable)}`);
      }
    }
  }

  private addVisit(job: MemoryJob, input: { windowStart: string; windowEnd: string; technicianIds: string[] }): MemoryVisit {
    const visit: MemoryVisit = {
      id: randomUUID(), jobId: job.id, sequence: job.visits.length + 1,
      status: input.technicianIds.length > 0 ? "scheduled" : "unassigned",
      windowStart: input.windowStart, windowEnd: input.windowEnd, completedAt: null,
      technicianIds: input.technicianIds, technicianNotes: null,
    };
    job.visits.push(visit);
    this.visits.set(visit.id, visit);
    return visit;
  }

  private jobView(job: MemoryJob) {
    return { ...job, visits: job.visits.map((v) => ({ ...v })) };
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

