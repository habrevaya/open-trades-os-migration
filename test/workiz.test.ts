import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshot } from "../src/snapshot/index.js";
import { transform, MemorySink } from "../src/transform/index.js";
import * as map from "../src/adapters/workiz/map.js";
import { workiz, createWorkizAdapter, detectPaging, readJobPage, PAGE_SIZE } from "../src/adapters/workiz/index.js";
import { wallClock } from "../src/adapters/time.js";
import * as money from "../src/money/index.js";
import { load } from "./fixtures.js";
import { mockHttp, instantRetry, memoryContext, drain, type Mocked } from "./mock-http.js";

const jobs = load("workiz", "jobs");
const team = load("workiz", "team");
const byUuid = (id: string) => {
  const found = jobs.find((j) => j["UUID"] === id);
  if (!found) throw new Error(id);
  return found;
};

describe("money", () => {
  it("reads dollar strings exactly", () => {
    expect(map.toJob(byUuid("WZJ7Q1")).total).toBe("344.2400");
    expect(map.toInvoices(byUuid("WZJ7Q2"))[0]).toMatchObject({ total: "185.1000", balance: "185.1000" });
  });

  it("reads a JSON number without picking up binary noise", () => {
    // 0.3 as a double is 0.299999999999999988898. Read through a float it
    // reconciles as a fraction of a cent short, forever.
    const invoice = map.toInvoices(byUuid("WZJ7Q4"))[0]!;
    expect(invoice.total).toBe("1234.5600");
    expect(invoice.balance).toBe("0.3000");
  });

  it("sums the open balance to the cent across jobs", () => {
    const balances = jobs.flatMap((j) => map.toInvoices(j)).map((i) => i.balance);
    expect(money.sum(balances)).toBe("185.4000");
  });

  it("does not split tax out of a total whose parts the schema does not define", () => {
    const invoice = map.toInvoices(byUuid("WZJ7Q1"))[0]!;
    expect(invoice).toMatchObject({ subtotal: "344.2400", taxTotal: "0.0000", total: "344.2400", lines: [] });
    expect(workiz.capabilities.unsupported?.map((u) => u.field)).toContain("job.SubTotal");
  });

  it("makes no invoice for a job with no money on it", () => {
    expect(map.toInvoices(byUuid("WZJ7Q3"))).toEqual([]);
  });
});

describe("splitting a job into customer, property and job", () => {
  it("takes the customer from the job's client fields", () => {
    expect(map.toCustomer(byUuid("WZJ7Q1"))).toMatchObject({
      sourceId: "1002", name: "Dana Whitfield", email: "dana.w@example.com", phone: "5125550192", type: "residential",
      customFields: { "Second phone": "5125550193" },
    });
  });

  it("treats a job with a company as a commercial client and keeps the person and extension", () => {
    expect(map.toCustomer(byUuid("WZJ7Q3"))).toMatchObject({
      name: "Brazos Property Group", type: "commercial", phone: "5125550110 x204",
      customFields: { "Contact name": "Marisol Vega" },
    });
  });

  it("derives the same property id for the same address however it was typed", () => {
    expect(map.propertyId(byUuid("WZJ7Q4"))).toBe(map.propertyId(byUuid("WZJ7Q1")));
    expect(map.propertyId(byUuid("WZJ7Q2"))).not.toBe(map.propertyId(byUuid("WZJ7Q1")));
  });

  it("reads a numeric unit as text", () => {
    expect(map.toProperty(byUuid("WZJ7Q3")).addressLine2).toBe("12");
  });

  it("names the job's property and customer, with one visit and its team", () => {
    const j = map.toJob(byUuid("WZJ7Q2"));
    expect(j.customerSourceId).toBe("1002");
    expect(j.propertySourceId).toBe(map.toProperty(byUuid("WZJ7Q2")).sourceId);
    expect(j.visits).toHaveLength(1);
    expect(j.visits[0]!.technicianSourceIds).toEqual(["35355", "35401"]);
    expect(j.completedAt).toBeUndefined();
  });

  it("refuses a job that names no client rather than inventing one", () => {
    expect(() => map.toJob({ UUID: "x", ClientId: 0 })).toThrow(/no client/);
  });

  it("reads team members", () => {
    expect(map.toUser(team[1]!)).toMatchObject({ sourceId: "35360", name: "Office Admin", role: "admin", active: true });
  });
});

