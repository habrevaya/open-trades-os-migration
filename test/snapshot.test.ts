import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshot } from "../src/snapshot/index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "snap-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const drain = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
};

describe("the snapshot", () => {
  it("round trips records", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    await snapshot.append("customer", [{ id: "1" }, { id: "2" }]);
    await snapshot.flush();

    const reopened = await Snapshot.read(dir);
    expect(await drain(reopened.records("customer"))).toEqual([{ id: "1" }, { id: "2" }]);
    expect(reopened.info.counts.customer).toBe(2);
  });

  it("appends across two runs rather than overwriting", async () => {
    const first = await Snapshot.open(dir, "jobber");
    await first.append("customer", [{ id: "1" }]);
    await first.flush();

    const second = await Snapshot.open(dir, "jobber");
    await second.append("customer", [{ id: "2" }]);
    await second.flush();

    expect(await drain(second.records("customer"))).toHaveLength(2);
  });

  it("refuses to mix two sources in one directory", async () => {
    // Source ids collide across systems, so a mixed snapshot would silently
    // merge two unrelated customers into one during the load.
    await (await Snapshot.open(dir, "jobber")).flush();
    await expect(Snapshot.open(dir, "housecall-pro")).rejects.toThrow(/jobber/);
  });

  it("survives the truncated last line a killed run leaves behind", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    await snapshot.append("customer", [{ id: "1" }, { id: "2" }]);
    // The shape of a process killed mid-write.
    await appendFile(join(dir, "customer.ndjson"), '{"id":"3","na', "utf8");

    const records = await drain(snapshot.records("customer"));
    expect(records).toEqual([{ id: "1" }, { id: "2" }]);
    expect(snapshot.info.warnings.join(" ")).toMatch(/line 3/);
  });

  it("returns nothing for an entity that was never extracted", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    expect(await drain(snapshot.records("invoice"))).toEqual([]);
  });

  it("remembers checkpoints so a killed run resumes", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    await snapshot.checkpoint("job", "cursor-40");

    const reopened = await Snapshot.open(dir, "jobber");
    expect(await reopened.resume("job")).toBe("cursor-40");
    expect(await reopened.resume("invoice")).toBeUndefined();
  });

  it("marks an entity complete so a resume skips it", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    await snapshot.complete("customer");
    expect((await Snapshot.open(dir, "jobber")).isComplete("customer")).toBe(true);
  });

  it("does not repeat the same warning", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    snapshot.warn("same");
    snapshot.warn("same");
    expect(snapshot.info.warnings).toEqual(["same"]);
  });

  it("writes a manifest a human can read without our software", async () => {
    const snapshot = await Snapshot.open(dir, "jobber");
    await snapshot.append("customer", [{ id: "1" }]);
    await snapshot.flush();
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    expect(manifest.source).toBe("jobber");
    expect(manifest.counts.customer).toBe(1);
  });

  it("ignores blank lines", async () => {
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, source: "jobber", startedAt: "", updatedAt: "", counts: {}, checkpoints: {}, completed: [], warnings: [] }), "utf8");
    await writeFile(join(dir, "customer.ndjson"), '{"id":"1"}\n\n{"id":"2"}\n', "utf8");
    const snapshot = await Snapshot.read(dir);
    expect(await drain(snapshot.records("customer"))).toHaveLength(2);
  });
});
