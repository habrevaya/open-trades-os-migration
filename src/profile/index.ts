import * as money from "../money/index.js";
import type { EntityName } from "../canonical/index.js";

/**
 * PROFILE
 *
 * Runs against the snapshot before anything moves, and exists to replace a
 * hope with a number.
 *
 * Every migration conversation starts with the contractor saying "about eight
 * thousand customers, going back maybe twelve years". The profile report is
 * the moment that becomes 9,412 customers, 1,180 of them with no address, the
 * oldest job dated 2009, and $41,206.18 of open receivables. Discovering any
 * of that after the load is how a cutover becomes a rollback.
 *
 * It computes nothing it cannot show its working for, and it never repairs
 * anything. Repair is a decision, and decisions belong to the operator.
 */

export interface FieldStats {
  present: number;
  blank: number;
  /** Distinct values, capped. Above the cap the field is free text, not an enum. */
  distinct?: number;
  examples: string[];
}

export interface EntityProfile {
  entity: EntityName;
  count: number;
  duplicateIds: string[];
  earliest?: string;
  latest?: string;
  fields: Record<string, FieldStats>;
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  /** Source ids, capped, so the operator can go and look at the real records. */
  sample: string[];
  count: number;
}

export interface MoneyTotals {
  invoiceTotal: string;
  invoiceBalance: string;
  paymentTotal: string;
  paymentAllocated: string;
  paymentUnallocated: string;
}

export interface ProfileReport {
  source: string;
  account?: string | undefined;
  entities: EntityProfile[];
  totals: MoneyTotals;
  findings: Finding[];
}

const DISTINCT_CAP = 50;
const SAMPLE_CAP = 10;

class FieldAccumulator {
  present = 0;
  blank = 0;
  private values = new Set<string>();
  private overflowed = false;

  observe(value: unknown): void {
    if (value === null || value === undefined || value === "" ||
        (Array.isArray(value) && value.length === 0)) {
      this.blank += 1;
      return;
    }
    this.present += 1;
    if (this.overflowed) return;
    const key = typeof value === "object" ? JSON.stringify(value) : String(value);
    this.values.add(key.length > 120 ? key.slice(0, 120) : key);
    if (this.values.size > DISTINCT_CAP) this.overflowed = true;
  }

  finish(): FieldStats {
    const examples = [...this.values].slice(0, 5);
    return this.overflowed
      ? { present: this.present, blank: this.blank, examples }
      : { present: this.present, blank: this.blank, distinct: this.values.size, examples };
  }
}

/** Fields worth reporting per entity. Everything else is noise on a report. */
const TRACKED: Partial<Record<EntityName, string[]>> = {
  customer: ["type", "email", "phone", "billingAddress", "leadSource", "taxExempt", "tags"],
  property: ["addressLine1", "city", "state", "postalCode", "nickname", "customerSourceIds"],
  job: ["status", "jobType", "leadSource", "total", "completedAt", "visits"],
  invoice: ["status", "issuedOn", "dueOn", "total", "balance", "lines"],
  payment: ["method", "status", "amount", "allocations"],
  equipment: ["category", "manufacturer", "serialNumber", "installedOn"],
};

