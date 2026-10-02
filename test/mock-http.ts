import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import type { RetryPolicy } from "../src/adapters/http.js";

/**
 * A SOURCE API, MOCKED AT THE SOCKET LAYER
 *
 * undici's MockAgent replaces the global dispatcher, so the adapter under
 * test goes through the real shared transport (`fetchJson`, its retry and
 * Retry-After handling) exactly as it does against the vendor. Only the
 * network is fake. Network connections are refused outright, so a test that
 * forgets to mock a route fails instead of calling somebody's production API.
 */
export interface Mocked {
  agent: MockAgent;
  requests: { method: string; path: string; headers: Record<string, string> }[];
  restore(): Promise<void>;
}

export function mockHttp(): Mocked {
  const previous: Dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return {
    agent,
    requests: [],
    async restore() {
      setGlobalDispatcher(previous);
      await agent.close();
    },
  };
}

export function headersOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k.toLowerCase()] = String(v);
  return out;
}

/** A retry policy that never sleeps and records what it would have waited. */
export function instantRetry(): RetryPolicy & { waits: { delayMs: number; reason: string }[] } {
  const waits: { delayMs: number; reason: string }[] = [];
  return {
    maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000,
    sleep: async () => {},
    onRetry: (info) => { waits.push({ delayMs: info.delayMs, reason: info.reason }); },
    waits,
  };
}

/** An extraction context that keeps everything in memory, with read-back. */
export function memoryContext(checkpoints: Record<string, string> = {}) {
  const files = new Map<string, unknown[]>();
  const logs: string[] = [];
  return {
    files, logs, checkpoints,
    ctx: {
      snapshotDir: "/nonexistent",
      append: async (entity: string, records: readonly unknown[]) => {
        const bucket = files.get(entity) ?? [];
        files.set(entity, bucket);
        bucket.push(...records);
      },
      checkpoint: async (entity: string, cursor: string) => { checkpoints[entity] = cursor; },
      resume: async (entity: string) => checkpoints[entity],
      log: (m: string) => { logs.push(m); },
      async *records<T>(entity: string): AsyncGenerator<T> {
        for (const r of files.get(entity) ?? []) yield r as T;
      },
    },
  };
}

export async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* drain */ }
}
