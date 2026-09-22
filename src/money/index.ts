/**
 * MONEY
 *
 * Every amount in this toolkit is a decimal string, and every operation on one
 * goes through here. There is no path where a monetary value becomes a JS
 * number, because `0.1 + 0.2` is the reason reconciliation reports lie.
 *
 * The internal representation is a bigint scaled by 10^4, which matches how
 * OpenTradesOS stores money. Four places is not arbitrary: tax rates and
 * per-unit prices in this industry routinely carry three, and rounding those
 * to cents before the line total is computed produces invoices that are off by
 * a few dollars across a year and impossible to explain to an accountant.
 */

export const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

export class MoneyError extends Error {
  constructor(public readonly value: string, message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parse a decimal string into the scaled integer. Throws rather than guessing. */
export function parse(value: string): bigint {
  const trimmed = value.trim();
  const match = PATTERN.exec(trimmed);
  if (!match) throw new MoneyError(value, `Not a decimal amount: ${JSON.stringify(value)}`);

  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > SCALE) {
    // Silently truncating here is how a migration loses a tenth of a cent per
    // line and then fails to reconcile by forty dollars with no explanation.
    throw new MoneyError(value, `More than ${SCALE} decimal places: ${JSON.stringify(value)}`);
  }
  const padded = fraction.padEnd(SCALE, "0");
  const magnitude = BigInt(whole ?? "0") * FACTOR + BigInt(padded === "" ? "0" : padded);
  return sign === "-" ? -magnitude : magnitude;
}

/** Render the scaled integer back to a decimal string, always with 4 places. */
export function format(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / FACTOR;
  const fraction = (magnitude % FACTOR).toString().padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Normalize whatever the source gave us into a canonical decimal string.
 *
 * Sources are inconsistent in a way that is worth enumerating, because each of
 * these has been seen in a real export: integer cents, a float, a string with
 * a currency symbol, a string with thousands separators, parenthesised
 * negatives from an accounting export, an empty string, and null.
 */
export function normalize(input: unknown, opts: { cents?: boolean } = {}): string {
  if (input === null || input === undefined || input === "") return "0.0000";

  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new MoneyError(String(input), "Amount is not finite");
    // A float reached us anyway. Convert through a fixed-precision string so
    // the binary representation error is discarded once, here, rather than
    // accumulating through every subsequent operation.
    if (opts.cents) {
      if (!Number.isInteger(input)) throw new MoneyError(String(input), "Cents amount is not an integer");
      return format(BigInt(input) * (FACTOR / 100n));
    }
    return format(parse(input.toFixed(SCALE)));
  }

  if (typeof input === "bigint") {
    return opts.cents ? format(input * (FACTOR / 100n)) : format(input * FACTOR);
  }

  if (typeof input !== "string") {
    throw new MoneyError(String(input), `Cannot read an amount from ${typeof input}`);
  }

  let text = input.trim();
  let negative = false;

  // Accounting exports write negatives in parentheses.
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  // Currency symbols and thousands separators.
  text = text.replace(/[$£€¥,\s]/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  if (text.startsWith("+")) text = text.slice(1);
  if (text === "") return "0.0000";

  if (opts.cents) {
    if (!/^\d+$/.test(text)) throw new MoneyError(input, `Cents amount is not an integer: ${JSON.stringify(input)}`);
    const scaled = BigInt(text) * (FACTOR / 100n);
    return format(negative ? -scaled : scaled);
  }

  const scaled = parse(text);
  return format(negative ? -scaled : scaled);
}

export const add = (a: string, b: string): string => format(parse(a) + parse(b));
export const subtract = (a: string, b: string): string => format(parse(a) - parse(b));
export const negate = (a: string): string => format(-parse(a));
export const sum = (values: readonly string[]): string =>
  format(values.reduce((acc, v) => acc + parse(v), 0n));

/**
 * Multiply two scaled amounts, rounding half away from zero.
 *
 * Half away from zero, not banker's rounding, because that is what every
 * source system in this industry does on an invoice line, and reconciliation
 * compares against what the source printed, not against what is statistically
 * tidier.
 */
export function multiply(a: string, b: string): string {
  const product = parse(a) * parse(b);
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const quotient = magnitude / FACTOR;
  const remainder = magnitude % FACTOR;
  const rounded = remainder * 2n >= FACTOR ? quotient + 1n : quotient;
  return format(negative ? -rounded : rounded);
}

export const compare = (a: string, b: string): -1 | 0 | 1 => {
  const left = parse(a);
  const right = parse(b);
  return left < right ? -1 : left > right ? 1 : 0;
};
export const equals = (a: string, b: string): boolean => parse(a) === parse(b);
export const isZero = (a: string): boolean => parse(a) === 0n;
export const abs = (a: string): string => format(parse(a) < 0n ? -parse(a) : parse(a));

/** Render for a human-facing report. Two places, with a sign when negative. */
export function display(a: string): string {
  const scaled = parse(a);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const cents = (magnitude + 50n) / 100n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}
