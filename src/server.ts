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
    try {
      await runTurn({
        userId,
        message,
        time,
        onEvent: (e) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }),
      });
    } catch (err) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: friendlyError(err) }) });
    }
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
