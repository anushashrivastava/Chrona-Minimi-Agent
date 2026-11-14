# Step-by-step guide: building the minimi agent with Claude Code

How to read this: every step has **Why** (the reasoning, so you can defend it in the video), **Do**, a **Prompt** to paste into Claude Code, and **Done when**.

## What the starter already is, and what is NOT verified
The starter is a working, typechecked skeleton: server, UI, agent loop, memory, search wrapper, prompts, offline tests, live eval harness.
This is the **Gemini edition** (free keys). It already includes the five fixes from the earlier review (real fake-clock in evals, Tavily published dates, never saving an empty answer, bigger output ceiling with a cut-off notice, logged summary failures); they are in `docs/decisions.md`.
- Verified here: `npm install` (no native build), `npm run typecheck`, `npm run check:memory` (date parsing + recall), `npm run check:loop` (the whole agent loop against local mock Gemini/Tavily servers: parallel searches, function-response turn, citations, saving, empty answers, 429 retry), `npm run dev` boots, UI + history endpoint + graceful error without keys.
- **Not verified (no real API keys in the build environment):** live calls to Gemini and Tavily. The mock test proves *our* logic; only the real API can prove it accepts our requests. `npm run doctor` and Step 3 are where you find out. Likeliest surprises: a model ID that does not exist or has no free quota for your key, and Gemini's exact request validation. That is normal; that is the point of Step 3.

## How to work with Claude Code (applies to every step)
- Open the repo folder, run `claude`. It reads `CLAUDE.md` automatically. **Why:** that file is the project's standing brief (the one-tool rule, no frameworks, log decisions), so you don't re-explain it each session.
- Use **plan mode** (Shift+Tab until it says plan) for anything non-trivial, and read the plan before approving. **Why:** the challenge says "you must be able to explain every decision". A plan you read is a decision you made.
- **One step per session**, `git commit` at the end of each. `/clear` between steps. **Why:** small diffs are reviewable; a commit history that tells a story is also a signal to the graders reading the repo.
- After each step ask: *"Explain the change in 3 sentences and add anything non-obvious to docs/decisions.md."* **Why:** `decisions.md` becomes the raw material for `DESIGN.md` and your video.

---

## Step 0: Accounts and keys (15 min)
**Why:** the agent needs a model and a search API. Get these first so nothing blocks you later. Both have free tiers with no credit card.
**Do:** create a Gemini API key at https://aistudio.google.com/apikey (Google account) and a Tavily key at https://app.tavily.com (1,000 free credits/month). Create a public GitHub repo `minimi-agent`.
**Free-tier reality:** Gemini limits are per model and per project and are shown in the AI Studio rate-limit page; some models may have no free quota. Tavily credits run out if you spam evals. Keep `SEARCH_DEPTH=basic` and don't re-run the full suite after every tiny change.
**Done when:** you have both keys.

## Step 1: Run the starter and commit (15 min)
**Why:** prove the toolchain works on your machine before changing anything. A green baseline lets you tell "I broke it" from "it never worked".
**Do:**
```bash
cd minimi-agent && npm install
cp .env.example .env     # paste both keys (type them in your editor, never into a chat)
npm run typecheck && npm run check:memory && npm run check:loop
npm run doctor           # real keys + real model IDs: tells you in seconds what is wrong
git init && git add -A && git commit -m "Starter: agent loop, memory, search, UI"
```
**Why `doctor` first:** it separates "my key or model ID is wrong" from "the code is wrong", which saves an hour of guessing. If it says a model does not exist, pick one from the list it prints and set `MODEL` / `FAST_MODEL` in `.env`.
**Done when:** the three offline checks pass, `doctor` is green, and the first commit exists. (Confirm `.env` is NOT committed: `git status` should not list it.)

## Step 2: Understand every file (45 min), the most important step
**Why:** graders read the code and will ask why. AI tools are welcome, but you must own the decisions. Doing this now means you can also record the video without notes.
**Prompt (plan mode):**
> Walk me through this codebase in the order a request flows: server.ts → agent.ts → memory.ts/time.ts → search.ts → prompt.ts. For each file: what it does, the one design decision in it that matters most, and what would break if I removed it. Then quiz me with 5 questions about the architecture, one at a time, and tell me whether my answers are right.
**Done when:** you can explain, without looking, (a) why memory is not a tool, (b) why dates are parsed in code, (c) why the stable prompt comes before the dynamic one, (d) what the claims ledger is for.

