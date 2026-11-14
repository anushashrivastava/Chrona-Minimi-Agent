// Live eval harness (needs API keys). Seeds fake history, fakes the clock, asks questions,
// checks the answers with cheap assertions, and reports latency.
// Run: npm run eval        (optionally: npm run eval -- still). EVAL_DELAY_MS paces calls for free-tier limits.
import { runTurn, type TurnResult } from "../src/agent.js";
import { resetDb, saveTurn, type Claim } from "../src/memory.js";
import { makeTimeCtx } from "../src/time.js";

process.env.ALLOW_FAKE_NOW = "1";
const tz = "Asia/Kolkata";
const NOW = "2026-11-14T10:00:00+05:30"; // a Saturday

interface Scenario {
  name: string;
  seed: { at: string; user: string; answer: string; claims?: Claim[] }[];
  ask: string;
  mustSearch: boolean;
  mustMatch?: RegExp[]; // all must match the answer
  mustNotMatch?: RegExp[];
  maxMs?: number;
  check?: (r: TurnResult) => string[]; // extra assertions; return problems (empty = pass)
}

/** Which "Changed / Unchanged / Could not confirm" section of a re-check answer mentions `name`. */
function sectionOf(answer: string, name: RegExp): string | null {
  let current: string | null = null;
  for (const line of answer.split("\n")) {
    const h = line.match(/\b(Could not confirm|Unchanged|Changed)\b/i);
    if (h && /\*\*|^#/.test(line)) current = h[1].toLowerCase();
    if (name.test(line) && current) return current;
  }
  return null;
}

const scenarios: Scenario[] = [
  {
    // Fix 1: absence of evidence must default to "Could not confirm". "Quorvex CRM" is a made-up test
    // fixture (no real product), so no source can state its current price; "Unchanged" would be a guess.
    name: "recheck-absence-not-evidence",
    seed: [
      {
        at: "2026-11-09T11:00:00+05:30",
        user: "How much is Quorvex CRM per user?",
        answer: "Quorvex CRM Team plan costs $12 per user/month.",
        claims: [{ claim: "Quorvex CRM Team plan costs $12 per user/month", asOf: "2026-11-09" }],
      },
    ],
    ask: "On Monday I asked about Quorvex CRM pricing. Is that still correct?",
    mustSearch: true,
    mustMatch: [/could not confirm|couldn'?t confirm|unable to (confirm|verify)|could not (find|verify)/i],
    check: (r) => {
      const line = r.answer.split("\n").find((l) => /quorvex/i.test(l) && /\$12/.test(l)) ?? "";
      return /\bunchanged\b|still (correct|\$12)/i.test(line) ? [`absence treated as unchanged: "${line.trim()}"`] : [];
    },
  },
  {
    // Fix 1: re-checks must look up CURRENT values (no `since`) and never rubber-stamp "Unchanged".
    // The Pipedrive claim is deliberately stale test data: filing it under Unchanged is a failure.
    name: "recheck-current-values",
    seed: [
      {
        at: "2026-11-09T11:00:00+05:30",
        user: "Shortlist for our 20-person sales team: HubSpot, Pipedrive, Freshsales. Price per user per month?",
        answer: "HubSpot Sales Hub Professional: $90-$100/user/month. Pipedrive Professional: $15/user/month. Freshsales Pro: $39/user/month.",
        claims: [
          { claim: "HubSpot Sales Hub Professional costs $90-$100 per user/month", asOf: "2026-11-09" },
          { claim: "Pipedrive Professional costs $15 per user/month", asOf: "2026-11-09" },
          { claim: "Freshsales Pro costs $39 per user/month", asOf: "2026-11-09" },
        ],
      },
    ],
    ask: "On Monday we shortlisted some CRM tools. Has any of them changed pricing since?",
    mustSearch: true,
    mustMatch: [/hubspot/i, /pipedrive/i, /freshsales/i, /\[\d+\]/],
    check: (r) => {
      const p: string[] = [];
      const current = r.searches.filter((s) => !s.since).length;
      if (current < 3) p.push(`only ${current} searches without since (need one per tool for current values)`);
      const line = r.answer.split("\n").find((l) => /pipedrive/i.test(l)) ?? "";
      if (sectionOf(r.answer, /pipedrive/i) === "unchanged" || /\bunchanged\b|now \$15\b/i.test(line))
        p.push("stale Pipedrive $15 claim was marked Unchanged");
      // the verdict must not count the stale Pipedrive claim as unchanged (3 items, so 3 unchanged = wrong)
      const verdict = r.answer.split("\n").find((l) => /verdict/i.test(l)) ?? r.answer.trim().split("\n")[0];
      if (/\b(all|3 of 3|3)\b[^\n]*\bunchanged|^\W*unchanged\W*$/i.test(verdict)) p.push(`verdict counts everything unchanged: "${verdict.trim()}"`);
      return p;
    },
  },
  {
    name: "recall-by-date",
    seed: [{ at: "2026-11-03T14:02:00+05:30", user: "What's the cheapest managed Postgres host?", answer: "Neon's free tier and Supabase Pro at $25/month are the usual picks." }],
    ask: "What did I ask you on 3 November?",
    mustSearch: false,
    mustMatch: [/postgres/i],
  },
  {
    name: "no-record",
    seed: [{ at: "2026-11-03T14:02:00+05:30", user: "What's the cheapest managed Postgres host?", answer: "Neon free tier." }],
    ask: "What did I ask you on 5 November?",
    mustSearch: false,
    mustNotMatch: [/postgres/i],
    mustMatch: [/(no record|don'?t have|didn'?t|nothing|no saved|not find)/i],
  },
  {
    name: "still-correct",
    seed: [{ at: "2026-11-03T14:02:00+05:30", user: "How much does Supabase Pro cost?", answer: "Supabase Pro is $25/month per project." }],
    ask: "What did I ask you on 3 November? Is your answer still correct today?",
    mustSearch: true,
    mustMatch: [/supabase/i, /\[\d+\]/],
  },
  {
    name: "pricing-changes-since",
    seed: [{ at: "2026-11-10T11:00:00+05:30", user: "Compare Neon and Supabase for Postgres hosting", answer: "Neon scales to zero; Supabase Pro is $25/month. Both have free tiers." }],
    ask: "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?",
    mustSearch: true,
    mustMatch: [/(neon|supabase)/i, /\[\d+\]/],
  },
  {
    name: "missing-shortlist",
    seed: [],
    ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    mustSearch: false,
    mustMatch: [/(which|what|list|remind|share|tell me)/i], // should ask for the 5 tools, not invent them
  },
  {
    name: "fresh-fact",
    seed: [],
    ask: "What's the latest stable version of Node.js?",
    mustSearch: true,
    mustMatch: [/\d+\.\d+/, /\[\d+\]/],
    maxMs: 15000,
  },
  {
    name: "chit-chat-no-search",
    seed: [],
    ask: "Thanks, that's helpful!",
    mustSearch: false,
    maxMs: 5000,
  },
];

const only = process.argv[2];
const delayMs = Number(process.env.EVAL_DELAY_MS ?? 4000); // free tiers have per-minute limits; pace the scenarios
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
for (const s of scenarios.filter((s) => !only || s.name.includes(only))) {
  await sleep(delayMs);
  resetDb(":memory:");
  for (const t of s.seed) saveTurn({ userId: "eval", ts: new Date(t.at).getTime(), tz, userText: t.user, answerText: t.answer, summary: `${t.user} -> ${t.answer}`, claims: t.claims ?? [] });
  const r = await runTurn({ userId: "eval", message: s.ask, time: makeTimeCtx({ tz, fakeNow: NOW }), awaitSummary: false });

  const problems: string[] = [];
  if (s.mustSearch && !r.searches.length) problems.push("expected a web search");
  if (!s.mustSearch && r.searches.length) problems.push(`unexpected search: ${r.searches.map((x) => x.query).join(", ")}`);
  for (const re of s.mustMatch ?? []) if (!re.test(r.answer)) problems.push(`answer missing ${re}`);
  for (const re of s.mustNotMatch ?? []) if (re.test(r.answer)) problems.push(`answer must not match ${re}`);
  problems.push(...(s.check?.(r) ?? []));
  if (s.maxMs && r.timings.totalMs > s.maxMs) problems.push(`too slow: ${r.timings.totalMs}ms > ${s.maxMs}ms`);

  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${s.name}  (${(r.timings.totalMs / 1000).toFixed(1)}s, first token ${r.timings.firstTokenMs ?? "-"}ms, ${r.searches.length} searches)`);
  problems.forEach((p) => console.log("    - " + p));
  if (process.env.EVAL_SHOW === "1") {
    // full answer + queries, to judge quality by eye (regex asserts are cheap, not sufficient)
    console.log("    searches: " + r.searches.map((x) => x.query + (x.since ? ` [since ${x.since}]` : "")).join(" | "));
    console.log(r.answer.replace(/^/gm, "    | "));
  } else if (!ok) console.log("    answer: " + r.answer.slice(0, 400).replace(/\n/g, " "));
}
console.log(failed ? `\n${failed} scenario(s) failed` : "\nall scenarios passed");
process.exit(failed ? 1 : 0);
