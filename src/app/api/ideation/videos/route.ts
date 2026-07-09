import { db, getActiveChannelId, listChannelCategories } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/ideation/videos
 *
 * Server data for the Ideation hub's "Videos" tab — a command-center
 * table of the active channel's videos with computed performance
 * fields (views-per-hour pace, view-count milestones).
 *
 * Selects explicit columns rather than `SELECT *` / the shared `Video`
 * type: `thumbnail_text` and `category` are real columns on `videos`
 * (see the "Videos: thumbnail OCR text + content category" block in
 * db.ts) but aren't part of the `Video` type used elsewhere, so this
 * route types its own row shape instead of importing/extending that
 * type.
 */

const MILESTONES = [1_000_000, 500_000, 250_000, 100_000] as const;

type VideoRow = {
  id: string;
  title: string;
  thumbnail_url: string | null;
  thumbnail_text: string | null;
  category: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  published_at: number | null;
  duration_seconds: number | null;
};

export type IdeationVideo = VideoRow & {
  vph: number | null;
  milestone: (typeof MILESTONES)[number] | null;
};

function computeVph(views: number | null, publishedAt: number | null): number | null {
  if (!views || !publishedAt) return null;
  const hoursElapsed = (Date.now() / 1000 - publishedAt) / 3600;
  const vph = views / Math.max(1, hoursElapsed);
  return Math.round(vph * 10) / 10;
}

function computeMilestone(views: number | null): (typeof MILESTONES)[number] | null {
  if (!views) return null;
  for (const m of MILESTONES) {
    if (views >= m) return m;
  }
  return null;
}

export async function GET() {
  const activeId = getActiveChannelId();
  if (!activeId) {
    return Response.json({ videos: [], categories: [] });
  }

  const rows = db
    .prepare(
      `SELECT id, title, thumbnail_url, thumbnail_text, category, views, likes, comments, published_at, duration_seconds
       FROM videos
       WHERE channel_id = ?
       ORDER BY published_at DESC
       LIMIT 1000`
    )
    .all(activeId) as VideoRow[];

  const videos: IdeationVideo[] = rows.map((r) => ({
    ...r,
    vph: computeVph(r.views, r.published_at),
    milestone: computeMilestone(r.views),
  }));

  return Response.json({ videos, categories: listChannelCategories() });
}
