// Central config. Everything env-driven lives here so there is one place to look.
// Values that tests change at runtime (ALLOW_FAKE_NOW) are getters, NOT constants evaluated at import
// time: an earlier version read it once at import, so the eval's fake clock was silently ignored.
const budget = process.env.THINKING_BUDGET?.trim();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  model: process.env.MODEL ?? "gemini-3.5-flash-lite",
  fastModel: process.env.FAST_MODEL ?? "gemini-3.1-flash-lite",
  // Tried in order when a model returns 404/403 (retired for this key) or 503 (overloaded). Empty = none.
  // Default: each lite model backs up the other (the chain skips whichever is already primary).
  modelFallbacks: (process.env.MODEL_FALLBACKS ?? "gemini-3.1-flash-lite,gemini-3.5-flash-lite")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  thinkingBudget: budget ? Number(budget) : undefined, // undefined = model default
  dbPath: process.env.DB_PATH ?? "data/agent.db",
  defaultTz: process.env.DEFAULT_TZ ?? "UTC",
  searchDepth: (process.env.SEARCH_DEPTH ?? "basic") as "basic" | "advanced",
  get allowFakeNow() {
    return process.env.ALLOW_FAKE_NOW === "1";
  },
  maxToolRounds: 2, // search rounds per turn, then a forced answer. Measured: 24/25 turns used <=2; the one 4-round turn took 21.8 s
  maxOutputTokens: 8192, // ceiling only; normal answers are far shorter
  maxSearchResults: 5,
  maxCharsPerResult: 900, // trim page content before it reaches the model (speed + focus)
  recentTurnsInContext: 6, // short-term memory: last N turns go in verbatim
  recallTurns: 5, // long-term memory: max past turns surfaced in the memory brief
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}
