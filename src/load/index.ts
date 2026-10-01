import { randomUUID } from "node:crypto";
import type { EntityName } from "../canonical/index.js";
import type {
  CanonicalCustomer, CanonicalProperty, CanonicalPriceBookItem, CanonicalJob,
  CanonicalEstimate, CanonicalInvoice, CanonicalPayment, CanonicalUser, CanonicalRecurringSchedule,
} from "../canonical/index.js";
import type { SourceAdapter } from "../adapters/types.js";
import type { Snapshot } from "../snapshot/index.js";
import { canonicalRecords } from "../transform/index.js";
import type { Mapping } from "../mapping/index.js";
import * as money from "../money/index.js";
import { statusPath, validate, Uuid, type JobStatus, type RouteName, type InputOf, type OutputOf } from "../target/contracts.js";
import { TargetError, pages, type Paged, type Target } from "../target/client.js";
import { Ledger } from "./ledger.js";
import { GAPS, type GapCode } from "./gaps.js";
import {
  customerRequest, propertyRequest, priceBookRequest, jobRequest, estimateRequest,
  invoiceRequest, paymentRequest, recurringRequest, refundRequest,
  type Translated, type Resolve, type TranslateOptions, type RefundCandidate,
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
 *   contacts       reported: the target has no route for them
 *   properties     linked to every customer that holds them
 *   equipment      reported: the target has no route for customer equipment
 *   price book
 *   jobs           with their visits (cancelled and untimed ones included),
 *                  completions and status walked forward
 *   recurring      schedules, started at their next occurrence
 *   estimates
 *   invoices       voided where the source voided them
 *   payments       allocated exactly as the source allocated them; money
 *                  applied to nothing is held for the customer
 *   refunds        against the payment they gave back
 *   write-offs     last, because a write-off takes the balance left after payment
 *
 * Every reference is resolved through the ledger, so a job is only sent once
 * its customer and property are known to exist in the target. A record whose
 * reference did not make it is BLOCKED, named on the report with what it was
 * waiting for, and never sent half-linked.
 *
 * Re-running is the recovery for everything. Records already in the ledger
 * are skipped. Records in flight when the process died are re-sent with the
 * same Idempotency-Key, and every create carries an externalRef, so the
 * target either replays what it made or answers 409 naming it, and the
 * loader adopts it. A lost ledger is rebuilt from the target with
 * `rebuild: true` (`load --rebuild-ledger`).
 *
 * Before the first write into a target the loader checks that the token may
 * record history (`data:import`), with a request the target refuses either
 * way and stores nothing from, so a token without it fails at once and says
 * why, rather than a thousand records in.
 *
 * `dryrun` runs exactly this against an in-memory target, which is the only
 * way a dry run can promise anything about the real one.
 */

export const LOAD_ORDER = [
  "user", "customer", "contact", "property", "equipment", "priceBookItem",
  "job", "recurringSchedule", "estimate", "invoice", "payment",
] as const;
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
  /** The externalRef source every record was sent with. */
  externalSource: string;
  entities: Partial<Record<LoadEntity, Record<Outcome, number>>>;
  problems: Problem[];
  warnings: { entity: string; sourceId: string; message: string }[];
  gaps: Partial<Record<GapCode, { count: number; sample: string[] }>>;
  /** Ledger entries read back out of the target, per entity, when rebuilding. */
  rebuilt?: Record<string, number>;
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
  /** Read what this migration already loaded back out of the target first. */
  rebuild?: boolean;
  /** Check the token may record history before the first write. Default on. */
  preflight?: boolean;
  /** Records in flight at once within one entity. Entities never overlap. */
  concurrency?: number;
  /** The target's today, for dates it would refuse as the future. */
  now?: Date;
  onProgress?: (entity: LoadEntity, processed: number) => void;
}

const SAMPLE = 10;

/** A failure that is about the run, not about one record. It stops the load. */
export class LoadStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadStopped";
  }
}

