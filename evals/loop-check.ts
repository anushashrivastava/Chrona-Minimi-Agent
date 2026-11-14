// Offline end-to-end check of the agent LOOP using local mock servers (no keys, no network).
// It proves: search call -> function response turn -> cited answer -> saved turn -> background claims,
// plus empty-answer-not-saved and 429 retry. It does NOT prove the real APIs accept our payloads:
// that is what `npm run doctor` and the live eval are for.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const seen: any[] = []; // every request body the mock Gemini received
let failNext429 = 0;

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b ? JSON.parse(b) : {}));
  });
}
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const cand = (parts: any[], finishReason?: string) => ({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] });

const mockGemini = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const url = req.url ?? "";
  if (failNext429 > 0 && url.includes("streamGenerateContent")) {
    failNext429--;
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }));
  }
  if (url.includes(":generateContent")) {
    // background summariser
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(cand([{ text: JSON.stringify({ summary: "User asked about the latest Node version; answered 24.x.", claims: [{ claim: "Latest Node LTS is 24.x", asOf: "2026-11-14" }] }) }], "STOP")));
  }
  seen.push(body);
  const last = body.contents.at(-1);
  const lastText: string = last.parts.map((p: any) => p.text ?? "").join("");
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (last.parts.some((p: any) => p.functionResponse)) {
    res.write(sse(cand([{ text: "Node 24 is the current LTS " }])));
    res.write(sse(cand([{ text: "[1]." }], "STOP")));
  } else if (/latest/i.test(lastText)) {
    res.write(sse(cand([{ functionCall: { id: "c1", name: "web_search", args: { query: "latest node lts" } } }, { functionCall: { id: "c2", name: "web_search", args: { query: "node release schedule", since: "2026-01-01" } } }], "STOP")));
  } else if (/blocked/i.test(lastText)) {
    res.write(sse({ candidates: [{ finishReason: "SAFETY" }] }));
  } else {
    res.write(sse(cand([{ text: "You're welcome!" }], "STOP")));
  }
  res.end();
});

let tavilyBodies: any[] = [];
const mockTavily = http.createServer(async (req, res) => {
  tavilyBodies.push(await readBody(req));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ results: [{ title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases", content: "Node 24 is Active LTS.", published_date: "2026-10-01" }] }));
});

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));
const gp = await listen(mockGemini);
const tp = await listen(mockTavily);
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${gp}`;
process.env.TAVILY_BASE_URL = `http://127.0.0.1:${tp}`;
process.env.GEMINI_API_KEY = "test";
process.env.TAVILY_API_KEY = "test";
process.env.ALLOW_FAKE_NOW = "1";

const { runTurn } = await import("../src/agent.js");
const { resetDb, allTurns } = await import("../src/memory.js");
const { makeTimeCtx } = await import("../src/time.js");
const time = makeTimeCtx({ tz: "Asia/Kolkata", fakeNow: "2026-11-14T10:00:00+05:30" });
resetDb(":memory:");

// 1. search turn: two parallel searches, function responses go back in ONE user turn, answer cites [1]
const events: string[] = [];
const r1 = await runTurn({ userId: "u", message: "What's the latest Node LTS?", time, onEvent: (e) => events.push(e.type), awaitSummary: true });
assert.equal(r1.searches.length, 2);
assert.match(r1.answer, /Node 24.*\[1\]/);
assert.equal(r1.sources.length, 1);
assert.equal(r1.sources[0].published, "2026-10-01");
assert.deepEqual(events.filter((e) => e !== "text"), ["status", "sources", "done"]);
const second = seen[1].contents; // the request after the tool call
assert.equal(second.at(-2).role, "model");
assert.equal(second.at(-2).parts.filter((p: any) => p.functionCall).length, 2); // model turn replayed verbatim
assert.equal(second.at(-1).role, "user");
assert.equal(second.at(-1).parts.filter((p: any) => p.functionResponse).length, 2); // both responses in one turn
assert.match(second.at(-1).parts[0].functionResponse.response.output, /\[1\] Node\.js releases · published 2026-10-01/);
assert.match(seen[0].systemInstruction.parts[0].text, /Saturday, 14 November 2026/); // the clock reached the model
assert.equal(tavilyBodies.at(-1).start_date, "2026-01-01"); // `since` mapped to Tavily's start_date
assert.equal(tavilyBodies.at(-1).include_published_date, true);
assert.equal(seen[0].toolConfig.functionCallingConfig.mode, "AUTO");
let turns = allTurns("u");
assert.equal(turns.length, 1);
assert.match(turns[0].claims_json ?? "", /Latest Node LTS is 24\.x/); // background claims stored

// 2. chit-chat: no search, and the previous turn is replayed as history with its timestamp
const before = seen.length;
const r2 = await runTurn({ userId: "u", message: "thanks", time, awaitSummary: true });
assert.equal(r2.searches.length, 0);
assert.equal(seen[before].contents[0].role, "user");
assert.match(seen[before].contents[0].parts[0].text, /^\[.*2026, \d\d:\d\d\] What's the latest Node LTS\?/);

// 3. blocked/empty answer is NOT saved
const n = allTurns("u").length;
const r3 = await runTurn({ userId: "u", message: "blocked please", time });
assert.equal(r3.turnId, null);
assert.equal(allTurns("u").length, n);

// 4. a 429 before any text is retried once and succeeds
failNext429 = 1;
const r4 = await runTurn({ userId: "u", message: "hello again", time });
assert.match(r4.answer, /welcome/i);

mockGemini.close();
mockTavily.close();
console.log("✓ agent loop checks passed (mock servers)");
process.exit(0);
