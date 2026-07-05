import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  getIntegration,
  getVideo,
  listTopLevelComments,
  upsertCommentAnalysis,
} from "./db";
import { log } from "./logger";

/**
 * Claude-driven audience analysis. Takes the top-level comments for
 * one video, feeds them into Sonnet, and gets back five things the
 * dashboard's Comments tab surfaces:
 *
 *   1. Sentiment score (1-10) — how the audience felt overall.
 *   2. Top themes — recurring ideas that come up across many comments.
 *   3. Credibility objections — where viewers pushed back on the
 *      video's claims, with severity (high / medium / low).
 *   4. Future video ideas — questions / suggestions that appear often
 *      enough to be worth their own video, with demand level + the
 *      comment excerpts that prove the demand exists.
 *   5. Best hook candidates — comments that would make standout
 *      opening lines for future videos (emotional, controversial,
 *      personal). Ready to drop into Hooks Library.
 *
 * Cached one-per-video; re-analyse overwrites previous row.
 */

const ANALYZER_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are an audience analyst for a YouTube creator. Given the top comments on one of their videos, produce a structured JSON breakdown that captures sentiment, recurring themes, credibility pushback, demand signals for future videos, and the best raw-material hooks the creator could lift directly out of the comment stream.

Output MUST be a single valid JSON object with this exact schema, and nothing else:

{
  "sentiment_score": integer 1-10,            // 1 = hostile, 5 = mixed, 10 = adoring
  "themes": [string, ...],                    // 4-8 recurring ideas, each 4-10 words
  "objections": [                             // claims viewers pushed back on
    { "text": string, "severity": "high" | "medium" | "low" }
  ],
  "future_ideas": [                           // ideas that repeat enough to deserve a video
    {
      "title": string,                        // a working video title, 6-12 words
      "demand": "high" | "medium" | "low",
      "evidence": string                      // 1-2 quoted phrases proving the demand
    }
  ],
  "hook_candidates": [                        // comments that would make great hooks
    {
      "author": string,
      "quote": string,                        // verbatim or lightly trimmed
      "why": string                           // 5-12 words on why it works as a hook
    }
  ],
  "summary": string                           // 2-3 sentences synthesising the audience mood + signals
}

Calibration rules:
- Sentiment score: 8+ is unusual praise; 5-7 is normal mixed; 1-3 is genuinely hostile audience.
- Themes: only include something if multiple comments echo it. One-off observations don't count.
- Objections: cite the technical / factual / ethical pushback, not generic dislike.
  Severity = how often + how confident the objection feels.
  - high: multiple commenters say it with evidence/experience
  - medium: a few commenters with confident phrasing
  - low: one commenter or vague hand-wave
- Future ideas: prefer concrete, specific titles ("How to do X when you're in Florida"
  beats "talk about X more"). Demand reflects how many comments are asking.
- Hook candidates: pick 2-4 max. Each must be self-contained enough to open a video
  without extra context. Emotional / controversial / first-person-experience trumps generic.
- Summary: write the synthesis in the same language as the comments (English comments → English summary).

Be tough. Default sentiment is 5-7. A 9-10 sentiment requires near-unanimous excitement. Hostile take-downs are worth flagging — don't paper over them.`;

export class CommentAnalyzerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentAnalyzerError";
  }
}

type AnalyzerOutput = {
  sentiment_score: number;
  themes: string[];
  objections: Array<{ text: string; severity: "high" | "medium" | "low" }>;
  future_ideas: Array<{
    title: string;
    demand: "high" | "medium" | "low";
    evidence: string;
  }>;
  hook_candidates: Array<{ author: string; quote: string; why: string }>;
  summary: string;
};

