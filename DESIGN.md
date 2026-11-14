# DESIGN.md

The first four sections are the design; the reference below them covers every component. Evidence for each decision is in [docs/decisions.md](docs/decisions.md), and every failure found, with exact inputs and answers, is in [docs/failures.md](docs/failures.md).

## How it works
```
message → code, no model call: clock + timezone, date parsing (chrono), SQLite/FTS5 recall by date and keyword
        → Gemini, streamed, ONE tool (web_search via Tavily), parallel searches, max 2 search rounds
        → code: citations renumbered, tally, "no record" line → saved → background summary stores dated claims
```
The brief allows one tool, so memory and the clock are plumbing around the model, not tools it must decide to call. Each turn is stored with the user's local date, so "3 November" means their 3 November.

## Why built this way (what the evals taught)
- **Absence of new pages is not evidence of no change.** Searching only for pages published since the old date, the model read "nothing new" as "unchanged"; pricing pages are rarely republished. It now looks up current values, and **Could not confirm** is the default.
- **With no history, the model invented a past** ("HubSpot: then $20 → now $20 — Unchanged"). The re-check instructions and format are now sent only when an earlier answer is in view.
- **Derived values belong in code, not in the model's output.** Written first, the model's verdict was a guess; written last, it miscounted its own labels. Code now counts the labels, states "I have no record of a conversation with you on Tuesday, 10 November 2026" (three rewordings never got the model to say it reliably), numbers citations by first appearance, and drops `[n]` that point nowhere.
- **Tavily returns stale page snapshots that disagree.** Two nodejs.org pages, indexed five weeks apart, gave different "latest" versions, so facts are dated by their source, not by today's date.
- **A prompt template attracts misuse.** A fill-in line for "no current value" got copied onto an unrelated name from history, so I parse what the model writes naturally instead.
- **Free-tier models differ per key.** For a new key, `gemini-2.5-flash` returned 404, `3.5-flash` took 27 s, and `3.8-flash` returned 503. Every call walks a fallback chain, which `npm run doctor` tests.

**Speed** (medians of 3 full runs): 1.2 s with no search, 4.0 s with one search round, 6.5 s with two or more. Of 25 turns that searched, 14 used 1 round, 10 used 2, and 1 used 4 (21.8 s), so the cap is 2. Thinking made no measurable difference, because the model's default already uses 0 thinking tokens.

**Tested** in three layers (see Tests below), with live answers judged by reading them, not by pass rates.

## Considered and rejected
- **A memory tool:** breaks the one-tool brief, and adds a round trip and a decision the model can get wrong.
- **A vector database:** the lookups are by exact date or keyword. Embeddings are a next-week item, for paraphrased topics.
- **Agent frameworks, and the SDK's automatic function calling:** opaque, and we need parallel calls, a round cap and status events.
- **Letting the model parse dates:** slower, and it can be wrong.
- **Classifier or verifier model calls:** an extra request on every turn, on a free tier.
- **Comparing prices in code:** prices come as ranges and billing variants.
- **Stronger models:** 27 s or more on the free tier.
- **`better-sqlite3`:** its native build failed `npm install` in a clean environment.
- **Patching the model's verdict after it streamed:** it would rewrite text the user had already seen.

**Trade-off:** in re-check answers the summary comes last, against my "lead with the conclusion" rule. Correctness won.

## With another week
- **Scheduled re-checks** ("tell me if this price changes"): minimi's proactive-nudge shape, built on the stored dated claims.
- **Embeddings alongside FTS:** keyword search misses paraphrased topics.
- **Stored source snapshots,** so claims can be compared against the page as it was seen.
- **A bigger eval set with repeated runs:** 3 runs is too few to rank prompt changes.

---

## Reference

### Components
| file | role |
|---|---|
| `src/server.ts` | Hono: `POST /api/chat` (SSE), `GET /api/history`, static UI. SSE writes are chained and awaited before the stream closes; fire-and-forget writes once dropped `sources` and `done`. |
| `src/agent.ts` | The tool loop, plus everything code does to the answer afterwards. No framework. |
| `src/models.ts` | Fallback chain and retries for every Gemini call. |
| `src/memory.ts` | `node:sqlite` storage, recall, the injected "earlier conversations" section, and the no-record guards. |
| `src/time.ts` | Clock, timezone, date parsing, and a fake "now" for tests. |
| `src/search.ts` | The one tool (Tavily), source numbering, and citation renumbering. |
| `src/verdict.ts` | Counts re-check labels into the Summary line. |
| `src/prompt.ts` | Stable prompt, re-check prompt (only with history), dynamic prompt, summary prompt. |
| `public/index.html` | A minimal UI: streaming, citation links, source chips, timings. |

Runtime dependencies are four: `@google/genai`, `hono`, `@hono/node-server`, `chrono-node`.

