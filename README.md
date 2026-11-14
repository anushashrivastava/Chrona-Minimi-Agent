# Chat agent with web search + time-aware memory (Gemini)

```bash
npm install
cp .env.example .env     # add GEMINI_API_KEY and TAVILY_API_KEY (both have free tiers, no card)
npm run doctor           # 10-second check: keys work, model IDs exist for your key
npm run dev              # http://localhost:3000
```

Requires **Node 22.13+** (uses the built-in `node:sqlite`, so there is no native build step). See `DESIGN.md` for how and why it works.

## API (for testing without the UI)
```bash
curl -N -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"userId":"me","message":"What is the latest Node.js LTS?","tz":"Asia/Kolkata"}'
```
Streams SSE events: `status`, `text`, `reset`, `sources`, `done`, `error`. History: `GET /api/history?userId=me`.

## Checks
| command | needs keys | what it proves |
|---|---|---|
| `npm run typecheck` | no | types |
| `npm run check:memory` | no | date parsing + recall ("last Tuesday", "3 November") |
| `npm run check:loop` | no | the agent loop end to end against local mock servers |
| `npm run doctor` | yes | your keys and model IDs actually work |
| `npm run eval` | yes | live scenarios with seeded history and a fake clock |

## Env
| var | purpose |
|---|---|
| `GEMINI_API_KEY` | model (free tier: https://aistudio.google.com/apikey) |
| `TAVILY_API_KEY` | web search (free tier: https://app.tavily.com) |
| `MODEL` / `FAST_MODEL` | answer model / background summariser (default `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`; `npm run doctor` checks both) |
| `MODEL_FALLBACKS` | comma-separated models tried in order on 404/403/503 (default: the two lite models back each other up) |
| `THINKING_BUDGET` | leave empty. The default model already uses 0 thinking tokens, and `0` is rejected with a 400 by `gemini-3.5-flash-lite` |
| `ALLOW_FAKE_NOW=1` | testing only: honour the `x-fake-now` header |

## Known limitations
Measured on `gemini-3.5-flash-lite` (free tier) with small samples; details and exact answers in [docs/failures.md](docs/failures.md).
- **"Last Tuesday I asked you about X. Has pricing changed?" with no saved history**: the "no record of Tuesday, 10 November" line is stated by code and always correct, but the model does not always answer the current part: in 3 runs, 2 gave cited current prices and 1 gave none; one of the good runs still said a price "remains" without an earlier value to compare.
- **"On Monday we shortlisted HubSpot, Pipedrive, ..." with no saved history**: gives cited current prices and news per tool, but does not say it has no earlier figures to compare against or name Monday's date.
- **A reference to a list that was never given, when unrelated history exists** (e.g. "has anything on the shortlist changed?" after an unrelated chat): asks which list about half the time; otherwise it treats an unrelated item from history as the list or answers without asking.
