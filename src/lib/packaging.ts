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
 *
 * STATISTICAL HONESTY. Two failure modes were caught with real data
 * on a live channel and are guarded against below:
 *   1) TINY-SAMPLE OVERCLAIMING — a word/feature seen only 1-2 times
 *      can look like a "rule" when really it's riding one outlier
 *      video (e.g. a word that happens to label the channel's single
 *      viral topic reads as a huge view-driver when it's actually a
 *      proxy for the topic, not a causal packaging choice). Guarded
 *      by per-side minimum-count gates (featureImpact) and a raised
 *      minUses for anything that feeds the prose formula
 *      (FORMULA_MIN_USES).
 *   2) IMMATURITY BIAS — lifetime views of a video published days ago
 *      are not comparable to a years-old video's lifetime views; every
 *      recently-used word/feature looks artificially weak next to old
 *      virals that have had years to accumulate views. Guarded by
 *      MIN_AGE_DAYS, applied to the prescriptive functions only (see
 *      below) — NOT to the purely descriptive ones.
 * ============================================================ */

/**
 * Views of videos younger than this haven't matured; comparing their
 * lifetime views against old videos poisons word/feature stats (a
 * video published 3 days ago will almost always look "worse" than one
 * published 3 years ago purely because it's had less time to
 * accumulate views, not because its packaging was weaker). Applied to
 * featureImpact(), thumbnailWordStats(), and thumbnailLengthBuckets()
 * — the functions whose output gets read as "do this / don't do
 * that" advice. NOT applied to topPackages() or channelViewStats(),
 * which describe the catalogue as it is rather than prescribe what to
 * do next, so including young videos there is honest, not misleading.
 */
const MIN_AGE_DAYS = 14;

/**
 * Unix-seconds cutoff for the maturity filter above — videos with
 * `published_at` older than (i.e. numerically less than) this value
 * have had at least MIN_AGE_DAYS to accumulate views. `published_at`
 * is stored in unix seconds (see sql-tool.ts), matching the
 * `Math.floor(Date.now() / 1000) - days * 86400` pattern already used
 * elsewhere in this codebase (e.g. purgeStaleReadCompetitorAlerts in
 * db.ts). Computed fresh on every call rather than cached as a module
 * constant so a long-lived server process doesn't serve a stale
 * cutoff.
 */
function matureCutoffUnixSeconds(): number {
  return Math.floor(Date.now() / 1000) - MIN_AGE_DAYS * 86400;
}

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
 * Two guards against reading noise as a rule (see module header):
 *   - MATURITY: only videos published >= MIN_AGE_DAYS ago are
 *     considered, so a feature used mostly on recent uploads doesn't
 *     look artificially weak against old videos that have had years
 *     to accumulate views.
 *   - SAMPLE SIZE: a feature is only included once BOTH sides
 *     ("has it" and "doesn't") have at least 3 videos — below that
 *     the delta is just noise from one or two outliers.
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
       WHERE channel_id = ? AND views IS NOT NULL
         AND published_at IS NOT NULL AND published_at <= ?`
    )
    .all(activeId, matureCutoffUnixSeconds()) as ThumbRow[];
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
    if (withViews.length < 3 || withoutViews.length < 3) return;
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
 * Minimum uses-per-word for a word to be trusted as a stated,
 * causal packaging rule (as opposed to a merely-observed data point).
 * Used to gate what packagingFormulaSummary() feeds Claude — the
 * table on the Packaging tab still defaults to the looser `minUses`
 * param below so the UI can show "worth testing" words too; it's only
 * the prose "winning formula" that requires this stricter bar (see
 * module header, failure mode 1).
 */
export const FORMULA_MIN_USES = 5;

/**
 * Per-word stats across the active channel's thumbnail text — the
 * thumbnail-text mirror of titleWordStats in db.ts. Same "success"
 * definition (views >= channel median x 1.5), same sort (by total
 * views desc, so the most-tested words rank first), same minUses
 * gate. Only covers OCR'd videos (see module header caveat).
 *
 * Also applies the MIN_AGE_DAYS maturity filter (see module header,
 * failure mode 2) — a word used mostly on last week's uploads would
 * otherwise look like a loser next to words used on years-old virals
 * that have simply had more time to accumulate views.
 */
export function thumbnailWordStats(
  minUses = 2,
  topN = 30
): ThumbnailWordStat[] {
  const activeId = getActiveChannelId();
  if (!activeId) return [];

  const cutoff = matureCutoffUnixSeconds();
  const allViews = activeChannelViewsRows().map((r) => r.views).sort((a, b) => a - b);
  if (allViews.length === 0) return [];
  const successThreshold = median(allViews) * 1.5;

  const rows = db
    .prepare(
      `SELECT id, title, thumbnail_text, views
       FROM videos
       WHERE channel_id = ? AND views IS NOT NULL
         AND thumbnail_text IS NOT NULL AND thumbnail_text != ''
         AND published_at IS NOT NULL AND published_at <= ?`
    )
    .all(activeId, cutoff) as ThumbRow[];
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
 *
 * Applies the MIN_AGE_DAYS maturity filter (see module header,
 * failure mode 2) so a bucket that happens to hold mostly-recent
 * uploads isn't penalized for not having had time to accumulate views.
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
       WHERE channel_id = ? AND views IS NOT NULL
         AND published_at IS NOT NULL AND published_at <= ?`
    )
    .all(activeId, matureCutoffUnixSeconds()) as ThumbRow[];
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