class Recorder {
  readonly report: LoadReport;
  constructor(target: string, dryRun: boolean, carryTotals: boolean, externalSource: string) {
    this.report = { target, dryRun, carryTotals, externalSource, entities: {}, problems: [], warnings: [], gaps: {} };
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

/**
 * Lifecycle rank, for refusing to walk a job backwards. The core would allow
 * completed -> in_progress -> on_hold -> scheduled, and a source that says
 * "active" about a job whose every visit is done does not mean that.
 */
const RANK: Record<JobStatus, number> = {
  lead: 0, estimating: 1, scheduled: 2, in_progress: 3, on_hold: 3, completed: 4, invoiced: 5, paid: 6, cancelled: 7,
};

/** The id a 409 says a source record already became: services/provenance.ts assertUnclaimed. */
export function adoptable(error: unknown): string | undefined {
  if (!(error instanceof TargetError) || error.status !== 409) return undefined;
  const found = /is already here, as ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(error.message)?.[1];
  return found && Uuid.safeParse(found).success ? found : undefined;
}

const numberTaken = (error: unknown): boolean =>
  error instanceof TargetError && error.status === 409 && /number \d+ is already taken/i.test(error.message);

/** A refusal of one record, which is reported, against anything that should stop the run. */
const isRecordRefusal = (error: unknown): error is TargetError =>
  error instanceof TargetError && !error.retryable && error.status !== 401 && error.status !== 403;

/** What a 403 means for a migration, said so the operator can fix it. */
function explainForbidden(error: TargetError): string {
  if (/data:import/.test(error.message)) {
    return `${error.message}. The token may not record history: back-dated invoices, payments and completions, ` +
      "document numbers and tax as charged all need the data:import permission, which only an owner can give the app. " +
      "Grant it for the length of the migration (docs/loading.md), then run load again.";
  }
  return `${error.message}. The token is missing a permission this step needs; see docs/loading.md for the list.`;
}

/** The lists that find a record by where it came from, per ledger entity. */
const FINDABLE: { entity: string; route: RouteName; extra?: Record<string, unknown> }[] = [
  { entity: "customer", route: "listCustomers", extra: { includeInactive: true } },
  { entity: "property", route: "listProperties" },
  { entity: "priceBookItem", route: "listPriceBook", extra: { includeInactive: true } },
  { entity: "job", route: "listJobs" },
  { entity: "estimate", route: "listEstimates" },
  { entity: "invoice", route: "listInvoices" },
  { entity: "payment", route: "listPayments" },
];

/**
 * REBUILD THE LEDGER FROM THE TARGET.
 *
 * Every record this migration made carries its externalRef, so the target
 * can say what each source record became. This reads every one back and
 * writes the ledger entries a lost or partial ledger is missing, together
 * with the steps whose effect is visible on the record (a void, a write-off,
 * a decline, a retirement). Visits are read back per job when the job is
 * reached, and every other step is safe to repeat.
 */
export async function rebuildLedger(target: Target, ledger: Ledger): Promise<Record<string, number>> {
  const source = ledger.externalSource;
  const counts: Record<string, number> = {};
  for (const list of FINDABLE) {
    let n = 0;
    for await (const row of pages(target, list.route, { ...list.extra, externalSource: source })) {
      const ref = row["externalRef"] as { source?: string; id?: string } | null | undefined;
      if (!ref || ref.source !== source || !ref.id) continue;
      const key = Ledger.key(list.entity, ref.id);
      const entries: { key: string; target: string; amount?: string }[] = [];
      if (!ledger.has(key)) {
        entries.push({ key, target: String(row["id"]), ...(list.entity === "invoice" && typeof row["total"] === "string" ? { amount: row["total"] } : {}) });
        n += 1;
      }
      const status = row["status"];
      if (list.entity === "invoice" && status === "void") entries.push({ key: `${key}#void`, target: "done" });
      if (list.entity === "invoice" && status === "written_off") entries.push({ key: `${key}#write-off`, target: "done" });
      if (list.entity === "estimate" && status === "declined") entries.push({ key: `${key}#decline`, target: "done" });
      if (list.entity === "priceBookItem" && row["active"] === false) entries.push({ key: `${key}#retired`, target: "done" });
      await ledger.record(...entries.filter((e) => !ledger.has(e.key)));
    }
    counts[list.entity] = n;
  }
  return counts;
}

export async function load(input: LoadInput): Promise<LoadReport> {
  const { snapshot, adapter, target, ledger, mapping } = input;
  const carryTotals = input.carryTotals ?? false;
  const externalSource = ledger.externalSource;
  const recorder = new Recorder(target.description, input.dryRun ?? false, carryTotals, externalSource);
  const resolve: Resolve = (entity, sourceId) => ledger.get(Ledger.key(entity, sourceId));
  const options: TranslateOptions = { mapping, carryTotals, externalSource, ...(input.now ? { now: input.now } : {}) };

  const call = <N extends RouteName>(name: N, body: InputOf<N>, key?: string): Promise<OutputOf<N>> =>
    target.call(name, body, key ? { idempotencyKey: ledger.idempotencyKey(key) } : {});

  /** A create, or the record the target says the source record already became. */
  const create = async <N extends RouteName>(name: N, body: InputOf<N>, key: string): Promise<{ id: string; output?: OutputOf<N> }> => {
    try {
      const output = await call(name, body, key);
      return { id: (output as unknown as { id: string }).id, output };
    } catch (error) {
      const adopted = adoptable(error);
      if (adopted) return { id: adopted };
      throw error;
    }
  };

  /**
   * A document carrying its source number. If the target already uses that
   * number (a company that was invoicing here before the migration), the
   * document still loads, with the next number, and the report says so.
   */
  const createNumbered = async <N extends "createJob" | "createEstimate" | "createInvoice">(
    entity: LoadEntity, sourceId: string, name: N, body: InputOf<N>, key: string,
  ): Promise<{ id: string; output?: OutputOf<N> }> => {
    try {
      return await create(name, body, key);
    } catch (error) {
      const number = (body as { number?: number }).number;
      if (!numberTaken(error) || number === undefined) throw error;
      const { number: _taken, ...rest } = body as InputOf<N> & { number?: number };
      recorder.absorb(entity, sourceId, {
        warnings: [`number ${number} is already used in the target; this one was given the next number`],
        gaps: ["document.number_taken"],
      });
      return create(name, rest as InputOf<N>, key);
    }
  };

  /**
   * A token whose scope on a kind of record is narrower than `all` sees only
   * some of them, and an app's own creations are not among them, so every
   * list (rebuild, reconcile) would come back empty. Checked once per kind
   * per run, on the first record made, by finding it again.
   */
  const VISIBLE: Partial<Record<string, RouteName>> = {
    customer: "listCustomers", job: "listJobs", estimate: "listEstimates", invoice: "listInvoices",
  };
  const seenVisible = new Map<string, Promise<void>>();
  const visible = (entity: string, sourceId: string): Promise<void> => {
    const route = VISIBLE[entity];
    if (!route || seenVisible.has(entity)) return seenVisible.get(entity) ?? Promise.resolve();
    const check = (async () => {
      const page = await call(route, { limit: 1, externalSource, externalId: sourceId, ...(entity === "customer" ? { includeInactive: true } : {}) } as InputOf<typeof route>) as unknown as Paged;
      if (page.data.length === 0) {
        throw new LoadStopped(
          `The target made ${entity} ${sourceId} and will not list it back to this token. Its scope on ${entity}s is narrower than "all", ` +
            "so nothing this migration loads can be found again or reconciled. Give the app the all scope on customers, jobs, estimates " +
            "and invoices (docs/loading.md), then run load again.",
        );
      }
    })();
    seenVisible.set(entity, check);
    return check;
  };

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

  let schedules: Promise<OutputOf<"listRecurringSchedules">["schedules"]> | undefined;

  const handlers: Record<LoadEntity, (record: Record<string, unknown>) => Promise<void>> = {
    async user(record) {
      const u = record as unknown as CanonicalUser;
      const mapped = mapping.users[u.sourceId]?.target;
      if (mapped && Uuid.safeParse(mapped).success) { recorder.count("user", "mapped"); return; }
      recorder.problem("user", u.sourceId, "skipped", `${u.name} has no target technician in mapping.json`);
      recorder.absorb("user", u.sourceId, { warnings: [], gaps: ["user.unmapped"] });
    },

    async customer(record) {
      const c = record as unknown as CanonicalCustomer;
      const key = Ledger.key("customer", c.sourceId);
      if (ledger.has(key)) { recorder.count("customer", "already"); return; }
      const t = customerRequest(c, options);
      if (!translated("customer", c.sourceId, t) || !checked("customer", c.sourceId, "createCustomer", t.body)) return;
      const made = await create("createCustomer", t.body, key);
      await ledger.record({ key, target: made.id });
      recorder.count("customer", made.output ? "created" : "already");
      await visible("customer", c.sourceId);
    },

    async contact(record) {
      const sourceId = String(record["sourceId"] ?? "");
      recorder.problem("contact", sourceId, "skipped", "the target has no route that creates a contact");
      recorder.absorb("contact", sourceId, { warnings: [], gaps: ["contact.create"] });
    },

    async property(record) {
      const p = record as unknown as CanonicalProperty;
      const key = Ledger.key("property", p.sourceId);
      const t = propertyRequest(p, resolve, options);
      let id = ledger.get(key);
      if (id) recorder.count("property", "already");
      else {
        if (!translated("property", p.sourceId, t) || !checked("property", p.sourceId, "createProperty", t.body)) return;
        const made = await create("createProperty", t.body, key);
        id = made.id;
        await ledger.record({ key, target: id });
        recorder.count("property", made.output ? "created" : "already");
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

    async equipment(record) {
      const sourceId = String(record["sourceId"] ?? "");
      recorder.problem("equipment", sourceId, "skipped", "the target has no route that creates a customer's equipment");
      recorder.absorb("equipment", sourceId, { warnings: [], gaps: ["equipment.create"] });
    },

    async priceBookItem(record) {
      const item = record as unknown as CanonicalPriceBookItem;
      const key = Ledger.key("priceBookItem", item.sourceId);
      let id = ledger.get(key);
      if (id) recorder.count("priceBookItem", "already");
      else {
        const t = priceBookRequest(item, options);
        if (!translated("priceBookItem", item.sourceId, t) || !checked("priceBookItem", item.sourceId, "createPriceBookItem", t.body)) return;
        const made = await create("createPriceBookItem", t.body, key);
        id = made.id;
        await ledger.record({ key, target: id });
        recorder.count("priceBookItem", made.output ? "created" : "already");
      }
      if (!item.active && !ledger.has(`${key}#retired`)) {
        await call("setPriceBookItemActive", { id, active: false, reason: `Inactive in ${item.sourceSystem}` });
        await ledger.record({ key: `${key}#retired`, target: "done" });
      }
    },

    async job(record) {
      const job = record as unknown as CanonicalJob;
      const key = Ledger.key("job", job.sourceId);
      const visitKey = (sourceId: string) => `${key}#visit:${sourceId}`;
      const t = jobRequest(job, resolve, options);
      let id = ledger.get(key);
      let fresh = false;
      if (id) recorder.count("job", "already");
      else {
        if (!translated("job", job.sourceId, t) || !checked("job", job.sourceId, "createJob", t.body)) return;
        const made = await createNumbered("job", job.sourceId, "createJob", t.body, key);
        id = made.id;
        const first = t.plan?.inline ? t.plan.visits[0] : undefined;
        const firstVisit = made.output ? [...made.output.visits].sort((a, b) => a.sequence - b.sequence)[0] : undefined;
        // The job and the visit created with it land in the ledger together.
        await ledger.record(
          { key, target: id },
          ...(first && firstVisit ? [{ key: visitKey(first.sourceId), target: firstVisit.id }] : []),
        );
        recorder.count("job", made.output ? "created" : "already");
        // An idempotent replay or an adopted job is not fresh: its later
        // visits may already exist.
        fresh = made.output !== undefined && made.output.visits.length <= (first ? 1 : 0);
        await visible("job", job.sourceId);
      }
      const plan = t.plan;
      if (!plan) return;

      // The rest of the visits. A job this run did not just make may already
      // have some, from a run whose ledger did not hear about them: read it
      // once and adopt each by the externalRef it was sent with.
      const missing = plan.visits.filter((v) => !ledger.has(visitKey(v.sourceId)));
      if (missing.length > 0 && !fresh) {
        const current = await call("getJob", { id });
        for (const visit of missing) {
          const found = current.visits.find((v) => v.externalRef?.source === externalSource && v.externalRef.id === visit.externalId);
          if (!found) continue;
          // Found already completed, the completion is recorded with it.
          const done = found.status === "completed" || found.status === "completed_after_cancellation";
          await ledger.record(
            { key: visitKey(visit.sourceId), target: found.id },
            ...(done && !ledger.has(`${key}#complete:${visit.sourceId}`) ? [{ key: `${key}#complete:${visit.sourceId}`, target: "done" }] : []),
          );
        }
      }
      for (const visit of plan.visits) {
        if (ledger.has(visitKey(visit.sourceId))) continue;
        const body: InputOf<"scheduleVisit"> = {
          id,
          ...(visit.windowStart && visit.windowEnd ? { windowStart: visit.windowStart, windowEnd: visit.windowEnd } : {}),
          estimatedDurationMinutes: visit.estimatedDurationMinutes, technicianIds: visit.technicianIds,
          ...(visit.action === "cancel" ? { status: "cancelled" as const } : {}),
          ...(options.externalSource ? { externalRef: { source: options.externalSource, id: visit.externalId } } : {}),
        };
        if (!checked("job", job.sourceId, "scheduleVisit", body)) return;
        const made = await create("scheduleVisit", body, visitKey(visit.sourceId));
        await ledger.record({ key: visitKey(visit.sourceId), target: made.id });
      }

      // Completions carry the source's completion time, so "done in March
      // 2023" stays March 2023. Completing twice is a no-op in the target.
      for (const visit of plan.visits) {
        if (visit.action !== "complete") continue;
        const completeKey = `${key}#complete:${visit.sourceId}`;
        const visitId = ledger.get(visitKey(visit.sourceId));
        if (ledger.has(completeKey) || !visitId) continue;
        await call("completeVisit", {
          id: visitId,
          ...(visit.completedAt ? { completedOfflineAt: visit.completedAt } : {}),
          ...(visit.notes ? { technicianNotes: visit.notes } : {}),
        });
        await ledger.record({ key: completeKey, target: "done" });
      }

      // Status last, walked along the target's lifecycle and never backwards.
      // The move to completed carries when it was finished.
      const statusKey = `${key}#status`;
      if (plan.status && !ledger.has(statusKey)) {
        const now = (await call("getJob", { id })) as OutputOf<"getJob"> & { completedAt?: string | null };
        const path = statusPath(now.status, plan.status);
        if (now.status !== plan.status && (!path || RANK[plan.status] < RANK[now.status])) {
          recorder.absorb("job", job.sourceId, {
            warnings: [`left at "${now.status}": the target cannot move a job from "${now.status}" to "${plan.status}"`], gaps: [],
          });
        } else {
          for (const step of path ?? []) {
            const stamp = step === "completed" && plan.completedAt && !now.completedAt ? { completedAt: plan.completedAt } : {};
            await call("updateJob", { id, status: step, ...stamp });
          }
        }
        await ledger.record({ key: statusKey, target: "done" });
      }
    },

    async recurringSchedule(record) {
      const s = record as unknown as CanonicalRecurringSchedule;
      const key = Ledger.key("recurringSchedule", s.sourceId);
      const t = recurringRequest(s, resolve, options);
      let id = ledger.get(key);
      if (id) recorder.count("recurringSchedule", "already");
      else {
        if (!translated("recurringSchedule", s.sourceId, t) || !checked("recurringSchedule", s.sourceId, "createRecurringSchedule", t.body)) return;
        // The target reads no Idempotency-Key here and takes no externalRef,
        // so a schedule a crashed run made is found by what it is.
        const body = t.body;
        schedules ??= call("listRecurringSchedules", {}).then((r) => r.schedules);
        const existing = (await schedules).find((x) => x.label === body.label && x.customerId === body.customerId &&
          x.propertyId === body.propertyId && x.model === body.model && x.startsOn === body.startsOn);
        id = existing?.id ?? (await call("createRecurringSchedule", body, key)).id;
        await ledger.record({ key, target: id });
        recorder.count("recurringSchedule", existing ? "already" : "created");
      }
      const plan = t.plan;
      if (!plan) return;
      if (plan.pause && !ledger.has(`${key}#paused`)) {
        await call("setRecurringScheduleActive", { id, active: false }, `${key}#paused`);
        await ledger.record({ key: `${key}#paused`, target: "done" });
      }
      if (plan.completedOn && !ledger.has(`${key}#completed`)) {
        try {
          await call("recordRecurringCompletion", { id, completedOn: plan.completedOn }, `${key}#completed`);
        } catch (error) {
          // Already recorded, by a run that did not live to write it down.
          if (!(error instanceof TargetError && error.status === 409 && /last completed/.test(error.message))) throw error;
        }
        await ledger.record({ key: `${key}#completed`, target: "done" });
      }
      for (const e of plan.exceptions) {
        const exceptionKey = `${key}#exception:${e.date}`;
        if (ledger.has(exceptionKey)) continue;
        await call("exceptRecurringOccurrence", { id, ...e }, exceptionKey);
        await ledger.record({ key: exceptionKey, target: "done" });
      }
    },

    async estimate(record) {
      const e = record as unknown as CanonicalEstimate;
      const key = Ledger.key("estimate", e.sourceId);
      const t = estimateRequest(e, resolve, options);
      let id = ledger.get(key);
      if (id) recorder.count("estimate", "already");
      else {
        if (!translated("estimate", e.sourceId, t) || !checked("estimate", e.sourceId, "createEstimate", t.body)) return;
        const made = await createNumbered("estimate", e.sourceId, "createEstimate", t.body, key);
        id = made.id;
        await ledger.record({ key, target: id });
        recorder.count("estimate", made.output ? "created" : "already");
        await visible("estimate", e.sourceId);
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
        const made = await createNumbered("invoice", i.sourceId, "createInvoice", t.body, key);
        id = made.id;
        await ledger.record({ key, target: id, ...(made.output ? { amount: made.output.total } : {}) });
        recorder.count("invoice", made.output ? "created" : "already");
        await visible("invoice", i.sourceId);
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
      if (money.compare(p.amount, "0") < 0) return; // a refund: its own pass, below
      if (ledger.has(key)) { recorder.count("payment", "already"); return; }
      const t = paymentRequest(p, resolve, options);
      if (!translated("payment", p.sourceId, t) || !checked("payment", p.sourceId, "recordPayment", t.body)) return;
      const made = await create("recordPayment", t.body, key);
      await ledger.record({ key, target: made.id, ...(made.output ? { amount: made.output.amount } : {}) });
      recorder.count("payment", made.output ? "created" : "already");
    },
  };

  /** One record through its handler, with a refusal of it reported and anything else stopping the run. */
  const run = async (entity: LoadEntity, sourceId: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      // A refusal of THIS record is reported and the run goes on. Anything
      // else (a refused token, a target that stopped answering, a crash)
      // stops the run, because carrying on would mark thousands of good
      // records as failed for a reason that has nothing to do with them.
      if (isRecordRefusal(error)) {
        recorder.problem(entity, sourceId, "rejected", error.message, error.issues);
        return;
      }
      throw error;
    }
  };

  try {
    if (input.rebuild) recorder.report.rebuilt = await rebuildLedger(target, ledger);
    if (input.preflight !== false) await preflight(target, ledger, input.now);

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
        await run(entity, sourceId, () => handlers[entity](item.record));
      });
    }

    // Refunds, once every payment they could have given back is there.
    await forEachConcurrent(canonicalRecords(snapshot, adapter, "payment"), 1, async (item) => {
      if (!("record" in item)) return;
      const p = item.record as unknown as CanonicalPayment;
      if (money.compare(p.amount, "0") >= 0) return;
      await run("payment", p.sourceId, async () => {
        const key = Ledger.key("payment", p.sourceId);
        if (ledger.has(key)) { recorder.count("payment", "already"); return; }
        const customerId = resolve("customer", p.customerSourceId);
        const candidates: RefundCandidate[] = [];
        if (customerId) {
          for await (const row of pages(target, "listPayments", { customerId, externalSource })) {
            const net = new Map<string, string>();
            for (const a of row["allocations"] as { invoiceId: string; amount: string }[]) net.set(a.invoiceId, money.add(net.get(a.invoiceId) ?? "0", a.amount));
            // The whole payment, not what is left of it: a refund this run
            // already recorded and did not live to write down must still find
            // its payment, and the target's key then replays it.
            candidates.push({
              id: String(row["id"]), amount: String(row["amount"]), refundedAmount: "0",
              receivedAt: String(row["receivedAt"]), allocations: [...net].map(([invoiceId, amount]) => ({ invoiceId, amount })),
            });
          }
        }
        const t = customerId
          ? refundRequest(p, resolve, candidates, options)
          : { blocked: `customer ${p.customerSourceId || "(none)"} is not in the target`, warnings: [], gaps: [] as GapCode[] };
        if (!translated("payment", p.sourceId, t) || !checked("payment", p.sourceId, "recordRefund", t.body)) return;
        await call("recordRefund", t.body, key);
        await ledger.record({ key, target: t.body.id, amount: money.negate(t.body.amount) });
        recorder.count("payment", "created");
      });
    });

    // Write-offs take the balance that is left, so they wait for payments.
    await forEachConcurrent(canonicalRecords(snapshot, adapter, "invoice"), input.concurrency ?? 4, async (item) => {
      if (!("record" in item)) return;
      const i = item.record as unknown as CanonicalInvoice;
      const key = Ledger.key("invoice", i.sourceId);
      const id = ledger.get(key);
      if (!id || ledger.has(`${key}#write-off`)) return;
      const action = invoiceRequest(i, resolve, options).plan;
      if (!action?.writeOff) return;
      try {
        await call("writeOffInvoice", { id, reason: `Written off in ${i.sourceSystem}` });
        await ledger.record({ key: `${key}#write-off`, target: "done" });
      } catch (error) {
        if (isRecordRefusal(error)) {
          recorder.report.problems.push({ entity: "invoice", sourceId: i.sourceId, outcome: "rejected", reason: `write-off: ${error.message}` });
          return;
        }
        throw error;
      }
    });
  } catch (error) {
    recorder.report.aborted = error instanceof TargetError && error.status === 403 ? explainForbidden(error) : (error as Error).message;
  }

  return recorder.report;
}

const PREFLIGHT = "preflight:data-import";

/**
 * MAY THIS TOKEN RECORD HISTORY?
 *
 * There is no route that lists a token's permissions, so the question is
 * asked the way the target answers it: an invoice dated a month back, with a
 * stated tax, that cannot add up to the total it says it expects. The target
 * admits the date (403 without data:import), takes the tax (403 without it),
 * and refuses the totals (422) before it looks at the customer or stores
 * anything. A 422 on `expectedTotals` is therefore a yes, and nothing exists
 * afterwards either way. Asked once per ledger.
 */
export async function preflight(target: Target, ledger: Ledger, now = new Date()): Promise<void> {
  if (ledger.has(PREFLIGHT)) return;
  const monthAgo = new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10);
  try {
    await target.call("createInvoice", {
      customerId: randomUUID(),
      issuedOn: monthAgo,
      memo: "Permission check by opentradesos-migrate. Refused by design; nothing is stored.",
      lines: [{ name: "Permission check", unitPrice: "1", taxRate: "0", taxAmount: "0" }],
      expectedTotals: { total: "0.01" },
    }, { idempotencyKey: ledger.idempotencyKey(PREFLIGHT) });
  } catch (error) {
    if (error instanceof TargetError && error.status === 422 && error.issues.some((i) => i.path.startsWith("expectedTotals"))) {
      await ledger.record({ key: PREFLIGHT, target: "done" });
      return;
    }
    if (error instanceof TargetError && error.status === 403) throw error;
    throw new LoadStopped(`The permission check did not get the refusal it expected (${(error as Error).message}). ` +
      "Check that --target is an OpenTradesOS that records history (data:import), then run load again.");
  }
  throw new LoadStopped("The target accepted an invoice it should have refused for not adding up. Nothing more was sent. " +
    "Check that --target is an OpenTradesOS that checks expectedTotals before loading into it.");
}