### Memory
- **Storage:** one `turns` table (user, UTC timestamp, **local date** in the user's timezone at write time, timezone, question, answer, summary, claims, sources), an index on (user, local date), and an FTS5 table over question, answer and summary. Users never see each other's turns, and that is tested.
- **Dates:** chrono-node, never the model. A bare weekday or a date without a year rolls back into the past ("Monday" means the most recent one), and future dates are ignored.
- **Context sent to the model:** the last 6 turns verbatim, each stamped with its date. Recall adds up to 5 turns on the dates the user named, and up to 5 BM25 keyword matches from older turns. The injected section states facts only ("No conversation is saved for Monday, 9 November 2026"), because instruction-like lines got repeated to users.
- **Background summary:** after the reply, on the fast model, it writes a 2-sentence summary and up to 8 dated claims. It retries 3 times (2 s, 4 s, 8 s) and walks the fallbacks; the user never waits for it. Free-tier 503s used to leave turns with no claims to re-check.

### Prompt
- **Order:** the stable text goes first and the per-turn text (clock, earlier conversations) last, so the shared prefix stays identical for any provider-side caching. There are two stable variants, with and without the re-check section.
- **Decision order**, first match wins:
  1. Unnamed earlier items ("the 5 tools we shortlisted"): ask.
  2. "What did I ask on…": answer from memory.
  3. No record, but the question is answerable from the web: say so, then answer the current part.
  4. Facts that can change: search.
  5. Otherwise, answer directly.
- **Rules:** cite only numbers that were seen; date facts by their source; when sources disagree, name both and use the newer; never say "unchanged" without a visible earlier value and a current source showing the same.

### Agent loop
- **Search:** one round, in parallel, one query per item; at most 2 search rounds, then a forced answer with tools disabled. If the forced answer is empty, the turn retries once with "Answer now from the search results above; no more searches", then shows a fixed fallback message.
- **Results:** Tavily `basic`, 5 results, trimmed to 900 characters each, with published dates requested. `since` maps to `start_date`, and undated pages are kept. Same-query results are cached for 10 minutes, and searches time out after 15 s. Errors go back to the model as text.
- **Model failures:** a 404/403/503 moves to the next model in `MODEL_FALLBACKS`. A 429/500 backs off and retries, up to 2 times, only before any text has streamed. Models that return 404/403 are skipped for the rest of the process. A turn stays on the model that answered, because thought signatures are per model.

### After the model (code, because the facts are known in code)
1. **No-record line:** "I have no record of a conversation with you on <day, date>." It fires only if the message refers to talking with *us* ("did I ask", "I asked you", "you told me"…), names exactly one past day (not "last week" or a range), and there is no saved turn, topic match or recent transcript. It streams first (first token in 2–4 ms), and a restated copy from the model is dropped.
2. **Citations:** renumbered 1, 2, 3… in order of first appearance; `[n]` with no source is dropped and lists like "[1, 5]" are split. The chips use the same numbers, and the saved answer matches what was shown.
3. **Tally:** "**Summary:** N changed, N unchanged, N could not confirm", counted from the `— label` lines, and only when an earlier answer is in view.
4. **Notes:** a fixed note when every search failed, and one when the answer hit the output limit.
5. **Saving:** an empty answer is never saved, because a saved empty turn would be replayed and break the chat.

### API
`POST /api/chat {userId, message, tz}` returns SSE events `status | text | reset | sources | done | error`; `reset` means "discard the shown text; the full text follows". `GET /api/history?userId=` returns saved turns. The UI sends the browser's timezone and a per-browser user id.

### Tests
- **`npm run check:memory`** (offline): date resolution, timezone day boundaries, recall, no cross-user leaks, and every no-record guard, including misfires ("we shortlisted on Monday", "last week", a range, a topic match on another day).
- **`npm run check:loop`** (offline, mock Gemini and Tavily): parallel calls and function-response turns, citation renumbering, the tally, the search-failed note, fallbacks (503 → backup, 404 skipped later), summary retries, the empty-forced-answer nudge, and the no-record line streaming and dedupe. It proves our logic, not that the real API accepts our payloads.
- **`npm run doctor`:** keys plus a real call to every configured model.
- **`npm run eval`** (live, fixed clock Sat 14 Nov 2026): 18 scenarios, including the grader's prompts verbatim on an empty database. A local fake Tavily covers search outages and conflicting sources at 0 credits. No answer may contain prompt vocabulary.

## Known limits
Full detail in docs/failures.md.
- **A4, "Last Tuesday I asked about Postgres hosting" with no history:** cited current prices in 2 of 3 runs; one good run said a price "remains" with nothing to compare.
- **A2, "we shortlisted these 5 tools" with no history:** gives current prices, but doesn't say it lacks Monday's figures.
- **A list never given, next to unrelated history:** the model asks which list about half the time, after one wasted search (9 runs, 3 fixes tried).
- **Minor:**
  - A Gemini 503 after text has started isn't retried (by design, to avoid duplicate text), and it crashes the eval script.
  - A re-check label written after "now" instead of at the end of the line gets no Summary.
