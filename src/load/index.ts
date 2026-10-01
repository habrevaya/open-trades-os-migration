import type { EntityName } from "../canonical/index.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalPriceBookItem, CanonicalJob,
  CanonicalEstimate, CanonicalInvoice, CanonicalPayment, CanonicalUser,
} from "../canonical/index.js";
import type { SourceAdapter } from "../adapters/types.js";
import type { Snapshot } from "../snapshot/index.js";
import { canonicalRecords } from "../transform/index.js";
import type { Mapping } from "../mapping/index.js";
import { statusPath, validate, Uuid, type JobStatus, type RouteName, type InputOf, type OutputOf } from "../target/contracts.js";
import { TargetError, type Target } from "../target/client.js";
import { Ledger } from "./ledger.js";
import { GAPS, type GapCode } from "./gaps.js";
import {
  customerRequest, propertyRequest, priceBookRequest, jobRequest, estimateRequest,
  invoiceRequest, paymentRequest, type Translated, type Resolve,
} from "./translate.js";

/**
 * LOAD
 *
 * One loader for every source. It reads canonical records out of the
 * snapshot one entity at a time, in dependency order, turns each into the
 * request that creates it, and records what the target says it made.
 *
 *   users          mapped to people who already exist; nothing is created
 *   customers
 *   properties     linked to every customer that holds them
 *   price book
 *   jobs           with their visits, completions and status walked forward
 *   estimates
 *   invoices       voided where the source voided them
 *   payments       allocated exactly as the source allocated them
 *   write-offs     last, because a write-off takes the balance left after payment
 *
 * Every reference is resolved through the ledger, so a job is only sent once
 * its customer and property are known to exist in the target. A record whose
 * reference did not make it is BLOCKED, named on the report with what it was
 * waiting for, and never sent half-linked: an invoice loaded without its job
 * is a receivable nobody can trace back to the work.
 *
 * Re-running is the recovery for everything. Records already in the ledger
 * are skipped, records in flight when the process died are re-sent with the
 * same Idempotency-Key, and visits (which the target does not deduplicate)
 * are read back before being added again.
 *
 * `dryrun` runs exactly this against an in-memory target, which is the only
 * way a dry run can promise anything about the real one.
 */

export const LOAD_ORDER = ["user", "customer", "property", "priceBookItem", "job", "estimate", "invoice", "payment"] as const;
export type LoadEntity = (typeof LOAD_ORDER)[number];

export type Outcome = "created" | "already" | "mapped" | "skipped" | "blocked" | "invalid" | "rejected" | "unreadable";
export const OUTCOMES: Outcome[] = ["created", "already", "mapped", "skipped", "blocked", "invalid", "rejected", "unreadable"];

export interface Problem {
  entity: string;
  sourceId: string;
  outcome: Outcome;
  reason: string;
  issues?: { path: string; message: string }[];
}

export interface LoadReport {
  target: string;
  dryRun: boolean;
  carryTotals: boolean;
  entities: Partial<Record<LoadEntity, Record<Outcome, number>>>;
  problems: Problem[];
  warnings: { entity: string; sourceId: string; message: string }[];
  gaps: Partial<Record<GapCode, { count: number; sample: string[] }>>;
  /** Set when the run stopped early. Re-running resumes from the ledger. */
  aborted?: string;
}

export interface LoadInput {
  snapshot: Snapshot;
  adapter: SourceAdapter;
  target: Target;
  ledger: Ledger;
  mapping: Mapping;
  carryTotals?: boolean;
  dryRun?: boolean;
  /** Records in flight at once within one entity. Entities never overlap. */
  concurrency?: number;
  onProgress?: (entity: LoadEntity, processed: number) => void;
}

const SAMPLE = 10;

class Recorder {
  readonly report: LoadReport;
  constructor(target: string, dryRun: boolean, carryTotals: boolean) {
    this.report = { target, dryRun, carryTotals, entities: {}, problems: [], warnings: [], gaps: {} };
  }

  count(entity: LoadEntity, outcome: Outcome): void {
    const row = this.report.entities[entity] ?? Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
    this.report.entities[entity] = row;
    row[outcome] += 1;
  }

  problem(entity: LoadEntity, sourceId: string, outcome: Outcome, reason: string, issues?: { path: string; message: string }[]): void {
    this.count(entity, outcome);
    this.report.problems.push({ entity, sourceId, outcome, reason, ...(issues && issues.length > 0 ? { issues } : {}) });
  }

