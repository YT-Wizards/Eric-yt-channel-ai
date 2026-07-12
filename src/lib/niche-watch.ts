import "server-only";
import {
  getActiveChannelId,
  getIntegration,
  listWatchNiches,
  pruneNicheHits,
  upsertNicheHit,
} from "./db";
import { fetchVideos, searchYouTube } from "./youtube";
import { log } from "./logger";

/**
 * Niche Watch scanning — the "search a few phrases, keep what's fresh
 * and hot" engine behind the watch_niches / niche_hits tables in db.ts.
 *
 * Universal by construction: every query is whatever the user typed as
 * a watch niche, nothing here is topic-specific.
 *
 * Per niche: one search.list call (100 units) for up to
 * SEARCH_MAX_RESULTS candidates, then one videos.list batch (1 unit per
 * 50 ids) for real stats. Kept videos are published within the last
 * MAX_AGE_DAYS days AND have at least MIN_VIEWS views — cheap filters
 * that keep "trending" from being swamped by old evergreen uploads or
 * brand-new videos with a handful of views. Quota is metered for real
 * inside youtube.ts's call(); the `apiUnits` numbers returned here are
 * only a rough estimate for the UI toast.
 */

const SEARCH_MAX_RESULTS = 25;
const MIN_VIEWS = 1000;
const MAX_AGE_DAYS = 7;

export type NicheToScan = { id: number; query: string };

export type NicheScanResult = {
  niches: number;
  found: number;
  apiUnits: number;
};

/**
 * Scan a single watch niche: search YouTube for its query, keep videos
 * published in the last 7 days with at least MIN_VIEWS views, compute
 * views-per-hour, and upsert each as a niche hit.
 *
 * Exported (rather than kept private inside scanWatchNiches below) so
 * the scan job route can drive niches one at a time and update job
 * progress (current query, running found-count) between calls — see
 * src/app/api/niche-watch/scan/route.ts.
 */
export async function scanOneNiche(
  niche: NicheToScan,
  apiKey: string
): Promise<{ found: number; apiUnits: number }> {
  // Restrict the search itself to the trend window and rank by views —
  // without publishedAfter, search returns all-time relevance hits and
  // the freshness filter below empties every scan.
  const searchResults = await searchYouTube(niche.query, apiKey, {
    type: "video",
    maxResults: SEARCH_MAX_RESULTS,
    publishedAfter: new Date(Date.now() - MAX_AGE_DAYS * 86400 * 1000).toISOString(),
    order: "viewCount",
  });
  let apiUnits = 100; // search.list, charged regardless of result count

  const ids = searchResults.map((r) => r.id).filter(Boolean);
  if (ids.length === 0) return { found: 0, apiUnits };

  // /videos doesn't return channelTitle (only channelId) — keep a
  // video-id -> channelTitle lookup from the search results so the hit
  // row can still store a human-readable channel name.
  const channelTitleByVideoId = new Map(
    searchResults.map((r) => [r.id, r.channelTitle])
  );

  const videos = await fetchVideos(ids, apiKey);
  apiUnits += Math.ceil(ids.length / 50);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - MAX_AGE_DAYS * 86400;

  let found = 0;
  for (const v of videos) {
    if (v.publishedAt < cutoff) continue;
    if (v.views < MIN_VIEWS) continue;

    const hoursSincePublish = Math.max(1, (nowSeconds - v.publishedAt) / 3600);
    const vph = Math.round((v.views / hoursSincePublish) * 10) / 10;

    upsertNicheHit({
      niche_id: niche.id,
      video_id: v.id,
      title: v.title,
      channel_title: channelTitleByVideoId.get(v.id) ?? null,
      channel_yt_id: v.channelId,
      views: v.views,
      published_at: v.publishedAt,
      vph,
    });
    found++;
  }

  return { found, apiUnits };
}

/**
 * Thin serial wrapper around scanOneNiche for callers that just want
 * "scan everything and tell me the totals" with no need for live
 * per-niche progress — e.g. a future cron/manual-trigger path. The
 * primary UI-facing path (POST /api/niche-watch/scan) does NOT call
 * this: it drives scanOneNiche itself in a loop so it can update the
 * job's `current` field between niches. Kept here anyway so that
 * behaviour (serial scan, per-niche error isolation, prune afterwards)
 * has exactly one implementation for any non-job caller to reuse.
 *
 * A single bad niche (search fails, transient network error, quota
 * exhausted) is caught and recorded rather than aborting the whole run.
 */
export async function scanWatchNiches(): Promise<NicheScanResult> {
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    throw new Error("YouTube API key is not configured. Add it in Integrations.");
  }
  if (!getActiveChannelId()) {
    throw new Error("No active channel selected");
  }

  const niches = listWatchNiches();
  let found = 0;
  let apiUnits = 0;
  let lastError: string | null = null;

  for (const niche of niches) {
    try {
      const result = await scanOneNiche(niche, apiKey);
      found += result.found;
      apiUnits += result.apiUnits;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn("niche-watch", `Scan skipped niche ${niche.id}: ${lastError}`, {
        nicheId: niche.id,
        query: niche.query,
      });
    }
  }

  try {
    pruneNicheHits();
  } catch (err) {
    log.warn("niche-watch", "pruneNicheHits failed (ignored)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { niches: niches.length, found, apiUnits };
}
