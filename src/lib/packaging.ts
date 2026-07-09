import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  getActiveChannelId,
  getIntegration,
  getSetting,
  setSetting,
  titleWordStats,
} from "./db";

/* ============================================================
 * PACKAGING ANALYSIS
 *
 * Statistics over the ACTIVE channel's own catalogue answering one
 * question: which TITLE + THUMBNAIL-TEXT combinations actually pull
 * views on this channel? Mirrors the Formula Analyzer's approach
 * (titleWordStats / titleLengthBuckets / topVsBottomTitles in
 * db.ts) — same query style, same "median x1.5 = success" grading,
 * same per-active-channel scoping via getActiveChannelId() — but
 * applied to `videos.thumbnail_text` (OCR'd thumbnail copy) and
 * `videos.category` instead of just the title.
 *
 * IMPORTANT CAVEAT: `thumbnail_text` is only populated for videos
 * that have gone through the thumbnail-OCR backfill (see
 * listVideosMissingThumbnailText / updateVideoThumbnailText in
 * db.ts). Any function here that reports on thumbnail text is
 * therefore scoped to the OCR'd subset of the catalogue, not the
 * whole channel — small/young channels or ones that haven't run
 * the backfill yet will see thin or empty results. Functions that
 * only look at titles (e.g. channelViewStats) still cover every
 * video with a non-null view count.
 *
 * Every function here returns an empty/neutral result when there's
 * no active channel — callers (the API route) turn that into a 400
 * instead of the lib layer throwing.
 * ============================================================ */

export type PackageRow = {
  id: string;
  title: string;
  thumbnailText: string;
  views: number;
  multiplier: number;
};

const ANALYZER_MODEL = "claude-sonnet-4-6";

const FORMULA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* ---------- shared row helpers ---------- */

type ViewsRow = { id: string; title: string; views: number };
type ThumbRow = { id: string; title: string; thumbnail_text: string; views: number };

