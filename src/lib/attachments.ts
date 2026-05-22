import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import {
  getComment,
  getTranscript,
  getVideo,
  listReplies,
  listTopLevelComments,
} from "./db";

export type AttachmentInput =
  | { type: "video"; id: string }
  | { type: "comment"; id: string }
  // `data` and `mediaType` are optional because history rebuild on reload
  // re-passes ResolvedAttachment metadata (id-only) through this resolver
  // — at that point we don't have the bytes anymore. The resolver silently
  // skips image inputs missing `data`, which gives us a clean degrade path.
  | { type: "image"; data?: string; mediaType?: string; filename?: string };

export type ResolvedAttachment =
  | {
      type: "video";
      id: string;
      title: string;
      thumbnail: string | null;
    }
  | {
      type: "comment";
      id: string;
      title: string; // a short preview for chip display (author: "first words…")
      thumbnail: null;
    }
  | {
      type: "image";
      id: string; // synthesised stable id for the chat session — base64 not persisted
      title: string; // filename or "Image" if none provided
      thumbnail: null;
    };

/**
 * Mediums Anthropic and Gemini both accept inline. Other formats (HEIC,
 * AVIF, etc.) would need server-side conversion — out of scope for now.
 */
const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

function isSupportedImageMediaType(s: string): s is SupportedImageMediaType {
  return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(s);
}

/**
 * Resolve client-supplied attachment refs into:
 *   - `forStorage` — minimal display metadata to save with the message
 *     (no image bytes — keeps the SQLite row small + fast to fetch).
 *   - `asContext` — a single text block summarising video / comment
 *     attachments for the model. Empty when only images are attached.
 *   - `imageBlocks` — Anthropic-shaped image content blocks ready to
 *     splice into the user message. Both providers consume these via
 *     the AI provider adapter.
 */
export function resolveAttachmentsForClaude(inputs: AttachmentInput[]): {
  forStorage: ResolvedAttachment[];
  asContext: string;
  imageBlocks: Anthropic.ImageBlockParam[];
} {
  if (!inputs?.length) return { forStorage: [], asContext: "", imageBlocks: [] };

  const forStorage: ResolvedAttachment[] = [];
  const blocks: string[] = [];
  const imageBlocks: Anthropic.ImageBlockParam[] = [];

  for (const a of inputs) {
    if (!a) continue;

    if (a.type === "video" && typeof a.id === "string") {
      const block = renderVideoBlock(a.id, forStorage);
      if (block) blocks.push(block);
    } else if (a.type === "comment" && typeof a.id === "string") {
      const block = renderCommentBlock(a.id, forStorage);
      if (block) blocks.push(block);
    } else if (a.type === "image" && typeof a.data === "string") {
      const mediaType =
        a.mediaType && isSupportedImageMediaType(a.mediaType)
          ? a.mediaType
          : null;
      if (!mediaType) continue;
      // Synthesised id — used by the UI as a React key + dedup hint, never
      // hits the DB. New ids per turn are fine because images aren't
      // persisted across reloads (intentional — base64 in chat history
      // would balloon the SQLite file fast).
      const id = `img_${Date.now().toString(36)}_${forStorage.length}`;
      const filename = (a.filename ?? "").trim();
      forStorage.push({
        type: "image",
        id,
        title: filename || "Image",
        thumbnail: null,
      });
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: a.data,
        },
      });
    }
  }

  if (!blocks.length && !imageBlocks.length) {
    return { forStorage: [], asContext: "", imageBlocks: [] };
  }

  const asContext = blocks.length
    ? [
        `The user has attached the following item(s) to this message. You may reference them directly without calling extra tools:`,
        "",
        blocks.join("\n\n"),
      ].join("\n")
    : "";

  return { forStorage, asContext, imageBlocks };
}