// v2: bumped when the summary's inputs/prompt changed to enforce
// statistical honesty (maturity cutoff, raised minUses, mandatory
// sample-size citations — see module header). Old `packaging.formula.
// <channelId>` entries are simply never read again under this key;
// they age out as harmless orphans in the settings table rather than
// needing an explicit migration/delete.
function formulaCacheKey(channelId: string): string {
  return `packaging.formula.v2.${channelId}`;
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
 *
 * STATISTICAL HONESTY (see module header): every input here is
 * already filtered/gated before it reaches Claude —
 * featureImpact/thumbnailWordStats/thumbnailLengthBuckets apply the
 * MIN_AGE_DAYS maturity cutoff internally, and both word-stat calls
 * below use FORMULA_MIN_USES (5) instead of the UI's looser default —
 * but the prompt ALSO has to say so explicitly, because Claude can
 * still misread a correct-but-small number in the JSON as license for
 * a confident rule. Hence the instruction below spells out sample-size
 * citation, a small-sample carve-out, and a mandatory caveats section
 * rather than trusting pre-filtered data alone.
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
    featureImpact: featureImpact(),
    thumbnailWordStats: thumbnailWordStats(FORMULA_MIN_USES, 15),
    titleWordStats: titleWordStats({ minUses: 5, topN: 15 }),
    thumbnailLengthBuckets: thumbnailLengthBuckets(),
  };

  const instruction = [
    "From these REAL statistics of one YouTube channel, write the channel's winning packaging formula:",
    "1) a one-line title structure template with placeholders,",
    "2) a one-line thumbnail-text recipe,",
    "3) 3 short bullet rules citing the numbers.",
    "",
    "Statistical honesty rules — follow all of them exactly:",
    "- Every quantitative rule MUST cite its sample size inline, in the form (n=17).",
    "- NEVER state a causal rule from a word or feature with fewer than 5 uses on each side (e.g. used only 5 times, or with fewer than 5 videos lacking it). Words/features below that bar may only be listed under a separate \"Worth testing (small sample)\" list, named with their use count but WITHOUT view numbers or any performance claim.",
    "- Prefer title-structure patterns (typically higher n) over thumbnail-word claims (typically lower n) when both are available — lead with what the larger sample supports.",
    "- Treat word stats as correlated with the video's TOPIC, not proven causes of performance. If a high-performing word is plausibly just naming the topic of one or two big videos rather than a repeatable packaging trick, say so explicitly instead of recommending it as a formula.",
    "- End with a short mandatory \"Data caveats\" section naming the weakest (smallest-sample or most topic-bound) stats you used above, so the reader knows what to double-check before trusting a rule.",
    "",
    "Same language as the channel's titles. No generic advice — every claim must reference a stat given. Keep it tight.",
  ].join("\n");

  const client = new Anthropic({ apiKey });
  let text: string;
  try {
    const response = await client.messages.create({
      model: ANALYZER_MODEL,
      max_tokens: 800,
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
