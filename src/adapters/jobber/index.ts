import type { EntityName } from "../../canonical/index.js";
import type { ExtractContext, SourceAdapter, SourceCapabilities } from "../types.js";
import { fetchJson, defaultRetry, type RetryPolicy } from "../http.js";
import * as Q from "./queries.js";
import * as map from "./map.js";

const ENDPOINT = "https://api.getjobber.com/api/graphql";

/**
 * The API version is pinned, not floating.
 *
 * Jobber dates its GraphQL schema and an unpinned client silently follows the
 * latest one. A migration that takes three nights to extract must see the same
 * schema on night three that it saw on night one, or half the snapshot is
 * shaped differently from the other half and nothing downstream can tell.
 */
const API_VERSION = "2023-11-15";

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

/**
 * Jobber throttles on query cost against a leaky bucket, and tells you the
 * bucket state on every response. Waiting until the bucket has refilled enough
 * for the next query is strictly better than firing it and handling the 429:
 * the failed call costs a round trip and still leaves you waiting.
 */
export function waitForBudget(
  throttle: ThrottleStatus | undefined,
  nextCost: number,
): number {
  if (!throttle || throttle.restoreRate <= 0) return 0;
  const deficit = nextCost - throttle.currentlyAvailable;
  if (deficit <= 0) return 0;
  return Math.ceil((deficit / throttle.restoreRate) * 1000);
}

export function readThrottle(body: unknown): ThrottleStatus | undefined {
  const extensions = (body as { extensions?: { cost?: { throttleStatus?: unknown } } })?.extensions;
  const status = extensions?.cost?.throttleStatus as Partial<ThrottleStatus> | undefined;
  if (!status || typeof status.currentlyAvailable !== "number") return undefined;
  return {
    maximumAvailable: status.maximumAvailable ?? 0,
    currentlyAvailable: status.currentlyAvailable,
    restoreRate: status.restoreRate ?? 0,
  };
}

export function readCost(body: unknown): number {
  const cost = (body as { extensions?: { cost?: { actualQueryCost?: number; requestedQueryCost?: number } } })
    ?.extensions?.cost;
  return cost?.actualQueryCost ?? cost?.requestedQueryCost ?? 0;
}

export class JobberGraphQLError extends Error {
  constructor(public readonly errors: unknown[], message: string) {
    super(message);
    this.name = "JobberGraphQLError";
  }
}

export interface Page {
  nodes: Record<string, unknown>[];
  endCursor?: string | undefined;
  hasNextPage: boolean;
}

/** Pull `{ pageInfo, nodes }` out of whichever connection the query asked for. */
export function readPage(data: unknown, connectionName: string): Page {
  const connection = (data as Record<string, unknown> | undefined)?.[connectionName];
  if (!connection || typeof connection !== "object") {
    throw new Error(`Response carried no "${connectionName}" connection`);
  }
  const conn = connection as Record<string, unknown>;
  const info = (conn["pageInfo"] ?? {}) as Record<string, unknown>;
  return {
    nodes: map.nodes(conn).map((n) => n as Record<string, unknown>),
    endCursor: typeof info["endCursor"] === "string" ? info["endCursor"] : undefined,
    hasNextPage: info["hasNextPage"] === true,
  };
}

interface EntityPlan {
  entity: EntityName;
  connection: string;
  query: string;
}

/**
 * Extraction order.
 *
 * Users, then products, then clients and properties, then the documents that
 * reference them. It does not matter for correctness, because the load stage
 * resolves references from the whole snapshot. It matters a great deal for the
 * operator: when an extraction dies at 2am, the entities that were already
 * finished are the ones `profile` can report on, and a report that says "9,400
 * clients, no invoices yet" is far more use than a uniformly half-done pull.
 */
const PLAN: EntityPlan[] = [
  { entity: "user", connection: "users", query: Q.USERS },
  { entity: "priceBookItem", connection: "productsAndServices", query: Q.PRODUCTS },
  { entity: "customer", connection: "clients", query: Q.CLIENTS },
  { entity: "property", connection: "properties", query: Q.PROPERTIES },
  { entity: "estimate", connection: "quotes", query: Q.QUOTES },
  { entity: "job", connection: "jobs", query: Q.JOBS },
  { entity: "invoice", connection: "invoices", query: Q.INVOICES },
  { entity: "payment", connection: "paymentRecords", query: Q.PAYMENTS },
];