## Step 3: First live run and fix what breaks (1 h)
**Why:** the starter was never run against the real APIs. Things most likely to need a touch: the model IDs in `.env` (`MODEL`, `FAST_MODEL`), how Gemini validates the function-call/function-response turns, and free-tier 429s.
**Do:** `npm run dev`, open http://localhost:3000, ask "What's the latest stable Node.js version?".
**Prompt:**
> Run `npm run doctor`, then test one real question end to end. If anything fails, check the official Gemini API docs (model IDs, function calling with @google/genai, thinking config) and Tavily docs (include_published_date, start_date) and fix only what does not match, telling me which doc you checked. Confirm in the raw search response that published dates actually come back. Do not change the architecture.
**Done when:** a search-backed answer streams with clickable [n] citations, and a second question in the same chat shows the earlier turn persisted after a page reload.

## Step 4: Prove the three target behaviours by hand (45 min)
**Why:** these are literally the grader's examples. If these three feel good, you're already ahead; if not, you now know what to fix.
**Do:** set `ALLOW_FAKE_NOW=1` and chat via curl with an `x-fake-now` header, or simply seed history with the eval harness (Step 5). Try:
1. "Compare Neon and Supabase for Postgres hosting" (a real turn), then later "What did I ask you earlier today? Is your answer still correct?"
2. "On Monday we shortlisted HubSpot, Pipedrive, Zoho, Close, Freshsales for a 20-person sales team." then "Has any of them changed pricing since Monday?"
3. A question where you gave no earlier context: "Has the shortlist changed pricing?" It should ask what the shortlist was, not invent one.
**Prompt:**
> Write down in docs/failures.md every case where the agent's answer was wrong, slow, or awkward, with the exact input and output. Do not fix anything yet.
**Why a failures list first:** fixing by feel makes you chase the last bug; a written list lets you fix in order of impact and later show "here is what I found and fixed" in DESIGN.md.

## Step 5: Turn the failures into evals (1 h)
**Why:** this is the single biggest differentiator. Most submissions will be demos; yours will have a repeatable test that proves the behaviour. It also lets you change the prompt without fear.
**Prompt:**
> Read docs/failures.md and evals/run.ts. Add one eval scenario per failure, plus at least 5 more covering: a date with no saved turns, ambiguity between two turns on the same day, a follow-up that depends on the previous turn, a question that needs 3 parallel searches, and a stable-knowledge question that should NOT search. Keep assertions cheap (regex + search count + latency). Run npm run eval and show me the results table.
**Done when:** `npm run eval` runs ≥12 scenarios and you can see which pass.

## Step 6: Make the failing evals pass, prompt first, code second (2 h)
**Why:** prompt changes are the cheapest fix and often enough; code changes add complexity you must defend. Always try the cheaper lever first, and re-run all evals so a fix doesn't break another case.
**Prompt (plan mode):**
> Here are the failing eval scenarios. For each: diagnose whether the cause is the prompt, the recall logic, the search layer, or the loop. Propose the smallest fix, in that order of preference. After I approve, implement, run typecheck + check:memory + eval, and log each decision in docs/decisions.md with the alternative you rejected.
**Done when:** evals pass; every change has a decision-log line.

## Step 7: Speed pass, measure before optimising (1 h)
**Why:** "answers fast" is a stated criterion. The UI already shows first-token and total time per answer; use real numbers instead of guessing, and put them in DESIGN.md.
**Prompt:**
> Instrument timing for: context build, time to first model token, search latency per query, and total. Run the eval suite and give me a table (median and worst per scenario). Identify the top two contributors to latency and propose fixes ranked by (gain / complexity). Candidates: trim result size, fewer results, 'basic' search depth, skipping search for non-factual turns, a faster model for easy turns, and the THINKING_BUDGET setting (compare default vs 0 on both speed and eval pass rate). Implement only what the numbers justify.
**Free-tier note:** every model call counts against your quota, including the background summary. Pace evals with `EVAL_DELAY_MS`, and if you hit 429s, try a different `MODEL` rather than adding retries.
**Done when:** you have before/after numbers and a sentence like "median 4.1 s with search, first token under 1.5 s without".

