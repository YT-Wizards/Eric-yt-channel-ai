import "server-only";
import { db, getActiveChannelId } from "./db";

/**
 * Safe read-only SQL executor for Claude.
 *
 * Hard rules:
 *   - Only SELECT / WITH statements
 *   - Only whitelisted tables (videos, channels, transcripts, comments).
 *     Other datasets (competitors, hooks, comment_analysis, …) have their
 *     own dedicated chat tools and are deliberately NOT exposed to raw SQL.
 *   - Caps rows returned
 *   - Disallows comments + multiple statements (defence-in-depth against
 *     prompt-injected `;DELETE …`)
 *
 * Channel scoping (CRITICAL — multi-channel users had cross-channel leaks):
 *   - The active channel is auto-injected as CTE shadows of `videos`,
 *     `transcripts`, and `comments`. Claude can write `SELECT … FROM
 *     videos …` as usual and it transparently sees only the active
 *     channel's rows. Same for transcripts and comments (joined through
 *     videos.id). The underlying tables remain accessible as `main.<name>`
 *     ONLY through our own CTE definitions — Claude can't reach them.
 *   - If there's no active channel, raw_sql is rejected outright. Better
 *     than silently returning empty (Claude can't tell the difference
 *     between "no rows match" and "the tool was blocked").
 *   - The `channels` table is NOT auto-scoped — Claude needs to list
 *     channels for context. That's safe: it's metadata, no per-channel
 *     numbers leak.
 */

const ALLOWED_TABLES = new Set([
  "videos",
  "channels",
  "transcripts",
  "comments",
]);

// Columns Claude is allowed to read. Keeps it schema-aware.
export const SQL_SCHEMA = `
TABLES (SQLite):

videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  published_at INTEGER,           -- unix seconds
  duration_seconds INTEGER,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  thumbnail_url TEXT,
  tags TEXT,                      -- JSON array as text
  imported_at INTEGER
)
-- AUTO-SCOPED to the user's currently-active channel. You do NOT need to
-- (and SHOULD NOT) add a WHERE channel_id = … clause yourself — every
-- row this view returns already belongs to the active channel.

channels (
  id TEXT PRIMARY KEY,
  title TEXT,
  handle TEXT,
  description TEXT,
  subscriber_count INTEGER,
  view_count INTEGER,
  video_count INTEGER,
  imported_at INTEGER
)
-- This is the only NOT auto-scoped table. Use it when you need the
-- active channel's metadata or to list which other channels are
-- connected.

transcripts (
  video_id TEXT PRIMARY KEY,       -- FK to videos.id
  language TEXT,
  text TEXT NOT NULL,
  fetched_at INTEGER
)
-- AUTO-SCOPED: only transcripts of videos belonging to the active
-- channel are visible.

comments (
  id TEXT PRIMARY KEY,             -- YouTube comment ID
  video_id TEXT NOT NULL,          -- FK to videos.id
  parent_id TEXT,                  -- NULL for top-level, else parent comment id
  author TEXT,
  author_channel_id TEXT,
  text TEXT NOT NULL,
  like_count INTEGER,
  reply_count INTEGER,
  published_at INTEGER,
  updated_at INTEGER,
  fetched_at INTEGER
)
-- AUTO-SCOPED: only comments on videos belonging to the active channel.

Useful idioms:
- datetime(published_at, 'unixepoch')
- strftime('%Y-%m', datetime(published_at, 'unixepoch')) for month bucketing
- AVG/MAX/MIN/COUNT for aggregates
- json_each(tags) for tag-level analysis

NOT available here (use the dedicated tools instead, NOT raw SQL):
- competitors / competitor outliers → list_competitors, list_competitor_alerts, competitor_gap_analysis
- Hook Lab scores → get_hook_stats, list_hook_breakdowns, get_video_hook
- per-video AI comment analysis → get_comment_analysis
- Hooks Library → list_saved_hooks
If you write SELECT … FROM one of those you'll get a "Table not allowed"
error — that means the data exists but lives behind a dedicated tool, NOT
that the user has no such data.
`.trim();

