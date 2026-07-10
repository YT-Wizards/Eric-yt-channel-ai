import "server-only";
import { apifyYouTubeScrape, type ApifyYouTubeVideo } from "./apify";
import {
  competitorMedianViews,
  db,
  getCompetitor,
  getIntegration,
  purgeStaleReadCompetitorAlerts,
  recordCompetitorAlert,
  updateCompetitorAfterSync,
  upsertCompetitorComments,
  upsertCompetitorVideo,
  type Competitor,
} from "./db";
import {
  fetchCommentThreads,
  fetchVideos,
  listUploadIds,
  resolveChannel,
  YouTubeApiError,
} from "./youtube";
import { log } from "./logger";

/* ============================================================
 * Competitor sync — YouTube Data API primary, Apify fallback.
 *
 * History: this used to be Apify-only because Apify scrapers don't need
 * an API key and don't share quota with anything else. The trade-off
 * was per-request cost (~$0.05 per channel sync) and slower throughput.
 *
 * Eric (and any local-only install) is better served by YouTube Data
 * API v3: 10k free units/day, faster, more accurate metadata. A typical
 * 50-video competitor sync costs roughly:
 *   - channels.list / search       1-10 units (channel resolution)
 *   - playlistItems.list           1 unit (uploads playlist)
 *   - videos.list (50/batch)       1 unit
 *   - commentThreads.list per video ~1 unit each   = ~50 units
 *   - timedtext (captions)         0 units (free, not in quota)
 *   ----------------------------------------------------------
 *   ~62 units per competitor full sync → ~160 syncs/day on the free
 *   tier. Plenty for any normal use.
 *
 * Apify is still here as a fallback for two cases:
 *   - User hasn't configured a YouTube Data API key yet
 *   - YT API quota exceeded for the day (403 with /quotaExceeded/)
 *
 * Apify gives metadata only; transcripts and comments are skipped on
 * the Apify path because the actor we use (streamers~youtube-scraper)
 * doesn't return them.
 * ============================================================ */

// Outlier threshold — when a video's views exceed median × this we flag it.
const OUTLIER_MULTIPLIER = 2.0;

// How many videos to pull per sync. Capped because:
//   - YouTube playlistItems.list returns 50 max per page
//   - Apify scraper rate is per request; 50 covers most channels' recent
//     activity without blowing through credits.
const VIDEOS_PER_SYNC = 50;

// Per-video cap for comments fetched on the YT-Data-API path. Most
// competitor analysis only needs the top-relevance handful — 20 is
// enough to surface theme + sentiment without doubling our quota cost.
const COMMENTS_PER_VIDEO = 20;

export class CompetitorSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitorSyncError";
  }
}

export type SyncResult = {
  videosSeen: number;
  videosInserted: number;
  newAlerts: number;
  channelTitle: string | null;
  medianViews: number;
  transcriptsSaved: number; // 0 on the Apify fallback path
  commentsSaved: number;    // 0 on the Apify fallback path
  source: "youtube-api" | "apify";
};

/**
 * Resolve various user-supplied identifiers (@handle, full URLs, plain
 * UCxxxxx) to a single canonical channel URL. Used by the Apify path,
 * which wants a URL string.
 */
export function normaliseChannelUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CompetitorSyncError("Empty channel identifier");
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/\/+$/, "");
  if (trimmed.startsWith("@")) {
    return `https://www.youtube.com/${trimmed}`;
  }
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}`;
  }
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://www.youtube.com/@${trimmed}`;
  }
  throw new CompetitorSyncError(
    `Could not parse identifier "${input}". Pass a YouTube channel URL, @handle, or UC-id.`
  );
}

/** Parse Apify's duration string ("PT3M42S" or "3:42" or seconds) into seconds. */
function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const iso = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (iso) {
    const [, h = "0", m = "0", s = "0"] = iso;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const parts = raw.split(":").map((p) => Number(p));
  if (parts.every((n) => Number.isFinite(n))) {
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function parseDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function extractVideoId(url: string | undefined, fallback: string | undefined): string | null {
  if (fallback) return fallback;
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|v=|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof YouTubeApiError)) return false;
  if (err.status !== 403) return false;
  return /quota/i.test(err.message);
}