## Step 8: Correctness hardening (1 h)
**Why:** "gets things right" is the second criterion, and wrong-but-confident answers are what a human tester notices instantly.
**Prompt:**
> Review prompt.ts and agent.ts for failure modes of a search-grounded assistant and add checks only where cheap: (1) answer cites a [n] that doesn't exist → strip or flag it, (2) a time-sensitive claim with no date, (3) search failed but the answer sounds certain, (4) two sources conflict. For each, say whether it is better handled in the prompt or in code, implement the code ones, and add an eval for each.
**Done when:** each failure mode has an eval or a deliberate "not handled, because…" line in decisions.md.

## Step 9: Good to talk to (45 min)
**Why:** the brief says "good to talk to". That means tone, brevity, asking one smart question instead of guessing, and a UI that feels responsive; not features.
**Do:** have a friend chat with it for 10 minutes without guidance. Watch where they hesitate.
**Prompt:**
> Here is feedback from a test user: [paste]. Propose changes limited to prompt.ts and public/index.html. Keep the UI minimal; no new libraries.
**Done when:** a stranger can use it without instructions.

## Step 10: Write DESIGN.md for real (1 h)
**Why:** this is half of how you're judged ("we'll read your DESIGN.md"). One page. The draft already has the structure the brief asks for: how it works, why, rejected alternatives, next week.
**Prompt:**
> Rewrite DESIGN.md as a single page using docs/decisions.md, the eval results, and the latency table. Replace every TODO with real numbers. Keep the four required sections. Be specific and a bit opinionated: name the trade-offs we accepted (e.g., FTS5 can miss paraphrased topics) instead of only listing strengths. Max ~500 words.
**Done when:** a stranger could rebuild the agent from it, and it contains your measured numbers.

## Step 11: Fresh-clone test (20 min)
**Why:** the rules say it must run with `npm install` then `npm run dev`. The most common way to lose is a repo that only works on the author's machine.
**Do:**
```bash
cd /tmp && git clone <your-repo-url> fresh && cd fresh
npm install && cp .env.example .env   # add keys
npm run dev
```
Check: `.env.example` lists every key; `DESIGN.md` is at the repo root; the repo is public (open it in a private window); Node version stated in README.
**Done when:** the fresh clone answers a question.

## Step 12: Video (60 s) and form
**Why:** 60 seconds forces clarity, and they're hiring for how you think. Structure it as problem → insight → proof.
**Script skeleton (≈150 words):**
1. (10 s) "The hard part of this task isn't web search. It's *time*: 'what did I ask on 3 November, is it still right?'"
2. (25 s) "So memory isn't a second tool, since the brief says one tool. It's plumbing before the model: I parse dates in code, look up past turns in SQLite by date and keyword, and give the model a memory brief plus today's date."
3. (15 s) "For 'is it still correct', I store the claims each answer made with their dates, then re-search them with a since-date and answer what changed, what didn't, and what I couldn't confirm."
4. (10 s) Live demo: ask the question, point at the streaming status and citations.
5. (5 s) "I tested it with a fake clock and an eval suite; with another week, scheduled re-checks."

**Form:** name, email, LinkedIn, college = yes, your three ranked projects (link + what it does + hardest part; lead with the ones you can explain in the most depth), the repo link, the video, and in "anything else" one line: *"Built with Claude Code; every decision is in docs/decisions.md and DESIGN.md."* (honest and welcome, per the brief).

---

## Time plan
| Block | Steps |
|---|---|
| Sat night | 0-3 |
| Sun morning | 4-6 |
| Sun afternoon | 7-9 |
| Sun evening | 10-12 and submit |

Reviews are first come, first served, but a better architecture beats an earlier one. Don't skip Step 5; the evals are your edge.
