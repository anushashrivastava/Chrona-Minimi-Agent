# Failures found (Step 3-4, 2026-11-14; status updated after fixes 1-4)
Model `gemini-3.5-flash-lite`, summary `gemini-3.1-flash-lite`, Tavily basic. Ordered by impact. Fixed ones say so.

## Fixed already
- **F0 Memory brief contradicted the transcript.** "What did I ask you on 3 November?" with a short history: the 3 Nov turn was in the recent window, so recall dropped it and the brief said "NO saved turns on that date. Say so plainly". Fixed in `memory.ts`, regression in `check:memory`.
- **F1 `sources` and `done` SSE events were dropped.** Live answers had no clickable citations or timing line. Fixed in `server.ts`.
- **F2 Default models unusable for new keys.** 2.5 models: 404 "no longer available to new users"; 3.5/3.8-flash: 27 s+ or 503. Switched defaults, doctor calls both models.

## Open
1. **FIXED (fix 1)**: **"Has pricing changed?" answers "Unchanged" on thin evidence.**
   Input (fake now Sat 14 Nov, after a real Monday turn listing 5 CRM prices): "On Monday we shortlisted 5 CRM tools. Has any changed pricing since?"
   Searches: 5 queries, all with `since=2026-11-09`, none without it.
   Output: `**Unchanged.** Pricing across all five platforms ... remains consistent with Monday's rates [1][2][8][10][11].`
   Problem: pricing pages are rarely republished, so `since` mostly returns fresh blog posts; no current price is stated per tool, so the user can't see what was compared. Should list each tool with old vs current price, or "could not confirm".
2. **FIXED (fix 2), cause was stale page snapshots**: **Inconsistent "latest Node.js" answers across runs.** Run 1: "latest LTS is Node.js 26 (v26.13.0)" [nodejs.org]. Eval run: "Node.js v24.22.2 ... is the latest LTS release as of October 2026". Same question, contradictory answers. Also "latest stable" was answered as LTS only, ignoring Current.
3. **FIXED (fix 2 + Step 7 cap of 2 search rounds)**: first round is parallel; worst case (4 rounds, 21.8 s) now capped. **Searches run sequentially across rounds instead of in parallel.** "latest stable Node.js": 3 searches over 4 rounds, first token 8.5-18.5 s (eval `fresh-fact` fails its 15 s budget). The 5-CRM turn did it right (5 parallel searches, 5.2 s), so the model can; single-topic questions trigger refine-and-retry.
4. **FIXED (fix 3 + MODEL_FALLBACKS)**: **Background summary fails with 503 on `gemini-3.1-flash-lite`** (2 of 4 eval turns). No retry, so the turn is saved without claims, and "is it still correct?" later has nothing structured to re-check.
5. **MODEL LIMIT (fix 4)**: answer is right (asks, invents nothing) but flash-lite still does 1 search, 9/9 runs across 3 levers. **Needless search when the answer is "tell me the list".** Eval `missing-shortlist`: answer was right (asked for the 5 tools, no invention) but it first searched "CRM tools for 20 person sales team", costing ~2.5 s and a Tavily credit.

## New (found in the full run after fixes)
6. **FIXED (tally computed in code, src/verdict.ts)**: **Verdict miscounts its own labels.** Eval `still-correct`: item line "Supabase Pro pricing: then $25/month per project → now $25/month per organization + usage [1][2] — Changed", then "**Verdict:** 0 changed, 0 unchanged, 1 could not confirm". The eval passed it (regex too weak). Candidate fix in code: recount the `— <label>` lines and correct the verdict line.
7. **MEASURED (Step 7)**: free-tier spikes, e.g. chit-chat median 1.9 s, slowest 11.9 s with no search. **Model latency swings unrelated to search.** `missing-shortlist`: 2.9-6.2 s earlier, 14.6 s in the full run with the same single search. Free-tier load; measure medians in Step 7 rather than single runs.

