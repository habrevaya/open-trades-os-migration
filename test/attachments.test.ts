import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Snapshot } from "../src/snapshot/index.js";
import { csv } from "../src/adapters/csv/index.js";
import { fetchAttachments, uploadAttachments, download, safeSegment } from "../src/attachments/index.js";
import { HttpTarget } from "../src/target/client.js";
import { MemoryTarget } from "../src/target/memory.js";
import { startFakeTarget, TOKEN } from "./fake-target.js";
import { Ledger } from "../src/load/ledger.js";
import { buildMapping, writeMapping, readMapping } from "../src/mapping/index.js";
import { jobber } from "../src/adapters/jobber/index.js";
import { load } from "./fixtures.js";
import type { RetryPolicy } from "../src/adapters/http.js";

let dir: string;
let server: Server | undefined;
let hits: string[];
let flaky: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "att-"));
  hits = [];
  flaky = 0;
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const PHOTO = Buffer.from("not really a jpeg, but bytes are bytes");

async function files(): Promise<string> {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/expired.pdf") { res.writeHead(403); return res.end("expired"); }
    if (req.url === "/moved.jpg") { res.writeHead(302, { location: "/photo.jpg" }); return res.end(); }
    if (req.url === "/busy.jpg" && flaky > 0) { flaky -= 1; res.writeHead(429, { "retry-after": "0" }); return res.end(); }
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(PHOTO);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const quiet: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} };

async function snapshotWith(rows: string): Promise<Snapshot> {
  const from = join(dir, "export");
  await mkdir(from, { recursive: true });
  await writeFile(join(from, "customers.csv"), "id,name\nC-1,Ada\n");
  await writeFile(join(from, "attachments.csv"), `id,entity_type,entity_id,file_name,url,path\n${rows}\n`);
  const snapshot = await Snapshot.open(join(dir, "snapshot"), "csv");
  for await (const p of csv.extract({ dir: from }, snapshot)) if (p.done) await snapshot.complete(p.entity);
  await snapshot.flush();
  return snapshot;
}

