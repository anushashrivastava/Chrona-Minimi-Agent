// Live eval harness (needs API keys). Seeds fake history, fakes the clock, asks questions,
// checks the answers with cheap assertions, and reports latency.
// Run: npm run eval        (optionally: npm run eval -- still). EVAL_DELAY_MS paces calls for free-tier limits.
import { runTurn, type TurnResult } from "../src/agent.js";
import { allTurns, resetDb, saveTurn, type Claim } from "../src/memory.js";
import { makeTimeCtx } from "../src/time.js";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.ALLOW_FAKE_NOW = "1";
const tz = "Asia/Kolkata";
const NOW = "2026-11-14T10:00:00+05:30"; // a Saturday. Every scenario runs at this fixed clock.

// Fake search for scenarios that must control what search returns (failure, conflicting sources).
// Real Gemini still answers; only Tavily is replaced, so these scenarios cost 0 search credits.
interface FakeResult { title: string; url: string; content: string; published_date?: string }
type FakeSearch = { fail: true } | { results: FakeResult[] };
let fake: FakeSearch = { results: [] } as FakeSearch;
const fakeTavily = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if ("fail" in fake) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "fake outage" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: fake.results }));
  });
});
await new Promise<void>((r) => fakeTavily.listen(0, () => r()));
const fakeUrl = `http://127.0.0.1:${(fakeTavily.address() as AddressInfo).port}`;