  absorb(entity: LoadEntity, sourceId: string, t: { warnings: string[]; gaps: GapCode[] }): void {
    for (const message of t.warnings) this.report.warnings.push({ entity, sourceId, message });
    // A gap counts once per record, however many times the record hit it.
    for (const code of new Set(t.gaps)) {
      const gap = this.report.gaps[code] ?? { count: 0, sample: [] };
      this.report.gaps[code] = gap;
      gap.count += 1;
      if (gap.sample.length < SAMPLE) gap.sample.push(`${entity} ${sourceId}`);
    }
  }
}

/**
 * Pull from an async iterator with `n` workers. Generators serialise their
 * own `next()` calls, so the workers can share one without a lock, and only
 * `n` records are ever in memory at once however large the file.
 */
async function forEachConcurrent<T>(source: AsyncIterable<T>, n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  let stop = false;
  const worker = async () => {
    while (!stop) {
      const next = await iterator.next();
      if (next.done) return;
      try {
        await fn(next.value);
      } catch (error) {
        stop = true;
        throw error;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, n) }, worker));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

const sameInstant = (a: string | null | undefined, b: string): boolean =>
  a !== null && a !== undefined && Date.parse(a) === Date.parse(b);

/**
 * Lifecycle rank, for refusing to walk a job backwards. The core would allow
 * completed -> in_progress -> on_hold -> scheduled, and a source that says
 * "active" about a job whose every visit is done does not mean that.
 */
const RANK: Record<JobStatus, number> = {
  lead: 0, estimating: 1, scheduled: 2, in_progress: 3, on_hold: 3, completed: 4, invoiced: 5, paid: 6, cancelled: 7,
};

