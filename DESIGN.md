# DESIGN.md (DRAFT: replace the TODOs with real numbers before submitting)

## What it is
A chat agent with one tool (web search) and time-aware memory. It answers fast, grounds claims in cited sources, and can answer "what did I ask on 3 November, and is that still true?"

## How it works
```
message → context builder (no LLM): clock + timezone, chrono date parsing, SQLite/FTS5 recall → memory brief
        → model (streamed) + web_search, parallel searches, max 4 rounds
        → answer with [n] citations → saved to SQLite
        → background: fast model writes a summary + dated claims for later re-checking
```
- **Time**: the model is told the exact current date/time/timezone every turn. Relative dates ("last Tuesday") are resolved in code, not by the model.
- **Memory**: every turn stored with UTC timestamp, the user's local date, answer, sources, summary, claims. Recall = turns on referenced dates + BM25 keyword matches. Recent turns also go in verbatim.
- **"Still correct?"**: the old turn's claims are in the prompt; the model re-searches each with `since=<old date>` and answers *What changed / Unchanged / Could not confirm*.

## Why this design
- **Memory is plumbing, not a tool.** The brief gives one tool. A memory tool would also cost a model round trip and could be skipped or misused. Building the brief deterministically is faster and testable offline.
- **Fast**: streaming, visible search status, parallel searches, trimmed results, a stable prompt prefix, summaries off the critical path (on a separate fast model). TODO: measured numbers (first token / total, with and without search).
- **Right**: citations only to sources the model saw, dates on time-sensitive facts, explicit "could not verify" instead of guessing, ask when memory is ambiguous.
- **Tested**: `check:memory` and `check:loop` (offline, mock servers) and `npm run eval` (live, fake clock). TODO: pass rate.
- **Zero-friction install**: built-in `node:sqlite` (no native build) and free-tier keys, so `npm install && npm run dev` works on a clean machine.

## Considered and rejected
Vector DB (exact date/keyword lookups don't need it) · agent frameworks (opaque, slower, harder to explain) · planner/critic multi-agent (latency) · full history in the prompt (cost, noise) · a memory tool (breaks the one-tool brief) · letting the LLM parse dates (slower, error-prone).

## With another week
Hybrid retrieval (embeddings + FTS) · claim-by-claim diffing with stored source snapshots · a larger eval set with an LLM judge · scheduled re-checks ("tell me if this price changes"), which is exactly the proactive-nudge shape minimi is built on.
