/**
 * WORKIZ
 *
 * Source documentation (the published OpenAPI document behind
 * https://developer.workiz.com): https://developer.workiz.com/api.json
 * Credentials: https://help.workiz.com/hc/en-us/articles/18053137531409-Accessing-your-Workiz-API-credentials
 *
 *   Base URL     https://api.workiz.com/api/v1/{api_token}
 *   Auth         the account's API token, IN THE PATH. There is no header.
 *                The API secret is only needed to write, so it is never asked for.
 *   Read routes  GET /job/all/  (start_date, offset, records <= 100, only_open, status)
 *                GET /team/all/ (active team members)
 *   Paging       offset + records. See `detectPaging` for why the meaning of
 *                offset is checked rather than assumed.
 *   Rate limits  not published. 429 and 5xx are retried with backoff and
 *                Retry-After by the shared transport.
 *
 * Everything the API does not let us read is declared in `unsupported`.
 */
import type { ExtractContext, SourceAdapter, SourceCapabilities } from "../types.js";
import { fetchJson, defaultRetry, HttpError, type RetryPolicy } from "../http.js";
import * as map from "./map.js";
import type { Raw } from "./map.js";

const BASE = "https://api.workiz.com/api/v1";
export const PAGE_SIZE = 100;
/** `job/all` defaults to the last 14 days without a start date. */
export const DEFAULT_SINCE = "2000-01-01";

export const capabilities: SourceCapabilities = {
  entities: ["user", "customer", "property", "job", "invoice"],
  hasApi: true,
  hasAttachments: false,
  recurrenceModel: "materialized-series",
  derivedFrom: { invoice: "job" },
  knownLimits: [
    "The public API reads jobs and team members only. Clients and properties are split out of the jobs that name them, so a client with no job in the extracted range is not in the snapshot.",
    "job/all lists jobs from start_date until today. Jobs scheduled after the day of extraction may not be returned; re-extract after the last scheduled job, or check the count in Workiz against profile.",
    "Invoices are materialised from each job's JobTotalPrice and JobAmountDue, with no lines and no tax split. Payments cannot be read, so the paid part of an invoice has no payment record: the snapshot's open balance is right, but an invoice loaded without its payments would show paid work as owed. dryrun's predicted reconcile shows exactly how much; do not load invoices until that is decided.",
    "Recurring jobs arrive as the individual jobs Workiz has already created. No recurrence rule is exposed.",
    "Team lists only active members. A technician who has left still appears on old jobs by id, and is mapped by hand during `map`.",
    "Times are converted from each job's own Timezone. A job with no Timezone keeps its wall-clock time unqualified.",
    "Rate limits are not published. Retries back off on 429 and 5xx and honour Retry-After.",
  ],
  unsupported: [
    { field: "client (record)", reason: "No client list or client read endpoint in the public API; clients exist only as copies on jobs." },
    { field: "lead", reason: "Leads are not jobs and have no canonical home; read through /lead/all/ is possible but not carried." },
    { field: "payment", reason: "The API can add a payment to a job but not list one." },
    { field: "invoice lines", reason: "Line items are not in the job resource." },
    { field: "job.SubTotal", reason: "The schema does not say whether its difference from JobTotalPrice is tax, discount or both, so no tax split is made. Kept in the payload." },
    { field: "job.item_cost, job.tech_cost", reason: "Job costing has no canonical home. Kept in the payload." },
    { field: "job completion time", reason: "LastStatusUpdate is when the status last changed to anything, not when the work was done." },
    { field: "customer billing address", reason: "Only the job's service address is exposed." },
    { field: "equipment, contacts, service plans", reason: "Not exposed by the public API." },
    { field: "attachments", reason: "Not exposed by the public API." },
  ],
};

export interface WorkizOptions {
  baseUrl?: string;
  retry?: RetryPolicy;
  /** The earliest job date to read, `YYYY-MM-DD`. */
  since?: string;
}

/**
 * The token is in the URL, so every error this client raises is rebuilt
 * without the URL. An exception message is the thing most likely to end up
 * pasted into an issue.
 */
export class WorkizClient {
  constructor(private readonly token: string, private readonly options: WorkizOptions = {}) {}

