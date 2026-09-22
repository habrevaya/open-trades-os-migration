import type { EntityName } from "../../canonical/index.js";
import type { ExtractContext, SourceAdapter, SourceCapabilities } from "../types.js";
import { fetchJson, defaultRetry, type RetryPolicy } from "../http.js";
import * as map from "./map.js";

const BASE = "https://api.housecallpro.com";
const PAGE_SIZE = 100;

/**
 * Paging here is page-number based, not cursor based, and that is a real
 * hazard rather than a stylistic difference.
 *
 * If a record is created while the extraction is running, everything after it
 * shifts by one and page 7 skips a record that page 6 already moved past. The
 * adapter cannot prevent that, so it detects it: ids are tracked across pages
 * and a repeat is reported. A migration run against a live account will always
 * have some drift, and the operator needs to know how much rather than being
 * told everything was fine.
 */
interface ListPlan {
  entity: EntityName;
  path: string;
  /** The array's key in the response envelope. */
  collection: string;
}

const PLAN: ListPlan[] = [
  { entity: "user", path: "/employees", collection: "employees" },
  { entity: "customer", path: "/customers", collection: "customers" },
  { entity: "estimate", path: "/estimates", collection: "estimates" },
  { entity: "job", path: "/jobs", collection: "jobs" },
  { entity: "invoice", path: "/invoices", collection: "invoices" },
];

export const capabilities: SourceCapabilities = {
  entities: [...PLAN.map((p) => p.entity), "property"],
  hasApi: true,
  hasAttachments: false,
  recurrenceModel: "materialized-series",
  // Properties have no file of their own: they are read back out of the
  // customer records, which is where Housecall Pro keeps them.
  derivedFrom: { property: "customer" },
  knownLimits: [
    "Properties are not separate records. They are addresses on the customer, so property ids are derived and the derivation must stay stable across runs.",
    "A job is one scheduled block. Multi-visit work has no representation, so each job produces exactly one visit.",
    "Amounts are integer cents throughout, unlike most other sources in this toolkit.",
    "Paging is by page number. Records created mid-run shift the pages, so duplicates and skips are detected and reported rather than prevented.",
    "Payments are not consistently exposed as their own collection. Where they are absent, receivables are reconstructed from invoice balances and flagged for review.",
  ],
};

export interface PageEnvelope {
  records: Record<string, unknown>[];
  page: number;
  totalPages: number;
}

/** Read whichever envelope shape the endpoint returned. Both are in the wild. */
export function readEnvelope(body: unknown, collection: string): PageEnvelope {
  const envelope = (body ?? {}) as Record<string, unknown>;
  const raw = envelope[collection] ?? envelope["data"];
  const records = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const page = Number(envelope["page"] ?? 1);
  const totalPages = Number(
    envelope["total_pages"] ??
      (Number(envelope["total_items"] ?? records.length) > 0
        ? Math.ceil(Number(envelope["total_items"]) / Math.max(1, Number(envelope["page_size"] ?? PAGE_SIZE)))
        : 1),
  );
  return {
    records,
    page: Number.isFinite(page) ? page : 1,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1,
  };
}

export interface HousecallProOptions {
  baseUrl?: string;
  retry?: RetryPolicy;
  transport?: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; body: unknown; text: string; headers: Record<string, string | string[] | undefined> }>;
}

export class HousecallProClient {
  constructor(private readonly key: string, private readonly options: HousecallProOptions = {}) {}

  async list(path: string, page: number): Promise<unknown> {
    const url = `${this.options.baseUrl ?? BASE}${path}?page=${page}&page_size=${PAGE_SIZE}`;
    const send = this.options.transport ?? ((u, init) => fetchJson(u, init, this.options.retry ?? defaultRetry()));
    const response = await send(url, {
      method: "GET",
      headers: {
        // Housecall Pro accepts both a personal API key and an OAuth bearer
        // token, and they use different schemes. Guessing from the shape of
        // the credential is friendlier than making the operator remember.
        authorization: this.key.startsWith("Bearer ") || this.key.includes(".")
          ? `Bearer ${this.key.replace(/^Bearer /, "")}`
          : `Token ${this.key}`,
        accept: "application/json",
      },
    });
    if (response.status >= 400) {
      throw new Error(`Housecall Pro returned HTTP ${response.status} for ${path}`);
    }
    return response.body;
  }
}

/**
 * The adapter takes its client options, rather than constructing a hardwired
 * client, so the paging and drift detection can be exercised against scripted
 * pages. A test that has to reach in and replace a method on a prototype is
 * telling you the thing under test is not built to be verified, and the parts
 * of this toolkit that most need verifying are exactly the ones that talk to
 * somebody else's API.
 */
export function createHousecallProAdapter(options: HousecallProOptions = {}): SourceAdapter {
  return {
  id: "housecall-pro",
  displayName: "Housecall Pro",
  capabilities,

  async verify(credentials) {
    const key = credentials["key"] ?? credentials["token"] ?? credentials["apiKey"];
    if (!key) return { ok: false, error: "No API key. Pass HOUSECALL_PRO_KEY or --key." };
    try {
      const body = await new HousecallProClient(key, options).list("/company", 1);
      const company = (body as { company?: { name?: string }; name?: string } | undefined);
      return { ok: true, account: company?.company?.name ?? company?.name ?? "unknown account" };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },

  async *extract(credentials, ctx: ExtractContext) {
    const key = credentials["key"] ?? credentials["token"] ?? credentials["apiKey"] ?? "";
    const client = new HousecallProClient(key, options);

    for (const plan of PLAN) {
      const resumed = await ctx.resume(plan.entity);
      let page = resumed ? Number(resumed) : 1;
      if (!Number.isFinite(page) || page < 1) page = 1;
      let count = 0;
      const seen = new Set<string>();
      let drift = 0;

      for (;;) {
        const envelope = readEnvelope(await client.list(plan.path, page), plan.collection);

        const fresh: Record<string, unknown>[] = [];
        for (const rec of envelope.records) {
          const id = String(rec["id"] ?? "");
          if (id !== "" && seen.has(id)) { drift += 1; continue; }
          if (id !== "") seen.add(id);
          fresh.push(rec);
        }

        if (fresh.length > 0) {
          await ctx.append(plan.entity, fresh);
          count += fresh.length;
        }

        yield { entity: plan.entity, count, done: page >= envelope.totalPages || envelope.records.length === 0 };

        if (page >= envelope.totalPages || envelope.records.length === 0) break;
        page += 1;
        await ctx.checkpoint(plan.entity, String(page));
      }

      if (drift > 0) {
        ctx.log(
          `${plan.entity}: ${drift} record(s) appeared on more than one page. The account was being ` +
            `edited during extraction, so some records may also have been skipped. Re-run extract ` +
            `for this entity outside business hours before loading.`,
        );
      }
    }
  },

  toCanonical(entity, raw) {
    const value = raw as Record<string, unknown>;
    switch (entity) {
      case "customer": return map.toCustomer(value);
      // A customer record yields several properties, so this returns an array
      // where the others return one record. The transform stage flattens it.
      case "property": return map.toProperties(value);
      case "job": return map.toJob(value);
      case "invoice": return map.toInvoice(value);
      case "payment": return map.toPayment(value);
      default:
        throw new Error(`Housecall Pro adapter has no canonical mapping for "${entity}" yet`);
    }
  },
  };
}

export const housecallPro: SourceAdapter = createHousecallProAdapter();
