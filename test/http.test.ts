import { describe, it, expect } from "vitest";
import { backoffDelay, retryAfterMs, type RetryPolicy } from "../src/adapters/http.js";

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 60_000,
  sleep: async () => {}, ...over,
});

describe("backoff", () => {
  it("grows the ceiling exponentially", () => {
    const p = policy();
    expect(backoffDelay(1, p, () => 1)).toBe(1000);
    expect(backoffDelay(2, p, () => 1)).toBe(2000);
    expect(backoffDelay(5, p, () => 1)).toBe(16000);
  });

  it("caps the ceiling", () => {
    expect(backoffDelay(20, policy(), () => 1)).toBe(60_000);
  });

  it("jitters across the whole window rather than adding noise to a fixed delay", () => {
    // Many clients retrying in lockstep is its own outage. Full jitter means
    // two clients that failed together do not come back together.
    const p = policy();
    expect(backoffDelay(4, p, () => 0)).toBe(0);
    expect(backoffDelay(4, p, () => 0.5)).toBe(4000);
  });
});

describe("Retry-After", () => {
  it("reads a delay in seconds", () => {
    expect(retryAfterMs("30")).toBe(30_000);
  });

  it("reads an HTTP date", () => {
    const now = Date.parse("2026-03-01T12:00:00Z");
    expect(retryAfterMs("Sun, 01 Mar 2026 12:00:45 GMT", now)).toBe(45_000);
  });

  it("never returns a negative delay from a date already in the past", () => {
    const now = Date.parse("2026-03-01T12:01:00Z");
    expect(retryAfterMs("Sun, 01 Mar 2026 12:00:00 GMT", now)).toBe(0);
  });

  it("takes the first value when the header repeats", () => {
    expect(retryAfterMs(["12", "99"])).toBe(12_000);
  });

  it("returns nothing for a missing or unreadable header", () => {
    expect(retryAfterMs(undefined)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});