  private redact(text: string): string {
    return this.token === "" ? text : text.split(this.token).join("<token>");
  }

  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    const url = `${this.options.baseUrl ?? BASE}/${encodeURIComponent(this.token)}${path}${qs ? `?${qs}` : ""}`;
    let response;
    try {
      response = await fetchJson(url, { method: "GET" }, this.options.retry ?? defaultRetry());
    } catch (error) {
      if (error instanceof HttpError) {
        throw new Error(`Workiz returned HTTP ${error.status} for ${path} after retrying`);
      }
      throw new Error(`Workiz request to ${path} failed: ${this.redact((error as Error).message)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Workiz refused the API token (HTTP ${response.status}). Check WORKIZ_TOKEN.`);
    }
    if (response.status >= 400) {
      throw new Error(`Workiz returned HTTP ${response.status} for ${path}: ${this.redact(response.text.slice(0, 200))}`);
    }
    const body = response.body as Record<string, unknown> | undefined;
    if (body && !Array.isArray(body) && body["flag"] === false) {
      throw new Error(`Workiz refused ${path}: ${this.redact(String(body["msg"] ?? body["message"] ?? "no reason given"))}`);
    }
    return response.body;
  }
}

export interface JobPage { records: Raw[]; hasMore: boolean }

/**
 * Two envelopes are in the wild. The published schema says an array of
 * `{ flag, data: Job }`; the API as clients have written against it returns
 * `{ flag, has_more, data: [Job] }`. Both are read. Without `has_more`, a
 * full page means there may be another.
 */
export function readJobPage(body: unknown): JobPage {
  if (Array.isArray(body)) {
    const records = body.map((e) => {
      const entry = e as Raw;
      return entry && typeof entry["data"] === "object" && !Array.isArray(entry["data"]) ? (entry["data"] as Raw) : entry;
    });
    return { records, hasMore: records.length >= PAGE_SIZE };
  }
  const envelope = (body ?? {}) as Raw;
  const data = envelope["data"];
  const records = Array.isArray(data) ? (data as Raw[]) : data && typeof data === "object" ? [data as Raw] : [];
  const hasMore = typeof envelope["has_more"] === "boolean" ? envelope["has_more"] : records.length >= PAGE_SIZE;
  return { records, hasMore };
}

export function readTeam(body: unknown): Raw[] {
  if (Array.isArray(body)) return body as Raw[];
  const data = ((body ?? {}) as Raw)["data"];
  return Array.isArray(data) ? (data as Raw[]) : [];
}

/**
 * What `offset` means.
 *
 * The published schema calls it a "record offset". At least one client
 * library in use steps it 0, 1, 2 as a page number. Assuming the wrong one
 * is silent and catastrophic either way: as a record offset read as pages,
 * every page but the first repeats 99 records; as pages read as a record
 * offset, offset 100 is page 100 and the extraction stops after the first
 * hundred jobs, reporting success.
 *
 * So it is measured. With a full first page, offset 1 is requested: a record
 * offset returns the first page shifted by one, a page number returns
 * entirely new records. Anything in between means the data moved under us,
 * and the run stops rather than guessing.
 */
export function detectPaging(first: Raw[], probe: Raw[]): "record" | "page" {
  const ids = (rs: Raw[]) => rs.map((r) => String(r["UUID"] ?? ""));
  const seen = new Set(ids(first));
  const overlap = ids(probe).filter((id) => seen.has(id)).length;
  if (overlap === 0) return "page";
  if (ids(probe)[0] === ids(first)[1] && overlap >= Math.min(first.length, probe.length) - 1) return "record";
  throw new Error(
    `Cannot tell how Workiz pages: offset 1 shared ${overlap} of ${probe.length} jobs with offset 0. ` +
      `The account was probably being edited; run extract again outside business hours.`,
  );
}

/** Records already written, rebuilt from the snapshot on resume. */
async function seenIn(ctx: ExtractContext, entity: "customer" | "property" | "job", key: (r: Raw) => string): Promise<Set<string>> {
  const seen = new Set<string>();
  if (!ctx.records) return seen;
  for await (const r of ctx.records<Raw>(entity)) seen.add(key(r));
  return seen;
}

