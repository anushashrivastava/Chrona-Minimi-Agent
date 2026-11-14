# DESIGN.md

## How it works
```
message → code, no model call: clock + timezone, date parsing (chrono), SQLite/FTS5 recall by date and keyword
        → Gemini, streamed, ONE tool (web_search via Tavily), parallel searches, max 2 search rounds
        → code: citations renumbered, tally, "no record" line → saved → background summary stores dated claims
```
Memory and the clock are plumbing, not tools; each turn stores the user's local date.

## Why built this way (what the evals taught)
- **Absence of new pages is not evidence of no change.** Searching only for pages published since the old date, it read "nothing new" as "unchanged"; pricing pages are rarely republished. It now looks up current values; **Could not confirm** is the default.
- **With no history, the model invented a past** ("HubSpot: then $20 → now $20 — Unchanged"). The re-check instructions are now sent only when an earlier answer is in view.
- **Derived values belong in code, not in the model's output.** Written first, the model's verdict was a guess; written last, it miscounted its own labels. Code now counts the labels, states "I have no record of a conversation with you on Tuesday, 10 November 2026" (three rewordings never managed it reliably), numbers citations by first appearance, and drops `[n]` that point nowhere.
- **Tavily returns stale page snapshots that disagree.** Two nodejs.org pages, indexed five weeks apart, gave different "latest" versions, so facts are dated by their source.
- **A prompt template attracts misuse.** A fill-in line for "no current value" got copied onto an unrelated name, so I parse what the model writes instead.
- **Free-tier models differ per key.** For a new key, `2.5-flash` returned 404, `3.5-flash` took 27 s, `3.8-flash` returned 503; calls walk a fallback chain that `npm run doctor` tests.

**Speed** (medians of 3 full runs): 1.2 s with no search, 4.0 s with one search round, 6.5 s with two or more. Of 25 turns that searched, 14 used 1 round, 10 used 2, and 1 used 4 (21.8 s), so the cap is 2. Thinking made no difference: the model's default already uses 0 thinking tokens.

**Tested:** offline checks (dates, recall, the loop against mock servers) and 18 live scenarios at a fixed clock, judged by reading the answers.

## Considered and rejected
A memory tool (breaks the one-tool brief) · a vector database (lookups are exact) · agent frameworks (opaque) · model-parsed dates (can be wrong) · classifier or verifier calls (an extra request every turn) · comparing prices in code (ranges, billing variants) · stronger models (27 s or more).
**Trade-off:** in re-check answers the summary comes last, against my "lead with the conclusion" rule. Correctness won.

## Known limits (docs/failures.md)
- **A4, "Last Tuesday I asked about Postgres hosting" with no history:** cited current prices in 2 of 3 runs; one said a price "remains".
- **A2, "we shortlisted these 5 tools" with no history:** doesn't say it lacks Monday's figures.
- **A list never given, next to unrelated history:** asks which list about half the time, after one wasted search (9 runs, 3 fixes tried).

## With another week
- **Scheduled re-checks** ("tell me if this price changes"): minimi's proactive-nudge shape, built on the stored dated claims.
- **Embeddings alongside FTS:** keyword search misses paraphrased topics.
- **Stored source snapshots** to compare claims against.
- **A bigger eval set with repeated runs:** 3 runs is too few to rank prompt changes.
