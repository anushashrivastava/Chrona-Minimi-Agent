// The ONE tool the model gets: web_search. Everything else (memory, clock) is plumbing
// around the model, not a tool it must decide to call.
import type { FunctionDeclaration } from "@google/genai";
import { config, requireEnv } from "./config.js";
import type { SourceRef } from "./memory.js";

export const searchTool: FunctionDeclaration = {
  name: "web_search",
  description:
    "Search the web for current information. Use it for anything that can change (prices, versions, news, " +
    "who holds a role, availability) and to check whether an earlier answer is still correct. " +
    "Make queries short and specific. Issue several searches in parallel when you need to cover several items " +
    "(one query per item). `since` restricts to pages published after a date: use it to look for news of a " +
    "change, never as the only check of a current value (pricing/docs pages are rarely republished).",
  parametersJsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query, 2-8 words, no filler." },
      since: {
        type: "string",
        description: "Optional YYYY-MM-DD. Only return results published on/after this date.",
      },
      topic: {
        type: "string",
        enum: ["general", "news"],
        description: "Use 'news' for recent events and announcements.",
      },
    },
    required: ["query"],
  },
};

export interface SearchInput {
  query: string;
  since?: string;
  topic?: "general" | "news";
}

interface RawResult {
  title: string;
  url: string;
  content: string;
  published_date?: string | null;
}

/** Per-turn numbering so [1], [2]... stay consistent across multiple searches in one answer. */
export class SourceRegistry {
  private byUrl = new Map<string, SourceRef>();
  add(r: RawResult): SourceRef {
    const hit = this.byUrl.get(r.url);
    if (hit) return hit;
    const ref: SourceRef = { n: this.byUrl.size + 1, title: r.title, url: r.url, published: r.published_date ?? undefined };
    this.byUrl.set(r.url, ref);
    return ref;
  }
  list(): SourceRef[] {
    return [...this.byUrl.values()];
  }
}

/**
 * Final citation pass over an answer. Registry numbers follow the order results ARRIVED (an answer could
 * cite [21][23]), so cited sources are renumbered 1, 2, 3... in order of FIRST APPEARANCE in the text, and
 * the chips get the same numbers. Any [n] this turn never saw is dropped in the same pass: a dead
 * citation looks like evidence and is not.
 */
export function renumberCitations(answer: string, seen: SourceRef[]): { answer: string; sources: SourceRef[] } {
  const byN = new Map(seen.map((s) => [s.n, s]));
  const map = new Map<number, number>();
  const text = answer.replace(/\s*\[(\d+)\]/g, (m, raw) => {
    const n = Number(raw);
    if (!byN.has(n)) return "";
    if (!map.has(n)) map.set(n, map.size + 1);
    return m.replace(raw, String(map.get(n)));
  });
  const sources = [...map].map(([old, n]) => ({ ...byN.get(old)!, n }));
  return { answer: text, sources };
}

// Tiny in-process cache: the same query on the same day returns the same answer, so skip the network.
const cache = new Map<string, { at: number; results: RawResult[] }>();
const TTL_MS = 10 * 60 * 1000;

async function tavily(input: SearchInput): Promise<RawResult[]> {
  const key = JSON.stringify([input.query, input.since ?? "", input.topic ?? "general"]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.results;

  const body: Record<string, unknown> = {
    query: input.query,
    search_depth: config.searchDepth,
    max_results: config.maxSearchResults,
    topic: input.topic ?? "general",
    // Without this, general searches return no dates and "has it changed since X?" gets much weaker.
    // (Tavily docs: include_published_date, beta; dates can be null, and are on by default for topic=news.)
    include_published_date: true,
  };
  // start_date keeps results published on/after the date. filter_by_published_date stays false on purpose,
  // so sources with no detectable date are kept rather than silently dropped.
  if (input.since && /^\d{4}-\d{2}-\d{2}$/.test(input.since)) body.start_date = input.since;

  const res = await fetch(`${process.env.TAVILY_BASE_URL ?? "https://api.tavily.com"}/search`, { // TAVILY_BASE_URL: offline test only
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${requireEnv("TAVILY_API_KEY")}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  const json = (await res.json()) as { results?: RawResult[] };
  const results = json.results ?? [];
  cache.set(key, { at: Date.now(), results });
  return results;
}

/** Runs one search and formats it for the model. Errors become text the model can reason about. */
export async function runSearch(
  input: SearchInput,
  registry: SourceRegistry,
): Promise<{ text: string; isError: boolean }> {
  if (typeof input?.query !== "string" || !input.query.trim())
    return { text: "web_search needs a non-empty `query` string.", isError: true };
  try {
    const results = await tavily(input);
    if (!results.length) return { text: `No results for "${input.query}".`, isError: false };
    const blocks = results.map((r) => {
      const ref = registry.add(r);
      const date = r.published_date ? ` · published ${r.published_date}` : "";
      const content = r.content.replace(/\s+/g, " ").slice(0, config.maxCharsPerResult);
      return `[${ref.n}] ${r.title}${date}\n${r.url}\n${content}`;
    });
    return { text: blocks.join("\n\n"), isError: false };
  } catch (e) {
    return {
      text: `Search failed (${(e as Error).message}). Tell the user you could not verify this, rather than guessing.`,
      isError: true,
    };
  }
}