/** Records that did not land and will not until something changes. */
export function failures(report: LoadReport): number {
  return report.problems.filter((p) => p.outcome === "invalid" || p.outcome === "blocked" || p.outcome === "rejected" || p.outcome === "unreadable").length;
}

const LABEL: Record<LoadEntity, string> = {
  user: "users", customer: "customers", contact: "contacts", property: "properties", equipment: "equipment",
  priceBookItem: "price book", job: "jobs", recurringSchedule: "recurring", estimate: "estimates",
  invoice: "invoices", payment: "payments",
};

/** Render a report for a terminal: counts, then every record that did not land, then what the target could not take. */
export function renderLoad(report: LoadReport, options: { limit?: number } = {}): string {
  const limit = options.limit ?? 25;
  const out: string[] = [];
  out.push(report.dryRun
    ? "DRY RUN against a scratch tenant in memory. Nothing was written anywhere."
    : `LOAD into ${report.target}, as externalSource ${report.externalSource}`);
  if (report.rebuilt) {
    const found = Object.entries(report.rebuilt).filter(([, n]) => n > 0).map(([e, n]) => `${n} ${e}`);
    out.push(`  Ledger rebuilt from the target: ${found.length > 0 ? found.join(", ") : "nothing was missing"}.`);
  }
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