export async function load(input: LoadInput): Promise<LoadReport> {
  const { snapshot, adapter, target, ledger, mapping } = input;
  const carryTotals = input.carryTotals ?? false;
  const recorder = new Recorder(target.description, input.dryRun ?? false, carryTotals);
  const resolve: Resolve = (entity, sourceId) => ledger.get(Ledger.key(entity, sourceId));
  const options = { mapping, carryTotals };

  const call = <N extends RouteName>(name: N, body: InputOf<N>, key?: string): Promise<OutputOf<N>> =>
    target.call(name, body, key ? { idempotencyKey: ledger.idempotencyKey(key) } : {});

  /** Local validation first: a request the target would refuse is never sent. */
  const checked = <N extends RouteName>(entity: LoadEntity, sourceId: string, name: N, body: InputOf<N>): boolean => {
    const result = validate(name, body);
    if (result.ok) return true;
    recorder.problem(entity, sourceId, "invalid", "the target's contract refuses this record", result.issues);
    return false;
  };

  /** The common outcomes of translation. Returns true when there is a body to send. */
  const translated = <T extends Translated<unknown>>(entity: LoadEntity, sourceId: string, t: T): t is T & { body: NonNullable<T["body"]> } => {
    recorder.absorb(entity, sourceId, t);
    if (t.blocked) { recorder.problem(entity, sourceId, "blocked", t.blocked); return false; }
    if (t.invalid) { recorder.problem(entity, sourceId, "invalid", t.invalid); return false; }
    if (t.skipped) {
      recorder.problem(entity, sourceId, "skipped", t.skipped.reason);
      if (t.skipped.gap) recorder.absorb(entity, sourceId, { warnings: [], gaps: [t.skipped.gap] });
      return false;
    }
    return t.body !== undefined;
  };

  const handlers: Record<LoadEntity, (record: Record<string, unknown>) => Promise<void>> = {
    async user(record) {
      const u = record as unknown as CanonicalUser;
      const mapped = mapping.users[u.sourceId]?.target;
      if (mapped && Uuid.safeParse(mapped).success) { recorder.count("user", "mapped"); return; }
      recorder.problem("user", u.sourceId, "skipped", `${u.name} has no target user in mapping.json`);
      recorder.absorb("user", u.sourceId, { warnings: [], gaps: ["user.create"] });
    },

    async customer(record) {
      const c = record as unknown as CanonicalCustomer;
      const key = Ledger.key("customer", c.sourceId);
      if (ledger.has(key)) { recorder.count("customer", "already"); return; }
      const t = customerRequest(c);
      if (!translated("customer", c.sourceId, t) || !checked("customer", c.sourceId, "createCustomer", t.body)) return;
      const created = await call("createCustomer", t.body, key);
      await ledger.record({ key, target: created.id });
      recorder.count("customer", "created");
    },

    async property(record) {
      const p = record as unknown as CanonicalProperty;
      const key = Ledger.key("property", p.sourceId);
      const t = propertyRequest(p, resolve);
      let id = ledger.get(key);
      if (id) recorder.count("property", "already");
      else {
        if (!translated("property", p.sourceId, t) || !checked("property", p.sourceId, "createProperty", t.body)) return;
        id = (await call("createProperty", t.body, key)).id;
        await ledger.record({ key, target: id });
        recorder.count("property", "created");
      }
      // A property held by an owner and a property manager is one place with
      // two customers, not two places.
      for (const customerId of t.plan?.links ?? []) {
        const linkKey = `${key}#link:${customerId}`;
        if (ledger.has(linkKey)) continue;
        await call("linkCustomerToProperty", { id, customerId, role: "owner", isPrimary: false });
        await ledger.record({ key: linkKey, target: "done" });
      }
    },

    async priceBookItem(record) {
      const item = record as unknown as CanonicalPriceBookItem;
      const key = Ledger.key("priceBookItem", item.sourceId);
      let id = ledger.get(key);
      if (id) recorder.count("priceBookItem", "already");
      else {
        const t = priceBookRequest(item);
        if (!translated("priceBookItem", item.sourceId, t) || !checked("priceBookItem", item.sourceId, "createPriceBookItem", t.body)) return;
        id = (await call("createPriceBookItem", t.body, key)).id;
        await ledger.record({ key, target: id });
        recorder.count("priceBookItem", "created");
      }
      if (!item.active && !ledger.has(`${key}#retired`)) {
        await call("setPriceBookItemActive", { id, active: false, reason: `Inactive in ${item.sourceSystem}` });
        await ledger.record({ key: `${key}#retired`, target: "done" });
      }
    },

    async job(record) {
      const job = record as unknown as CanonicalJob;
      const key = Ledger.key("job", job.sourceId);
      const t = jobRequest(job, resolve, mapping);
      let id = ledger.get(key);
      let fresh = false;
      if (id) recorder.count("job", "already");
      else {
        if (!translated("job", job.sourceId, t) || !checked("job", job.sourceId, "createJob", t.body)) return;
        const created = await call("createJob", t.body, key);
        id = created.id;
        const first = t.plan?.visits[0];
        const firstVisit = [...created.visits].sort((a, b) => a.sequence - b.sequence)[0];
        // The job and the visit created with it land in the ledger together.
        await ledger.record(
          { key, target: id },
          ...(first && firstVisit ? [{ key: `${key}#visit:${first.sourceId}`, target: firstVisit.id }] : []),
        );
        recorder.count("job", "created");
        // An idempotent replay of a create that already happened is not fresh:
        // its later visits may already exist.
        fresh = created.visits.length <= 1;
      }
      const plan = t.plan;
      if (!plan) return;

      // The rest of the visits. Scheduling a visit is the one write the target
      // does not deduplicate, so a resumed job is read back first, and a visit
      // already there at the same window is adopted rather than added twice.
      let current: OutputOf<"getJob"> | undefined;
      for (const visit of plan.visits) {
        const visitKey = `${key}#visit:${visit.sourceId}`;
        if (ledger.has(visitKey)) continue;
        if (!fresh) {
          current ??= await call("getJob", { id });
          // Claimed by this job's own visits only: a lookup per visit, not a
          // scan of a ledger that may hold half a million lines.
          const claimed = new Set(plan.visits.map((v) => ledger.get(`${key}#visit:${v.sourceId}`)).filter((x): x is string => x !== undefined));
          const match = current.visits.find((v) => !claimed.has(v.id) &&
            sameInstant(v.windowStart, visit.windowStart) && sameInstant(v.windowEnd, visit.windowEnd));
          if (match) { await ledger.record({ key: visitKey, target: match.id }); continue; }
        }
        const body: InputOf<"scheduleVisit"> = {
          id, windowStart: visit.windowStart, windowEnd: visit.windowEnd,
          estimatedDurationMinutes: visit.estimatedDurationMinutes, technicianIds: visit.technicianIds,
        };
        if (!checked("job", job.sourceId, "scheduleVisit", body)) return;
        const scheduled = await call("scheduleVisit", body);
        await ledger.record({ key: visitKey, target: scheduled.id });
      }

      // Completions carry the source's completion time, so "done in March
      // 2023" stays March 2023. Completing twice is a no-op in the target.
      for (const visit of plan.visits) {
        if (visit.action !== "complete") continue;
        const completeKey = `${key}#complete:${visit.sourceId}`;
        const visitId = ledger.get(`${key}#visit:${visit.sourceId}`);
        if (ledger.has(completeKey) || !visitId) continue;
        await call("completeVisit", {
          id: visitId,
          ...(visit.completedAt ? { completedOfflineAt: visit.completedAt } : {}),
          ...(visit.notes ? { technicianNotes: visit.notes } : {}),
        });
        await ledger.record({ key: completeKey, target: "done" });
      }

      // Status last, walked along the target's lifecycle and never backwards.
      const statusKey = `${key}#status`;
      if (plan.status && !ledger.has(statusKey)) {
        const now = (await call("getJob", { id })).status;
        const path = statusPath(now, plan.status);
        if (now !== plan.status && (!path || RANK[plan.status] < RANK[now])) {
          recorder.absorb("job", job.sourceId, {
            warnings: [`left at "${now}": the target cannot move a job from "${now}" to "${plan.status}"`], gaps: [],
          });
        } else {
          for (const step of path ?? []) await call("updateJob", { id, status: step });
        }
        await ledger.record({ key: statusKey, target: "done" });
      }
    },

    async estimate(record) {
      const e = record as unknown as CanonicalEstimate;
      const key = Ledger.key("estimate", e.sourceId);
      const t = estimateRequest(e, resolve, mapping);
      let id = ledger.get(key);
      if (id) recorder.count("estimate", "already");
      else {
        if (!translated("estimate", e.sourceId, t) || !checked("estimate", e.sourceId, "createEstimate", t.body)) return;
        id = (await call("createEstimate", t.body, key)).id;
        await ledger.record({ key, target: id });
        recorder.count("estimate", "created");
      }
      if (t.decline && !ledger.has(`${key}#decline`)) {
        await call("declineEstimate", { id, reason: `Declined in ${e.sourceSystem}` });
        await ledger.record({ key: `${key}#decline`, target: "done" });
      }
    },

    async invoice(record) {
      const i = record as unknown as CanonicalInvoice;
      const key = Ledger.key("invoice", i.sourceId);
      const t = invoiceRequest(i, resolve, options);
      let id = ledger.get(key);
      if (id) recorder.count("invoice", "already");
      else {
        if (!translated("invoice", i.sourceId, t) || !checked("invoice", i.sourceId, "createInvoice", t.body)) return;
        const created = await call("createInvoice", t.body, key);
        id = created.id;
        await ledger.record({ key, target: id, amount: created.total });
        recorder.count("invoice", "created");
      }
      // Void before any payment can land on it: the target refuses to void
      // an invoice that has been paid against.
      if (t.plan?.void && !ledger.has(`${key}#void`)) {
        await call("voidInvoice", { id, reason: `Void in ${i.sourceSystem} before migration` });
        await ledger.record({ key: `${key}#void`, target: "done" });
      }
    },

    async payment(record) {
      const p = record as unknown as CanonicalPayment;
      const key = Ledger.key("payment", p.sourceId);
      if (ledger.has(key)) { recorder.count("payment", "already"); return; }
      const t = paymentRequest(p, resolve, mapping);
      if (!translated("payment", p.sourceId, t) || !checked("payment", p.sourceId, "recordPayment", t.body)) return;
      const created = await call("recordPayment", t.body, key);
      await ledger.record({ key, target: created.id, amount: created.amount });
      recorder.count("payment", "created");
    },
  };

  try {
    for (const entity of LOAD_ORDER) {
      let processed = 0;
      const stream = canonicalRecords(snapshot, adapter, entity as EntityName);
      await forEachConcurrent(stream, input.concurrency ?? 4, async (item) => {
        processed += 1;
        input.onProgress?.(entity, processed);
        if ("failure" in item) {
          recorder.problem(entity, item.failure.sourceId, "unreadable", item.failure.error);
          return;
        }
        const sourceId = String(item.record["sourceId"] ?? "");
        try {
          await handlers[entity](item.record);
        } catch (error) {
          // A refusal of THIS record is reported and the run goes on. Anything
          // else (a refused token, a target that stopped answering, a crash)
          // stops the run, because carrying on would mark thousands of good
          // records as failed for a reason that has nothing to do with them.
          if (error instanceof TargetError && !error.retryable && error.status !== 401 && error.status !== 403) {
            recorder.problem(entity, sourceId, "rejected", error.message, error.issues);
            return;
          }
          throw error;
        }
      });
    }

    // Write-offs take the balance that is left, so they wait for payments.
    await forEachConcurrent(canonicalRecords(snapshot, adapter, "invoice"), input.concurrency ?? 4, async (item) => {
      if (!("record" in item)) return;
      const i = item.record as unknown as CanonicalInvoice;
      const key = Ledger.key("invoice", i.sourceId);
      const id = ledger.get(key);
      if (!id || ledger.has(`${key}#write-off`)) return;
      const t = invoiceRequest(i, resolve, options);
      if (!t.plan?.writeOff) return;
      try {
        await call("writeOffInvoice", { id, reason: `Written off in ${i.sourceSystem}` });
        await ledger.record({ key: `${key}#write-off`, target: "done" });
      } catch (error) {
        if (error instanceof TargetError && !error.retryable && error.status !== 401 && error.status !== 403) {
          recorder.report.problems.push({ entity: "invoice", sourceId: i.sourceId, outcome: "rejected", reason: `write-off: ${error.message}` });
          return;
        }
        throw error;
      }
    });
  } catch (error) {
    recorder.report.aborted = (error as Error).message;
  }

  return recorder.report;
}