// Cached prepared statement — this runs once per video on every sync
// (potentially dozens of times per competitor), so preparing it fresh
// each call would be wasteful. Mirrors the db.prepare(...).get(...)
// idiom used throughout db.ts (e.g. commentCount, unreadCompetitorAlertCount);
// added here rather than as a new db.ts export since it's a one-off,
// sync-internal existence check with no other caller.
const hasCachedCommentsStmt = db.prepare(
  `SELECT 1 FROM competitor_comments WHERE competitor_id = ? AND video_id = ? LIMIT 1`
);

/**
 * True when `video_id` already has at least one cached comment row for
 * this competitor. Used to skip re-fetching comments on every re-sync —
 * a competitor sync used to spend ~1 YT Data API call per video (up to
 * VIDEOS_PER_SYNC = 50) refetching the same top-relevance comment set
 * every single time, which is most of why a "healthy" sync took 1-3
 * minutes per competitor. Top-comment sets on an already-seen video
 * rarely shift enough between syncs to justify paying that cost again;
 * the video's view/like counts (which DO change) are still refreshed
 * every sync via upsertCompetitorVideo above, only the comment re-fetch
 * is skipped.
 */
function hasCachedComments(competitorId: number, videoId: string): boolean {
  return hasCachedCommentsStmt.get(competitorId, videoId) !== undefined;
}

/* ============================================================
 * Public entrypoint — picks the best backend and falls back on quota.
 * ============================================================ */

export async function syncCompetitor(competitorId: number): Promise<SyncResult> {
  // Piggyback the stale-alert purge on sync activity rather than a timer.
  purgeStaleReadCompetitorAlerts();

  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    throw new CompetitorSyncError(`Competitor ${competitorId} not found`);
  }

  const youtubeKey = getIntegration("youtube")?.api_key;
  const apifyKey = getIntegration("apify")?.api_key;

  // Prefer YouTube Data API: free, faster, richer (transcripts + comments).
  if (youtubeKey) {
    try {
      return await syncViaYouTubeApi(competitor, youtubeKey);
    } catch (err) {
      if (isQuotaExceeded(err) && apifyKey) {
        log.warn(
          "competitors",
          "YouTube Data API quota exceeded — falling back to Apify",
          { competitorId, error: err instanceof Error ? err.message : String(err) }
        );
        return await syncViaApify(competitor, apifyKey);
      }
      throw err;
    }
  }

  if (apifyKey) {
    log.info(
      "competitors",
      "No YouTube Data API key — using Apify for competitor sync",
      { competitorId }
    );
    return await syncViaApify(competitor, apifyKey);
  }

  throw new CompetitorSyncError(
    "No competitor-sync backend configured. Add a YouTube Data API key in Integrations (free, recommended) or an Apify token as a fallback."
  );
}

/* ============================================================
 * Backend: YouTube Data API (primary)
 * ============================================================ */

