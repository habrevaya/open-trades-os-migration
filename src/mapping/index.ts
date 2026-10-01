import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceAdapter } from "../adapters/types.js";
import type { Snapshot } from "../snapshot/index.js";
import { canonicalRecords } from "../transform/index.js";
import { JobStatus, PaymentMethod, Uuid } from "../target/contracts.js";

/**
 * THE MAPPING FILE
 *
 * The decisions a migration needs a person for, written down where the
 * person can read them, change them and keep them.
 *
 * Every value the source uses for a job status, a visit status, an invoice
 * status, an estimate status and a payment method is listed with the
 * toolkit's best guess beside it, and every technician and job type is listed
 * with an empty slot for the target id it should become. `map` writes the
 * file; the operator edits it; `map` again adds anything new without touching
 * what they changed; `dryrun` and `load` read it.
 *
 * It is a file rather than a prompt, deliberately. A migration is run more
 * than once (a scratch tenant, then production, then the delta at cutover),
 * and a decision made interactively is a decision made three times, possibly
 * three ways. A file is made once, reviewed, and can be checked in.
 *
 * Technicians cannot be guessed and are not. The target has no API to create
 * a user, by design (who may log in is not a migration's decision), and no
 * API to list them either, so the operator copies each person's id from the
 * target's settings screen. An unmapped technician is dropped from the visits
 * they worked, and the report says how many visits that touched.
 */

export type VisitAction = "schedule" | "complete" | "skip";
export type InvoiceAction = "open" | "void" | "write_off";
export type EstimateAction = "open" | "decline";
export type PaymentAction = "load" | "skip";

export interface Mapping {
  version: 1;
  source: string;
  /** Source user id to the target user id they are, or null for "not mapped yet". */
  users: Record<string, { name: string; email?: string; target: string | null }>;
  /** Source job type name to a target job type id, or null to leave the job untyped. */
  jobTypes: Record<string, string | null>;
  /** Source job status to the status the job should end in, or null to leave it where creation puts it. */
  jobStatus: Record<string, JobStatus | null>;
  /** A visit with a completion time is completed whatever this says, unless it says skip. */
  visitStatus: Record<string, VisitAction>;
  invoiceStatus: Record<string, InvoiceAction>;
  estimateStatus: Record<string, EstimateAction>;
  paymentMethods: Record<string, PaymentMethod>;
  paymentStatus: Record<string, PaymentAction>;
}

export const MAPPING_FILE = "mapping.json";

export const norm = (value: unknown): string => String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Best guesses for the words the two API sources use, and the obvious
 * English ones a spreadsheet uses. Anything not here maps to null (job) or
 * the cautious choice, and is listed in the file for a person to decide.
 */
export function guessJobStatus(status: string): JobStatus | null {
  const s = norm(status);
  const table: Record<string, JobStatus> = {
    lead: "lead", unscheduled: "lead", needs_scheduling: "lead", new: "lead",
    estimating: "estimating", quoted: "estimating",
    active: "scheduled", upcoming: "scheduled", today: "scheduled", late: "scheduled",
    action_required: "scheduled", scheduled: "scheduled", open: "scheduled",
    in_progress: "in_progress", started: "in_progress", working: "in_progress",
    on_hold: "on_hold", hold: "on_hold",
    requires_invoicing: "completed", archived: "completed", completed: "completed", complete: "completed",
    complete_rated: "completed", complete_unrated: "completed", done: "completed", closed: "completed",
    // Invoiced and paid are reached by loading the invoice and its payments,
    // which is the only way the target's ledger agrees with the status.
    invoiced: "completed", paid: "completed",
    cancelled: "cancelled", canceled: "cancelled", user_canceled: "cancelled", pro_canceled: "cancelled",
  };
  return table[s] ?? (JobStatus.safeParse(s).success ? (s as JobStatus) : null);
}

export function guessVisitAction(status: string): VisitAction {
  const s = norm(status);
  if (["complete", "completed", "done", "finished", "complete_rated", "complete_unrated"].includes(s)) return "complete";
  // A cancelled visit cannot be recorded as cancelled (no route does it), and
  // loading it as scheduled would put a technician in a driveway the
  // customer already declined. Skipped, and counted on the report.
  if (["cancelled", "canceled", "user_canceled", "pro_canceled", "no_show", "deleted"].includes(s)) return "skip";
  return "schedule";
}

export function guessInvoiceAction(status: string): InvoiceAction {
  const s = norm(status);
  if (["void", "voided", "cancelled", "canceled"].includes(s)) return "void";
  if (["bad_debt", "written_off", "write_off", "uncollectible"].includes(s)) return "write_off";
  return "open";
}

export function guessEstimateAction(status: string): EstimateAction {
  const s = norm(status);
  return ["declined", "rejected", "lost"].includes(s) ? "decline" : "open";
}

export function guessPaymentMethod(method: string): PaymentMethod {
  const s = norm(method);
  if (s.includes("card") || ["visa", "mastercard", "amex", "credit", "debit", "stripe"].includes(s)) {
    return s === "credit" ? "credit" : "card";
  }
  if (["ach", "bank_transfer", "eft", "e_check", "echeck", "bank"].includes(s)) return "ach";
  if (s === "cash") return "cash";
  if (["check", "cheque"].includes(s)) return "check";
  if (s.includes("financ")) return "financing";
  if (PaymentMethod.safeParse(s).success) return s as PaymentMethod;
  return "other";
}

export function guessPaymentAction(status: string): PaymentAction {
  const s = norm(status);
  return ["failed", "declined", "voided", "void", "cancelled", "canceled", "pending"].includes(s) ? "skip" : "load";
}

