// Central config. Everything env-driven lives here so there is one place to look.
// Values that tests change at runtime (ALLOW_FAKE_NOW) are getters, NOT constants evaluated at import
// time: an earlier version read it once at import, so the eval's fake clock was silently ignored.
const budget = process.env.THINKING_BUDGET?.trim();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  model: process.env.MODEL ?? "gemini-3.5-flash-lite",
  fastModel: process.env.FAST_MODEL ?? "gemini-3.1-flash-lite",
  thinkingBudget: budget ? Number(budget) : undefined, // undefined = model default
  dbPath: process.env.DB_PATH ?? "data/agent.db",
  defaultTz: process.env.DEFAULT_TZ ?? "UTC",
  searchDepth: (process.env.SEARCH_DEPTH ?? "basic") as "basic" | "advanced",
  get allowFakeNow() {
    return process.env.ALLOW_FAKE_NOW === "1";
  },
  maxToolRounds: 4, // hard cap on search rounds per turn: bounds latency and cost
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