function renderVideoBlock(id: string, forStorage: ResolvedAttachment[]): string | null {
  const v = getVideo(id);
  if (!v) return null;

  forStorage.push({
    type: "video",
    id: v.id,
    title: v.title,
    thumbnail: v.thumbnail_url,
  });

  const transcript = getTranscript(v.id);
  const publishedAt = v.published_at
    ? new Date(v.published_at * 1000).toISOString().slice(0, 10)
    : "unknown";
  const duration = v.duration_seconds
    ? `${Math.floor(v.duration_seconds / 60)}m${v.duration_seconds % 60}s`
    : "unknown";
  const engagement =
    v.views > 0 ? (((v.likes + v.comments) / v.views) * 100).toFixed(2) + "%" : "n/a";
  const tagList = (() => {
    try {
      const parsed = JSON.parse(v.tags ?? "[]");
      return Array.isArray(parsed) ? parsed.slice(0, 20).join(", ") : "";
    } catch {
      return "";
    }
  })();

  // Keep transcripts capped so we never blow past the model's context budget
  // when the user attaches a handful of hour-long videos.
  const TRANSCRIPT_CAP = 12_000;
  const transcriptBody = transcript?.text
    ? transcript.text.length > TRANSCRIPT_CAP
      ? transcript.text.slice(0, TRANSCRIPT_CAP) +
        `\n\n[…truncated, ${transcript.text.length - TRANSCRIPT_CAP} more chars. Use the fetch_transcript tool to request a specific section or search_my_transcripts to find a phrase.]`
      : transcript.text
    : null;

  const lines = [
    `=== Attached video: ${v.title} ===`,
    `- video_id: ${v.id}`,
    `- url: https://www.youtube.com/watch?v=${v.id}`,
    `- published: ${publishedAt}`,
    `- duration: ${duration}`,
    `- views: ${v.views}`,
    `- likes: ${v.likes}`,
    `- comments: ${v.comments}`,
    `- engagement_rate: ${engagement}`,
  ];
  if (tagList) lines.push(`- tags: ${tagList}`);
  if (v.description?.trim()) {
    const desc = v.description.trim().slice(0, 1500);
    lines.push(`- description: """${desc}${v.description.length > 1500 ? "…" : ""}"""`);
  }
  if (transcriptBody) {
    lines.push(
      `- transcript${transcript?.language ? ` (${transcript.language})` : ""}:\n"""\n${transcriptBody}\n"""`
    );
  } else {
    lines.push(`- transcript: (not available)`);
  }

  // Top comments — attached automatically with the video so the model
  // can reason about audience reaction without the user separately
  // attaching individual comment threads. Cached comments only (synced
  // via the Videos page); top 15 by like count, each capped so a few
  // attached videos can't blow the context budget.
  const TOP_COMMENTS = 15;
  const PER_COMMENT_CAP = 280;
  const topComments = listTopLevelComments(v.id, TOP_COMMENTS, 0);
  if (topComments.length > 0) {
    lines.push(
      ``,
      `- top_comments (${topComments.length} most-liked, cached):`
    );
    for (const c of topComments) {
      const text =
        c.text.length > PER_COMMENT_CAP
          ? c.text.slice(0, PER_COMMENT_CAP) + "…"
          : c.text;
      const flat = text.replace(/\s+/g, " ").trim();
      lines.push(
        `  - [${c.author ?? "?"}, ${c.like_count}♥, ${c.reply_count} replies] ${flat}`
      );
    }
    lines.push(
      `  (Use search_my_comments or list_video_comments_cached for the full set.)`
    );
  } else {
    lines.push(
      ``,
      `- top_comments: (none cached — user can sync this video's comments from its Comments tab)`
    );
  }
  return lines.join("\n");
}

function renderCommentBlock(id: string, forStorage: ResolvedAttachment[]): string | null {
  const c = getComment(id);
  if (!c) return null;

  // If the user attached a reply, we still want to show the model the parent
  // for context — it's meaningless otherwise.
  const parent = c.parent_id ? getComment(c.parent_id) ?? c : c;
  const video = getVideo(parent.video_id);
  const replies = listReplies(parent.id);

  const preview = (parent.text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const chipTitle = `${parent.author ?? "?"}: ${preview}${parent.text.length > 80 ? "…" : ""}`;

  forStorage.push({
    type: "comment",
    id: c.id,
    title: chipTitle,
    thumbnail: null,
  });

  const publishedAt = parent.published_at
    ? new Date(parent.published_at * 1000).toISOString().slice(0, 16).replace("T", " ")
    : "unknown";

  // Cap replies — a single thread can have 1000s.
  const REPLIES_CAP = 40;
  const cappedReplies = replies.slice(0, REPLIES_CAP);
  const PER_REPLY_CAP = 600;

  const lines = [`=== Attached comment thread ===`];
  if (video) {
    lines.push(`- on_video: "${video.title}"`, `- video_id: ${video.id}`);
  } else {
    lines.push(`- video_id: ${parent.video_id}`);
  }
  lines.push(
    `- comment_id: ${parent.id}`,
    `- author: ${parent.author ?? "?"}`,
    `- published: ${publishedAt}`,
    `- likes: ${parent.like_count}`,
    `- reply_count_total: ${parent.reply_count} (cached: ${replies.length})`,
    ``,
    `Top-level comment:`,
    `"""`,
    parent.text,
    `"""`
  );

  if (cappedReplies.length > 0) {
    lines.push(``, `Replies (${cappedReplies.length}${replies.length > REPLIES_CAP ? ` of ${replies.length} shown` : ""}):`);
    for (const r of cappedReplies) {
      const rText =
        r.text.length > PER_REPLY_CAP
          ? r.text.slice(0, PER_REPLY_CAP) + "…"
          : r.text;
      const rDate = r.published_at
        ? new Date(r.published_at * 1000).toISOString().slice(0, 10)
        : "?";
      lines.push(`- [${r.author ?? "?"}, ${rDate}, ${r.like_count}♥] ${rText}`);
    }
    if (replies.length > REPLIES_CAP) {
      lines.push(
        `[…${replies.length - REPLIES_CAP} more replies cached but not shown. Use get_comment_thread to read them all.]`
      );
    }
  } else if (parent.reply_count > 0) {
    lines.push(
      ``,
      `Replies: ${parent.reply_count} exist on YouTube but none are cached yet. The user can sync them from the video's Comments tab.`
    );
  }

  return lines.join("\n");
}
