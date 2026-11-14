// Time is a first-class concern for this agent. All "now" and date maths go through here
// so (a) the model is always told the real date and timezone and (b) evals can fake the clock.
import * as chrono from "chrono-node";
import { config } from "./config.js";

export interface TimeCtx {
  now: Date;
  tz: string;
}

/** Resolve the clock for a request. A fake "now" is only honoured when explicitly enabled. */
export function makeTimeCtx(opts: { tz?: string; fakeNow?: string | null } = {}): TimeCtx {
  const tz = validTz(opts.tz) ?? config.defaultTz;
  let now = new Date();
  if (config.allowFakeNow && opts.fakeNow) {
    const d = new Date(opts.fakeNow);
    if (!isNaN(d.getTime())) now = d;
  }
  return { now, tz };
}

function validTz(tz?: string): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** YYYY-MM-DD of an instant in a timezone. Stored on every turn so date lookups are exact. */
export function localDate(d: Date | number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** "Saturday, 14 November 2026, 01:15 (Asia/Kolkata)": injected into the system prompt. */
export function describeNow({ now, tz }: TimeCtx): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `${s} (${tz})`;
}

/**
 * "Monday 9 November 2026" for a stored YYYY-MM-DD. It is a calendar date (already the user's local day),
 * so it is formatted at UTC noon: no timezone can shift it to a neighbouring day.
 */
export function describeDate(ymd: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${ymd}T12:00:00Z`));
}

/** Short stamp for memory entries: "Mon 3 Nov 2026, 14:02". */
export function describeInstant(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ts);
}

/**
 * Find date references in the user's text ("last Tuesday", "3 November", "yesterday")
 * and return the local dates (YYYY-MM-DD) they point to.
 *
 * Users almost always mean the PAST when they refer to earlier conversations, so a
 * resolved date in the future is rolled back (a bare "Monday" -> most recent Monday;
 * "3 November" said in January -> last year's).
 */
export function resolvePastDates(text: string, time: TimeCtx): string[] {
  return [...new Set(pastRefs(text, time).map((r) => r.ymd))];
}

interface PastRef {
  ymd: string;
  singleDay: boolean; // a named date or weekday ("3 November", "Monday", "yesterday"), not "last week" or a range
}

function pastRefs(text: string, { now, tz }: TimeCtx): PastRef[] {
  const today = localDate(now, tz);
  const out: PastRef[] = [];
  const results = chrono.parse(text, { instant: now, timezone: tz }, { forwardDate: false });
  for (const r of results) {
    let d = r.start.date();
    if (localDate(d, tz) > today && !r.start.isCertain("year")) {
      if (r.start.isCertain("month")) {
        d = new Date(d); // "3 November" said in January -> last year's
        d.setUTCFullYear(d.getUTCFullYear() - 1);
      } else {
        d = new Date(d.getTime() - 7 * 864e5); // bare "Monday" -> the most recent one
      }
    }
    const ymd = localDate(d, tz);
    if (ymd > today) continue; // future references ("tomorrow") aren't memory lookups
    // chrono marks "last week" as a certain day (7 days ago), so period words are rejected by text
    const named = r.start.isCertain("day") || r.start.isCertain("weekday");
    out.push({ ymd, singleDay: named && !r.end && !/\b(week|month|year|weekend)s?\b/i.test(r.text) });
  }
  return out;
}

// chrono reads "between 2 and 5 November" as just "5 November"; a range is never a single day
const RANGE = /\bbetween\b|\bfrom\b.+\b(to|until|till)\b|\d\s*(-|–|to)\s*\d/i;

/** The one explicit past day the text names, or null if it names none, several, a range, or something vague. */
export function singlePastDay(text: string, time: TimeCtx): string | null {
  if (RANGE.test(text)) return null;
  // "today" is the present ("is your answer still correct today?"), not a second past day
  const today = localDate(time.now, time.tz);
  const refs = pastRefs(text, time).filter((r) => r.ymd !== today);
  return refs.length === 1 && refs[0].singleDay ? refs[0].ymd : null;
}