8. **KNOWN FLAKY**: `missing-context-ask` with unrelated history containing a nameable item: about half the runs ask correctly; others treat the unrelated name as the shortlist or quote the prompt. Regression from the tally template was found and reverted; see decisions.md.
9. **FIXED**: `THINKING_BUDGET=0` (as the old docs suggested) returns 400 on gemini-3.5-flash-lite. Docs now say leave it empty.

## Cold start (empty history, grader prompts), 2026-11-14
10. **PARTLY FIXED / A2 KNOWN LIMIT.** Code now states the no-record line for "I asked you / did I ask" + one named day (A3 and the A4 lead are exact, right date). A2 ("we shortlisted", no code lead): after removing the injected "no conversation saved" line it gives cited current prices and news per tool, with no fabricated then-values, but still does not say it has no earlier figures or name Monday 9 Nov. Was: `cold-shortlist-named`: lists current prices/news per tool but never says it has no record of Monday or names 9 Nov (3/3 runs). `cold-postgres-no-record`: once "I have no record of our conversation last Tuesday, 3 November 2026" (wrong date, it is 10 Nov) followed by price-less "could not confirm" lines; once stopped after the no-record sentence. Three wording attempts.
11. **FIXED (wording)**: with no history the model fabricated "then" values in the re-check format. Re-check section now applies only with the earlier answer in view.
12. **FIXED/TESTED**: dead `[n]` citations stripped (code); all-searches-failed note (code); conflicting sources named (prompt, fake-search scenario).

## Final full run before feature freeze (2026-11-14), then four targeted exceptions. REPO RE-FROZEN: only fixes for bugs found in the friend test.
13. **FIXED (freeze exception 1), with a remaining gap.** Re-check shape now only sent with history; fabrication 0/3 A4 runs. REMAINING (known limit): answering the current part is 1/3 (one run stopped at "I cannot tell what changed", one claimed "has not changed [1][2][3]", unsupported). Was: **fabricated "then" values after the code lead.** `cold-postgres-no-record` passed its asserts but answered "Supabase Pro: then $25/month → now $25/month [1] — Unchanged" with NO history, so the "then" is invented. The A4 eval does not forbid "then … →" (A2's does), so it passed. The tally guard correctly added no Summary.
14. **FIXED (freeze exception 2)**: one nudge retry, finish reason logged, offline tests; the real trigger is rare and was not reproduced live. Was: **empty forced answer.** `parallel-official-sources`: 2 search rounds, then the forced final round (tools off) returned no text, so the user got the fallback message. First occurrence; plausibly linked to the round cap of 2 (the forced round now runs more often).
15. **FIXED (freeze exception 4)**: regexes now accept these answers (checked offline against the recorded text). Was: **EVAL FALSE NEGATIVES** (correct answers, regex too strict): `cold-shortlist-unnamed` ("...please name them so I can check..." has no "?"); `s8-conflicting-sources` ("costs either $24 or $29 per month depending on the source [1][2]" lacks the listed keywords).
17. **KNOWN LIMIT, after the last fix (absence rule in the always-present prompt)**: A4, 3 runs: no explicit "has not changed" (was 1/3); cited current prices 2/3; 1/3 none (honest "cannot tell what has changed"); one good run wrote "the Pro plan remains at $25/month" (implied unchanged, no earlier value). No further A4 tuning.
18. **OPEN (harness)**: a mid-stream Gemini 503 after text has started is not retried (by design: no duplicate output); the server shows the error, but `evals/run.ts` crashes instead of recording a failed scenario.
19. **OPEN (minor parse gap)**: `recheck-absence-not-evidence` answered correctly but put the label after "now" ("→ now Could not confirm ..."), so `verdict.ts` (which expects "— <label>" at the end) added no Summary and the eval's tally check failed.
16. **FIXED (freeze exception 3)**: lists split into single markers before renumbering. Was: **Minor**: the model sometimes writes "[1, 5]"; `renumberCitations` only handles "[n]", so those are not renumbered or validated.

## Worked well (keep)
- Recall by date, with the exact question and answer, in 1.2 s, no search.
- "No record" for a date with no turns; no invented conversation.
- 5 parallel searches for 5 items, all with `since` set to the right date (memory brief + clock worked).
- Chit-chat answered in 0.7 s without searching.
