// Offline check (no API keys needed): the date + recall logic that powers "what did I ask on 3 November?".
// Run: npm run check:memory
import assert from "node:assert/strict";
import { buildMemoryBrief, ftsQuery, recall, resetDb, saveTurn } from "../src/memory.js";
import { localDate, resolvePastDates } from "../src/time.js";

const tz = "Asia/Kolkata";
const at = (iso: string) => new Date(iso).getTime();
const time = { now: new Date("2026-11-14T01:15:00+05:30"), tz }; // Saturday

// --- date resolution ---
assert.deepEqual(resolvePastDates("What did I ask you on 3 November?", time), ["2026-11-03"]);
assert.deepEqual(resolvePastDates("Last Tuesday I asked about Postgres", time), ["2026-11-10"]);
assert.deepEqual(resolvePastDates("On Monday we shortlisted 5 CRM tools", time), ["2026-11-09"]); // most recent Monday
assert.deepEqual(resolvePastDates("what did I ask yesterday", time), ["2026-11-13"]);
assert.deepEqual(resolvePastDates("what will happen tomorrow", time), []); // future: not a memory lookup
assert.deepEqual(resolvePastDates("3 November", { now: new Date("2027-01-10T10:00:00+05:30"), tz }), ["2026-11-03"]); // rolls back a year
assert.equal(localDate(at("2026-11-03T23:50:00+05:30"), tz), "2026-11-03"); // tz-correct day boundary

// --- fts query safety ---
assert.equal(ftsQuery("is it?"), null);
assert.ok(ftsQuery('Postgres "hosting" (pricing)!')!.includes('"postgres"'));

// --- recall ---
resetDb(":memory:");
saveTurn({ userId: "u", ts: at("2026-11-03T14:02:00+05:30"), tz, userText: "Compare Neon and Supabase for Postgres hosting", answerText: "Neon free tier ... Supabase Pro $25/mo [1]", claims: [{ claim: "Supabase Pro costs $25/month", asOf: "2026-11-03" }] });
saveTurn({ userId: "u", ts: at("2026-11-09T10:00:00+05:30"), tz, userText: "We shortlisted HubSpot, Pipedrive, Zoho, Salesforce, Close as CRM tools", answerText: "Noted.", });
for (let i = 0; i < 6; i++) saveTurn({ userId: "u", ts: at(`2026-11-1${i}T20:0${i}:00+05:30`.replace("2026-11-10", "2026-11-12")), tz, userText: `filler ${i}`, answerText: "ok" }); // pushes older turns out of the recent window
saveTurn({ userId: "other", ts: at("2026-11-03T09:00:00+05:30"), tz, userText: "someone else's secret", answerText: "x" });

const byDate = recall("u", "What did I ask you on 3 November? Is your answer still correct today?", time);
assert.equal(byDate.byDate.length, 1);
assert.match(byDate.byDate[0].user_text, /Postgres hosting/);
assert.ok(!JSON.stringify(byDate).includes("secret"), "must never leak another user's turns");

const byTopic = recall("u", "any pricing changes for Postgres hosting?", time);
assert.ok(byTopic.byTopic.some((t) => /Postgres hosting/.test(t.user_text)));

const brief = buildMemoryBrief(byDate);
assert.match(brief, /Supabase Pro costs \$25\/month \(as of 2026-11-03\)/);

const none = buildMemoryBrief(recall("u", "what did I ask on 1 October", time));
assert.match(none, /No conversation is saved for Thursday,? 1 October 2026./); // weekday + date spelled out in code

// regression: a date whose turn is in the recent transcript must not be reported as "NO saved turns"
// (the brief used to contradict the transcript). And "still correct today?" never reports today as empty.
resetDb(":memory:");
saveTurn({ userId: "u", ts: at("2026-11-03T14:02:00+05:30"), tz, userText: "cheapest managed Postgres host?", answerText: "Neon" });
const recentBrief = buildMemoryBrief(recall("u", "What did I ask you on 3 November? Is it still correct today?", time));
assert.doesNotMatch(recentBrief, /No conversation is saved/);
assert.match(recentBrief, /conversation on Tuesday,? 3 November 2026 is in the chat above/);
const missing = buildMemoryBrief(recall("u", "What did I ask you on 5 November?", time));
assert.match(missing, /No conversation is saved for Thursday,? 5 November 2026\./);
assert.doesNotMatch(missing, /say so|do not guess|plainly/i); // facts only: no instructions the model could echo

console.log("✓ memory + time checks passed");
