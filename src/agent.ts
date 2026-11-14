// The agent: a plain tool-use loop on the Gemini API. No framework, so every line is explainable.
//   1. build context (clock + memory brief + recent turns)
//   2. stream the model; if it asks for searches, run them in parallel and loop (capped)
//   3. save the turn; summarise it in the background (off the critical path)
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type Part,
} from "@google/genai";
import { config, requireEnv } from "./config.js";
import {
  attachSummary,
  buildMemoryBrief,
  recall,
  recentTurns,
  saveTurn,
  type Claim,
  type SourceRef,
} from "./memory.js";
import { dynamicPrompt, STABLE_PROMPT, SUMMARY_PROMPT } from "./prompt.js";
import { withModelFallback } from "./models.js";
import { summaryLine } from "./verdict.js";
import { runSearch, searchTool, SourceRegistry, type SearchInput } from "./search.js";
import { describeInstant, localDate, type TimeCtx } from "./time.js";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "reset" } // model wrote text, then decided to search: discard the partial text
  | { type: "sources"; sources: SourceRef[] }
  | { type: "done"; timings: Timings; searches: SearchInput[] };

export interface Timings {
  firstTokenMs: number | null;
  totalMs: number;
  rounds: number;
}

export interface TurnResult {
  answer: string;
  sources: SourceRef[];
  searches: SearchInput[];
  searchesPerRound: number[]; // e.g. [3] = one parallel round, [1,1,1] = sequential (slow)
  timings: Timings;
  turnId: number | null; // null when nothing was saved (empty/blocked answer)
}

const FALLBACK_ANSWER = "Sorry, I couldn't produce an answer to that. Try rephrasing, or ask again in a moment.";

let client: GoogleGenAI | null = null;
// GEMINI_BASE_URL is only for the offline loop test (a local mock server); leave unset in real use.
const gemini = () =>
  (client ??= new GoogleGenAI({
    apiKey: requireEnv("GEMINI_API_KEY"),
    ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}),
  }));

/** Turn provider errors into something a user can act on. */
export function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/429|RESOURCE_EXHAUSTED/i.test(msg))
    return "The model's rate limit was hit (free tier). Wait about a minute and try again.";
  if (/API key|API_KEY_INVALID|401|403|PERMISSION_DENIED/i.test(msg))
    return "The Gemini API key was rejected. Check GEMINI_API_KEY in .env.";
  return msg;
}

interface Round {
  parts: Part[];
  text: string;
  calls: FunctionCall[];
  finishReason?: string;
}

/**
 * One streamed model call. Text goes to onText as it arrives; function calls are collected.
 * Falls back / retries (see models.ts) only while no text has reached the user.
 */
async function streamRound(opts: {
  model: string;
  contents: Content[];
  system: string;
  forceAnswer: boolean; // last round: forbid more tool calls
  onText: (delta: string) => void;
}): Promise<Round & { model: string }> {
  let streamedText = false;
  const { value, model } = await withModelFallback(
    opts.model,
    async (model) => {
      const stream = await gemini().models.generateContentStream({
        model,
        contents: opts.contents,
        config: {
          systemInstruction: opts.system,
          maxOutputTokens: config.maxOutputTokens,
          tools: [{ functionDeclarations: [searchTool] }],
          toolConfig: {
            functionCallingConfig: {
              mode: opts.forceAnswer ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO,
            },
          },
          // We run the loop ourselves (parallel searches, caps, status events), so no SDK auto-execution.
          automaticFunctionCalling: { disable: true },
          ...(config.thinkingBudget !== undefined
            ? { thinkingConfig: { thinkingBudget: config.thinkingBudget } }
            : {}),
        },
      });

      const parts: Part[] = [];
      let text = "";
      let finishReason: string | undefined;
      for await (const chunk of stream) {
        const cand = chunk.candidates?.[0];
        if (cand?.finishReason) finishReason = String(cand.finishReason);
        for (const p of cand?.content?.parts ?? []) {
          parts.push(p); // keep the model's parts verbatim: Gemini needs them back (e.g. thought signatures)
          if (p.text && !p.thought) {
            text += p.text;
            streamedText = true;
            opts.onText(p.text);
          }
        }
      }
      const calls = parts.flatMap((p) => (p.functionCall ? [p.functionCall] : []));
      return { parts, text, calls, finishReason };
    },
    { label: "answer", retries: 2, baseDelayMs: 1500, canRetry: () => !streamedText },
  );
  return { ...value, model };
}