export function emptyMapping(source: string): Mapping {
  return {
    version: 1, source, users: {}, jobTypes: {}, jobStatus: {}, visitStatus: {},
    invoiceStatus: {}, estimateStatus: {}, paymentMethods: {}, paymentStatus: {},
  };
}

export interface MappingSummary {
  mapping: Mapping;
  added: string[];
  unmappedUsers: string[];
  unmappedJobTypes: string[];
  undecidedJobStatuses: string[];
  invalidTargets: string[];
}

/**
 * Read the snapshot, and add to `existing` every value it has not seen.
 * Values already in the file are never changed: the file is the operator's.
 */
export async function buildMapping(
  snapshot: Snapshot,
  adapter: SourceAdapter,
  existing?: Mapping,
): Promise<MappingSummary> {
  const mapping: Mapping = existing ? structuredClone(existing) : emptyMapping(snapshot.source);
  const added: string[] = [];
  const add = <T>(table: Record<string, T>, section: string, key: string, value: T) => {
    if (key === "" || key in table) return;
    table[key] = value;
    added.push(`${section}.${key}`);
  };

  for await (const item of canonicalRecords(snapshot, adapter, "user")) {
    if (!("record" in item)) continue;
    const u = item.record;
    const id = String(u["sourceId"] ?? "");
    if (id === "" || id in mapping.users) continue;
    mapping.users[id] = {
      name: String(u["name"] ?? ""),
      ...(typeof u["email"] === "string" ? { email: u["email"] } : {}),
      target: null,
    };
    added.push(`users.${id}`);
  }

  for await (const item of canonicalRecords(snapshot, adapter, "job")) {
    if (!("record" in item)) continue;
    const job = item.record;
    add(mapping.jobStatus, "jobStatus", norm(job["status"]), guessJobStatus(String(job["status"] ?? "")));
    if (typeof job["jobType"] === "string") add(mapping.jobTypes, "jobTypes", job["jobType"], null);
    for (const visit of (Array.isArray(job["visits"]) ? job["visits"] : []) as Record<string, unknown>[]) {
      add(mapping.visitStatus, "visitStatus", norm(visit["status"]), guessVisitAction(String(visit["status"] ?? "")));
      // Technicians named on visits but absent from the user file still need
      // a slot, or they vanish from history without anyone deciding that.
      for (const tech of (Array.isArray(visit["technicianSourceIds"]) ? visit["technicianSourceIds"] : []) as string[]) {
        if (!(tech in mapping.users)) {
          mapping.users[tech] = { name: "(named on a visit, not in the user list)", target: null };
          added.push(`users.${tech}`);
        }
      }
    }
  }

  for await (const item of canonicalRecords(snapshot, adapter, "invoice")) {
    if ("record" in item) add(mapping.invoiceStatus, "invoiceStatus", norm(item.record["status"]), guessInvoiceAction(String(item.record["status"] ?? "")));
  }
  for await (const item of canonicalRecords(snapshot, adapter, "estimate")) {
    if ("record" in item) add(mapping.estimateStatus, "estimateStatus", norm(item.record["status"]), guessEstimateAction(String(item.record["status"] ?? "")));
  }
  for await (const item of canonicalRecords(snapshot, adapter, "payment")) {
    if (!("record" in item)) continue;
    add(mapping.paymentMethods, "paymentMethods", norm(item.record["method"]), guessPaymentMethod(String(item.record["method"] ?? "")));
    add(mapping.paymentStatus, "paymentStatus", norm(item.record["status"]), guessPaymentAction(String(item.record["status"] ?? "")));
  }

  return { mapping, added, ...check(mapping) };
}

/** What still needs a person, and which ids typed into the file are not ids. */
export function check(mapping: Mapping): Omit<MappingSummary, "mapping" | "added"> {
  const invalidTargets: string[] = [];
  const unmappedUsers: string[] = [];
  for (const [id, user] of Object.entries(mapping.users)) {
    if (user.target === null || user.target === "") unmappedUsers.push(id);
    else if (!Uuid.safeParse(user.target).success) invalidTargets.push(`users.${id}: ${user.target}`);
  }
  const unmappedJobTypes: string[] = [];
  for (const [name, target] of Object.entries(mapping.jobTypes)) {
    if (target === null || target === "") unmappedJobTypes.push(name);
    else if (!Uuid.safeParse(target).success) invalidTargets.push(`jobTypes.${name}: ${target}`);
  }
  for (const [status, target] of Object.entries(mapping.jobStatus)) {
    if (target !== null && !JobStatus.safeParse(target).success) invalidTargets.push(`jobStatus.${status}: ${target}`);
  }
  for (const [method, target] of Object.entries(mapping.paymentMethods)) {
    if (!PaymentMethod.safeParse(target).success) invalidTargets.push(`paymentMethods.${method}: ${target}`);
  }
  const undecidedJobStatuses = Object.entries(mapping.jobStatus).filter(([, v]) => v === null).map(([k]) => k);
  return { unmappedUsers, unmappedJobTypes, undecidedJobStatuses, invalidTargets };
}

export function mappingPath(snapshotDir: string): string {
  return join(snapshotDir, MAPPING_FILE);
}

export async function readMapping(path: string): Promise<Mapping | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Mapping;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read the mapping at ${path}: ${(error as Error).message}`);
  }
}

export async function writeMapping(path: string, mapping: Mapping): Promise<void> {
  await writeFile(path, JSON.stringify(mapping, null, 2) + "\n", "utf8");
}
