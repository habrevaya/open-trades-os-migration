import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ROUTES, type RouteName } from "../src/target/contracts.js";
import { MemoryTarget } from "../src/target/memory.js";
import { TargetError } from "../src/target/client.js";

/**
 * A FAKE OPENTRADESOS, OVER REAL HTTP
 *
 * A local server that speaks the target's wire protocol (the /api mount, the
 * contract paths, bearer tokens, Idempotency-Key, 422 field lists, the error
 * body the core's dispatcher writes) and serves it from the same
 * MemoryTarget that `dryrun` loads into. The loader under test goes through
 * HttpTarget and undici exactly as it does against a real deployment.
 *
 * It can be told to misbehave: answer the next N requests with a status, so
 * the 429 and 5xx paths are exercised over a real socket rather than a mock.
 */

export const TOKEN = "ots_test_token";

interface Compiled { name: RouteName; method: string; segments: string[] }

const TABLE: Compiled[] = (Object.entries(ROUTES) as [RouteName, (typeof ROUTES)[RouteName]][])
  .map(([name, route]) => ({ name, method: route.method, segments: route.path.split("/").filter(Boolean) }))
  .sort((a, b) => b.segments.filter((s) => !s.startsWith("{")).length - a.segments.filter((s) => !s.startsWith("{")).length);

function match(method: string, path: string): { name: RouteName; params: Record<string, string> } | undefined {
  const parts = path.split("/").filter(Boolean);
  for (const entry of TABLE) {
    if (entry.method !== method || entry.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    entry.segments.forEach((segment, i) => {
      if (segment.startsWith("{")) params[segment.slice(1, -1)] = decodeURIComponent(parts[i]!);
      else if (segment !== parts[i]) ok = false;
    });
    if (ok) return { name: entry.name, params };
  }
  return undefined;
}

export interface Logged { method: string; path: string; idempotencyKey?: string; status: number }

export interface FakeTarget {
  url: string;
  memory: MemoryTarget;
  log: Logged[];
  /** Answer the next `count` requests with `status` (and Retry-After, when given). */
  failNext(status: number, count: number, retryAfter?: string): void;
  close(): Promise<void>;
}

const body = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

export async function startFakeTarget(memory = new MemoryTarget()): Promise<FakeTarget> {
  const log: Logged[] = [];
  let failures: { status: number; count: number; retryAfter?: string | undefined } | undefined;

  const send = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(value));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const key = req.headers["idempotency-key"];
      const entry: Logged = { method: req.method ?? "GET", path: url.pathname, status: 0, ...(typeof key === "string" ? { idempotencyKey: key } : {}) };
      log.push(entry);
      const text = await body(req);

      if (failures && failures.count > 0) {
        failures.count -= 1;
        entry.status = failures.status;
        return send(res, failures.status, { error: "Slow down", status: failures.status },
          failures.retryAfter === undefined ? {} : { "retry-after": failures.retryAfter });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        entry.status = 401;
        return send(res, 401, { error: "Not signed in", status: 401 });
      }
      if (!url.pathname.startsWith("/api/")) {
        entry.status = 404;
        return send(res, 404, { error: `No route for ${url.pathname}`, status: 404 });
      }
      const found = match(req.method ?? "GET", url.pathname.slice("/api".length));
      if (!found) {
        entry.status = 404;
        return send(res, 404, { error: `No route for ${url.pathname}`, status: 404 });
      }

      // The core's query coercion, for the fields the lists use.
      const query: Record<string, unknown> = {};
      for (const [k, v] of url.searchParams) {
        query[k] = k === "limit" ? Number(v) : k === "includeInactive" || k === "unappliedOnly" ? v === "true" : v;
      }
      const input = { ...query, ...(text.trim() === "" ? {} : JSON.parse(text) as Record<string, unknown>), ...found.params };

      try {
        const result = await memory.call(found.name, input as never, typeof key === "string" ? { idempotencyKey: key } : {});
        entry.status = req.method === "POST" ? 201 : 200;
        send(res, entry.status, result);
      } catch (error) {
        if (error instanceof TargetError) {
          entry.status = error.status;
          return send(res, error.status, {
            error: error.message, status: error.status,
            ...(error.issues.length > 0 ? { issues: error.issues } : {}),
          });
        }
        entry.status = 500;
        send(res, 500, { error: "Internal error", status: 500 });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    memory,
    log,
    failNext(status, count, retryAfter) { failures = { status, count, retryAfter }; },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