describe("times", () => {
  it("converts a wall-clock time using the job's own time zone, across daylight saving", () => {
    // March 14 is after the US change: Central is UTC-5. January is UTC-6.
    expect(map.toJob(byUuid("WZJ7Q1")).visits[0]!.windowStart).toBe("2024-03-14T14:00:00.000Z");
    expect(map.toJob(byUuid("WZJ7Q2")).visits[0]!.windowStart).toBe("2024-01-09T20:30:00.000Z");
  });

  it("keeps a time with no zone as an unqualified local time rather than calling it UTC", () => {
    expect(map.toJob(byUuid("WZJ7Q4")).visits[0]!.windowStart).toBe("2023-11-02T10:00:00");
  });

  it("refuses an unknown zone", () => {
    expect(() => wallClock("2024-01-01 10:00:00", "Mars/Olympus")).toThrow(/Unknown time zone/);
  });
});

describe("paging", () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ UUID: `j${from + i}` }));

  it("recognises offset as a record offset", () => {
    expect(detectPaging(page(0, 100), page(1, 100))).toBe("record");
  });

  it("recognises offset as a page number", () => {
    expect(detectPaging(page(0, 100), page(100, 100))).toBe("page");
  });

  it("stops rather than guessing when the two pages half overlap", () => {
    expect(() => detectPaging(page(0, 100), page(50, 100))).toThrow(/Cannot tell how Workiz pages/);
  });

  it("reads both envelopes", () => {
    expect(readJobPage({ flag: true, has_more: false, data: [{ UUID: "a" }] })).toEqual({ records: [{ UUID: "a" }], hasMore: false });
    expect(readJobPage([{ flag: true, data: { UUID: "a" } }])).toEqual({ records: [{ UUID: "a" }], hasMore: false });
  });
});