// Never let prompt vocabulary reach the user (it once said "...in the conversation or memory brief").
const JARGON = /memory brief|the message refers to|saved history|earlier conversations below|\brule \d|this guidance|these instructions/i;
const DATE = /\b\d{1,2}(st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,? \d{4}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4}\b/i;
const NO_RECORD = /no record|(don'?t|do not) have (a |any )?record|no saved|nothing saved|no (earlier|previous|prior) conversation/i;
const CANT_FIND = /(couldn'?t|could not|unable to|can'?t) (find|confirm|verify)|not (publicly )?(listed|published)|no (public|current) pric/i;
const TOOLS = ["HubSpot", "Pipedrive", "Zoho", "Close", "Freshsales"];

interface Scenario {
  name: string;
  seed: { at: string; user: string; answer: string; claims?: Claim[] }[];
  ask: string;
  mustSearch: boolean;
  maxSearches?: number; // with mustSearch=false: tolerate up to N searches (documented model limitation)
  mustMatch?: RegExp[]; // all must match the answer
  mustNotMatch?: RegExp[];
  maxMs?: number;
  awaitSummary?: boolean; // wait for the background summary (to assert on stored claims)
  search?: FakeSearch; // replace Tavily for this scenario (0 credits)
  check?: (r: TurnResult) => string[]; // extra assertions; return problems (empty = pass)
}

/**
 * Re-check answers: every item is a labelled "then → now — <label>" line, the model writes no verdict,
 * and the server-computed Summary matches the labels. Counted here with a deliberately DIFFERENT parser
 * (last label word on each "→" line) from src/verdict.ts, so the eval is not the code checking itself.
 */
function tallyCheck(minItems: number) {
  return (r: TurnResult): string[] => {
    const p: string[] = [];
    const lines = r.answer.split("\n");
    const labels = lines
      .filter((l) => l.includes("→") || /^\W*[^:]+:\W*could not confirm/i.test(l))
      .map((l) => [...l.toLowerCase().matchAll(/could not confirm|unchanged|changed/g)].at(-1)?.[0])
      .filter(Boolean) as string[];
    if (labels.length < minItems) p.push(`expected ≥${minItems} labelled item lines, found ${labels.length}`);
    if (lines.some((l) => /\bverdict\b/i.test(l))) p.push("model wrote its own verdict line");
    const summary = lines.find((l) => l.includes("**Summary:**")) ?? "";
    const n = (l: string) => labels.filter((x) => x === l).length;
    const want = `${n("changed")} changed, ${n("unchanged")} unchanged, ${n("could not confirm")} could not confirm`;
    if (labels.length && !summary.includes(want)) p.push(`summary "${summary}" does not match labels (${want})`);
    return p;
  };
}

const scenarios: Scenario[] = [
  {
    // Fix 4: missing context -> ask; never invent the list or mistake unrelated history for it.
    // Ideal is 0 searches, but flash-lite does exactly 1 regardless of prompt (9/9 runs, see decisions.md),
    // so the hard requirement is "asks, invents nothing" and the wasted search is tolerated, not hidden.
    name: "missing-context-ask",
    seed: [{ at: "2026-11-12T09:00:00+05:30", user: "What's a good name for a sales standup?", answer: "Try 'Pipeline Pulse'." }],
    ask: "Has anything on the shortlist changed pricing?",
    mustSearch: false,
    maxSearches: 1,
    mustMatch: [/(\?|please (share|let me know|tell|specify|clarify|provide))/i, /(which|what|share|list|remind)/i],
    // no re-check format when there is nothing to re-check (it once "re-checked" the standup name)
    mustNotMatch: [/no pricing to change/i, /hubspot|pipedrive|salesforce|zoho/i, /→/, /Summary:/, /could not confirm/i,
      /memory brief|the message refers to/i], // it once parroted the prompt's rule text back to the user
    maxMs: 8000,
  },
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
      const p = /\bunchanged\b|still (correct|\$12)/i.test(line) ? [`absence treated as unchanged: "${line.trim()}"`] : [];
      return [...p, ...tallyCheck(1)(r)];
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
      if (/\bunchanged\b|now \$15\b/i.test(line)) p.push("stale Pipedrive $15 claim was marked Unchanged");
      return [...p, ...tallyCheck(3)(r)];
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
    check: tallyCheck(1), // was regex-only and passed a "Changed" item with a "1 could not confirm" verdict
  },
  {
    name: "pricing-changes-since",
    seed: [{ at: "2026-11-10T11:00:00+05:30", user: "Compare Neon and Supabase for Postgres hosting", answer: "Neon scales to zero; Supabase Pro is $25/month. Both have free tiers." }],
    ask: "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?",
    mustSearch: true,
    mustMatch: [/(neon|supabase)/i, /\[\d+\]/],
    check: tallyCheck(2),
  },
  // ---- Cold start: EMPTY history, the grader's own prompts verbatim (fresh instance is the common case) ----
  {
    // A1: tools not named -> one short question, invent nothing (1 search tolerated: known flash-lite habit)
    name: "cold-shortlist-unnamed",
    seed: [],
    ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    mustSearch: false,
    maxSearches: 1,
    mustNotMatch: [/hubspot|pipedrive|salesforce|zoho|freshsales|close\.com|monday\.com/i, /→|Summary:/],
    mustMatch: [/\?/, /(which|what)/i],
    check: (r) => (r.answer.length > 300 ? [`not short: ${r.answer.length} chars`] : []),
  },
  {
    // A2: tools named -> search each tool's CURRENT pricing in round one, resolve "Monday" from the clock,
    // say plainly there is no record of Monday's prices, per-tool current price (or honest "couldn't find")
    // with citation and source date. Natural lines: no labels, so no tally (nothing to compare against).
    name: "cold-shortlist-named",
    seed: [],
    ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team: HubSpot, Pipedrive, Zoho CRM, Close, Freshsales. Has any of them changed pricing or shipped something big since?",
    mustSearch: true,
    mustMatch: [NO_RECORD, /\b9(th)? nov(ember)?\b|\bnov(ember)? 9\b/i],
    mustNotMatch: [/Summary:/],
    check: (r) => {
      const p: string[] = [];
      const first = r.searches.slice(0, r.searchesPerRound[0] ?? 0).map((s) => s.query).join(" | ");
      const missing = TOOLS.filter((t) => !new RegExp(t, "i").test(first));
      if (missing.length) p.push(`round 1 did not search: ${missing.join(", ")} (round 1: ${first})`);
      for (const t of TOOLS) {
        // the tool's own line: mentions it, and not 3+ other tools (skips an intro that lists all five)
        const line = r.answer.split("\n").find((l) => new RegExp(`\\b${t}\\b`, "i").test(l) && TOOLS.filter((o) => new RegExp(`\\b${o}\\b`, "i").test(l)).length < 3) ?? "";
        if (!line) p.push(`${t}: no line of its own`);
        else if (/\$\s?\d/.test(line)) {
          if (!/\[\d+\]/.test(line)) p.push(`${t}: price without citation`);
          if (!DATE.test(line)) p.push(`${t}: price without a date`);
        } else if (!CANT_FIND.test(line)) p.push(`${t}: neither a current price nor an honest "couldn't find"`);
      }
      return p;
    },
  },
  {
    // A3: date asked, nothing saved -> "no record", short, no search, nothing invented
    name: "cold-recall-date-still-correct",
    seed: [],
    ask: "What did I ask you on 3 November? Is your answer still correct today?",
    mustSearch: false,
    mustMatch: [NO_RECORD],
    mustNotMatch: [/postgres|supabase|neon|\$\d/i],
    check: (r) => (r.answer.length > 300 ? [`not short: ${r.answer.length} chars`] : []),
  },
  {
    // A4: no record, but the topic is named -> say so in the FIRST sentence, then answer the answerable part
    // (current pricing) with citations and dates; never claim to remember. Structure only, no vendor names.
    name: "cold-postgres-no-record",
    seed: [],
    ask: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    mustSearch: true,
    mustMatch: [/\[\d+\]/, DATE],
    mustNotMatch: [/as I (said|mentioned)|I (told|recommended|suggested) you|last time I|when we (spoke|talked)|you asked me about [^.]* and I/i],
    check: (r) => {
      const p: string[] = [];
      const first = r.answer.trim().split(/(?<=[.!?])\s+/)[0];
      if (!NO_RECORD.test(first)) p.push(`first sentence does not say "no record": "${first}"`);
      // the answerable part must actually be answered: today's prices, cited (it once listed only "could not confirm")
      const priced = r.answer.split("\n").filter((l) => /\$\s?\d/.test(l) && /\[\d+\]/.test(l)).length;
      if (priced < 2) p.push(`only ${priced} lines with a cited current price (need ≥2)`);
      // "last Tuesday" from Sat 14 Nov is 10 Nov; it once wrote "last Tuesday, 3 November"
      const named = r.answer.match(/\b(\d{1,2}) nov(ember)?\b/i)?.[1];
      if (named && named !== "10") p.push(`wrong date for "last Tuesday": ${named} November`);
      return p;
    },
  },
  // ---- Step 8: correctness with controlled search (fake Tavily, 0 credits) ----
  {
    // every search fails -> the model hedges, no citations survive, and code appends the fixed note
    name: "s8-all-searches-failed",
    seed: [],
    search: { fail: true },
    ask: "What does Supabase Pro cost per month right now?",
    mustSearch: true,
    mustMatch: [/Web search failed for this answer/],
    mustNotMatch: [/\[\d+\]/],
    check: (r) => {
      const own = r.answer.split("_(Web search failed")[0]; // the model's own words, before our note
      return CANT_FIND.test(own) || /(couldn'?t|could not|unable to|can'?t) (access|reach|search|check|retrieve)/i.test(own)
        ? [] : [`model's own text does not admit it could not verify: "${own.trim().slice(0, 160)}"`];
    },
  },
  {
    // two official-looking pages disagree -> say so, and go with the newer. "Velmora DB" is a made-up fixture.
    name: "s8-conflicting-sources",
    seed: [],
    search: {
      results: [
        // a genuine conflict: two current official pages, two days apart, different prices
        { title: "Velmora DB Pricing", url: "https://velmora.example/pricing", content: "Velmora DB Pro plan: $29 per month, billed monthly.", published_date: "2026-11-12" },
        { title: "Velmora DB Docs: Plans and limits", url: "https://docs.velmora.example/plans", content: "Pro plan: $24 per month. Includes 50 GB storage.", published_date: "2026-11-10" },
      ],
    },
    ask: "How much is Velmora DB Pro per month?",
    mustSearch: true,
    mustMatch: [/\$29/, /\$24/, /\[\d+\]/], // both values named, newer ($29) present
    check: (r) =>
      /(disagree|conflict|differ|inconsisten|while|but|however|whereas)/i.test(r.answer) ? [] : ["disagreement not stated"],
  },
  {
    // Fix 3: the background summary must actually store dated claims (it used to die on free-tier 503s,
    // leaving nothing for a later "is it still correct?"). Retries + MODEL_FALLBACKS make it survive.
    name: "summary-claims-stored",
    seed: [],
    ask: "How much does Supabase Pro cost per month?",
    mustSearch: true,
    awaitSummary: true,
    mustMatch: [/\$\d+/, /\[\d+\]/],
    check: (r) => {
      const row = allTurns("eval").find((t) => t.id === r.turnId);
      const claims: Claim[] = row?.claims_json ? JSON.parse(row.claims_json) : [];
      if (!row?.summary) return ["no summary stored"];
      if (!claims.length) return ["summary stored but no claims"];
      return claims.every((c) => c.asOf === "2026-11-14") ? [] : [`claims not dated with the turn date: ${row.claims_json}`];
    },
  },
  {
    // Fix 2: two items -> both searched in the FIRST round (parallel), grounded in at least one official
    // source. A later refinement round is tolerated but must fit the latency budget (maxMs).
    name: "parallel-official-sources",
    seed: [],
    ask: "What are the latest stable versions of Python and TypeScript?",
    mustSearch: true,
    mustMatch: [/python/i, /typescript/i, /\d+\.\d+/, /\[\d+\]/],
    maxMs: 12000,
    check: (r) => {
      const p: string[] = [];
      const first = r.searches.slice(0, r.searchesPerRound[0] ?? 0).map((s) => s.query).join(" ");
      if (!/python/i.test(first) || !/typescript/i.test(first))
        p.push(`first round did not cover both items in parallel: [${r.searchesPerRound.join(",")}] ${first}`);
      const official = /python\.org|typescriptlang\.org|devblogs\.microsoft\.com|github\.com\/microsoft|npmjs\.com\/package\/typescript/;
      if (!r.sources.some((s) => official.test(s.url))) p.push(`no official source cited: ${r.sources.map((s) => s.url).join(", ")}`);
      return p;
    },
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
// EVAL_JSON=<file>: append one JSON line per scenario (timings, search shape) for latency analysis
const jsonOut = process.env.EVAL_JSON;
for (const s of scenarios.filter((s) => !only || s.name.includes(only))) {
  await sleep(delayMs);
  resetDb(":memory:");
  for (const t of s.seed) saveTurn({ userId: "eval", ts: new Date(t.at).getTime(), tz, userText: t.user, answerText: t.answer, summary: `${t.user} -> ${t.answer}`, claims: t.claims ?? [] });
  if (s.search) {
    fake = s.search;
    process.env.TAVILY_BASE_URL = fakeUrl; // read per call by search.ts
  } else delete process.env.TAVILY_BASE_URL;
  const r = await runTurn({ userId: "eval", message: s.ask, time: makeTimeCtx({ tz, fakeNow: NOW }), awaitSummary: !!s.awaitSummary });

  const problems: string[] = [];
  if (JARGON.test(r.answer)) problems.push(`prompt wording reached the user: "${r.answer.match(JARGON)?.[0]}"`);
  if (s.mustSearch && !r.searches.length) problems.push("expected a web search");
  if (!s.mustSearch && r.searches.length > (s.maxSearches ?? 0)) problems.push(`unexpected search: ${r.searches.map((x) => x.query).join(", ")}`);
  for (const re of s.mustMatch ?? []) if (!re.test(r.answer)) problems.push(`answer missing ${re}`);
  for (const re of s.mustNotMatch ?? []) if (re.test(r.answer)) problems.push(`answer must not match ${re}`);
  problems.push(...(s.check?.(r) ?? []));
  if (s.maxMs && r.timings.totalMs > s.maxMs) problems.push(`too slow: ${r.timings.totalMs}ms > ${s.maxMs}ms`);

  const ok = problems.length === 0;
  if (jsonOut) {
    const { appendFileSync } = await import("node:fs");
    const row = { at: new Date().toISOString(), name: s.name, ok, problems, firstTokenMs: r.timings.firstTokenMs, totalMs: r.timings.totalMs, rounds: r.timings.rounds, searches: r.searches.length, searchesPerRound: r.searchesPerRound, thinkingBudget: process.env.THINKING_BUDGET ?? "" };
    appendFileSync(jsonOut, JSON.stringify(row) + "\n");
  }
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${s.name}  (${(r.timings.totalMs / 1000).toFixed(1)}s, first token ${r.timings.firstTokenMs ?? "-"}ms, ${r.searches.length} searches, per round [${r.searchesPerRound.join(",")}])`);
  problems.forEach((p) => console.log("    - " + p));
  if (process.env.EVAL_SHOW === "1") {
    // full answer + queries, to judge quality by eye (regex asserts are cheap, not sufficient)
    console.log("    searches: " + r.searches.map((x) => x.query + (x.since ? ` [since ${x.since}]` : "")).join(" | "));
    console.log(r.answer.replace(/^/gm, "    | "));
  } else if (!ok) console.log("    answer: " + r.answer.slice(0, 400).replace(/\n/g, " "));
}
console.log(failed ? `\n${failed} scenario(s) failed` : "\nall scenarios passed");
fakeTavily.close();
process.exit(failed ? 1 : 0);
