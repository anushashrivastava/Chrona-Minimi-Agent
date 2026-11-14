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
export function resolvePastDates(text: string, { now, tz }: TimeCtx): string[] {
  const today = localDate(now, tz);
  const out = new Set<string>();
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
    if (ymd <= today) out.add(ymd); // future references ("tomorrow") aren't memory lookups
  }
  return [...out];
}