const FORBIDDEN = [
  /\bPRAGMA\b/i,
  /\bATTACH\b/i,
  /\bDETACH\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bREPLACE\b/i,
  /\bREINDEX\b/i,
  /\bVACUUM\b/i,
  // No comments — they're the classic way to smuggle a second statement
  // past the FORBIDDEN regexes.
  /--/,
  /\/\*/,
  // No multiple statements: reject a semicolon followed by more SQL. A
  // bare trailing `;` (optionally followed by whitespace) is fine — it's
  // common and gets stripped before execution. Only `;` + non-whitespace
  // (a real second statement) is blocked. The old `/;.+/` also rejected a
  // harmless trailing "; " and broke otherwise-valid queries.
  /;\s*\S/,
  // No raw access to underlying tables — Claude must go through the CTE
  // shadows. If we let `main.videos` through, it'd skip our channel
  // filter and leak rows from every channel.
  /\bmain\s*\./i,
];

/**
 * Build the CTE prefix that shadows `videos`, `transcripts`, and
 * `comments` with channel-scoped views. The user's query then references
 * `videos`/`transcripts`/`comments` as if they were tables, and SQLite
 * resolves the names to our CTEs instead of the underlying tables.
 *
 * Note: inside each CTE we have to qualify with `main.` to escape the
 * CTE-name shadowing. Otherwise `videos AS (SELECT * FROM videos …)` is
 * a recursive reference that SQLite errors on.
 */
function buildChannelScopeCTEs(): string {
  // Parameterised via `?` placeholders, NOT string-concatenated — the
  // channel id is user-controlled (it comes from the active-channel
  // setting which the API can set), so we go through prepared statement
  // binding for safety even though it's been validated upstream.
  return [
    `videos AS (SELECT * FROM main.videos WHERE channel_id = ?)`,
    `transcripts AS (
       SELECT t.* FROM main.transcripts t
       WHERE t.video_id IN (SELECT id FROM main.videos WHERE channel_id = ?)
     )`,
    `comments AS (
       SELECT c.* FROM main.comments c
       WHERE c.video_id IN (SELECT id FROM main.videos WHERE channel_id = ?)
     )`,
  ].join(",\n     ");
}

export function runSelect(
  query: string,
  maxRows = 200
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const q = query.trim();
  if (!/^\s*(WITH|SELECT)\b/i.test(q)) {
    throw new Error("Only SELECT / WITH statements allowed.");
  }
  for (const rx of FORBIDDEN) {
    if (rx.test(q)) throw new Error(`Disallowed token in SQL: ${rx}`);
  }

  // Lightweight referenced-table check. All FROM/JOIN identifiers must
  // be in the whitelist. This is the first line of defence — the second
  // line is the `main.` ban that prevents Claude from sidestepping our
  // CTE shadows.
  const referenced = Array.from(
    q.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)
  ).map((m) => m[1].toLowerCase());
  for (const t of referenced) {
    if (!ALLOWED_TABLES.has(t)) {
      throw new Error(`Table not allowed: ${t}`);
    }
  }

  // Refuse to run if no active channel — Claude could otherwise issue a
  // query that comes back empty and confuse itself into thinking the
  // creator has no data, when in fact they just haven't switched on a
  // channel yet. Clearer to refuse and tell them what's wrong.
  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) {
    throw new Error(
      "No active channel selected. Switch to a channel in the sidebar before running raw SQL."
    );
  }

  // Splice our channel-scoped CTEs into the query. If the user query
  // already starts with WITH, we prepend our definitions as additional
  // CTEs (comma-separated). Otherwise we wrap the whole thing in a
  // fresh WITH block.
  const cteBlock = buildChannelScopeCTEs();
  let scopedQuery: string;
  if (/^\s*WITH\s/i.test(q)) {
    scopedQuery = q.replace(/^\s*WITH\s+/i, `WITH ${cteBlock},\n     `);
  } else {
    scopedQuery = `WITH ${cteBlock}\n${q}`;
  }

  // Enforce row cap by wrapping if no LIMIT present. We fetch one MORE than
  // the cap so we can tell the caller whether the result was actually
  // truncated (vs landing exactly on the cap by coincidence) and flag it —
  // otherwise the model reasons on a silently-clipped result believing it's
  // the whole picture.
  const fetchCap = maxRows + 1;
  const withLimit = /\bLIMIT\s+\d+/i.test(scopedQuery)
    ? scopedQuery
    : `SELECT * FROM (${scopedQuery.replace(/;+\s*$/, "")}) LIMIT ${fetchCap}`;

  // 3 `?` placeholders — one per CTE definition — all bound to the same
  // active channel id.
  const stmt = db.prepare(withLimit);
  stmt.raw(true);
  const rows = stmt.all(activeChannelId, activeChannelId, activeChannelId) as unknown[][];
  const columns = stmt.columns().map((c) => c.name);
  const truncated = rows.length > maxRows;
  return { columns, rows: rows.slice(0, maxRows), truncated };
}
