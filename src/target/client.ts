import { fetchJson, defaultRetry, HttpError, type RetryPolicy, type HttpResult } from "../adapters/http.js";
import { ROUTES, type RouteName, type InputOf, type OutputOf } from "./contracts.js";

/**
 * TALKING TO OPENTRADESOS
 *
 * Everything the loader writes goes through the target's public HTTP API, the
 * same one a partner integration uses, and never through its database. That
 * is a design rule rather than a preference: this toolkit has to work against
 * any OpenTradesOS, hosted or self hosted, at whatever version the operator is
 * running, and the API is the only surface that promises to be the same on
 * all of them. A loader that wrote rows would also skip every rule the
 * services enforce (the ledger postings, the status lifecycle, the audit
 * trail), and a migration that bypasses the audit trail is one nobody can
 * defend later.
 *
 * Authentication is a connected-app bearer token (`ots_...`), read from the
 * environment by the CLI and never taken as a flag.
 */

export interface CallOptions {
  /**
   * Sent as the `Idempotency-Key` header, which the core reads for every
   * route declared idempotent. Derived from the source record, so a retried
   * or re-run request is the same request.
   */
  idempotencyKey?: string;
}

/** What the loader and reconcile need from a target. Two implementations: HTTP, and in-memory. */
export interface Target {
  readonly description: string;
  call<N extends RouteName>(name: N, input: InputOf<N>, options?: CallOptions): Promise<OutputOf<N>>;
}

/**
 * A refusal from the target, carrying what the server said.
 *
 * `issues` is the 422 body's field list, so the report can say
 * "address.postalCode: Required" rather than "bad request". `retryable` is set
 * only when retries were exhausted on a status that is normally transient, so
 * a re-run is the right response rather than a data fix.
 */
export class TargetError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues: { path: string; message: string }[] = [],
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "TargetError";
  }
}

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResult>;

export interface HttpTargetOptions {
  retry?: RetryPolicy;
  /** Injectable so the request shapes can be tested without a server. */
  transport?: Transport;
}

/**
 * Where the API lives. Accepts the deployment's address, the API mount or
 * the versioned root, because all three get pasted in practice, and resolves
 * them to the mount the contract paths are relative to.
 *
 *   https://ots.example.com          -> https://ots.example.com/api
 *   https://ots.example.com/api      -> unchanged
 *   https://ots.example.com/api/v1   -> https://ots.example.com/api
 */
export function apiBase(input: string): string {
  const url = new URL(input);
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  if (path === "") path = "/api";
  return `${url.origin}${path}`;
}

/** Build the request for a route: path parameters substituted, the rest as body or query. */
export function requestFor(
  name: RouteName,
  input: Record<string, unknown>,
): { method: string; path: string; body?: string } {
  const route = ROUTES[name];
  const remaining: Record<string, unknown> = { ...input };
  const path = route.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = remaining[key];
    delete remaining[key];
    if (typeof value !== "string" || value === "") throw new Error(`${name} needs ${key}`);
    return encodeURIComponent(value);
  });

  if (route.method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(remaining)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const v of value) query.append(key, String(v));
      else query.set(key, String(value));
    }
    const qs = query.toString();
    return { method: "GET", path: qs === "" ? path : `${path}?${qs}` };
  }
  return { method: route.method, path, body: JSON.stringify(remaining) };
}

export class HttpTarget implements Target {
  private readonly base: string;

  constructor(baseUrl: string, private readonly token: string, private readonly options: HttpTargetOptions = {}) {
    this.base = apiBase(baseUrl);
  }

  get description(): string { return this.base; }

  async call<N extends RouteName>(name: N, input: InputOf<N>, options: CallOptions = {}): Promise<OutputOf<N>> {
    const request = requestFor(name, input as Record<string, unknown>);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      "user-agent": "opentradesos-migrate",
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const send = this.options.transport ?? ((url, init) => fetchJson(url, init, this.options.retry ?? defaultRetry()));
    let response: HttpResult;
    try {
      response = await send(`${this.base}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (error) {
      // Retries are already spent by the time this throws. Said as retryable
      // so the report tells the operator to run load again, not to fix data.
      if (error instanceof HttpError) {
        throw new TargetError(error.status, `${name}: ${error.message}`, [], true);
      }
      throw new TargetError(0, `${name}: ${(error as Error).message}`, [], true);
    }

    if (response.status >= 200 && response.status < 300) {
      const parsed = ROUTES[name].output.safeParse(response.body);
      if (!parsed.success) {
        throw new TargetError(response.status, `${name}: the target answered with a shape this toolkit does not recognise (${parsed.error.issues[0]?.path.join(".") ?? ""}: ${parsed.error.issues[0]?.message ?? ""})`);
      }
      return parsed.data as OutputOf<N>;
    }

    const body = (response.body ?? {}) as { error?: unknown; issues?: unknown };
    const issues = Array.isArray(body.issues)
      ? (body.issues as { path?: unknown; message?: unknown }[]).map((i) => ({ path: String(i.path ?? ""), message: String(i.message ?? "") }))
      : [];
    const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new TargetError(401, `${name}: the target refused the token. Check OPENTRADESOS_TOKEN and that the app is still connected.`);
    }
    throw new TargetError(response.status, `${name}: ${message}`, issues);
  }
}
