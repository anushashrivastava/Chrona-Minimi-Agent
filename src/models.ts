// Which model serves a call, and what to do when it fails. Free-tier Gemini models get retired for new
// keys (404/403) or overloaded (503) without notice, so a call walks MODEL -> MODEL_FALLBACKS in order.
import { config } from "./config.js";

const statusOf = (e: unknown) => (e as { status?: number })?.status ?? 0;
const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

/** 404/403: this model is gone for this key. Not coming back mid-session. */
function isGone(e: unknown): boolean {
  return [403, 404].includes(statusOf(e)) || /NOT_FOUND|PERMISSION_DENIED|no longer available/i.test(messageOf(e));
}

/** 503: overloaded right now. Another model is likely to answer sooner than this one recovers. */
function isOverloaded(e: unknown): boolean {
  return statusOf(e) === 503 || /UNAVAILABLE|high demand|overloaded/i.test(messageOf(e));
}

/** Worth retrying the same model after a pause (rate limit, transient server error). */
function isRetryable(e: unknown): boolean {
  return [429, 500].includes(statusOf(e)) || /RESOURCE_EXHAUSTED|INTERNAL/i.test(messageOf(e)) || isOverloaded(e);
}

// Models that returned 404/403 are skipped for the life of the process, so a retired model costs one
// failed round trip once, not on every turn.
const gone = new Set<string>();

export function modelChain(primary: string): string[] {
  const all = [...new Set([primary, ...config.modelFallbacks])];
  const alive = all.filter((m) => !gone.has(m));
  return alive.length ? alive : all; // all "gone" usually means a bad key: let the real error surface
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `call` on the primary model, falling back on 404/403/503 and backing off on 429/500 (or 503 when
 * no fallback is left). `canRetry` lets a streaming caller refuse once text has reached the user, since a
 * retry would duplicate output. Returns the model that answered, so a multi-round turn can stay on it.
 */
export async function withModelFallback<T>(
  primary: string,
  call: (model: string) => Promise<T>,
  opts: { label: string; retries: number; baseDelayMs: number; canRetry?: () => boolean },
): Promise<{ value: T; model: string }> {
  const chain = modelChain(primary);
  let i = 0;
  let attempt = 0;
  for (;;) {
    const model = chain[i];
    try {
      return { value: await call(model), model };
    } catch (e) {
      if (opts.canRetry && !opts.canRetry()) throw e;
      if (isGone(e)) gone.add(model);
      if ((isGone(e) || isOverloaded(e)) && i < chain.length - 1) {
        console.warn(`[model] ${opts.label}: ${model} failed (${messageOf(e).slice(0, 80)}); trying ${chain[i + 1]}`);
        i++;
        continue;
      }
      if (isRetryable(e) && attempt < opts.retries) {
        await sleep(opts.baseDelayMs * 2 ** attempt++);
        continue;
      }
      throw e;
    }
  }
}
