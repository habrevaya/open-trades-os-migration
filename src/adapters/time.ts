/**
 * WALL-CLOCK TIMES
 *
 * Several sources write timestamps as `2024-03-14 15:41:00` with no offset:
 * the time on the office clock, in a zone the record names separately
 * (Workiz's `Timezone`) or not at all (ServiceM8). Reading one as UTC moves
 * every appointment by the account's offset, which is a technician arriving
 * five hours early on paper.
 *
 * With a zone, the time is converted to UTC through Intl, so daylight saving
 * comes from the same tz database the rest of the platform uses. Without one
 * it is returned as an unqualified local time (`2024-03-14T15:41:00`), which
 * says exactly what the source said and no more.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const QUALIFIED = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/;

/** Zero dates are how several sources write "never". */
export function isZeroDate(value: string): boolean {
  return /^0000-00-00/.test(value);
}

function offsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - instant;
}

/**
 * `2024-03-14 15:41:00` in `zone` to `2024-03-14T20:41:00.000Z`.
 *
 * An already qualified ISO timestamp is returned unchanged. An unknown zone
 * throws rather than silently falling back to UTC.
 */
export function wallClock(value: string | undefined, zone?: string): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "" || isZeroDate(v)) return undefined;
  if (QUALIFIED.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = LOCAL.exec(v);
  if (!m) throw new Error(`Not a timestamp this adapter can read: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, s] = m;
  if (!zone) return `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}`;

  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  try {
    // Two passes: the offset at the naive instant can differ from the offset
    // at the real one across a daylight saving change.
    const first = naive - offsetMs(naive, zone);
    const second = naive - offsetMs(first, zone);
    return new Date(second).toISOString();
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`Unknown time zone ${JSON.stringify(zone)} on a record`);
    throw error;
  }
}
