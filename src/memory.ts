// Long-term memory. Deliberately boring: SQLite + FTS5 + a stored local date per turn.
// Why not a vector DB? The questions we must answer are "what did I ask on <date>" and
// "what did I ask about <topic>". Date index + keyword search covers both with zero
// extra services, and it is trivial to explain. See docs/decisions.md.
import { DatabaseSync } from "node:sqlite"; // built in: no native build step, `npm install` just works
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { describeDate, describeInstant, localDate, resolvePastDates, singlePastDay, type TimeCtx } from "./time.js";

export interface Claim {
  claim: string; // e.g. "Pipedrive Essential costs $14/user/month"
  asOf?: string; // YYYY-MM-DD the claim was true at answer time
}
export interface SourceRef {
  n: number;
  title: string;
  url: string;
  published?: string;
}
export interface TurnRow {
  id: number;
  user_id: string;
  ts: number;
  local_date: string;
  tz: string;
  user_text: string;
  answer_text: string;
  summary: string | null;
  claims_json: string | null;
  sources_json: string | null;
}

let db: DatabaseSync | null = null;

export function openDb(file = config.dbPath): DatabaseSync {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ts INTEGER NOT NULL,            -- UTC epoch ms
      local_date TEXT NOT NULL,       -- YYYY-MM-DD in the user's tz at the time
      tz TEXT NOT NULL,
      user_text TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      summary TEXT,                   -- filled in async by the fast model
      claims_json TEXT,               -- dated factual claims, used for "is it still correct?"
      sources_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_user_date ON turns(user_id, local_date);
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(user_text, answer_text, summary);
  `);
  return db;
}

/** For tests/evals: start from a clean in-memory database. */
export function resetDb(file = ":memory:") {
  db?.close();
  db = null;
  return openDb(file);
}

export function saveTurn(t: {
  userId: string;
  ts: number;
  tz: string;
  userText: string;
  answerText: string;
  sources?: SourceRef[];
  summary?: string;
  claims?: Claim[];
}): number {
  const d = openDb();
  const info = d
    .prepare(
      `INSERT INTO turns (user_id, ts, local_date, tz, user_text, answer_text, summary, claims_json, sources_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.userId,
      t.ts,
      localDate(t.ts, t.tz),
      t.tz,
      t.userText,
      t.answerText,
      t.summary ?? null,
      t.claims ? JSON.stringify(t.claims) : null,
      t.sources ? JSON.stringify(t.sources) : null,
    );
  const id = Number(info.lastInsertRowid);
  d.prepare(`INSERT INTO turns_fts(rowid, user_text, answer_text, summary) VALUES (?, ?, ?, ?)`).run(
    id,
    t.userText,
    t.answerText,
    t.summary ?? "",
  );
  return id;
}

/** Called after the background summariser finishes. Updates FTS too. */
export function attachSummary(id: number, summary: string, claims: Claim[]) {
  const d = openDb();
  d.prepare(`UPDATE turns SET summary = ?, claims_json = ? WHERE id = ?`).run(
    summary,
    JSON.stringify(claims),
    id,
  );
  const row = d.prepare(`SELECT user_text, answer_text FROM turns WHERE id = ?`).get(id) as unknown as
    | { user_text: string; answer_text: string }
    | undefined;
  if (!row) return;
  d.prepare(`DELETE FROM turns_fts WHERE rowid = ?`).run(id);
  d.prepare(`INSERT INTO turns_fts(rowid, user_text, answer_text, summary) VALUES (?, ?, ?, ?)`).run(
    id,
    row.user_text,
    row.answer_text,
    summary,
  );
}

