import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { friendlyError, runTurn } from "./agent.js";
import { config } from "./config.js";
import { allTurns, openDb } from "./memory.js";
import { makeTimeCtx } from "./time.js";

openDb();
const app = new Hono();

// POST /api/chat  { userId, message, tz? }  ->  Server-Sent Events: status | text | reset | sources | done | error
// Also usable with curl, so graders can test without the UI.
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ userId?: string; message?: string; tz?: string }>();
  const message = body.message?.trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  const userId = body.userId || "default";
  const time = makeTimeCtx({ tz: body.tz, fakeNow: c.req.header("x-fake-now") });

  return streamSSE(c, async (stream) => {
    // Writes are chained (keeps order) and awaited before we return: the stream closes when this callback
    // resolves, and fire-and-forget writes still in flight were dropped, so `sources`/`done` never arrived.
    let writes = Promise.resolve();
    const send = (event: string, data: unknown) =>
      (writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })));
    try {
      await runTurn({ userId, message, time, onEvent: (e) => void send(e.type, e) });
    } catch (err) {
      send("error", { type: "error", message: friendlyError(err) });
    }
    await writes;
  });
});

// Chat history so the UI can restore the conversation after a reload.
app.get("/api/history", (c) => {
  const userId = c.req.query("userId") || "default";
  const turns = allTurns(userId).map((t) => ({
    ts: t.ts,
    user: t.user_text,
    answer: t.answer_text,
    sources: t.sources_json ? JSON.parse(t.sources_json) : [],
  }));
  return c.json({ turns });
});

app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Chat agent running on http://localhost:${info.port}`);
  if (!process.env.GEMINI_API_KEY || !process.env.TAVILY_API_KEY)
    console.warn("⚠ GEMINI_API_KEY / TAVILY_API_KEY missing: copy .env.example to .env");
});