export const capabilities: SourceCapabilities = {
  entities: PLAN.map((p) => p.entity),
  hasApi: true,
  hasAttachments: false,
  recurrenceModel: "materialized-series",
  knownLimits: [
    "Recurring jobs arrive as materialized visits, not as a rule. The cadence has to be inferred from visit spacing and confirmed by a human during `map`.",
    "Attachments are not reachable through the public GraphQL schema, so photos and documents need a separate export requested from the account.",
    "Net payment terms are not exposed per client. Every customer lands as due-on-receipt unless the operator maps otherwise.",
    "Line item tax is a boolean, not a rate. Historical tax amounts come from the invoice totals rather than per line.",
    "Nested visit and line item pages are capped at 100. Jobs or invoices above that are flagged rather than truncated silently.",
  ],
};

export interface JobberClientOptions {
  endpoint?: string;
  retry?: RetryPolicy;
  /** Injectable purely so the adapter's paging can be tested without a network. */
  transport?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: unknown; text: string; headers: Record<string, string | string[] | undefined> }>;
  sleep?: (ms: number) => Promise<void>;
}

export class JobberClient {
  private throttle: ThrottleStatus | undefined;
  private lastCost = 0;

  constructor(private readonly token: string, private readonly options: JobberClientOptions = {}) {}

  get throttleStatus(): ThrottleStatus | undefined { return this.throttle; }

  async query<T = unknown>(document: string, variables: Record<string, unknown>): Promise<T> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = waitForBudget(this.throttle, this.lastCost);
    if (wait > 0) await sleep(wait);

    const send = this.options.transport ?? ((url, init) => fetchJson(url, init, this.options.retry ?? defaultRetry()));
    const response = await send(this.options.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": API_VERSION,
      },
      body: JSON.stringify({ query: document, variables }),
    });

    const body = response.body as { data?: T; errors?: unknown[] } | undefined;
    this.throttle = readThrottle(body) ?? this.throttle;
    this.lastCost = readCost(body) || this.lastCost;

    if (body?.errors && body.errors.length > 0) {
      const first = body.errors[0] as { message?: string } | undefined;
      throw new JobberGraphQLError(body.errors, first?.message ?? "Jobber returned GraphQL errors");
    }
    if (response.status >= 400 || body?.data === undefined) {
      throw new Error(`Jobber returned HTTP ${response.status} with no data`);
    }
    return body.data;
  }
}

/** See the note on `createHousecallProAdapter`: injectable for the same reason. */
export function createJobberAdapter(options: JobberClientOptions = {}): SourceAdapter {
  return {
  id: "jobber",
  displayName: "Jobber",
  capabilities,

  async verify(credentials) {
    const token = credentials["token"] ?? credentials["accessToken"];
    if (!token) return { ok: false, error: "No access token. Pass JOBBER_TOKEN or --token." };
    try {
      const client = new JobberClient(token, options);
      const data = await client.query<{ account?: { name?: string } }>(Q.ACCOUNT, {});
      return { ok: true, account: data.account?.name ?? "unknown account" };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },

  async *extract(credentials, ctx: ExtractContext) {
    const token = credentials["token"] ?? credentials["accessToken"] ?? "";
    const client = new JobberClient(token, options);

    for (const plan of PLAN) {
      let after = await ctx.resume(plan.entity);
      let count = 0;

      for (;;) {
        const data = await client.query<Record<string, unknown>>(plan.query, {
          first: Q.PAGE_SIZE,
          after: after ?? null,
        });
        const page = readPage(data, plan.connection);
        if (page.nodes.length > 0) {
          await ctx.append(plan.entity, page.nodes);
          count += page.nodes.length;
        }
        flagTruncation(ctx, plan.entity, page.nodes);

        yield { entity: plan.entity, count, done: !page.hasNextPage };

        if (!page.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
        await ctx.checkpoint(plan.entity, after);
      }
    }
  },

  toCanonical(entity, raw) {
    const value = raw as Record<string, unknown>;
    switch (entity) {
      case "customer": return map.toCustomer(value);
      case "property": return map.toProperty(value);
      case "job": return map.toJob(value);
      case "invoice": return map.toInvoice(value);
      case "payment": return map.toPayment(value);
      default:
        throw new Error(`Jobber adapter has no canonical mapping for "${entity}" yet`);
    }
  },
  };
}

export const jobber: SourceAdapter = createJobberAdapter();

/**
 * A nested connection that says it has another page is silent data loss: the
 * job imports, it looks right, and visits 101 through 260 of a five-year
 * maintenance agreement are simply gone. Flagging it puts the job on the
 * profile report where a human decides, rather than discovering it a year in.
 */
function flagTruncation(ctx: ExtractContext, entity: EntityName, nodes: Record<string, unknown>[]): void {
  for (const node of nodes) {
    for (const key of ["visits", "lineItems"]) {
      const nested = node[key] as { pageInfo?: { hasNextPage?: boolean } } | undefined;
      if (nested?.pageInfo?.hasNextPage === true) {
        ctx.log(`truncated: ${entity} ${String(node["id"])} has more than 100 ${key}`);
      }
    }
  }
}