export async function runTurn(opts: {
  userId: string;
  message: string;
  time: TimeCtx;
  onEvent?: (e: AgentEvent) => void;
  awaitSummary?: boolean; // evals await it so claims exist before the next turn
}): Promise<TurnResult> {
  const { userId, message, time } = opts;
  const emit = opts.onEvent ?? (() => {});
  const t0 = Date.now();

  // --- 1. context -----------------------------------------------------------
  const recent = recentTurns(userId);
  const brief = buildMemoryBrief(recall(userId, message, time));
  const contents: Content[] = [];
  for (const t of recent) {
    contents.push({ role: "user", parts: [{ text: `[${describeInstant(t.ts, t.tz)}] ${t.user_text}` }] });
    contents.push({ role: "model", parts: [{ text: t.answer_text }] });
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  // Stable text first, per-turn text (date + memory) last: keeps the shared prefix identical across turns,
  // which is what any provider-side prompt caching keys on.
  const system = STABLE_PROMPT + "\n" + dynamicPrompt(time, brief);

  // --- 2. tool loop -----------------------------------------------------------
  const registry = new SourceRegistry();
  const searches: SearchInput[] = [];
  const searchesPerRound: number[] = [];
  let failedSearches = 0;
  let firstTokenMs: number | null = null;
  let answer = "";
  let rounds = 0;
  // Starts at MODEL; if a fallback answers, later rounds stay on it: replaying one model's parts (thought
  // signatures) to another model is asking for a 400.
  let turnModel = config.model;

  for (let round = 0; round <= config.maxToolRounds; round++) {
    rounds++;
    const forceAnswer = round === config.maxToolRounds; // force an answer, no more searching
    const r = await streamRound({
      model: turnModel,
      contents,
      system,
      forceAnswer,
      onText: (delta) => {
        firstTokenMs ??= Date.now() - t0;
        emit({ type: "text", delta });
      },
    });

    turnModel = r.model;
    if (!r.calls.length || forceAnswer) {
      answer = r.text;
      if (r.finishReason === "MAX_TOKENS") {
        const note = "\n\n_(The answer was cut off because it hit the output length limit.)_";
        answer += note;
        emit({ type: "text", delta: note });
      }
      break;
    }
    if (r.text) emit({ type: "reset" });

    contents.push({ role: "model", parts: r.parts });
    const inputs = r.calls.map((c) => (c.args ?? {}) as unknown as SearchInput);
    searches.push(...inputs);
    searchesPerRound.push(inputs.length);
    emit({ type: "status", text: "Searching: " + inputs.map((i) => i.query).join(" · ") });

    // Parallel: N searches cost about the latency of one.
    const results = await Promise.all(inputs.map((i) => runSearch(i, registry)));
    failedSearches += results.filter((x) => x.isError).length;
    contents.push({
      role: "user",
      parts: r.calls.map((c, i) => ({
        functionResponse: {
          id: c.id,
          name: c.name,
          response: results[i].isError ? { error: results[i].text } : { output: results[i].text },
        },
      })),
    });
  }

  // A citation must point at a source this turn actually saw. The model can cite a number it never got
  // (or one from an earlier turn in the transcript); a dead [n] looks like evidence and is not. Strip it.
  // Rare, so when it happens we resend the cleaned text with the existing `reset` event rather than
  // complicating the stream; the saved answer is the cleaned one.
  const known = new Set(registry.list().map((s) => s.n));
  const cleaned = answer.replace(/\s*\[(\d+)\]/g, (m, n) => (known.has(Number(n)) ? m : ""));
  if (cleaned !== answer) {
    answer = cleaned;
    emit({ type: "reset" });
    emit({ type: "text", delta: answer });
  }

  // Empty answer (safety block, refusal, cut-off before any text): never save it. A saved empty
  // assistant turn would be replayed into every later request and could break the chat for good.
  if (!answer.trim()) {
    emit({ type: "text", delta: FALLBACK_ANSWER });
    const timings: Timings = { firstTokenMs, totalMs: Date.now() - t0, rounds };
    emit({ type: "done", timings, searches });
    return { answer: FALLBACK_ANSWER, sources: [], searches, searchesPerRound, timings, turnId: null };
  }

  // Re-check answers: the tally is computed from the per-item labels (verdict.ts), appended as one final
  // delta so nothing already streamed is rewritten, and saved with the answer.
  const summary = summaryLine(answer);
  if (summary) {
    const delta = `\n\n${summary}`;
    answer += delta;
    emit({ type: "text", delta });
  }

  // Every search failed: whatever the answer says, nothing in it was checked. That is a fact we know in
  // code, so code states it (the prompt asks the model to say so too, but it can sound certain anyway).
  if (searches.length && failedSearches === searches.length) {
    const delta = "\n\n_(Web search failed for this answer, so none of it could be checked against sources.)_";
    answer += delta;
    emit({ type: "text", delta });
  }

  // Only keep sources the answer actually cites; [n] already matches the registry numbers.
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const sources = registry.list().filter((s) => cited.has(s.n));
  if (sources.length) emit({ type: "sources", sources });

  const timings: Timings = { firstTokenMs, totalMs: Date.now() - t0, rounds };
  emit({ type: "done", timings, searches });

  // --- 3. persist + background summary -------------------------------------------
  const turnId = saveTurn({
    userId,
    ts: time.now.getTime(),
    tz: time.tz,
    userText: message,
    answerText: answer,
    sources,
  });
  const summarise = summariseTurn(turnId, message, answer, localDate(time.now, time.tz));
  if (opts.awaitSummary) await summarise;

  return { answer, sources, searches, searchesPerRound, timings, turnId };
}

/**
 * Fast model distils a turn into a summary + dated claims. Fire-and-forget in production.
 * Failures are logged (not thrown): a missing summary degrades recall but must never break a chat.
 */
async function summariseTurn(turnId: number, q: string, a: string, date: string) {
  try {
    // Background, so it can afford patience: fallbacks plus 3 backoff retries (2 s, 4 s, 8 s). Without this,
    // free-tier 503s left half the turns with no claims, and "is it still correct?" had nothing to re-check.
    const { value: res } = await withModelFallback(
      config.fastModel,
      (model) =>
        gemini().models.generateContent({
          model,
          contents: `Turn date: ${date}\n\nUser: ${q}\n\nAssistant: ${a}`,
          config: {
            systemInstruction: SUMMARY_PROMPT,
            responseMimeType: "application/json",
            maxOutputTokens: 800,
            temperature: 0,
          },
        }),
      { label: "summary", retries: 3, baseDelayMs: 2000 },
    );
    const json = (res.text ?? "").match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("summary model returned no JSON");
    const parsed = JSON.parse(json) as { summary?: string; claims?: Claim[] };
    attachSummary(turnId, parsed.summary ?? "", Array.isArray(parsed.claims) ? parsed.claims.slice(0, 8) : []);
  } catch (e) {
    console.warn(`[summary] turn ${turnId} not summarised: ${(e as Error).message}`);
  }
}