function extractJson(text: string): string {
  // Prefer a fenced code block if present. Tolerant of a missing leading or
  // trailing newline inside the fence (```json{…}``` and ```\n{…}\n``` both
  // match) — the old regex required literal newlines on both sides and fell
  // through to the brace-span fallback whenever the model omitted them.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  // Otherwise grab the outermost {…} span.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function validateOutput(parsed: unknown): AnalyzerOutput {
  if (typeof parsed !== "object" || parsed === null) {
    throw new CommentAnalyzerError("Analyzer returned non-object JSON");
  }
  const p = parsed as Record<string, unknown>;
  const sentiment = Number(p.sentiment_score);
  if (!Number.isFinite(sentiment) || sentiment < 1 || sentiment > 10) {
    throw new CommentAnalyzerError(
      `Bad sentiment_score: ${p.sentiment_score}`
    );
  }
  // Be lenient on substructure — coerce missing arrays to [], etc.
  // The dashboard renders defensively so an empty section is fine.
  return {
    sentiment_score: Math.round(sentiment),
    themes: Array.isArray(p.themes)
      ? (p.themes as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    objections: Array.isArray(p.objections)
      ? (p.objections as unknown[])
          .filter((o): o is { text: string; severity: string } =>
            typeof o === "object" && o !== null && typeof (o as { text?: unknown }).text === "string"
          )
          .map((o) => ({
            text: o.text,
            severity:
              o.severity === "high" || o.severity === "medium" || o.severity === "low"
                ? (o.severity as "high" | "medium" | "low")
                : ("medium" as const),
          }))
      : [],
    future_ideas: Array.isArray(p.future_ideas)
      ? (p.future_ideas as unknown[])
          .filter(
            (
              i
            ): i is { title: string; demand: string; evidence: string } =>
              typeof i === "object" &&
              i !== null &&
              typeof (i as { title?: unknown }).title === "string"
          )
          .map((i) => ({
            title: i.title,
            demand:
              i.demand === "high" || i.demand === "medium" || i.demand === "low"
                ? (i.demand as "high" | "medium" | "low")
                : ("medium" as const),
            evidence: typeof i.evidence === "string" ? i.evidence : "",
          }))
      : [],
    hook_candidates: Array.isArray(p.hook_candidates)
      ? (p.hook_candidates as unknown[])
          .filter(
            (
              h
            ): h is { author: string; quote: string; why: string } =>
              typeof h === "object" &&
              h !== null &&
              typeof (h as { quote?: unknown }).quote === "string"
          )
          .map((h) => ({
            author: typeof h.author === "string" ? h.author : "?",
            quote: h.quote,
            why: typeof h.why === "string" ? h.why : "",
          }))
      : [],
    summary: typeof p.summary === "string" ? p.summary : "",
  };
}

const COMMENT_LIMIT = 100;
const COMMENT_TEXT_CAP = 600;

/**
 * Run the comment analysis for a single video. Pulls up to 100 cached
 * top-level comments (sorted by like_count desc), trims each to
 * ~600 chars so the prompt stays under context limits, asks Claude
 * for a structured JSON breakdown, writes it into `comment_analysis`.
 */
export async function analyzeVideoComments(
  videoId: string
): Promise<
  | { ok: true; commentsCount: number; sentimentScore: number }
  | { ok: false; reason: string }
> {
  const video = getVideo(videoId);
  if (!video) return { ok: false, reason: "video not found" };

  // Pull top-rated comments first (likes desc) so we feed Claude the
  // signal-richest sample. The DB helper orders by published_at by
  // default; we re-sort client-side here to avoid a parallel SQL fork.
  const all = listTopLevelComments(videoId, COMMENT_LIMIT, 0);
  if (all.length === 0) {
    return {
      ok: false,
      reason:
        "No comments cached for this video. Sync comments first (Comments tab → Sync from YouTube).",
    };
  }
  const top = [...all]
    .sort((a, b) => b.like_count - a.like_count)
    .slice(0, COMMENT_LIMIT);

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return { ok: false, reason: "Claude API key not configured" };
  }

  // Compose a single chunk Claude can read top-to-bottom. We label
  // each comment with author + likes so it can weight things the
  // way a real social-listening pass would.
  const lines: string[] = [
    `Video title: "${video.title}"`,
    `Sample of top comments (sorted by likes desc, ${top.length} total):`,
    "",
  ];
  for (const c of top) {
    const text = (c.text ?? "").replace(/\s+/g, " ").slice(0, COMMENT_TEXT_CAP);
    lines.push(
      `[${c.author ?? "?"} · ${c.like_count} likes]: ${text}`
    );
  }
  const userPrompt = lines.join("\n");

  const client = new Anthropic({ apiKey });
  let raw: string;
  try {
    const response = await client.messages.create({
      model: ANALYZER_MODEL,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    return {
      ok: false,
      reason: `Claude call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let parsed: AnalyzerOutput;
  try {
    parsed = validateOutput(JSON.parse(extractJson(raw)));
  } catch (e) {
    log.warn("comment-analysis", `JSON parse failed for ${videoId}`, {
      raw: raw.slice(0, 400),
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "JSON parse failed",
    };
  }

  upsertCommentAnalysis({
    video_id: videoId,
    sentiment_score: parsed.sentiment_score,
    themes: JSON.stringify(parsed.themes),
    objections: JSON.stringify(parsed.objections),
    future_ideas: JSON.stringify(parsed.future_ideas),
    hook_candidates: JSON.stringify(parsed.hook_candidates),
    summary: parsed.summary,
    analyzer_model: ANALYZER_MODEL,
    comments_count: top.length,
    analyzed_at: Math.floor(Date.now() / 1000),
  });

  log.info("comment-analysis", "Video comments analysed", {
    videoId,
    sentimentScore: parsed.sentiment_score,
    themesCount: parsed.themes.length,
    objectionsCount: parsed.objections.length,
    ideasCount: parsed.future_ideas.length,
    hookCandidatesCount: parsed.hook_candidates.length,
    commentsCount: top.length,
  });

  return {
    ok: true,
    commentsCount: top.length,
    sentimentScore: parsed.sentiment_score,
  };
}
