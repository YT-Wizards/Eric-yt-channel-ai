import { db, getActiveChannelId, competitorGapAnalysis, listCompetitorAlerts } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/signals
 *
 * One-shot aggregate payload for the Signals tab of the Ideation hub —
 * "what should I make next, based on data". Three feeds, all scoped to
 * the active channel and universal across niche/language (every string
 * surfaced here comes straight out of the channel's own catalogue /
 * competitor sync / comment analysis, never a hardcoded topical word):
 *
 *   - freshOutliers: recently-detected competitor videos worth reacting
 *     to. Includes both the new "fresh" alert kind (caught via a
 *     views-in-first-hours check) and unread legacy median-outlier
 *     alerts (kind is NULL pre-migration — see CompetitorAlert in db.ts).
 *   - gaps: keywords competitors use a lot that this channel doesn't —
 *     straight pass-through of competitorGapAnalysis's shape.
 *   - audienceRequests: "make a video about X" asks mined out of
 *     comment_analysis.future_ideas across every analyzed video in the
 *     active channel, flattened + ranked by demand then recency.
 *
 * 400s when there's no active channel — every section below is scoped
 * to one channel and has no meaningful "all channels" fallback.
 */
export async function GET() {
  if (!getActiveChannelId()) {
    return Response.json(
      { error: "No active channel selected." },
      { status: 400 }
    );
  }

  return Response.json({
    freshOutliers: getFreshOutliers(),
    gaps: competitorGapAnalysis({ topN: 20 }),
    audienceRequests: getAudienceRequests(),
  });
}

export type FreshOutlier = {
  id: number;
  competitor: string | null;
  videoId: string;
  title: string | null;
  views: number | null;
  multiplier: number | null;
  kind: string;
  ageHours: number | null;
  detectedAt: number;
  publishedAt: number | null;
  unread: boolean;
};

/**
 * "fresh" kind alerts (age-based, brand new detector) OR unread legacy
 * outliers (kind is NULL, detected via the original median-multiplier
 * check) — capped at 25. We pull a generous window from
 * listCompetitorAlerts (all alerts, not just unread) so read 'fresh'
 * alerts still surface — a fresh outlier is worth acting on whether or
 * not the user has dismissed its notification badge — then apply the
 * fresh-OR-unread-legacy filter ourselves since listCompetitorAlerts has
 * no native `kind` filter.
 *
 * Ordering: "fresh" kind entries first (these are active spikes — the
 * whole point is reacting NOW — newest-detected first among them), then
 * every other row (mostly a competitor's backfilled/legacy history)
 * ordered by the video's own publish date, newest first, with rows
 * whose publish date is unknown (pre-migration, not yet backfilled)
 * sorted after everything that has one — falling back to detected_at
 * for those. This is what actually fixes the "unsorted wall of history"
 * complaint: without it, a first-time competitor sync backfills months
 * of alerts in whatever order SQLite handed them back.
 */
function getFreshOutliers(): FreshOutlier[] {
  const alerts = listCompetitorAlerts({ limit: 100 });
  return alerts
    .filter((a) => a.kind === "fresh" || (a.kind == null && a.read_at == null))
    .sort((a, b) => {
      const aFresh = a.kind === "fresh";
      const bFresh = b.kind === "fresh";
      if (aFresh !== bFresh) return aFresh ? -1 : 1;
      if (aFresh && bFresh) return b.detected_at - a.detected_at;
      // Non-fresh (legacy median-outlier) rows: newest video first, NULLS
      // LAST, falling back to detected_at when both sides are NULL.
      if (a.published_at != null && b.published_at != null) {
        return b.published_at - a.published_at;
      }
      if (a.published_at != null) return -1;
      if (b.published_at != null) return 1;
      return b.detected_at - a.detected_at;
    })
    .slice(0, 25)
    .map((a) => ({
      id: a.id,
      competitor: a.competitor_title ?? a.competitor_handle,
      videoId: a.video_id,
      title: a.title,
      views: a.views,
      multiplier: a.multiplier,
      kind: a.kind ?? "median_outlier",
      ageHours: a.age_hours,
      detectedAt: a.detected_at,
      publishedAt: a.published_at ?? null,
      unread: a.read_at == null,
    }));
}

export type AudienceRequest = {
  title: string;
  demand: "high" | "medium" | "low";
  evidence: string;
  videoId: string;
  videoTitle: string;
};

type FutureIdeaRow = { title?: unknown; demand?: unknown; evidence?: unknown };

const DEMAND_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Flattens comment_analysis.future_ideas (JSON per row) across every
 * analyzed video in the active channel into one ranked list. Each row's
 * JSON is parsed independently in a try/catch — one malformed row
 * (shouldn't happen given upsertCommentAnalysis always writes
 * JSON.stringify output, but Claude-authored JSON blobs are exactly the
 * kind of thing worth being defensive about) must not take down the
 * whole feed.
 */
function getAudienceRequests(): AudienceRequest[] {
  const activeId = getActiveChannelId();
  if (!activeId) return [];

  const rows = db
    .prepare(
      `SELECT ca.future_ideas, ca.analyzed_at, ca.video_id, v.title AS video_title
       FROM comment_analysis ca
       JOIN videos v ON v.id = ca.video_id
       WHERE v.channel_id = ? AND ca.future_ideas IS NOT NULL AND ca.future_ideas != ''
       ORDER BY ca.analyzed_at DESC`
    )
    .all(activeId) as {
    future_ideas: string;
    analyzed_at: number;
    video_id: string;
    video_title: string;
  }[];

  const flattened: (AudienceRequest & { analyzedAt: number })[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.future_ideas);
    } catch {
      continue; // malformed JSON on this row — skip, don't fail the feed
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed as FutureIdeaRow[]) {
      if (typeof item !== "object" || item === null) continue;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (!title) continue;
      const demand =
        item.demand === "high" || item.demand === "medium" || item.demand === "low"
          ? item.demand
          : "medium";
      flattened.push({
        title,
        demand,
        evidence: typeof item.evidence === "string" ? item.evidence : "",
        videoId: row.video_id,
        videoTitle: row.video_title,
        analyzedAt: row.analyzed_at,
      });
    }
  }

  return flattened
    .sort((a, b) => {
      const rankDiff = DEMAND_RANK[a.demand] - DEMAND_RANK[b.demand];
      if (rankDiff !== 0) return rankDiff;
      return b.analyzedAt - a.analyzedAt;
    })
    .slice(0, 25)
    .map(({ analyzedAt: _analyzedAt, ...rest }) => rest);
}