export function recentTurns(userId: string, limit = config.recentTurnsInContext): TurnRow[] {
  const rows = openDb()
    .prepare(`SELECT * FROM turns WHERE user_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(userId, limit) as unknown as TurnRow[];
  return rows.reverse();
}

export function allTurns(userId: string, limit = 200): TurnRow[] {
  const rows = openDb()
    .prepare(`SELECT * FROM turns WHERE user_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(userId, limit) as unknown as TurnRow[];
  return rows.reverse();
}

const STOP = new Set(
  "the a an and or but of to in on at for with about from is are was were be been do does did i me my we our you your it its this that these those what which who whom how when where why can could would should will just any all some has have had has not no yes please tell ask asked said last since then now today yesterday tomorrow".split(
    " ",
  ),
);

/** Turn free text into a safe FTS5 OR query. Quotes every token so punctuation can't break MATCH. */
export function ftsQuery(text: string): string | null {
  const tokens = (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g) ?? [])
    .map((t) => t.replace(/[.-]+$/, ""))
    .filter((t) => t.length > 2 && !STOP.has(t));
  const uniq = [...new Set(tokens)].slice(0, 12);
  if (!uniq.length) return null;
  return uniq.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export interface Recall {
  byDate: TurnRow[];
  byTopic: TurnRow[];
  dates: string[];
  missingDates: string[]; // referenced dates with no turns at all (today excluded)
  inTranscriptDates: string[]; // referenced dates whose turns are all in the recent transcript (today excluded)
}

/**
 * Find past turns relevant to a new message:
 *  1. turns on any date the user referred to ("last Tuesday", "3 November")
 *  2. turns that match the message's keywords (BM25 via FTS5)
 * Turns already in the recent window are excluded; they're in the prompt verbatim.
 */
export function recall(userId: string, text: string, time: TimeCtx): Recall {
  const d = openDb();
  const recentIds = new Set(recentTurns(userId).map((t) => t.id));
  const dates = resolvePastDates(text, time);

  const byDate: TurnRow[] = [];
  for (const date of dates) {
    const rows = d
      .prepare(`SELECT * FROM turns WHERE user_id = ? AND local_date = ? ORDER BY ts`)
      .all(userId, date) as unknown as TurnRow[];
    byDate.push(...rows);
  }

  let byTopic: TurnRow[] = [];
  const q = ftsQuery(text);
  if (q) {
    try {
      byTopic = d
        .prepare(
          `SELECT t.* FROM turns_fts f JOIN turns t ON t.id = f.rowid
           WHERE turns_fts MATCH ? AND t.user_id = ?
           ORDER BY bm25(turns_fts) LIMIT ?`,
        )
        .all(q, userId, config.recallTurns) as unknown as TurnRow[];
    } catch {
      byTopic = []; // a bad FTS query must never break a chat turn
    }
  }

  // Say "no saved turns" only when there truly are none. A date whose turns are all in the recent
  // window is "in the transcript", not empty: conflating the two made the brief contradict the
  // transcript. Today is never reported empty: "is it still correct today?" is not a memory lookup.
  const today = localDate(time.now, time.tz);
  const withTurns = new Set(byDate.map((r) => r.local_date));
  const missingDates = dates.filter((x) => !withTurns.has(x) && x !== today);
  const inTranscriptDates = dates.filter(
    (x) => x !== today && withTurns.has(x) && byDate.every((r) => r.local_date !== x || recentIds.has(r.id)),
  );

  const seen = new Set<number>();
  const keep = (rows: TurnRow[]) =>
    rows.filter((r) => {
      if (recentIds.has(r.id) || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  return {
    byDate: keep(byDate).slice(0, config.recallTurns),
    byTopic: keep(byTopic).slice(0, config.recallTurns),
    dates,
    missingDates,
    inTranscriptDates,
  };
}

function fmtTurn(t: TurnRow): string {
  const claims: Claim[] = t.claims_json ? JSON.parse(t.claims_json) : [];
  const sources: SourceRef[] = t.sources_json ? JSON.parse(t.sources_json) : [];
  const lines = [
    `#### ${describeInstant(t.ts, t.tz)}`,
    `User asked: ${t.user_text}`,
    t.summary ? `Your answer (summary): ${t.summary}` : `Your answer: ${t.answer_text.slice(0, 600)}`,
  ];
  if (claims.length)
    lines.push(
      "Claims you made then:\n" + claims.map((c) => `- ${c.claim}${c.asOf ? ` (as of ${c.asOf})` : ""}`).join("\n"),
    );
  if (sources.length) lines.push("Sources then: " + sources.slice(0, 4).map((s) => s.url).join(", "));
  return lines.join("\n");
}

// References to a conversation WITH US only. "We shortlisted on Monday" is the user describing their own
// week, not a claim that we spoke, so it must not trigger "I have no record of a conversation with you".
const ASKS_ABOUT_US = /\b(did I ask|I asked you|you told me|you said|your answer|last time I asked)\b/i;

/**
 * A fixed first line for a question about a past conversation that does not exist. "No conversation on
 * that day" is a fact code knows for certain; three rounds of prompt wording did not make the model state
 * it reliably (it skipped it, or named the wrong date). Fires only when ALL hold:
 *   1. the message refers to a conversation with us (ASKS_ABOUT_US);
 *   2. it names exactly one explicit past day (not a range, not "last week");
 *   3. nothing is saved on that day, nothing matches the topic on any other day, and the recent
 *      transcript is empty: if anything related exists, the model must look at it instead.
 */
export function noRecordLead(text: string, r: Recall, recentCount: number, time: TimeCtx): string | null {
  if (!ASKS_ABOUT_US.test(text)) return null;
  const day = singlePastDay(text, time);
  if (!day || !r.missingDates.includes(day)) return null;
  if (r.byDate.length || r.byTopic.length || recentCount > 0) return null;
  return `I have no record of a conversation with you on ${describeDate(day)}.`;
}

/**
 * The "earlier conversations" section injected into the system prompt ("memory brief" in code only).
 * Facts only, no instructions, in a voice that is harmless if the model echoes it: the old
 * "There are NO saved turns ... Say so plainly; do not guess." got repeated to users and discouraged
 * answering the still-answerable part of a question. Dates are spelled out ("Monday 9 November 2026")
 * so the model does not have to work out the weekday itself.
 */
export function buildMemoryBrief(r: Recall, opts: { missingLine?: boolean } = {}): string {
  const parts: string[] = [];
  const days = (ds: string[]) => ds.map(describeDate).join(" or ");
  if (r.missingDates.length && opts.missingLine !== false) parts.push(`No conversation is saved for ${days(r.missingDates)}.`);
  if (r.inTranscriptDates.length) parts.push(`The conversation on ${days(r.inTranscriptDates)} is in the chat above.`);
  if (r.byDate.length) parts.push(`### Saved conversations from ${days(r.dates)}\n` + r.byDate.map(fmtTurn).join("\n\n"));
  if (r.byTopic.length) parts.push("### Possibly related earlier conversations\n" + r.byTopic.map(fmtTurn).join("\n\n"));
  return parts.join("\n\n");
}