describe("attachments", () => {
  it("downloads, hashes and indexes each file against the record load made", async () => {
    const base = await files();
    const snapshot = await snapshotWith([
      `A-1,customer,C-1,photo.jpg,${base}/photo.jpg,`,
      `A-2,customer,C-1,moved.jpg,${base}/moved.jpg,`,
      `A-3,customer,C-1,../../escape.pdf,${base}/expired.pdf,`,
    ].join("\n"));
    const ledger = Ledger.memory("t", "csv");
    const target = randomUUID();
    await ledger.record({ key: "customer:C-1", target });

    const report = await fetchAttachments(snapshot, csv, { ledger, retry: quiet });
    expect(report).toMatchObject({ downloaded: 2, already: 0 });
    // An expired signed URL is a 403, and retrying does not un-expire it.
    expect(report.failed).toEqual([{ sourceId: "A-3", reason: "HTTP 403" }]);
    expect(hits.filter((h) => h === "/expired.pdf")).toHaveLength(1);

    const index = (await readFile(join(report.dir, "index.ndjson"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(index[0]).toMatchObject({
      sourceId: "A-1", targetEntityId: target, bytes: PHOTO.length,
      sha256: createHash("sha256").update(PHOTO).digest("hex"),
    });
    expect(await readFile(String(index[0]!["path"]))).toEqual(PHOTO);
  });

  it("resumes without fetching anything twice", async () => {
    const base = await files();
    const snapshot = await snapshotWith(`A-1,customer,C-1,photo.jpg,${base}/photo.jpg,`);
    await fetchAttachments(snapshot, csv, { retry: quiet });
    const again = await fetchAttachments(snapshot, csv, { retry: quiet });
    expect(again).toMatchObject({ downloaded: 0, already: 1 });
    expect(hits).toEqual(["/photo.jpg"]);
  });

  it("waits out a 429 and copies local files", async () => {
    const base = await files();
    flaky = 2;
    await mkdir(join(dir, "export", "photos"), { recursive: true });
    await writeFile(join(dir, "export", "photos", "a.jpg"), PHOTO);
    const snapshot = await snapshotWith([
      `A-1,customer,C-1,busy.jpg,${base}/busy.jpg,`,
      `A-2,customer,C-1,a.jpg,,photos/a.jpg`,
    ].join("\n"));
    const report = await fetchAttachments(snapshot, csv, { retry: quiet });
    expect(report).toMatchObject({ downloaded: 2, failed: [] });
    expect(hits.filter((h) => h === "/busy.jpg")).toHaveLength(3);
  });

  it("never lets a file name climb out of its folder", () => {
    const escaped = safeSegment("../../etc/passwd");
    expect(escaped).not.toContain("/");
    expect(escaped.startsWith(".")).toBe(false);
    expect(safeSegment("..")).toBe("_");
    expect(safeSegment("")).toBe("_");
  });

  it("leaves no half-written file behind when a download fails", async () => {
    const base = await files();
    const path = join(dir, "x.pdf");
    await expect(download(`${base}/expired.pdf`, path, quiet)).rejects.toThrow("HTTP 403");
    await expect(readFile(`${path}.part`)).rejects.toThrow();
    await expect(readFile(path)).rejects.toThrow();
  });
});

describe("attaching them in OpenTradesOS", () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a photograph of a furnace")]);

  it("attaches each file to the record load made, once, and says what the target will not store", async () => {
    await mkdir(join(dir, "export", "files"), { recursive: true });
    await writeFile(join(dir, "export", "files", "furnace.jpg"), JPEG);
    await writeFile(join(dir, "export", "files", "notes.docx"), "PK not a pdf");
    const snapshot = await snapshotWith([
      "A-1,customer,C-1,furnace.jpg,,files/furnace.jpg",
      "A-2,customer,C-1,notes.docx,,files/notes.docx",
      "A-3,customer,C-9,furnace.jpg,,files/furnace.jpg",
    ].join("\n"));
    const report = await fetchAttachments(snapshot, csv, { retry: quiet });
    expect(report.downloaded).toBe(3);

    const memory = new MemoryTarget();
    const fake = await startFakeTarget(memory);
    try {
      const customer = await memory.call("createCustomer", { name: "Ada" });
      const ledger = Ledger.memory("t", "csv");
      await ledger.record({ key: "customer:C-1", target: customer.id });
      const target = new HttpTarget(fake.url, TOKEN);

      const first = await uploadAttachments(report.dir, target, ledger);
      expect(first).toMatchObject({ uploaded: 1, already: 0, failed: [] });
      expect(first.unattachable).toEqual([{ sourceId: "A-2", reason: "notes.docx is not an image or a PDF by its first bytes" }]);
      expect(first.notLoaded).toEqual([{ sourceId: "A-3", reason: "customer C-9 is not in the target" }]);
      const [attached] = [...memory.attachments.values()];
      expect(attached).toMatchObject({ entityType: "customer", entityId: customer.id, fileName: "furnace.jpg", contentType: "image/jpeg", kind: "photo" });
      expect(fake.log.find((r) => r.path === "/api/v1/attachments")?.idempotencyKey).toMatch(/^otsm-/);

      const second = await uploadAttachments(report.dir, target, ledger);
      expect(second).toMatchObject({ uploaded: 0, already: 1 });
      expect(memory.attachments.size).toBe(1);
    } finally {
      await fake.close();
    }
  });
});

describe("the mapping file", () => {
  it("adds what is new and never changes what the operator decided", async () => {
    const snapshot = await Snapshot.open(join(dir, "jobber"), "jobber");
    await snapshot.append("user", load("jobber", "users"));
    await snapshot.append("job", load("jobber", "jobs"));
    await snapshot.flush();

    const first = await buildMapping(snapshot, jobber);
    expect(first.mapping.users["u-1"]).toEqual({ name: "Ray Ortiz", email: "ray@example.com", target: null });
    expect(first.mapping.jobStatus).toEqual({ active: "scheduled", archived: "completed" });
    expect(first.unmappedUsers).toEqual(["u-1", "u-2"]);

    const ray = randomUUID();
    first.mapping.users["u-1"]!.target = ray;
    first.mapping.jobStatus["archived"] = "cancelled";
    const path = join(dir, "mapping.json");
    await writeMapping(path, first.mapping);

    await snapshot.append("payment", load("jobber", "payments"));
    await snapshot.flush();
    const second = await buildMapping(snapshot, jobber, await readMapping(path));
    expect(second.mapping.users["u-1"]!.target).toBe(ray);
    expect(second.mapping.jobStatus["archived"]).toBe("cancelled");
    expect(second.mapping.paymentMethods).toEqual({ credit_card: "card", check: "check" });
    expect(second.added).toEqual(expect.arrayContaining(["paymentMethods.credit_card", "paymentStatus.completed"]));
    expect(second.unmappedUsers).toEqual(["u-2"]);
  });
});
