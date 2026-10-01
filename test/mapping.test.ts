import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshot } from "../src/snapshot/index.js";
import { jobber } from "../src/adapters/jobber/index.js";
import { buildMapping, proposeFromTarget } from "../src/mapping/index.js";
import { HttpTarget } from "../src/target/client.js";
import { MemoryTarget } from "../src/target/memory.js";
import type { EntityName } from "../src/canonical/index.js";
import { load as fixture } from "./fixtures.js";
import { startFakeTarget, TOKEN, type FakeTarget } from "./fake-target.js";

let dir: string;
let fake: FakeTarget | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "map-")); });
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function jobberMapping() {
  const snapshot = await Snapshot.open(join(dir, "snapshot"), "jobber");
  for (const [entity, file] of [["user", "users"], ["job", "jobs"]] as [EntityName, string][]) {
    await snapshot.append(entity, fixture("jobber", file));
  }
  await snapshot.flush();
  return (await buildMapping(snapshot, jobber)).mapping;
}

describe("map --target", () => {
  it("proposes technicians by email, then by name, and job types by name or code, over HTTP", async () => {
    const memory = new MemoryTarget();
    const ray = memory.addPerson({ name: "Raymond Ortiz", email: "RAY@example.com" });
    // Nia left; her account is still there, under a different email.
    const nia = memory.addPerson({ name: "Nia Osei", email: "nia.osei@old.example.com", active: false });
    memory.addPerson({ name: "Office", email: "office@example.com", technician: false });
    const recurring = memory.addJobType("Recurring maintenance", "RECURRING");
    fake = await startFakeTarget(memory);

    const mapping = await jobberMapping();
    const { mapping: proposed, proposed: made, people, jobTypes } = await proposeFromTarget(mapping, new HttpTarget(fake.url, TOKEN));

    expect(people).toBe(2);
    expect(jobTypes).toBe(1);
    expect(proposed.users["u-1"]?.target).toBe(ray);
    expect(proposed.users["u-2"]?.target).toBe(nia);
    expect(proposed.jobTypes).toEqual({ RECURRING: recurring, ONE_OFF: null });
    expect(proposed.proposed).toEqual({ users: { "u-1": "email", "u-2": "name" }, jobTypes: { RECURRING: "code" } });
    expect(made.map((p) => p.key)).toEqual(["users.u-1", "users.u-2", "jobTypes.RECURRING"]);
  });

  it("never replaces a value a person set, and leaves a match it cannot settle to them", async () => {
    const memory = new MemoryTarget();
    memory.addPerson({ name: "Nia Osei", email: "nia1@example.com" });
    memory.addPerson({ name: "Nia Osei", email: "nia2@example.com" });
    memory.addPerson({ name: "Ray Ortiz", email: "ray@example.com" });

    const mapping = await jobberMapping();
    mapping.users["u-1"]!.target = "8a1e3f8e-5f47-4c55-9d2a-111111111111";
    const result = await proposeFromTarget(mapping, memory);
    expect(result.mapping.users["u-1"]!.target).toBe("8a1e3f8e-5f47-4c55-9d2a-111111111111");
    expect(result.mapping.users["u-2"]!.target).toBeNull();
    expect(result.ambiguous).toEqual(["users.u-2"]);
  });
});