async function syncViaYouTubeApi(
  competitor: Competitor,
  youtubeKey: string
): Promise<SyncResult> {
  const input =
    competitor.channel_id ||
    competitor.handle ||
    null;
  if (!input) {
    throw new CompetitorSyncError(
      `Competitor ${competitor.id} has no channel identifier — re-add with a valid handle/URL.`
    );
  }

  log.info("competitors", "Syncing competitor via YouTube Data API", {
    competitorId: competitor.id,
    input,
  });
  const startedAt = Date.now();

  // 1. Resolve channel (~1-10 quota units)
  const ch = await resolveChannel(input, youtubeKey);

  // 2. List uploads (1 unit per 50-video page; cap to VIDEOS_PER_SYNC)
  const videoIds = await listUploadIds(ch.uploadsPlaylistId, youtubeKey, {
    max: VIDEOS_PER_SYNC,
  });

  // 3. Fetch video metadata (1 unit per 50-video batch)
  const videos = await fetchVideos(videoIds, youtubeKey);

  let videosInserted = 0;
  for (const v of videos) {
    upsertCompetitorVideo({
      competitor_id: competitor.id,
      video_id: v.id,
      title: v.title,
      thumbnail_url: v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      duration_seconds: v.durationSeconds,
      published_at: v.publishedAt,
    });
    videosInserted++;
  }

  // Persist channel-level metadata. resolveChannel already returned
  // subscribers / avatar / handle — previously we dropped them on the
  // floor here, which is why competitor cards showed "—" subs and a
  // letter-placeholder avatar even after a successful sync.
  updateCompetitorAfterSync(competitor.id, {
    title: ch.title,
    channel_id: ch.id,
    handle: ch.handle ?? competitor.handle,
    subscriber_count: ch.subscribers,
    avatar_url: ch.thumbnail,
    video_count: videosInserted,
  });

  // Competitor transcripts are no longer fetched — the free timedtext
  // path was removed platform-wide. Competitor sync keeps metadata +
  // comments only.
  const transcriptsSaved = 0;

  // 5. Top comments per video (1 unit per video — biggest quota chunk).
  //    If the quota runs out mid-loop we bail out gracefully without
  //    failing the whole sync. Videos already carrying cached comments
  //    from a previous sync are skipped entirely (see hasCachedComments)
  //    — this is the single biggest reason re-syncing a competitor used
  //    to take 1-3 minutes: 50 videos × 1 comment-thread call each, every
  //    single time, even though the top comments rarely change.
  let commentsSaved = 0;
  let commentsSkipped = 0;
  let quotaHitOnComments = false;
  for (const v of videos) {
    if (quotaHitOnComments) break;
    if (hasCachedComments(competitor.id, v.id)) {
      commentsSkipped++;
      continue;
    }
    try {
      const threads = await fetchCommentThreads(v.id, youtubeKey, {
        maxThreads: COMMENTS_PER_VIDEO,
        order: "relevance",
      });
      upsertCompetitorComments(
        competitor.id,
        threads
          // Only top-level for competitors — reply chains rarely add
          // signal and double the row count.
          .filter((c) => c.parentId === null)
          .map((c) => ({
            id: c.id,
            video_id: v.id,
            author: c.author,
            author_channel_id: c.authorChannelId,
            text: c.text,
            like_count: c.likes,
            reply_count: c.replyCount,
            published_at: c.publishedAt,
          }))
      );
      commentsSaved += threads.filter((c) => c.parentId === null).length;
    } catch (err) {
      if (isQuotaExceeded(err)) {
        log.warn(
          "competitors",
          "YouTube quota exceeded during competitor comments — stopping comments fetch but keeping metadata/transcripts",
          { competitorId: competitor.id, videosWithComments: commentsSaved }
        );
        quotaHitOnComments = true;
        continue;
      }
      // Comments disabled, video private, etc. — log and move on.
      log.warn("competitors", "Failed to fetch comments for competitor video", {
        competitorId: competitor.id,
        videoId: v.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Outlier scan — runs after inserts so median includes the new rows.
  const median = competitorMedianViews(competitor.id);
  let newAlerts = 0;
  if (median > 0) {
    for (const v of videos) {
      if (!v.views) continue;
      const multiplier = v.views / median;
      // Noise floor for the legacy median-outlier detector only: a tiny
      // channel's median can be a handful of views, so "2x median" can
      // trip on e.g. 40 views vs a 20-view median — real to the channel,
      // meaningless to the user browsing alerts. The "fresh" detector
      // below already has its own floor (views >= max(1000, 0.1*median)).
      const isMedianOutlier = multiplier >= OUTLIER_MULTIPLIER && v.views >= 1000;
      if (isMedianOutlier) {
        recordCompetitorAlert({
          competitor_id: competitor.id,
          video_id: v.id,
          title: v.title,
          thumbnail_url: v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          views: v.views,
          channel_median_views: median,
          multiplier: Math.round(multiplier * 10) / 10,
          published_at: v.publishedAt ?? null,
        });
        newAlerts++;
      }

      /* --------------------------------------------------------------
       * "Fresh outlier" — catches a spike while it's still happening,
       * instead of waiting for lifetime views to cross 2× median (which
       * a brand-new upload can't do for days). Mirrors the reference
       * product's "X views in 4h" alert.
       *
       * - Only videos aged 0.5-72h: younger than 30min is too noisy
       *   (view counts lag on YouTube's end right after publish), older
       *   than 72h and the lifetime median check above is the better
       *   signal anyway.
       * - expectedPace assumes "reasonable" videos reach the channel's
       *   median over a week (÷168 = hours/week) — that's the bar a
       *   fresh video needs to beat, not just any nonzero velocity.
       * - Require 3× that pace (not 1x) so we don't flag ordinary
       *   variance as a spike — only videos running at 3x the speed
       *   needed to hit median-in-a-week count as "fresh outlier".
       * - The `views >= max(1000, 0.1 * median)` floor keeps tiny
       *   channels/videos (a handful of views in the first minutes)
       *   from tripping the ratio purely on small numbers.
       * - Skip if it already qualifies as a median outlier — that's
       *   the stronger, confirmed signal, and letting fresh fire too
       *   would just overwrite the median alert row on the
       *   (competitor_id, video_id) upsert.
       * ------------------------------------------------------------ */
      if (!isMedianOutlier && v.publishedAt) {
        const ageHours = (Date.now() / 1000 - v.publishedAt) / 3600;
        if (ageHours >= 0.5 && ageHours <= 72) {
          const expectedPaceViewsPerHour = median / 168;
          const vph = v.views / ageHours;
          if (
            expectedPaceViewsPerHour > 0 &&
            vph >= 3 * expectedPaceViewsPerHour &&
            v.views >= Math.max(1000, 0.1 * median)
          ) {
            recordCompetitorAlert({
              competitor_id: competitor.id,
              video_id: v.id,
              title: v.title,
              thumbnail_url: v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
              views: v.views,
              channel_median_views: median,
              multiplier: Math.round((vph / expectedPaceViewsPerHour) * 10) / 10,
              kind: "fresh",
              age_hours: Math.round(ageHours * 10) / 10,
              published_at: v.publishedAt ?? null,
            });
            newAlerts++;
          }
        }
      }
    }
  }

  log.info("competitors", "Competitor sync done (YouTube Data API)", {
    competitorId: competitor.id,
    videosSeen: videos.length,
    videosInserted,
    transcriptsSaved,
    commentsSaved,
    commentsSkipped,
    newAlerts,
    medianViews: median,
    durationMs: Date.now() - startedAt,
  });

  return {
    videosSeen: videos.length,
    videosInserted,
    newAlerts,
    channelTitle: ch.title,
    medianViews: median,
    transcriptsSaved,
    commentsSaved,
    source: "youtube-api",
  };
}

/* ============================================================
 * Backend: Apify (fallback)
 * ============================================================ */

async function syncViaApify(
  competitor: Competitor,
  apifyKey: string
): Promise<SyncResult> {
  const url = competitor.channel_id
    ? `https://www.youtube.com/channel/${competitor.channel_id}`
    : competitor.handle
      ? normaliseChannelUrl(competitor.handle)
      : null;
  if (!url) {
    throw new CompetitorSyncError(
      `Competitor ${competitor.id} has no channel identifier — re-add with a valid handle/URL.`
    );
  }

  log.info("competitors", "Syncing competitor via Apify (fallback)", {
    competitorId: competitor.id,
    url,
  });
  const startedAt = Date.now();
  const items: ApifyYouTubeVideo[] = await apifyYouTubeScrape(
    { startUrls: [{ url }], maxResults: VIDEOS_PER_SYNC, includeTranscript: false },
    apifyKey
  );

  const first = items[0];
  const channelTitle = first?.channelName ?? competitor.title ?? null;
  const channelIdMatch = first?.channelUrl?.match(/channel\/(UC[A-Za-z0-9_-]+)/);
  const resolvedChannelId = channelIdMatch
    ? channelIdMatch[1]
    : competitor.channel_id ?? null;

  let videosInserted = 0;
  for (const it of items) {
    const vid = extractVideoId(it.url, it.id);
    if (!vid || !it.title) continue;
    upsertCompetitorVideo({
      competitor_id: competitor.id,
      video_id: vid,
      title: it.title,
      thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
      views: it.viewCount ?? 0,
      likes: it.likes ?? 0,
      comments: it.commentsCount ?? 0,
      duration_seconds: parseDuration(it.duration),
      published_at: parseDate(it.date),
    });
    videosInserted++;
  }

  // Apify's video scraper doesn't return channel-level subscriber count
  // or avatar — those fields stay whatever they were. The YouTube Data
  // API path (preferred) fills them in properly; Apify is a quota
  // fallback so this gap is acceptable.
  updateCompetitorAfterSync(competitor.id, {
    title: channelTitle,
    channel_id: resolvedChannelId,
    video_count: videosInserted,
  });

  const median = competitorMedianViews(competitor.id);
  let newAlerts = 0;
  if (median > 0) {
    for (const it of items) {
      const vid = extractVideoId(it.url, it.id);
      if (!vid || !it.title || !it.viewCount) continue;
      const multiplier = it.viewCount / median;
      // Noise floor for the legacy median-outlier detector only — see
      // matching comment on the YouTube Data API path above. The
      // "fresh" detector below already has its own floor.
      const isMedianOutlier = multiplier >= OUTLIER_MULTIPLIER && it.viewCount >= 1000;
      // Parsed once here and reused by the "fresh outlier" check below.
      const publishedAt = parseDate(it.date);
      if (isMedianOutlier) {
        recordCompetitorAlert({
          competitor_id: competitor.id,
          video_id: vid,
          title: it.title,
          thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
          views: it.viewCount,
          channel_median_views: median,
          multiplier: Math.round(multiplier * 10) / 10,
          published_at: publishedAt,
        });
        newAlerts++;
      }

      /* --------------------------------------------------------------
       * "Fresh outlier" — catches a spike while it's still happening,
       * instead of waiting for lifetime views to cross 2× median (which
       * a brand-new upload can't do for days). Mirrors the reference
       * product's "X views in 4h" alert.
       *
       * - Only videos aged 0.5-72h: younger than 30min is too noisy
       *   (view counts lag on YouTube's end right after publish), older
       *   than 72h and the lifetime median check above is the better
       *   signal anyway.
       * - expectedPace assumes "reasonable" videos reach the channel's
       *   median over a week (÷168 = hours/week) — that's the bar a
       *   fresh video needs to beat, not just any nonzero velocity.
       * - Require 3× that pace (not 1x) so we don't flag ordinary
       *   variance as a spike — only videos running at 3x the speed
       *   needed to hit median-in-a-week count as "fresh outlier".
       * - The `views >= max(1000, 0.1 * median)` floor keeps tiny
       *   channels/videos (a handful of views in the first minutes)
       *   from tripping the ratio purely on small numbers.
       * - Skip if it already qualifies as a median outlier — that's
       *   the stronger, confirmed signal, and letting fresh fire too
       *   would just overwrite the median alert row on the
       *   (competitor_id, video_id) upsert.
       * ------------------------------------------------------------ */
      if (!isMedianOutlier && publishedAt) {
        const ageHours = (Date.now() / 1000 - publishedAt) / 3600;
        if (ageHours >= 0.5 && ageHours <= 72) {
          const expectedPaceViewsPerHour = median / 168;
          const vph = it.viewCount / ageHours;
          if (
            expectedPaceViewsPerHour > 0 &&
            vph >= 3 * expectedPaceViewsPerHour &&
            it.viewCount >= Math.max(1000, 0.1 * median)
          ) {
            recordCompetitorAlert({
              competitor_id: competitor.id,
              video_id: vid,
              title: it.title,
              thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
              views: it.viewCount,
              channel_median_views: median,
              multiplier: Math.round((vph / expectedPaceViewsPerHour) * 10) / 10,
              kind: "fresh",
              age_hours: Math.round(ageHours * 10) / 10,
              published_at: publishedAt,
            });
            newAlerts++;
          }
        }
      }
    }
  }

  log.info("competitors", "Competitor sync done (Apify fallback)", {
    competitorId: competitor.id,
    videosSeen: items.length,
    videosInserted,
    newAlerts,
    medianViews: median,
    durationMs: Date.now() - startedAt,
  });

  return {
    videosSeen: items.length,
    videosInserted,
    newAlerts,
    channelTitle,
    medianViews: median,
    transcriptsSaved: 0,
    commentsSaved: 0,
    source: "apify",
  };
}
