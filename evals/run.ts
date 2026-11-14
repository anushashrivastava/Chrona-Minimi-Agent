// Live eval harness (needs API keys). Seeds fake history, fakes the clock, asks questions,
// checks the answers with cheap assertions, and reports latency.
// Run: npm run eval        (optionally: npm run eval -- still). EVAL_DELAY_MS paces calls for free-tier limits.
import { runTurn } from "../src/agent.js";
import { resetDb, saveTurn } from "../src/memory.js";
import { makeTimeCtx } from "../src/time.js";

process.env.ALLOW_FAKE_NOW = "1";
const tz = "Asia/Kolkata";
const NOW = "2026-11-14T10:00:00+05:30"; // a Saturday

interface Scenario {
  name: string;
  seed: { at: string; user: string; answer: string }[];
  ask: string;
  mustSearch: boolean;
  mustMatch?: RegExp[]; // all must match the answer
  mustNotMatch?: RegExp[];
  maxMs?: number;
}

const scenarios: Scenario[] = [
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
  for (const t of s.seed) saveTurn({ userId: "eval", ts: new Date(t.at).getTime(), tz, userText: t.user, answerText: t.answer, summary: `${t.user} -> ${t.answer}`, claims: [] });
  const r = await runTurn({ userId: "eval", message: s.ask, time: makeTimeCtx({ tz, fakeNow: NOW }), awaitSummary: false });

  const problems: string[] = [];
  if (s.mustSearch && !r.searches.length) problems.push("expected a web search");
  if (!s.mustSearch && r.searches.length) problems.push(`unexpected search: ${r.searches.map((x) => x.query).join(", ")}`);
  for (const re of s.mustMatch ?? []) if (!re.test(r.answer)) problems.push(`answer missing ${re}`);
  for (const re of s.mustNotMatch ?? []) if (re.test(r.answer)) problems.push(`answer must not match ${re}`);
  if (s.maxMs && r.timings.totalMs > s.maxMs) problems.push(`too slow: ${r.timings.totalMs}ms > ${s.maxMs}ms`);

  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${s.name}  (${(r.timings.totalMs / 1000).toFixed(1)}s, first token ${r.timings.firstTokenMs ?? "-"}ms, ${r.searches.length} searches)`);
  if (!ok) {
    problems.forEach((p) => console.log("    - " + p));
    console.log("    answer: " + r.answer.slice(0, 400).replace(/\n/g, " "));
  }
}
console.log(failed ? `\n${failed} scenario(s) failed` : "\nall scenarios passed");
process.exit(failed ? 1 : 0);