/** Records that did not land and will not until something changes. */
export function failures(report: LoadReport): number {
  return report.problems.filter((p) => p.outcome === "invalid" || p.outcome === "blocked" || p.outcome === "rejected" || p.outcome === "unreadable").length;
}

const LABEL: Record<LoadEntity, string> = {
  user: "users", customer: "customers", property: "properties", priceBookItem: "price book",
  job: "jobs", estimate: "estimates", invoice: "invoices", payment: "payments",
};

/** Render a report for a terminal: counts, then every record that did not land, then what the target could not take. */
export function renderLoad(report: LoadReport, options: { limit?: number } = {}): string {
  const limit = options.limit ?? 25;
  const out: string[] = [];
  out.push(report.dryRun
    ? "DRY RUN against a scratch tenant in memory. Nothing was written anywhere."
    : `LOAD into ${report.target}`);
  out.push("");
  out.push(`  ${"".padEnd(12)} ${["new", "already", "mapped", "skipped", "blocked", "invalid", "refused", "unread"].map((h) => h.padStart(8)).join("")}`);
  for (const entity of LOAD_ORDER) {
    const row = report.entities[entity];
    if (!row) continue;
    const cells = [row.created, row.already, row.mapped, row.skipped, row.blocked, row.invalid, row.rejected, row.unreadable];
    out.push(`  ${LABEL[entity].padEnd(12)} ${cells.map((c) => (c === 0 ? "-" : String(c)).padStart(8)).join("")}`);
  }

  const grouped = new Map<Outcome, Problem[]>();
  for (const p of report.problems) {
    const bucket = grouped.get(p.outcome) ?? [];
    grouped.set(p.outcome, bucket);
    bucket.push(p);
  }
  const titles: Partial<Record<Outcome, string>> = {
    invalid: "WOULD BE REFUSED BY THE TARGET",
    rejected: "REFUSED BY THE TARGET",
    blocked: "WAITING ON A RECORD THAT DID NOT LOAD",
    unreadable: "UNREADABLE IN THE SNAPSHOT",
    skipped: "NOT LOADED, ON PURPOSE",
  };
  for (const outcome of ["invalid", "rejected", "blocked", "unreadable", "skipped"] as Outcome[]) {
    const problems = grouped.get(outcome);
    if (!problems || problems.length === 0) continue;
    out.push("", `${titles[outcome]} (${problems.length})`);
    for (const p of problems.slice(0, limit)) {
      out.push(`  ${p.entity} ${p.sourceId}: ${p.reason}`);
      for (const issue of p.issues ?? []) out.push(`      ${issue.path || "(body)"}: ${issue.message}`);
    }
    if (problems.length > limit) out.push(`  ...and ${problems.length - limit} more. --json has every one.`);
  }

  const gaps = Object.entries(report.gaps) as [GapCode, { count: number; sample: string[] }][];
  if (gaps.length > 0) {
    out.push("", "WHAT THE TARGET API COULD NOT TAKE (docs/target-api-gaps.md)");
    for (const [code, gap] of gaps.sort((a, b) => b[1].count - a[1].count)) {
      out.push(`  ${String(gap.count).padStart(6)}  ${code}: ${GAPS[code].lost}`);
    }
  }

  if (report.warnings.length > 0) {
    out.push("", `WARNINGS (${report.warnings.length})`);
    for (const w of report.warnings.slice(0, limit)) out.push(`  ${w.entity} ${w.sourceId}: ${w.message}`);
    if (report.warnings.length > limit) out.push(`  ...and ${report.warnings.length - limit} more. --json has every one.`);
  }

  if (report.aborted) {
    out.push("", `STOPPED: ${report.aborted}`, "  Everything confirmed so far is in the ledger. Run the same command again to resume.");
  }
  return out.join("\n");
}
