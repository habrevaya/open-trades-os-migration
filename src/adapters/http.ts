import { request } from "undici";

/**
 * SHARED TRANSPORT
 *
 * One place that knows how to be polite to somebody else's API, so no adapter
 * has to reinvent backoff and every adapter is equally well behaved.
 *
 * A migration is a burst of read traffic against a production system that
 * other people's businesses are running on at the same time. Getting rate
 * limited is normal and expected; hammering through it is not, and it is the
 * fastest way to have this toolkit's traffic pattern treated as abuse.
 */

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  text: string;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable so tests do not actually wait. */
  sleep: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export const defaultRetry = (): RetryPolicy => ({
  maxAttempts: 6,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** Full jitter. Synchronised retries from many clients are their own outage. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild. */
export function retryAfterMs(header: string | string[] | undefined, now = Date.now()): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  policy: RetryPolicy = defaultRetry(),
): Promise<HttpResult> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let result: HttpResult | undefined;
    try {
      const response = await request(url, {
        method: (init.method ?? "GET") as "GET",
        headers: { accept: "application/json", ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      const text = await response.body.text();
      let body: unknown = undefined;
      try { body = text === "" ? undefined : JSON.parse(text); } catch { body = undefined; }
      result = { status: response.statusCode, headers: response.headers, body, text };
    } catch (error) {
      lastError = error as Error;
    }

    if (result && !RETRYABLE.has(result.status)) return result;

    if (attempt === policy.maxAttempts) {
      if (result) {
        throw new HttpError(result.status, result.text, `${init.method ?? "GET"} ${url} failed with ${result.status} after ${attempt} attempts`);
      }
      throw lastError ?? new Error(`${url} failed after ${attempt} attempts`);
    }

    const advertised = result ? retryAfterMs(result.headers["retry-after"]) : undefined;
    const delayMs = advertised ?? backoffDelay(attempt, policy);
    policy.onRetry?.({
      attempt,
      delayMs,
      reason: result ? `HTTP ${result.status}` : (lastError?.message ?? "network error"),
    });
    await policy.sleep(delayMs);
  }

  /* c8 ignore next */
  throw lastError ?? new Error(`${url} failed`);
}
