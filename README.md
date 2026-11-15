# CHRONA

A chat agent with one tool (web search) and time-aware memory. It answers with cited, dated sources and remembers what you asked and when, so it can answer "What did I ask you on 3 November? Is your answer still correct today?". How and why it is built this way: [DESIGN.md](DESIGN.md).

## How to run

**You need:** Node.js **22.13 or newer** (it uses the built-in `node:sqlite`, so there is no native build step) and two free API keys, neither needing a card:
- Gemini: https://aistudio.google.com/apikey
- Tavily (web search): https://app.tavily.com

**1. Install**
```bash
git clone https://github.com/anushashrivastava/Chrona-Minimi-Agent.git
cd Chrona-Minimi-Agent
npm install
```

**2. Add your keys.** Copy the example file, then open `.env` and fill in `GEMINI_API_KEY` and `TAVILY_API_KEY`. Put them in `.env`, never in `.env.example`, which is committed.
```bash
cp .env.example .env
```

**3. Check the setup** (about 10 seconds). It confirms both keys work and calls every configured model, because a model can be listed for your key and still be unavailable to it.
```bash
npm run doctor
```
If a model line shows `✗`, set `MODEL` / `FAST_MODEL` in `.env` to one of the models it lists.

**4. Start it**
```bash
npm run dev
```
Open http://localhost:3000. Your chat history is saved in `data/agent.db` and restored when you reload. Each browser gets its own user id.

**Things to try:** "What's the latest stable Node.js version?" · "Compare Neon and Supabase pricing" · and later, "What did I ask you earlier today? Is your answer still correct?"

## Use it without the UI
```bash
curl -N -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"userId":"me","message":"What is the latest Node.js LTS?","tz":"Asia/Kolkata"}'
```
The response is a stream of server-sent events: `status` (e.g. "Searching: ..."), `text` (answer chunks), `reset` (discard the text shown so far; the full corrected text follows), `sources` (the cited sources, numbered as in the text), `done` (timings and searches), `error`. History: `GET /api/history?userId=me`.

## Checks
| command | needs keys | what it proves |
|---|---|---|
| `npm run typecheck` | no | types |
| `npm run check:memory` | no | date parsing, recall, and the "no record" guards |
| `npm run check:loop` | no | the agent loop end to end against local mock Gemini/Tavily servers (citations, fallbacks, retries, the tally) |
| `npm run doctor` | yes | your keys and model IDs actually work |
| `npm run eval` | yes | 18 live scenarios with seeded history and a fixed clock; `npm run eval -- cold` runs those whose name contains "cold"; `EVAL_SHOW=1` prints full answers |

Live evals use real Tavily credits (roughly 25 for a full run on the free tier's 1,000/month).

## Env
| var | purpose |
|---|---|
| `GEMINI_API_KEY` | model (free tier: https://aistudio.google.com/apikey) |
| `TAVILY_API_KEY` | web search (free tier: https://app.tavily.com) |
| `MODEL` / `FAST_MODEL` | answer model / background summariser (default `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`; `npm run doctor` checks both) |
| `MODEL_FALLBACKS` | comma-separated models tried in order on 404/403/503 (default: the two lite models back each other up) |
| `THINKING_BUDGET` | leave empty. The default model already uses 0 thinking tokens, and `0` is rejected with a 400 by `gemini-3.5-flash-lite` |
| `PORT` / `DB_PATH` / `DEFAULT_TZ` | server port (3000), database file (`data/agent.db`), timezone used when a request sends none |
| `SEARCH_DEPTH` | Tavily depth: `basic` (default, 1 credit) or `advanced` |
| `ALLOW_FAKE_NOW=1` | testing only: honour the `x-fake-now` header |

## Troubleshooting
- **`npm run dev` says keys are missing:** `.env` doesn't exist or is empty. Run step 2.
- **"The model's rate limit was hit (free tier)"** or "high demand": wait a minute. Fallback models are tried automatically.
- **`ExperimentalWarning` about SQLite:** expected on Node 22–24; the scripts already suppress it.

## Known limitations
Measured on `gemini-3.5-flash-lite` (free tier) with small samples; details and exact answers in [docs/failures.md](docs/failures.md).
- **"Last Tuesday I asked you about X. Has pricing changed?" with no saved history**: the "no record of Tuesday, 10 November" line is stated by code and always correct, but the model does not always answer the current part: in 3 runs, 2 gave cited current prices and 1 gave none; one of the good runs still said a price "remains" without an earlier value to compare.
- **"On Monday we shortlisted HubSpot, Pipedrive, ..." with no saved history**: gives cited current prices and news per tool, but does not say it has no earlier figures to compare against or name Monday's date.
- **A reference to a list that was never given, when unrelated history exists** (e.g. "has anything on the shortlist changed?" after an unrelated chat): asks which list about half the time; otherwise it treats an unrelated item from history as the list or answers without asking.