const dateOf = (rec: Record<string, unknown>): string | undefined => {
  for (const key of ["completedAt", "issuedOn", "receivedAt", "installedOn", "createdAt"]) {
    const value = rec[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
};

interface EntityBucket {
  count: number;
  ids: Map<string, number>;
  fields: Map<string, FieldAccumulator>;
  earliest?: string | undefined;
  latest?: string | undefined;
}

export class Profiler {
  private readonly perEntity = new Map<EntityName, EntityBucket>();

  private readonly customerIds = new Set<string>();
  private readonly propertyIds = new Set<string>();
  private readonly invoiceIds = new Set<string>();

  private invoiceTotal = "0";
  private invoiceBalance = "0";
  private paymentTotal = "0";
  private paymentAllocated = "0";

  private readonly orphanJobCustomer: string[] = [];
  private readonly orphanJobProperty: string[] = [];
  private readonly orphanPaymentInvoice: string[] = [];
  private readonly propertyNoAddress: string[] = [];
  private readonly customerNoContact: string[] = [];
  private readonly invoiceLineMismatch: string[] = [];
  private readonly negativeBalance: string[] = [];
  private readonly jobNoVisits: string[] = [];
  private readonly unallocatedPayments: string[] = [];

  private counts = {
    orphanJobCustomer: 0, orphanJobProperty: 0, orphanPaymentInvoice: 0,
    propertyNoAddress: 0, customerNoContact: 0, invoiceLineMismatch: 0,
    negativeBalance: 0, jobNoVisits: 0, unallocatedPayments: 0,
  };

  observe(entity: EntityName, canonical: Record<string, unknown>): void {
    const bucket: EntityBucket = this.perEntity.get(entity) ?? { count: 0, ids: new Map(), fields: new Map() };
    this.perEntity.set(entity, bucket);
    bucket.count += 1;

    const id = String(canonical["sourceId"] ?? "");
    if (id !== "") bucket.ids.set(id, (bucket.ids.get(id) ?? 0) + 1);

    for (const field of TRACKED[entity] ?? []) {
      const acc = bucket.fields.get(field) ?? new FieldAccumulator();
      bucket.fields.set(field, acc);
      acc.observe(canonical[field]);
    }

    const when = dateOf(canonical);
    if (when) {
      if (!bucket.earliest || when < bucket.earliest) bucket.earliest = when;
      if (!bucket.latest || when > bucket.latest) bucket.latest = when;
    }

    switch (entity) {
      case "customer": this.observeCustomer(id, canonical); break;
      case "property": this.observeProperty(id, canonical); break;
      case "job": this.observeJob(id, canonical); break;
      case "invoice": this.observeInvoice(id, canonical); break;
      case "payment": this.observePayment(id, canonical); break;
      default: break;
    }
  }

  private observeCustomer(id: string, rec: Record<string, unknown>): void {
    this.customerIds.add(id);
    // A customer with no email and no phone cannot be sent an invoice or a
    // reminder, which for a migrating shop is usually the first thing they try.
    if (!rec["email"] && !rec["phone"]) {
      this.counts.customerNoContact += 1;
      if (this.customerNoContact.length < SAMPLE_CAP) this.customerNoContact.push(id);
    }
  }

  private observeProperty(id: string, rec: Record<string, unknown>): void {
    this.propertyIds.add(id);
    if (!rec["addressLine1"] || !rec["city"] || !rec["postalCode"]) {
      this.counts.propertyNoAddress += 1;
      if (this.propertyNoAddress.length < SAMPLE_CAP) this.propertyNoAddress.push(id);
    }
  }

  private observeJob(id: string, rec: Record<string, unknown>): void {
    const visits = Array.isArray(rec["visits"]) ? rec["visits"] : [];
    if (visits.length === 0) {
      this.counts.jobNoVisits += 1;
      if (this.jobNoVisits.length < SAMPLE_CAP) this.jobNoVisits.push(id);
    }
  }

  private observeInvoice(id: string, rec: Record<string, unknown>): void {
    this.invoiceIds.add(id);
    const total = String(rec["total"] ?? "0");
    const balance = String(rec["balance"] ?? "0");
    this.invoiceTotal = money.add(this.invoiceTotal, total);
    this.invoiceBalance = money.add(this.invoiceBalance, balance);

    if (money.compare(balance, "0") < 0) {
      // A negative balance is an overpayment or a credit, and it is real money
      // owed back to a customer. It must not be rounded away into zero.
      this.counts.negativeBalance += 1;
      if (this.negativeBalance.length < SAMPLE_CAP) this.negativeBalance.push(id);
    }

    const lines = Array.isArray(rec["lines"]) ? (rec["lines"] as Record<string, unknown>[]) : [];
    if (lines.length > 0) {
      const lineSum = money.sum(lines.map((l) => String(l["lineTotal"] ?? "0")));
      const expected = money.add(String(rec["subtotal"] ?? "0"), "0");
      // Reported rather than corrected. A discount, a manual adjustment or a
      // historical tax rate all produce this legitimately, and the operator is
      // the one who knows which.
      if (!money.equals(lineSum, expected)) {
        this.counts.invoiceLineMismatch += 1;
        if (this.invoiceLineMismatch.length < SAMPLE_CAP) this.invoiceLineMismatch.push(id);
      }
    }
  }

  private observePayment(id: string, rec: Record<string, unknown>): void {
    const amount = String(rec["amount"] ?? "0");
    this.paymentTotal = money.add(this.paymentTotal, amount);
    const allocations = Array.isArray(rec["allocations"]) ? (rec["allocations"] as Record<string, unknown>[]) : [];
    this.paymentAllocated = money.add(
      this.paymentAllocated,
      money.sum(allocations.map((a) => String(a["amount"] ?? "0"))),
    );
    if (allocations.length === 0) {
      this.counts.unallocatedPayments += 1;
      if (this.unallocatedPayments.length < SAMPLE_CAP) this.unallocatedPayments.push(id);
    }
  }

  /**
   * Referential checks run at the end, not during, because a snapshot is not
   * ordered. A job can be read before the customer it names.
   */
  private linkCheck(jobs: Iterable<{ id: string; customer: string; property: string }>): void {
    for (const job of jobs) {
      if (job.customer !== "" && !this.customerIds.has(job.customer)) {
        this.counts.orphanJobCustomer += 1;
        if (this.orphanJobCustomer.length < SAMPLE_CAP) this.orphanJobCustomer.push(job.id);
      }
      if (job.property !== "" && !this.propertyIds.has(job.property)) {
        this.counts.orphanJobProperty += 1;
        if (this.orphanJobProperty.length < SAMPLE_CAP) this.orphanJobProperty.push(job.id);
      }
    }
  }

  private readonly deferredJobs: { id: string; customer: string; property: string }[] = [];
  private readonly deferredAllocations: { id: string; invoice: string }[] = [];

  /** Called by the caller's second pass; see `profile()`. */
  defer(entity: EntityName, canonical: Record<string, unknown>): void {
    if (entity === "job") {
      this.deferredJobs.push({
        id: String(canonical["sourceId"] ?? ""),
        customer: String(canonical["customerSourceId"] ?? ""),
        property: String(canonical["propertySourceId"] ?? ""),
      });
    }
    if (entity === "payment") {
      const allocations = Array.isArray(canonical["allocations"]) ? (canonical["allocations"] as Record<string, unknown>[]) : [];
      for (const a of allocations) {
        this.deferredAllocations.push({
          id: String(canonical["sourceId"] ?? ""),
          invoice: String(a["invoiceSourceId"] ?? ""),
        });
      }
    }
  }

  report(source: string, account?: string): ProfileReport {
    this.linkCheck(this.deferredJobs);
    for (const allocation of this.deferredAllocations) {
      if (allocation.invoice !== "" && !this.invoiceIds.has(allocation.invoice)) {
        this.counts.orphanPaymentInvoice += 1;
        if (this.orphanPaymentInvoice.length < SAMPLE_CAP) this.orphanPaymentInvoice.push(allocation.id);
      }
    }

    const entities: EntityProfile[] = [...this.perEntity.entries()].map(([entity, bucket]) => ({
      entity,
      count: bucket.count,
      duplicateIds: [...bucket.ids.entries()].filter(([, n]) => n > 1).map(([id]) => id).slice(0, SAMPLE_CAP),
      ...(bucket.earliest === undefined ? {} : { earliest: bucket.earliest }),
      ...(bucket.latest === undefined ? {} : { latest: bucket.latest }),
      fields: Object.fromEntries([...bucket.fields.entries()].map(([k, v]) => [k, v.finish()])),
    }));

    const findings: Finding[] = [];
    const add = (severity: Severity, code: string, count: number, sample: string[], message: string) => {
      if (count > 0) findings.push({ severity, code, count, sample, message });
    };

    for (const entity of entities) {
      add("error", `${entity.entity}.duplicate_source_id`, entity.duplicateIds.length, entity.duplicateIds,
        `${entity.duplicateIds.length} ${entity.entity} record(s) share a source id. The load is keyed on that id, so these would collapse into one record.`);
    }

    add("error", "job.orphan_customer", this.counts.orphanJobCustomer, this.orphanJobCustomer,
      `${this.counts.orphanJobCustomer} job(s) name a customer that is not in the snapshot. Extraction was incomplete, or the customer is archived and was filtered out.`);
    add("error", "job.orphan_property", this.counts.orphanJobProperty, this.orphanJobProperty,
      `${this.counts.orphanJobProperty} job(s) name a property that is not in the snapshot. These would load with no address.`);
    add("error", "payment.orphan_invoice", this.counts.orphanPaymentInvoice, this.orphanPaymentInvoice,
      `${this.counts.orphanPaymentInvoice} payment(s) are allocated to an invoice that is not in the snapshot. Receivables will not reconcile.`);
    add("warning", "property.incomplete_address", this.counts.propertyNoAddress, this.propertyNoAddress,
      `${this.counts.propertyNoAddress} property record(s) are missing street, city or postal code. Routing and taxes both depend on these.`);
    add("warning", "customer.no_contact", this.counts.customerNoContact, this.customerNoContact,
      `${this.counts.customerNoContact} customer(s) have neither an email nor a phone number. They cannot be invoiced or reminded.`);
    add("warning", "invoice.lines_do_not_sum", this.counts.invoiceLineMismatch, this.invoiceLineMismatch,
      `${this.counts.invoiceLineMismatch} invoice(s) have line totals that do not sum to the subtotal. Usually a discount or a historical adjustment. Totals are migrated as the source recorded them, never recomputed.`);
    add("warning", "invoice.negative_balance", this.counts.negativeBalance, this.negativeBalance,
      `${this.counts.negativeBalance} invoice(s) carry a negative balance, meaning an overpayment or credit owed back to the customer.`);
    add("info", "job.no_visits", this.counts.jobNoVisits, this.jobNoVisits,
      `${this.counts.jobNoVisits} job(s) have no visit. Normal for unscheduled or cancelled work.`);
    add("info", "payment.unallocated", this.counts.unallocatedPayments, this.unallocatedPayments,
      `${this.counts.unallocatedPayments} payment(s) are not applied to any invoice. These are deposits or account credits and carry real money.`);

    const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

    return {
      source,
      account,
      entities,
      totals: {
        invoiceTotal: money.normalize(this.invoiceTotal),
        invoiceBalance: money.normalize(this.invoiceBalance),
        paymentTotal: money.normalize(this.paymentTotal),
        paymentAllocated: money.normalize(this.paymentAllocated),
        paymentUnallocated: money.subtract(this.paymentTotal, this.paymentAllocated),
      },
      findings,
    };
  }
}

/** Render a report for a terminal. Findings first, because those are the point. */
export function renderProfile(report: ProfileReport): string {
  const out: string[] = [];
  out.push(`Source: ${report.source}${report.account ? ` (${report.account})` : ""}`);
  out.push("");

  out.push("RECORDS");
  for (const entity of report.entities) {
    const span = entity.earliest && entity.latest
      ? `  ${entity.earliest.slice(0, 10)} to ${entity.latest.slice(0, 10)}`
      : "";
    out.push(`  ${entity.entity.padEnd(16)} ${String(entity.count).padStart(8)}${span}`);
  }
  out.push("");

  out.push("MONEY");
  out.push(`  invoiced           ${money.display(report.totals.invoiceTotal).padStart(16)}`);
  out.push(`  open balance       ${money.display(report.totals.invoiceBalance).padStart(16)}`);
  out.push(`  payments           ${money.display(report.totals.paymentTotal).padStart(16)}`);
  out.push(`  unapplied          ${money.display(report.totals.paymentUnallocated).padStart(16)}`);
  out.push("");

  if (report.findings.length === 0) {
    out.push("No findings.");
    return out.join("\n");
  }

  out.push("FINDINGS");
  for (const finding of report.findings) {
    out.push(`  [${finding.severity}] ${finding.code}`);
    out.push(`    ${finding.message}`);
    if (finding.sample.length > 0) out.push(`    e.g. ${finding.sample.slice(0, 5).join(", ")}`);
  }
  return out.join("\n");
}