export function createWorkizAdapter(options: WorkizOptions = {}): SourceAdapter {
  const tokenOf = (c: Record<string, string>) => c["token"] ?? c["key"] ?? "";

  return {
    id: "workiz",
    displayName: "Workiz",
    capabilities,

    async verify(credentials) {
      const token = tokenOf(credentials);
      if (!token) return { ok: false, error: "No API token. Set WORKIZ_TOKEN." };
      try {
        readTeam(await new WorkizClient(token, options).get("/team/all/"));
        // Workiz exposes no account name or id to a token. The operator can
        // name it (WORKIZ_ACCOUNT) to keep two Workiz accounts loaded into
        // one target apart.
        return { ok: true, account: credentials["account"] ?? "Workiz account" };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },

    async *extract(credentials, ctx: ExtractContext) {
      const client = new WorkizClient(tokenOf(credentials), options);
      const since = credentials["since"] ?? options.since ?? DEFAULT_SINCE;

      // Team: one unpaged call.
      if ((await ctx.resume("user")) !== "done") {
        const team = readTeam(await client.get("/team/all/"));
        await ctx.append("user", team);
        await ctx.checkpoint("user", "done");
        yield { entity: "user", count: team.length, done: true };
      }

      // Jobs, newest first, with their customers and properties split out.
      const query = (offset: number) => ({
        start_date: since, only_open: "false", records: String(PAGE_SIZE), offset: String(offset),
      });
      const resumed = await ctx.resume("job");
      if (resumed === "done") return;

      const customers = await seenIn(ctx, "customer", (r) => map.clientId(r) ?? "");
      const properties = await seenIn(ctx, "property", (r) => map.propertyId(r));
      // Jobs a killed run wrote after its last checkpoint. Skipped quietly on
      // resume; a repeat within this run is drift, and is said out loud.
      const written = await seenIn(ctx, "job", (r) => String(r["UUID"] ?? ""));
      const jobs = new Set<string>();
      let count = 0;
      let drift = 0;

      const take = async (records: Raw[]) => {
        const fresh: Raw[] = [];
        const newCustomers: Raw[] = [];
        const newProperties: Raw[] = [];
        for (const job of records) {
          const id = String(job["UUID"] ?? "");
          if (id !== "" && written.has(id)) { written.delete(id); continue; }
          if (id !== "" && jobs.has(id)) { drift += 1; continue; }
          if (id !== "") jobs.add(id);
          fresh.push(job);
          const client = map.clientId(job);
          if (!client) continue;
          if (!customers.has(client)) { customers.add(client); newCustomers.push(job); }
          const property = map.propertyId(job);
          if (!properties.has(property)) { properties.add(property); newProperties.push(job); }
        }
        // Parents first, so a run killed between the writes never leaves a
        // job whose customer was not written.
        await ctx.append("customer", newCustomers);
        await ctx.append("property", newProperties);
        await ctx.append("job", fresh);
        count += fresh.length;
      };

      let mode: "record" | "page";
      let offset: number;
      if (resumed && /^(record|page):\d+$/.test(resumed)) {
        const [m, n] = resumed.split(":");
        mode = m as "record" | "page";
        offset = Number(n);
      } else {
        const first = readJobPage(await client.get("/job/all/", query(0)));
        await take(first.records);
        if (!first.hasMore || first.records.length < PAGE_SIZE) {
          await ctx.checkpoint("job", "done");
          yield { entity: "job", count, done: true };
          yield { entity: "customer", count: customers.size, done: true };
          yield { entity: "property", count: properties.size, done: true };
          return;
        }
        const probe = readJobPage(await client.get("/job/all/", query(1)));
        mode = detectPaging(first.records, probe.records);
        if (mode === "page") {
          await take(probe.records);
          offset = 2;
          if (!probe.hasMore || probe.records.length === 0) offset = -1;
        } else {
          offset = first.records.length;
        }
        if (offset >= 0) await ctx.checkpoint("job", `${mode}:${offset}`);
        yield { entity: "job", count, done: offset < 0 };
      }

      while (offset >= 0) {
        const page = readJobPage(await client.get("/job/all/", query(offset)));
        await take(page.records);
        const finished = !page.hasMore || page.records.length === 0;
        offset = finished ? -1 : mode === "page" ? offset + 1 : offset + page.records.length;
        await ctx.checkpoint("job", finished ? "done" : `${mode}:${offset}`);
        yield { entity: "job", count, done: finished };
      }
      yield { entity: "customer", count: customers.size, done: true };
      yield { entity: "property", count: properties.size, done: true };

      if (drift > 0) {
        ctx.log(
          `job: ${drift} job(s) appeared on more than one page. Workiz was being edited during ` +
            `extraction, so some jobs may also have been skipped. Re-run extract outside business hours.`,
        );
      }
    },

    toCanonical(entity, raw) {
      const value = raw as Raw;
      switch (entity) {
        case "user": return map.toUser(value);
        case "customer": return map.toCustomer(value);
        case "property": return map.toProperty(value);
        case "job": return map.toJob(value);
        case "invoice": return map.toInvoices(value);
        default:
          throw new Error(`Workiz adapter has no canonical mapping for "${entity}"`);
      }
    },
  };
}

export const workiz: SourceAdapter = createWorkizAdapter();
