// `npm run doctor`: 10-second check that both keys work and the model IDs exist for YOUR key.
// Run this first; it turns "something is wrong" into a one-line reason.
import { GoogleGenAI } from "@google/genai";
import { config } from "../src/config.js";

const ok = (m: string) => console.log("✓ " + m);
const bad = (m: string) => {
  console.log("✗ " + m);
  failed = true;
};
let failed = false;
const warn = (m: string) => console.log("! " + m); // degraded but working (e.g. a dead fallback)

const geminiKey = process.env.GEMINI_API_KEY;
const tavilyKey = process.env.TAVILY_API_KEY;
if (!geminiKey) bad("GEMINI_API_KEY is empty (.env). Get one: https://aistudio.google.com/apikey");
if (!tavilyKey) bad("TAVILY_API_KEY is empty (.env). Get one: https://app.tavily.com");

if (geminiKey) {
  const ai = new GoogleGenAI({ apiKey: geminiKey });
  try {
    const names: string[] = [];
    for await (const m of await ai.models.list()) {
      if (m.supportedActions?.includes("generateContent") && m.name) names.push(m.name.replace(/^models\//, ""));
    }
    ok(`Gemini key works. ${names.length} models support generateContent.`);
    for (const [label, id] of [["MODEL", config.model], ["FAST_MODEL", config.fastModel]] as const)
      names.includes(id)
        ? ok(`${label}=${id} exists for your key`)
        : bad(`${label}=${id} not found. Pick one of: ${names.filter((n) => /flash/.test(n)).slice(0, 12).join(", ")}`);
    console.log(`  MODEL_FALLBACKS=${config.modelFallbacks.join(",") || "(none)"}  (tried in order on 404/403/503)`);
    for (const id of config.modelFallbacks)
      names.includes(id) ? ok(`fallback ${id} exists for your key`) : warn(`fallback ${id} not found: it will be skipped`);
  } catch (e) {
    bad("Gemini model list failed: " + (e as Error).message.slice(0, 200));
  }
  // Call BOTH models: being listed is not enough (some listed models reject new users, and one hung).
  // The 30 s abort turns a silent hang into a clear failure.
  const primaries = new Set([config.model, config.fastModel]);
  for (const id of new Set([...primaries, ...config.modelFallbacks])) {
    const t = Date.now();
    try {
      const r = await ai.models.generateContent({
        model: id,
        contents: "Reply with the single word: pong",
        config: { maxOutputTokens: 256, abortSignal: AbortSignal.timeout(30_000) },
      });
      ok(`${id} answered "${(r.text ?? "").trim().slice(0, 20)}" in ${Date.now() - t} ms`);
    } catch (e) {
      (primaries.has(id) ? bad : warn)(`${id} call failed after ${Date.now() - t} ms: ${(e as Error).message.slice(0, 200)} (a 429 here means free-tier quota for this model; try another one)`);
    }
  }
}

if (tavilyKey) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tavilyKey}` },
      body: JSON.stringify({ query: "latest Node.js LTS version", max_results: 3, include_published_date: true, start_date: "2026-01-01" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { results?: { url: string; published_date?: string | null }[] };
    const n = j.results?.length ?? 0;
    const dated = (j.results ?? []).filter((r) => r.published_date).length;
    ok(`Tavily works: ${n} results, ${dated} with published dates`);
    if (n && !dated) console.log("  ! no dates came back; 'has it changed since?' will be weaker. Check include_published_date in src/search.ts.");
  } catch (e) {
    bad("Tavily call failed: " + (e as Error).message);
  }
}
process.exit(failed ? 1 : 0);