describe("extraction over HTTP", () => {
  let http: Mocked;
  beforeEach(() => { http = mockHttp(); });
  afterEach(async () => { await http.restore(); });

  const TOKEN = "api_tok_9f8e7d6c5b4a";
  const origin = "https://api.workiz.com";

  /** Serve `total` jobs, paging the way `mode` says Workiz does. */
  function serveJobs(total: number, mode: "record" | "page", seen: string[] = []) {
    const all = Array.from({ length: total }, (_, i) => ({
      ...byUuid("WZJ7Q1"), UUID: `J${String(i).padStart(4, "0")}`, ClientId: 2000 + (i % 7), Address: `${i % 3} Elm St`,
    }));
    http.agent.get(origin).intercept({ path: (p) => p.startsWith(`/api/v1/${TOKEN}/job/all/`), method: "GET" })
      .reply((opts) => {
        const url = new URL(String(opts.path), origin);
        seen.push(url.search);
        const offset = Number(url.searchParams.get("offset"));
        const size = Number(url.searchParams.get("records"));
        const start = mode === "record" ? offset : offset * size;
        const data = all.slice(start, start + size);
        return { statusCode: 200, data: { flag: true, has_more: start + size < total, data } };
      }).persist();
    http.agent.get(origin).intercept({ path: `/api/v1/${TOKEN}/team/all/`, method: "GET" })
      .reply(200, { flag: true, data: team }).persist();
    return all;
  }

  for (const mode of ["record", "page"] as const) {
    it(`reads every job exactly once when offset is a ${mode} offset`, async () => {
      const all = serveJobs(230, mode);
      const m = memoryContext();
      await drain(createWorkizAdapter({ retry: instantRetry() }).extract({ token: TOKEN }, m.ctx));
      const ids = (m.files.get("job") as { UUID: string }[]).map((j) => j.UUID);
      expect(ids).toHaveLength(230);
      expect(new Set(ids).size).toBe(230);
      expect(ids).toEqual(all.map((j) => j.UUID));
      // Seven clients across three addresses each: written once apiece.
      expect(m.files.get("customer")).toHaveLength(7);
      expect(m.files.get("property")!.length).toBe(new Set(all.map((j) => map.propertyId(j))).size);
      expect(m.checkpoints["job"]).toBe("done");
    });
  }

  it("asks for everything since the start date, closed jobs included", async () => {
    const seen: string[] = [];
    serveJobs(5, "record", seen);
    const m = memoryContext();
    await drain(createWorkizAdapter({ retry: instantRetry() }).extract({ token: TOKEN }, m.ctx));
    const q = new URLSearchParams(seen[0]);
    expect(q.get("start_date")).toBe("2000-01-01");
    expect(q.get("only_open")).toBe("false");
    expect(q.get("records")).toBe(String(PAGE_SIZE));
  });

  it("resumes from the checkpointed offset", async () => {
    const seen: string[] = [];
    serveJobs(230, "record", seen);
    const m = memoryContext({ user: "done", job: "record:200" });
    await drain(createWorkizAdapter({ retry: instantRetry() }).extract({ token: TOKEN }, m.ctx));
    expect(seen.map((s) => new URLSearchParams(s).get("offset"))).toEqual(["200"]);
    expect(m.files.get("job")).toHaveLength(30);
  });

  it("waits out a rate limit for as long as Retry-After says", async () => {
    const retry = instantRetry();
    const pool = http.agent.get(origin);
    pool.intercept({ path: `/api/v1/${TOKEN}/team/all/`, method: "GET" })
      .reply(429, "Too many requests", { headers: { "retry-after": "7" } });
    pool.intercept({ path: `/api/v1/${TOKEN}/team/all/`, method: "GET" }).reply(200, { flag: true, data: team });
    pool.intercept({ path: (p) => p.startsWith(`/api/v1/${TOKEN}/job/all/`), method: "GET" })
      .reply(200, { flag: true, has_more: false, data: [byUuid("WZJ7Q1")] });
    const m = memoryContext();
    await drain(createWorkizAdapter({ retry }).extract({ token: TOKEN }, m.ctx));
    expect(retry.waits).toEqual([{ delayMs: 7000, reason: "HTTP 429" }]);
    expect(m.files.get("user")).toHaveLength(2);
  });

  it("never puts the token, which lives in the URL, into an error", async () => {
    http.agent.get(origin).intercept({ path: `/api/v1/${TOKEN}/team/all/`, method: "GET" })
      .reply(503, `upstream failed for /api/v1/${TOKEN}/team/all/`).persist();
    const result = await createWorkizAdapter({ retry: instantRetry() }).verify({ token: TOKEN });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 503/);
    expect(result.error).not.toContain(TOKEN);
  });

  it("says the token was refused, without repeating it", async () => {
    http.agent.get(origin).intercept({ path: `/api/v1/${TOKEN}/team/all/`, method: "GET" })
      .reply(401, { flag: false, msg: `bad token ${TOKEN}` });
    const result = await createWorkizAdapter({ retry: instantRetry() }).verify({ token: TOKEN });
    expect(result).toEqual({ ok: false, error: "Workiz refused the API token (HTTP 401). Check WORKIZ_TOKEN." });
  });

  it("treats flag: false as the error it is, not as an empty page", async () => {
    http.agent.get(origin).intercept({ path: `/api/v1/${TOKEN}/team/all/`, method: "GET" })
      .reply(200, { flag: false, msg: "Account suspended" });
    const result = await createWorkizAdapter({ retry: instantRetry() }).verify({ token: TOKEN });
    expect(result.error).toMatch(/Account suspended/);
  });
});

describe("through a real snapshot", () => {
  let http: Mocked;
  let dir: string;
  beforeEach(async () => { http = mockHttp(); dir = await mkdtemp(join(tmpdir(), "workiz-")); });
  afterEach(async () => { await http.restore(); await rm(dir, { recursive: true, force: true }); });

  it("profiles clean: every job's customer and property is in the snapshot, once", async () => {
    const pool = http.agent.get("https://api.workiz.com");
    pool.intercept({ path: "/api/v1/t/team/all/", method: "GET" }).reply(200, { flag: true, data: team });
    pool.intercept({ path: (p) => p.startsWith("/api/v1/t/job/all/"), method: "GET" })
      .reply(200, { flag: true, has_more: false, data: jobs });

    const snapshot = await Snapshot.open(dir, "workiz");
    await drain(createWorkizAdapter({ retry: instantRetry() }).extract({ token: "t" }, snapshot));
    await snapshot.flush();

    const sink = new MemorySink();
    const result = await transform(snapshot, workiz, sink);
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({ user: 2, customer: 2, property: 3, job: 4, invoice: 3 });
    expect(result.profile.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.profile.totals.invoiceTotal).toBe("1763.9000");
    expect(result.profile.totals.invoiceBalance).toBe("185.4000");
    // The newest job's copy of the client wins.
    expect(sink.get("customer").find((c) => c["sourceId"] === "1002")!["sourcePayload"]).toMatchObject({ UUID: "WZJ7Q1" });
  });
});
