import type { EntityName } from "../canonical/index.js";
import { ENTITY_ORDER } from "../canonical/index.js";
import type { SourceAdapter } from "../adapters/types.js";
import type { Snapshot } from "../snapshot/index.js";
import { Profiler, type ProfileReport } from "../profile/index.js";

/**
 * TRANSFORM
 *
 * The bridge between an adapter's snapshot and anything that consumes
 * canonical records. It does three jobs and deliberately no more.
 *
 * It fans out, because some sources hold several canonical records in one raw
 * record. A Housecall Pro customer carries its addresses inline, so reading
 * the customer file yields customers AND properties. An adapter that returns
 * an array is expressing that, and this is the only place that knows it.
 *
 * It never fails the whole run for one bad record. A migration against ten
 * years of data will contain rows that nothing can make sense of, and stopping
 * at the first one means the operator fixes them one per run, overnight, for a
 * week. Bad records are collected and reported.
 *
 * It orders output, because references only resolve if customers land before
 * the jobs that name them.
 */

export interface TransformFailure {
  entity: EntityName;
  sourceId: string;
  error: string;
}

export interface TransformResult {
  counts: Partial<Record<EntityName, number>>;
  failures: TransformFailure[];
  profile: ProfileReport;
}

/**
 * Which raw entity files produce which canonical entities.
 *
 * Usually one to one. The exception is a source whose customer record carries
 * its addresses, where one raw file feeds two canonical streams, and reading
 * the file twice is correct rather than wasteful: the alternative is holding
 * every property in memory while the customers stream past.
 */
export function derivations(adapter: SourceAdapter): { from: EntityName; to: EntityName }[] {
  const supported = new Set(adapter.capabilities.entities);
  const derived = adapter.capabilities.derivedFrom ?? {};
  return ENTITY_ORDER
    .filter((entity) => supported.has(entity))
    .map((entity) => ({ from: derived[entity] ?? entity, to: entity }));
}

export interface TransformSink {
  write(entity: EntityName, canonical: Record<string, unknown>): Promise<void> | void;
}

export async function transform(
  snapshot: Snapshot,
  adapter: SourceAdapter,
  sink: TransformSink,
): Promise<TransformResult> {
  const counts: Partial<Record<EntityName, number>> = {};
  const failures: TransformFailure[] = [];
  const profiler = new Profiler();

  for (const { from, to } of derivations(adapter)) {
    for await (const raw of snapshot.records<Record<string, unknown>>(from)) {
      let produced: unknown;
      try {
        produced = adapter.toCanonical(to, raw);
      } catch (error) {
        // An entity the adapter declares but has no mapping for yet is a gap in
        // the toolkit, not a defect in the operator's data, and it should not
        // land in the failure list ten thousand times.
        const message = (error as Error).message;
        if (message.includes("no canonical mapping")) break;
        failures.push({ entity: to, sourceId: String(raw["id"] ?? ""), error: message });
        continue;
      }

      for (const canonical of Array.isArray(produced) ? produced : [produced]) {
        const value = canonical as Record<string, unknown>;
        counts[to] = (counts[to] ?? 0) + 1;
        profiler.observe(to, value);
        profiler.defer(to, value);
        await sink.write(to, value);
      }
    }
  }

  return { counts, failures, profile: profiler.report(snapshot.source, snapshot.info.account) };
}

/** A sink that keeps everything. For tests and for small accounts only. */
export class MemorySink implements TransformSink {
  readonly records = new Map<EntityName, Record<string, unknown>[]>();
  write(entity: EntityName, canonical: Record<string, unknown>): void {
    const bucket = this.records.get(entity) ?? [];
    this.records.set(entity, bucket);
    bucket.push(canonical);
  }
  get(entity: EntityName): Record<string, unknown>[] { return this.records.get(entity) ?? []; }
}

/** A sink that counts and discards. What `profile` uses on a large account. */
export class CountingSink implements TransformSink {
  readonly counts = new Map<EntityName, number>();
  write(entity: EntityName): void {
    this.counts.set(entity, (this.counts.get(entity) ?? 0) + 1);
  }
}
