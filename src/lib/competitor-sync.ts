import "server-only";
import { apifyYouTubeScrape, type ApifyYouTubeVideo } from "./apify";
import {
  competitorMedianViews,
  getCompetitor,
  getIntegration,
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

/* ============================================================
 * Public entrypoint — picks the best backend and falls back on quota.
 * ============================================================ */

export async function syncCompetitor(competitorId: number): Promise<SyncResult> {
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
  //    failing the whole sync.
  let commentsSaved = 0;
  let quotaHitOnComments = false;
  for (const v of videos) {
    if (quotaHitOnComments) break;
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
      if (multiplier >= OUTLIER_MULTIPLIER) {
        recordCompetitorAlert({
          competitor_id: competitor.id,
          video_id: v.id,
          title: v.title,
          thumbnail_url: v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          views: v.views,
          channel_median_views: median,
          multiplier: Math.round(multiplier * 10) / 10,
        });
        newAlerts++;
      }
    }
  }

  log.info("competitors", "Competitor sync done (YouTube Data API)", {
    competitorId: competitor.id,
    videosSeen: videos.length,
    videosInserted,
    transcriptsSaved,
    commentsSaved,
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
      if (multiplier >= OUTLIER_MULTIPLIER) {
        recordCompetitorAlert({
          competitor_id: competitor.id,
          video_id: vid,
          title: it.title,
          thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
          views: it.viewCount,
          channel_median_views: median,
          multiplier: Math.round(multiplier * 10) / 10,
        });
        newAlerts++;
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
