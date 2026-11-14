# Project context for Claude Code

## What this is
A chat agent for the minimi hiring challenge. The grader will chat with it like a real user, read the code, and read `DESIGN.md`.
"The best architecture wins": not the most features, not the prettiest UI. The owner (Anusha) must be able to explain every decision in the code and in a 60-second video.

## The brief (do not violate)
- JavaScript/TypeScript on Node. Must run with `npm install` then `npm run dev`.
- The agent has exactly ONE tool: `web_search`. Do not add other tools. Memory and the clock are plumbing around the model, not tools.
- Every API key is listed in `.env.example`.
- Must answer fast, get things right, remember what the user asked and when.
- Test prompts look like: "What did I ask you on 3 November? Is your answer still correct today?", "Last Tuesday I asked about Postgres hosting. Has any pricing changed since?", "On Monday we shortlisted 5 CRM tools. Has any changed pricing?" -> time-aware memory + re-verification is the core.

## Architecture (read before changing anything)
- `src/time.ts`   clock + timezone + date-reference parsing (chrono-node). Supports a fake "now" for tests.
- `src/memory.ts` built-in `node:sqlite` (no native build) turns table + FTS5 + `local_date` index. `recall()` finds past turns by referenced date and by keyword; `buildMemoryBrief()` formats them.
- `src/search.ts` the single tool: Tavily wrapper (asks for published dates), per-turn source numbering, small cache, errors returned as text.
- `src/prompt.ts` stable prompt first + dynamic prompt (now + memory brief) last, so the shared prefix stays identical across turns.
- `src/agent.ts`  the tool loop on the Gemini API (`@google/genai`): stream -> parallel searches -> loop (max rounds) -> save (never an empty answer) -> background summary. Retries 429/503 before the first token.
- `src/server.ts` Hono: `POST /api/chat` (SSE), `GET /api/history`, static UI.
- `evals/memory-check.ts` offline date/recall tests. `evals/loop-check.ts` offline loop test against mock servers (proves our logic, NOT that the real API accepts our payloads). `evals/run.ts` live scenarios. `scripts/doctor.ts` checks keys + model IDs.

## Rules for working here
1. **Plan first** for any change bigger than ~30 lines: say what you will change and why, wait for approval.
2. **Small steps.** One concern per change. Run `npm run typecheck && npm run check:memory && npm run check:loop` after every change. Run `npm run eval` after prompt or agent changes.
3. **No new dependencies** without asking. No LangChain/agent frameworks, no vector DB, no ORM. Boring and explainable beats clever.
4. **Log decisions.** Whenever you make a non-obvious choice, append to `docs/decisions.md`: what, why, what was rejected. This feeds `DESIGN.md`.
5. **Never invent facts in prompts or tests.** If you rely on external API behaviour (Gemini model IDs, SDK options, Tavily params), check the official docs and say so. Gemini model IDs change often: `npm run doctor` lists what exists for the key.
9. **Free-tier limits are real.** Every model call counts (the background summary is a second request per turn, on the fast model). Do not add model calls casually; evals are paced by `EVAL_DELAY_MS`.
6. **Latency is a feature.** Don't add a model call on the critical path without measuring its cost and saying so. Background work is fine.
7. **Keep files small and readable**; comments explain *why*, not *what*.
8. Don't commit `.env` or `data/*.db`.

## Definition of done for any task
Typecheck passes, `check:memory` and `check:loop` pass, relevant eval scenarios pass, decision logged, and you can explain the change in two sentences.

## Commands
- `npm run dev`          start with reload (http://localhost:3000)
- `npm run typecheck`
- `npm run doctor`       verify both keys and the model IDs (run this first)
- `npm run check:memory` offline date/recall tests
- `npm run check:loop`   offline agent-loop test with mock Gemini/Tavily servers
- `npm run eval`         live scenarios (needs keys); `npm run eval -- still` runs scenarios whose name contains "still"