function activeChannelViewsRows(): ViewsRow[] {
  const activeId = getActiveChannelId();
  if (!activeId) return [];
  return db
    .prepare(
      `SELECT id, title, views
       FROM videos
       WHERE channel_id = ? AND views IS NOT NULL`
    )
    .all(activeId) as ViewsRow[];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Channel-wide view stats — the baseline everything else in this
 * module compares against. `withThumbText` tells the caller how much
 * of the catalogue the thumbnail-specific stats below actually cover
 * (see the OCR caveat in the module header).
 */
export function channelViewStats(): {
  avg: number;
  median: number;
  count: number;
  withThumbText: number;
} {
  const rows = activeChannelViewsRows();
  if (rows.length === 0) return { avg: 0, median: 0, count: 0, withThumbText: 0 };
  const views = rows.map((r) => r.views).sort((a, b) => a - b);
  const total = views.reduce((a, b) => a + b, 0);

  const activeId = getActiveChannelId();
  const withThumbTextRow = activeId
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM videos
           WHERE channel_id = ? AND views IS NOT NULL
             AND thumbnail_text IS NOT NULL AND thumbnail_text != ''`
        )
        .get(activeId) as { n: number } | undefined)
    : undefined;

  return {
    avg: Math.round(total / rows.length),
    median: median(views),
    count: rows.length,
    withThumbText: withThumbTextRow?.n ?? 0,
  };
}

/**
 * The `topPackages(15)` view for the dashboard — the best-performing
 * title + thumbnail-text pairs, ranked by raw views. `multiplier` is
 * views / channelAvg (avg taken over ALL channel videos with views,
 * not just the OCR'd ones) so a package's strength reads at a glance
 * ("2.3x the channel average").
 */
export function topPackages(limit = 15): { channelAvg: number; rows: PackageRow[] } {
  const activeId = getActiveChannelId();
  if (!activeId) return { channelAvg: 0, rows: [] };

  const allRows = activeChannelViewsRows();
  const channelAvg =
    allRows.length > 0
      ? allRows.reduce((a, b) => a + b.views, 0) / allRows.length
      : 0;

  const rows = db
    .prepare(
      `SELECT id, title, thumbnail_text, views
       FROM videos
       WHERE channel_id = ? AND views IS NOT NULL
         AND thumbnail_text IS NOT NULL AND thumbnail_text != ''
       ORDER BY views DESC
       LIMIT ?`
    )
    .all(activeId, limit) as ThumbRow[];

  return {
    channelAvg: Math.round(channelAvg),
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnailText: r.thumbnail_text,
      views: r.views,
      multiplier:
        channelAvg > 0 ? Math.round((r.views / channelAvg) * 10) / 10 : 0,
    })),
  };
}

/* ---------- feature impact ---------- */

type FeatureCheck = {
  feature: string;
  label: string;
  scope: "title" | "thumb";
  test: (video: { title: string; thumbnail_text: string }) => boolean;
};

const TITLE_FEATURE_CHECKS: FeatureCheck[] = [
  {
    feature: "title_has_number",
    label: "Title has a number",
    scope: "title",
    test: (v) => /\d/.test(v.title),
  },
  {
    feature: "title_has_year",
    label: "Title has a year (e.g. 2024)",
    scope: "title",
    test: (v) => /\b(19|20)\d{2}\b/.test(v.title),
  },
  {
    feature: "title_is_question",
    label: "Title is a question",
    scope: "title",
    test: (v) => v.title.includes("?"),
  },
  {
    feature: "title_has_price",
    label: "Title has a price ($/€/£)",
    scope: "title",
    test: (v) => /[$€£]\s?\d/.test(v.title),
  },
  {
    feature: "long_title",
    label: "Long title (13+ words)",
    scope: "title",
    test: (v) => wordCount(v.title) >= 13,
  },
];

const THUMB_FEATURE_CHECKS: FeatureCheck[] = [
  {
    feature: "thumb_has_number",
    label: "Thumbnail text has a number",
    scope: "thumb",
    test: (v) => /\d/.test(v.thumbnail_text),
  },
  {
    feature: "thumb_has_price",
    label: "Thumbnail text has a price ($/€/£)",
    scope: "thumb",
    test: (v) => /[$€£]\s?\d/.test(v.thumbnail_text),
  },
  {
    feature: "thumb_all_caps",
    label: "Thumbnail text is ALL CAPS",
    scope: "thumb",
    test: (v) => isAllCaps(v.thumbnail_text),
  },
  {
    feature: "thumb_short",
    label: "Short thumbnail text (<=3 words)",
    scope: "thumb",
    test: (v) => wordCount(v.thumbnail_text) <= 3,
  },
  {
    feature: "thumb_long",
    label: "Long thumbnail text (7+ words)",
    scope: "thumb",
    test: (v) => wordCount(v.thumbnail_text) >= 7,
  },
];

function wordCount(s: string): number {
  return (s ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function isAllCaps(s: string): boolean {
  const letters = (s ?? "").replace(/[^a-zA-Zа-яА-ЯёЁіїєґІЇЄҐ]/g, "");
  if (letters.length === 0) return false;
  return letters === letters.toUpperCase();
}

/**
 * Universal packaging-feature lift: for each feature, split the
 * catalogue into "has it" vs "doesn't", compare average views, and
 * report the percentage delta. Title features run over every video
 * with views; thumbnail features run only over the OCR'd subset
 * (videos that have thumbnail_text) since a "has no thumbnail text"
 * bucket would just be measuring "was this video ever OCR'd", not a
 * real packaging choice.
 *
 * A feature is only included once both sides have at least 2 videos
 * — below that the delta is just noise from a single outlier.
 * Sorted by |deltaPct| descending so the strongest signals surface
 * first regardless of direction.
 */
export function featureImpact(): Array<{
  feature: string;
  label: string;
  withCount: number;
  withoutCount: number;
  avgWith: number;
  avgWithout: number;
  deltaPct: number;
}> {
  const activeId = getActiveChannelId();
  if (!activeId) return [];

  const allRows = db
    .prepare(
      `SELECT id, title, thumbnail_text, views
       FROM videos
       WHERE channel_id = ? AND views IS NOT NULL`
    )
    .all(activeId) as ThumbRow[];
  if (allRows.length === 0) return [];

  const normalized = allRows.map((r) => ({
    title: r.title ?? "",
    thumbnail_text: r.thumbnail_text ?? "",
    views: r.views,
    hasThumbText: !!(r.thumbnail_text && r.thumbnail_text.trim() !== ""),
  }));

  const thumbSubset = normalized.filter((v) => v.hasThumbText);

  const results: Array<{
    feature: string;
    label: string;
    withCount: number;
    withoutCount: number;
    avgWith: number;
    avgWithout: number;
    deltaPct: number;
  }> = [];

  const evalCheck = (
    check: FeatureCheck,
    pool: { title: string; thumbnail_text: string; views: number }[]
  ) => {
    const withViews: number[] = [];
    const withoutViews: number[] = [];
    for (const v of pool) {
      if (check.test(v)) withViews.push(v.views);
      else withoutViews.push(v.views);
    }
    if (withViews.length < 2 || withoutViews.length < 2) return;
    const avgWith = withViews.reduce((a, b) => a + b, 0) / withViews.length;
    const avgWithout =
      withoutViews.reduce((a, b) => a + b, 0) / withoutViews.length;
    const deltaPct =
      avgWithout > 0 ? ((avgWith - avgWithout) / avgWithout) * 100 : 0;
    results.push({
      feature: check.feature,
      label: check.label,
      withCount: withViews.length,
      withoutCount: withoutViews.length,
      avgWith: Math.round(avgWith),
      avgWithout: Math.round(avgWithout),
      deltaPct: Math.round(deltaPct * 10) / 10,
    });
  };

  for (const check of TITLE_FEATURE_CHECKS) evalCheck(check, normalized);
  for (const check of THUMB_FEATURE_CHECKS) evalCheck(check, thumbSubset);

  return results.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
}

/* ---------- thumbnail word stats ---------- */

// Same stopword list as tokeniseForFormula in db.ts (kept in sync by hand
// since it's not exported) — the word-frequency signal should mean the
// same thing whether we're looking at titles or thumbnail text.
const THUMB_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with","is","are","was","were","be","been",
  "this","that","these","those","i","you","he","she","it","we","they","my","your","his","her","its","our","their",
  "do","does","did","done","have","has","had","not","no","yes","at","by","from","as","than","then","so","very",
  "what","when","where","why","how","who","which","there","here","just","like","get","got","make","made",
  "will","would","can","could","should","shall","may","might","one","two","three","new","video","watch",
]);

/**
 * Tokenize thumbnail text the same way tokeniseForFormula (db.ts)
 * tokenizes titles, except `$` survives the strip since a bare price
 * ("$500") is a common — and meaningful — thumbnail token. Minimum
 * token length is 2 (vs. 3 for titles) because short punchy thumbnail
 * words ("NO", "OK", "10x") carry real signal at that length.
 */
function tokeniseThumbnailText(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9$ ]+/giu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !THUMB_STOPWORDS.has(w));
}

export type ThumbnailWordStat = {
  word: string;
  uses: number;
  avgViews: number;
  successRate: number; // share of uses where views >= channel median x 1.5
  exampleThumbText: string;
};

/**
 * Per-word stats across the active channel's thumbnail text — the
 * thumbnail-text mirror of titleWordStats in db.ts. Same "success"
 * definition (views >= channel median x 1.5), same sort (by total
 * views desc, so the most-tested words rank first), same minUses
 * gate. Only covers OCR'd videos (see module header caveat).
 */
export function thumbnailWordStats(
  minUses = 2,
  topN = 30
): ThumbnailWordStat[] {
  const activeId = getActiveChannelId();
  if (!activeId) return [];

  const allViews = activeChannelViewsRows().map((r) => r.views).sort((a, b) => a - b);
  if (allViews.length === 0) return [];
  const successThreshold = median(allViews) * 1.5;

  const rows = db
    .prepare(
      `SELECT id, title, thumbnail_text, views
       FROM videos
       WHERE channel_id = ? AND views IS NOT NULL
         AND thumbnail_text IS NOT NULL AND thumbnail_text != ''`
    )
    .all(activeId) as ThumbRow[];
  if (rows.length === 0) return [];

  type Agg = {
    uses: number;
    totalViews: number;
    successes: number;
    sampleThumbText: string;
  };
  const stats = new Map<string, Agg>();
  for (const r of rows) {
    const words = new Set(tokeniseThumbnailText(r.thumbnail_text));
    for (const w of words) {
      const cur = stats.get(w);
      if (cur) {
        cur.uses += 1;
        cur.totalViews += r.views;
        if (r.views >= successThreshold) cur.successes += 1;
      } else {
        stats.set(w, {
          uses: 1,
          totalViews: r.views,
          successes: r.views >= successThreshold ? 1 : 0,
          sampleThumbText: r.thumbnail_text,
        });
      }
    }
  }

  return Array.from(stats.entries())
    .filter(([, s]) => s.uses >= minUses)
    .map(([word, s]) => ({
      word,
      uses: s.uses,
      avgViews: Math.round(s.totalViews / s.uses),
      successRate: Math.round((s.successes / s.uses) * 100),
      exampleThumbText: s.sampleThumbText,
    }))
    .sort((a, b) => b.avgViews * b.uses - a.avgViews * a.uses)
    .slice(0, topN);
}

/* ---------- thumbnail length buckets ---------- */

const THUMB_LENGTH_BUCKET_ORDER = ["no text", "1 word", "2-3", "4-6", "7+"] as const;

/**
 * Thumbnail-text length performance buckets — the thumbnail-text
 * mirror of titleLengthBuckets in db.ts. Crucially includes a
 * "no text" bucket (videos never OCR'd, or OCR'd empty) as the
 * baseline everything else is measured against — without it there'd
 * be no way to tell whether having ANY thumbnail text helps at all.
 */
export function thumbnailLengthBuckets(): Array<{
  bucket: string;
  count: number;
  avgViews: number;
}> {
  const empty = THUMB_LENGTH_BUCKET_ORDER.map((bucket) => ({
    bucket,
    count: 0,
    avgViews: 0,
  }));
  const activeId = getActiveChannelId();
  if (!activeId) return empty;

  const rows = db
    .prepare(
      `SELECT id, title, thumbnail_text, views
       FROM videos
       WHERE channel_id = ? AND views IS NOT NULL`
    )
    .all(activeId) as ThumbRow[];
  if (rows.length === 0) return empty;

  const buckets: Record<(typeof THUMB_LENGTH_BUCKET_ORDER)[number], number[]> = {
    "no text": [],
    "1 word": [],
    "2-3": [],
    "4-6": [],
    "7+": [],
  };
  for (const r of rows) {
    const text = (r.thumbnail_text ?? "").trim();
    if (text === "") {
      buckets["no text"].push(r.views);
      continue;
    }
    const n = wordCount(text);
    if (n <= 1) buckets["1 word"].push(r.views);
    else if (n <= 3) buckets["2-3"].push(r.views);
    else if (n <= 6) buckets["4-6"].push(r.views);
    else buckets["7+"].push(r.views);
  }

  return THUMB_LENGTH_BUCKET_ORDER.map((bucket) => {
    const arr = buckets[bucket];
    return {
      bucket,
      count: arr.length,
      avgViews:
        arr.length > 0
          ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
          : 0,
    };
  });
}

/* ---------- Claude-written "winning formula" summary ---------- */

type FormulaCacheEntry = { text: string; ts: number };

function formulaCacheKey(channelId: string): string {
  return `packaging.formula.${channelId}`;
}

/**
 * Cached, Claude-written prose summary of "this channel's winning
 * packaging formula" — one Claude call over the real stats computed
 * above, cached per-channel in the `settings` table (same
 * getSetting/setSetting key-value store other cached lookups use)
 * as `{ text, ts }` JSON. Recomputed when the cache is missing,
 * stale (> 7 days), or `opts.refresh` is set.
 *
 * Returns null — NOT a thrown error — when there's no active
 * channel or no Claude API key configured, mirroring how
 * analyzeVideoComments (comment-analyzer.ts) reports a soft
 * "can't do this right now" instead of blowing up the route.
 */
export async function packagingFormulaSummary(
  opts: { refresh?: boolean } = {}
): Promise<string | null> {
  const activeId = getActiveChannelId();
  if (!activeId) return null;

  const cacheKey = formulaCacheKey(activeId);
  if (!opts.refresh) {
    const cachedRaw = getSetting(cacheKey);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as FormulaCacheEntry;
        if (
          cached &&
          typeof cached.text === "string" &&
          typeof cached.ts === "number" &&
          Date.now() - cached.ts < FORMULA_CACHE_MAX_AGE_MS
        ) {
          return cached.text;
        }
      } catch {
        /* fall through and recompute on parse failure */
      }
    }
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) return null;

  const payload = {
    topPackages: topPackages(10),
    featureImpact: featureImpact().slice(0, 8),
    thumbnailWordStats: thumbnailWordStats(2, 15),
    titleWordStats: titleWordStats({ minUses: 2, topN: 15 }),
    thumbnailLengthBuckets: thumbnailLengthBuckets(),
  };

  const instruction =
    "From these REAL statistics of one YouTube channel, write the channel's " +
    "winning packaging formula: 1) a one-line title structure template with " +
    "placeholders, 2) a one-line thumbnail-text recipe, 3) 3 short bullet " +
    "rules citing the numbers. Same language as the sample titles. No " +
    "generic advice — every claim must reference a stat given.";

  const client = new Anthropic({ apiKey });
  let text: string;
  try {
    const response = await client.messages.create({
      model: ANALYZER_MODEL,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `${instruction}\n\nStatistics:\n${JSON.stringify(payload)}`,
        },
      ],
    });
    text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch {
    // Claude call failed (rate limit, network, bad key, etc.) — behave
    // like "no key configured" rather than surfacing a 500 to the route.
    return null;
  }
  if (!text) return null;

  const entry: FormulaCacheEntry = { text, ts: Date.now() };
  setSetting(cacheKey, JSON.stringify(entry));
  return text;
}
