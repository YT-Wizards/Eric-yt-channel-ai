import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  getActiveChannelId,
  getIntegration,
  listVideos,
  setSetting,
  setVideoCategory,
  type Video,
} from "./db";
import { log } from "./logger";

/**
 * Niche-agnostic AI categorizer for the active channel's videos.
 *
 * Design:
 * - Universal: this platform serves any creator in any niche/language, so
 *   categories are never drawn from a hardcoded topic list. They're derived
 *   fresh, per channel, from that channel's own titles + tags.
 * - Per-channel: always scoped to whichever channel is currently active
 *   (same "active channel" pointer every other endpoint uses).
 * - Single Claude call: one clustering pass sees every video at once and
 *   returns both the category set AND the per-video assignment in one shot,
 *   rather than classifying videos one-by-one against a list that doesn't
 *   exist yet.
 * - 200-video cap: `listVideos` defaults to (and this module always
 *   requests) its max of 200 most-recent videos. Channels with more than
 *   200 uploads only get the newest 200 categorized per run — acceptable
 *   coverage for a content-bucket overview, not a full historical audit.
 */

const CATEGORIZER_MODEL = "claude-sonnet-4-6";
const VIDEO_CAP = 200;
const MAX_TAGS_PER_VIDEO = 5;

export class CategorizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategorizerError";
  }
}

type CategorizerOutput = {
  categories: string[];
  assignments: Record<string, string>;
};

// Same tolerant-fence-then-brace-span parsing as comment-analyzer.ts's
// extractJson — kept local rather than shared so each module can evolve its
// prompt/output shape independently.
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function validateOutput(parsed: unknown): CategorizerOutput {
  if (typeof parsed !== "object" || parsed === null) {
    throw new CategorizerError("Categorizer returned non-object JSON");
  }
  const p = parsed as Record<string, unknown>;

  if (!Array.isArray(p.categories)) {
    throw new CategorizerError("Categorizer response missing categories array");
  }
  const categories = (p.categories as unknown[])
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim());
  if (categories.length < 1 || categories.length > 12) {
    throw new CategorizerError(
      `Categorizer returned ${categories.length} categories (expected 1-12)`
    );
  }

  if (typeof p.assignments !== "object" || p.assignments === null) {
    throw new CategorizerError("Categorizer response missing assignments object");
  }
  const rawAssignments = p.assignments as Record<string, unknown>;
  const assignments: Record<string, string> = {};
  for (const [videoId, category] of Object.entries(rawAssignments)) {
    if (typeof category === "string" && categories.includes(category)) {
      assignments[videoId] = category;
    }
    // Invalid/unknown-category assignments are silently dropped here —
    // the caller counts a video as "skipped" when no valid assignment
    // survives, rather than coercing it into a category the model didn't
    // actually pick for it.
  }

  return { categories, assignments };
}

/**
 * Cluster the active channel's videos into 4-8 short, channel-specific
 * category names and assign each video to exactly one of them.
 *
 * @param opts.onlyMissing - Accepted for API symmetry with the route, but
 *   `Video` (src/lib/db.ts) doesn't expose the `category` column in its
 *   type, and this module can't edit db.ts to add it. Filtering "already
 *   categorized" videos out of the batch isn't possible without that field,
 *   so this flag is currently a no-op: every run (re)assigns all videos in
 *   the batch. Left in the signature so callers/UI can wire it up later
 *   once `Video` gains a typed `category` field.
 */
export async function categorizeChannelVideos(
  opts: { onlyMissing?: boolean } = {}
): Promise<{ categories: string[]; assigned: number; skipped: number }> {
  void opts.onlyMissing; // see doc comment above — not yet actionable

  const channelId = getActiveChannelId();
  if (!channelId) {
    throw new CategorizerError("No active channel selected");
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    throw new CategorizerError("Claude API key not configured");
  }

  const videos = listVideos({ limit: VIDEO_CAP });
  if (videos.length === 0) {
    throw new CategorizerError("No videos found for the active channel");
  }

  // getVideo/listVideos type as `Video`, which doesn't declare `tags` in a
  // parsed form — the raw column is a JSON string (see attachments.ts's
  // JSON.parse(v.tags ?? "[]") idiom, mirrored here).
  const items = videos.map((v: Video) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(v.tags ?? "[]");
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      tags = [];
    }
    return { id: v.id, title: v.title, tags: tags.slice(0, MAX_TAGS_PER_VIDEO) };
  });

  const userPrompt = [
    "You will cluster a YouTube channel's videos into 4-8 SHORT category ",
    "names (1-3 words each), in the SAME language the titles are ",
    "predominantly written in. Categories must describe recurring content ",
    "themes of THIS channel (derive from the titles/tags), not generic ",
    "labels like \"Other\". Every video gets exactly one category. Return ",
    "STRICT JSON only: {\"categories\":[\"...\"],\"assignments\":{\"<videoId>\":\"<category>\"}}",
    "",
    "",
    JSON.stringify(items),
  ].join("");

  const client = new Anthropic({ apiKey });
  let raw: string;
  try {
    const response = await client.messages.create({
      model: CATEGORIZER_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: userPrompt }],
    });
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    throw new CategorizerError(
      `Claude call failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  let parsed: CategorizerOutput;
  try {
    parsed = validateOutput(JSON.parse(extractJson(raw)));
  } catch (e) {
    log.warn("claude", "Categorizer JSON parse/validate failed", {
      raw: raw.slice(0, 400),
      error: e instanceof Error ? e.message : String(e),
    });
    throw e instanceof CategorizerError
      ? e
      : new CategorizerError(e instanceof Error ? e.message : "JSON parse failed");
  }

  let assigned = 0;
  let skipped = 0;
  for (const item of items) {
    const category = parsed.assignments[item.id];
    if (category) {
      setVideoCategory(item.id, category);
      assigned += 1;
    } else {
      skipped += 1;
    }
  }

  // Persist the derived category set for this channel so other features
  // (filters, future runs) can reuse it without re-deriving from scratch.
  setSetting(`categories.set.${channelId}`, JSON.stringify(parsed.categories));

  log.info("claude", "Channel videos categorized", {
    channelId,
    categoriesCount: parsed.categories.length,
    assigned,
    skipped,
    videosConsidered: items.length,
  });

  return { categories: parsed.categories, assigned, skipped };
}
