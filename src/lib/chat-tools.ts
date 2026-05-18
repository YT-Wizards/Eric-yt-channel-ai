import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import {
  competitorGapAnalysis,
  getChannel,
  getComment,
  getCommentAnalysis,
  getIntegration,
  getSetting,
  getTranscript,
  getVideoHook,
  hookFormulaStats,
  hookOverallStats,
  listAllChannels,
  listCompetitorAlerts,
  listCompetitors,
  listHooksLibrary,
  listHooksWithVideos,
  listReplies,
  listTopLevelComments,
  listVideos,
  searchComments,
  searchTranscripts,
  titleLengthBuckets,
  titleWordStats,
  topVsBottomTitles,
  recordDeepgramUsage,
  upsertTranscript,
  videoStats,
} from "./db";
import {
  fetchComments,
  fetchTrending,
  fetchTranscriptFree,
  nicheExplorer,
  searchYouTube,
  youtubeSuggest,
} from "./youtube";
import { apifyYouTubeScrape } from "./apify";
import { transcribeYouTubeVideo } from "./deepgram";
import { runSelect, SQL_SCHEMA } from "./sql-tool";
import {
  fetchChannelOverview,
  fetchVideoAnalytics,
  fetchChannelAudience,
  fetchChannelRevenue,
  getRevenueAccessFlag,
  YtAnalyticsError,
  type PeriodSpec,
} from "./yt-analytics";
import { getOAuthTokens } from "./google-oauth";

/**
 * A tool group the user can enable/disable via the "+" menu in chat.
 *
 * Web search isn't a group here — Anthropic's native web_search is wired
 * unconditionally for Claude turns (see ai-provider.ts). The previous
 * `exa` group is intentionally removed: it duplicated the same feature
 * less reliably and the toggle made the picker feel cluttered.
 */
export type ToolGroup =
  | "youtube"
  | "apify"
  | "analytics"
  | "research"
  | "yt_analytics"
  | "strategy";

type Tool = Anthropic.Tool;
type ToolInput = Record<string, unknown>;

function requireKey(name: string): string {
  const key = getIntegration(name)?.api_key;
  if (!key) throw new Error(`${name} API key is not configured`);
  return key;
}

// ---------------------------------------------------------------------------
// Tool schemas — what Claude sees
// ---------------------------------------------------------------------------

const YOUTUBE_TOOLS: Tool[] = [
  {
    name: "channel_summary",
    description:
      "Return overall stats for the user's bound YouTube channel: title, subscribers, total views, videos, average views/likes/comments across imported videos. Use this first when the user asks about 'my channel'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_my_videos",
    description:
      "List the user's own imported videos from local DB, sorted by recent publish date. Optionally filter by text search across title/description. Returns id, title, views, likes, comments, duration, publishedAt.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional keyword filter." },
        limit: { type: "number", description: "Default 50, max 200.", default: 50 },
      },
    },
  },
  {
    name: "search_my_transcripts",
    description:
      "Full-text search across transcripts of the user's own videos. Use when the user asks what they said about a topic, or to find which videos discuss something.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "get_video_comments",
    description:
      "Fetch top-level YouTube comments for a video by ID. Use to analyze audience reaction / sentiment. Costs 1 YouTube API unit per ~100 comments.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube video ID (11 chars)." },
        max: { type: "number", default: 50 },
      },
      required: ["videoId"],
    },
  },
  {
    name: "list_video_comments_cached",
    description:
      "Return top-level comments for one of the USER'S OWN videos from the local cache (already synced via the UI). Prefer this over `get_video_comments` when the user asks about their own video — it's instant and costs no API quota. Each comment has reply_count; call `get_comment_thread` to read replies.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string" },
        limit: { type: "number", default: 50, maximum: 200 },
        offset: { type: "number", default: 0 },
      },
      required: ["videoId"],
    },
  },
  {
    name: "search_my_comments",
    description:
      "Full-text search across ALL cached comments on the user's videos (FTS5). Use for audience-sentiment questions like \"what do people say about X\", \"who mentioned sponsorship\", \"complaints about audio quality\". Returns comment text + author + like_count + video_id + video_title. No API quota.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20, maximum: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_comment_thread",
    description:
      "Fetch a single top-level comment plus all its cached replies from the local cache. Use after `search_my_comments` or `list_video_comments_cached` to read the full discussion under a specific comment.",
    input_schema: {
      type: "object",
      properties: {
        commentId: { type: "string" },
      },
      required: ["commentId"],
    },
  },
  {
    name: "search_youtube",
    description:
      "Search public YouTube for videos or channels matching a query. Costs 100 YouTube API units — use sparingly. Returns titles, channels, IDs.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["video", "channel"], default: "video" },
        maxResults: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
];

const ANALYTICS_TOOLS: Tool[] = [
  {
    name: "execute_sql",
    description:
      `Run a **read-only** SELECT against the local SQLite database. Use this for statistical / structured analysis of the user's videos (averages, correlations, bucketing by month, tag analysis, outlier detection). Returns up to 200 rows.\n\nSchema:\n${SQL_SCHEMA}`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A single SELECT/WITH statement." },
      },
      required: ["query"],
    },
  },
  {
    name: "youtube_trending",
    description:
      "List what's trending on YouTube right now by region. Useful to spot format patterns and hot topics. Free (1 YouTube API unit).",
    input_schema: {
      type: "object",
      properties: {
        regionCode: { type: "string", description: "ISO 3166-1 alpha-2 (US, UA, GB, ...)", default: "US" },
        categoryId: { type: "string", description: "Optional YT videoCategoryId." },
        maxResults: { type: "number", default: 25, maximum: 50 },
      },
    },
  },
  {
    name: "niche_explorer",
    description:
      "Given a topic/niche phrase, returns the top-5 channels by subscribers and top-10 outlier videos (highest views in the last 6 months). Costs ~200 YouTube API units — use once per niche question.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        maxChannels: { type: "number", default: 5, maximum: 10 },
      },
      required: ["topic"],
    },
  },
  {
    name: "fetch_transcript",
    description:
      "Fetch the transcript of a YouTube video (any public video with captions — manual or auto). Free, no API key. Caches result in local DB if the video is already known.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube 11-char video ID." },
        lang: { type: "string", description: "Preferred language code (en, uk, ...)" },
      },
      required: ["videoId"],
    },
  },
];

const RESEARCH_TOOLS: Tool[] = [
  {
    name: "youtube_suggest",
    description:
      "YouTube search autocomplete — returns what YouTube users actually type when searching for a seed query. Perfect for discovering long-tail topic ideas and content gaps. Free, no API key.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        hl: { type: "string", description: "Language (en, uk, ...)", default: "en" },
        gl: { type: "string", description: "Country code (US, UA, ...)" },
      },
      required: ["query"],
    },
  },
  // NOTE: `google_trends_interest` + `google_trends_related` were removed —
  // the underlying Apify actor hits Google Trends without an official API,
  // and Google returns 429 against Apify's datacenter IPs essentially all
  // the time. The tool was burning research iterations on guaranteed
  // failures. `youtube_suggest` (autocomplete) covers real search demand
  // well enough as a substitute signal. The `./trends.ts` library is
  // intentionally left in the repo in case we bring it back via residential
  // proxies or a different provider.
];

const APIFY_TOOLS: Tool[] = [
  {
    name: "scrape_youtube_channel",
    description:
      "Use Apify to scrape a YouTube channel (usually a competitor, not the user's own channel). Returns up to `maxResults` videos with title, views, likes, duration, comment count, and optionally transcripts. Slower and more expensive than the YouTube API, but bypasses quota and can fetch transcripts.",
    input_schema: {
      type: "object",
      properties: {
        channelUrl: {
          type: "string",
          description: "Channel URL like https://www.youtube.com/@handle or /channel/UC...",
        },
        maxResults: { type: "number", default: 20, maximum: 100 },
        includeTranscript: { type: "boolean", default: false },
      },
      required: ["channelUrl"],
    },
  },
  {
    name: "get_youtube_transcript",
    description:
      "Transcribe one or more YouTube videos via Deepgram (yt-dlp pulls audio locally, streams to Deepgram). Caches results into the local transcripts DB. Costs ≈$0.0043/min against the user's Deepgram credit.",
    input_schema: {
      type: "object",
      properties: {
        videoUrls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
      },
      required: ["videoUrls"],
    },
  },
];

// ---------------------------------------------------------------------------
// YouTube Analytics tools — proxy the same /v2/reports calls the dashboard
// uses, but expose them to Claude so it can answer questions like "where do
// viewers drop off in this video?" or "where is most of my watch time
// coming from?". All four require a working Google OAuth connection AND
// for the connected user to have at least Brand Account Manager / Owner
// access on the channel — Channel Permissions Manager will 403 (we
// translate that to a clear error so Claude tells the user what to do).
// ---------------------------------------------------------------------------

const PERIOD_ENUM = ["7d", "28d", "90d", "365d", "all"] as const;

const YT_ANALYTICS_TOOLS: Tool[] = [
  {
    name: "get_channel_analytics_overview",
    description:
      "Live channel-level analytics from YouTube Analytics API for a chosen period. Returns totals (views, watch minutes, subscribers gained/lost, likes, comments, shares), the same metrics for the preceding period of equal length (so you can compute Δ% trends), a daily time series, and the top 10 videos in the period sorted by views. Use whenever the user asks about overall channel performance over a window of time.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [...PERIOD_ENUM],
          description: "Time window. 'all' = since channel creation.",
          default: "28d",
        },
      },
    },
  },
  {
    name: "get_video_analytics",
    description:
      "Per-video DEEP analytics from YouTube Analytics API. Returns a thick bundle: " +
      "(1) totals — views, watch minutes, avg view duration, average view percentage, likes, comments, shares, subscribers gained/lost, playlist additions/removals; " +
      "(2) daily time series for views, watch time, likes, comments, subs gained/lost; " +
      "(3) audience retention curve — fraction of viewers still watching at each percentage point of the video (use to identify drop-off moments); " +
      "(4) traffic sources (YT_SEARCH, SUGGESTED_VIDEO, EXTERNAL, BROWSE, etc.); " +
      "(5) playback locations — WATCH page, EMBEDDED on third-party sites, CHANNEL page, SEARCH, SHORTS feed; " +
      "(6) top YouTube SEARCH terms that led viewers to this video (gold for SEO); " +
      "(7) sharing services — where viewers shared the video (Twitter, WhatsApp, Reddit, etc.); " +
      "(8) operating systems breakdown; " +
      "(9) subscribed-vs-not breakdown — subscribed audience vs new viewers, with separate watch time / avg duration for each; " +
      "(10) demographics (age × gender, viewer percentages); " +
      "(11) geography — top countries by views; " +
      "(12) cards & end-screen performance — impressions, clicks, CTR for overlay cards and end-screen elements; " +
      "(13) vsChannelAverage — how this video's views/watch/duration compares to the channel's typical video (1.0× = average). " +
      "Use whenever the user asks about a SPECIFIC video — retention drops, traffic, audience, search keywords, sharing patterns, anything.",
    input_schema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "YouTube 11-char video ID." },
        period: {
          type: "string",
          enum: [...PERIOD_ENUM],
          description: "Time window. 'all' = since video published.",
          default: "28d",
        },
      },
      required: ["videoId"],
    },
  },
  {
    name: "get_channel_audience",
    description:
      "Channel-wide audience analytics: demographics (age × gender breakdown), top 25 countries by views, device split (mobile/desktop/tablet/TV), and traffic sources. Use when the user asks WHO is watching the channel, WHERE they are, or HOW they find the videos.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["28d", "90d", "365d", "all"],
          default: "28d",
        },
      },
    },
  },
  {
    name: "get_channel_revenue",
    description:
      "Revenue analytics: estimated revenue, ad revenue, YouTube Premium revenue, gross revenue, CPM, playback CPM, monetized playbacks, ad impressions, daily revenue trend, and the top 10 earning videos. Requires the connected Google account to have Owner-tier access — Manager-tier returns a 'denied' result you should relay to the user. Only call when the user explicitly asks about money / earnings / RPM / CPM.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [...PERIOD_ENUM],
          default: "28d",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Strategy tools — every Phase D / B dataset, exposed read-only so chat can
// reason about the user's channel the same way the dashboards do.
// ---------------------------------------------------------------------------
const STRATEGY_TOOLS: Tool[] = [
  {
    name: "list_competitors",
    description:
      "List the user's tracked competitor channels with their subs, video counts, and last sync time. Use whenever the user asks who they're tracking, or wants channel-by-channel competitor stats.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_competitor_alerts",
    description:
      "List recent outlier alerts — videos from tracked competitors that hit ≥2× their channel's median views. Use to surface what's going viral in the user's niche right now.",
    input_schema: {
      type: "object",
      properties: {
        unreadOnly: { type: "boolean", default: false },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "competitor_gap_analysis",
    description:
      "Find title keywords frequent in competitors' top videos that the user has NEVER used. Returns words ranked by aggregate competitor views, with usage frequency and example titles. Use when the user wants ideas grounded in proven competitor formulas.",
    input_schema: {
      type: "object",
      properties: { topN: { type: "number", default: 25 } },
    },
  },
  {
    name: "get_hook_stats",
    description:
      "Channel-wide hook analysis stats: how many hooks analysed, average score, winning hook formula (direct question / statistic / story / mystery / etc.), per-formula avg views. Use to answer 'which kind of hook works best on my channel?'",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_hook_breakdowns",
    description:
      "Hook-by-hook breakdown with per-video score, formula, strengths and weaknesses. Use after get_hook_stats when the user wants specific examples or wants to look at the lowest-scoring hooks to fix.",
    input_schema: {
      type: "object",
      properties: {
        orderBy: {
          type: "string",
          enum: ["score", "views", "recent"],
          default: "score",
        },
        limit: { type: "number", default: 30 },
      },
    },
  },
  {
    name: "get_video_hook",
    description:
      "Pull the full hook analysis for one specific video — formula type, 7 quality scores, strengths, suggested improvements, the literal hook text.",
    input_schema: {
      type: "object",
      properties: { videoId: { type: "string" } },
      required: ["videoId"],
    },
  },
  {
    name: "get_formula_breakdown",
    description:
      "Statistical breakdown of the user's title formulas: per-word avg views + success rate, title-length buckets, top 10 vs bottom 10 video titles. Use for 'what's working in my titles' questions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_comment_analysis",
    description:
      "Return the cached AI audience analysis for one video — sentiment 1-10, top themes, credibility objections, future-video ideas with demand level, best hook candidates. Returns 'no analysis yet' if the user hasn't run it; tell them to open the Comments tab and click 'Analyse with AI'.",
    input_schema: {
      type: "object",
      properties: { videoId: { type: "string" } },
      required: ["videoId"],
    },
  },
  {
    name: "list_saved_hooks",
    description:
      "List the user's Hooks Library — comments / quotes they saved to reuse as opening lines in future videos. Includes status (available / used), source video, score. Use when planning a new video to remind the user of unused material they already curated.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export function getToolsFor(groups: ToolGroup[]): Tool[] {
  const set = new Set(groups);
  const tools: Tool[] = [];
  if (set.has("youtube")) tools.push(...YOUTUBE_TOOLS);
  if (set.has("analytics")) tools.push(...ANALYTICS_TOOLS);
  if (set.has("research")) tools.push(...RESEARCH_TOOLS);
  if (set.has("apify")) tools.push(...APIFY_TOOLS);
  if (set.has("yt_analytics")) tools.push(...YT_ANALYTICS_TOOLS);
  if (set.has("strategy")) tools.push(...STRATEGY_TOOLS);
  return tools;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function runTool(name: string, input: ToolInput): Promise<ToolResult> {
  try {
    switch (name) {
      case "channel_summary": {
        const channel = getChannel();
        const stats = videoStats();
        return { ok: true, data: { channel, stats } };
      }
      case "list_my_videos": {
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        const search = typeof input.search === "string" ? input.search : undefined;
        const rows = listVideos({ limit, search });
        return {
          ok: true,
          data: rows.map((v) => ({
            id: v.id,
            title: v.title,
            views: v.views,
            likes: v.likes,
            comments: v.comments,
            duration: v.duration_seconds,
            publishedAt: v.published_at,
          })),
        };
      }
      case "search_my_transcripts": {
        const q = String(input.query ?? "").trim();
        if (!q) return { ok: false, error: "query required" };
        return { ok: true, data: searchTranscripts(q, 20) };
      }
      case "get_video_comments": {
        const key = requireKey("youtube");
        const videoId = String(input.videoId ?? "").trim();
        const max = Math.min(500, Math.max(1, Number(input.max) || 50));
        if (!videoId) return { ok: false, error: "videoId required" };
        return { ok: true, data: await fetchComments(videoId, key, max) };
      }
      case "list_video_comments_cached": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
        const offset = Math.max(0, Number(input.offset) || 0);
        const rows = listTopLevelComments(videoId, limit, offset);
        return {
          ok: true,
          data: rows.map((c) => ({
            id: c.id,
            author: c.author,
            text: c.text,
            likes: c.like_count,
            replyCount: c.reply_count,
            publishedAt: c.published_at,
          })),
        };
      }
      case "search_my_comments": {
        const q = String(input.query ?? "").trim();
        if (!q) return { ok: false, error: "query required" };
        const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
        const rows = searchComments(q, limit);
        return {
          ok: true,
          data: rows.map((c) => ({
            id: c.id,
            videoId: c.video_id,
            videoTitle: c.video_title,
            parentId: c.parent_id,
            author: c.author,
            text: c.text,
            likes: c.like_count,
            replyCount: c.reply_count,
            publishedAt: c.published_at,
          })),
        };
      }
      case "get_comment_thread": {
        const commentId = String(input.commentId ?? "").trim();
        if (!commentId) return { ok: false, error: "commentId required" };
        const top = getComment(commentId);
        if (!top) return { ok: false, error: "comment not found in cache" };
        // If caller passed a reply id, resolve the actual parent.
        const parent = top.parent_id ? getComment(top.parent_id) ?? top : top;
        const replies = listReplies(parent.id);
        return {
          ok: true,
          data: {
            parent: {
              id: parent.id,
              videoId: parent.video_id,
              author: parent.author,
              text: parent.text,
              likes: parent.like_count,
              replyCount: parent.reply_count,
              publishedAt: parent.published_at,
            },
            replies: replies.map((r) => ({
              id: r.id,
              author: r.author,
              text: r.text,
              likes: r.like_count,
              publishedAt: r.published_at,
            })),
          },
        };
      }
      case "search_youtube": {
        const key = requireKey("youtube");
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const type = (input.type === "channel" ? "channel" : "video") as "video" | "channel";
        const maxResults = Math.min(25, Math.max(1, Number(input.maxResults) || 10));
        return { ok: true, data: await searchYouTube(query, key, { type, maxResults }) };
      }
      case "scrape_youtube_channel": {
        const key = requireKey("apify");
        const channelUrl = String(input.channelUrl ?? "").trim();
        if (!channelUrl) return { ok: false, error: "channelUrl required" };
        const maxResults = Math.min(100, Math.max(1, Number(input.maxResults) || 20));
        const includeTranscript = !!input.includeTranscript;
        return {
          ok: true,
          data: await apifyYouTubeScrape(
            { startUrls: [{ url: channelUrl }], maxResults, includeTranscript },
            key
          ),
        };
      }
      case "execute_sql": {
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const result = runSelect(query, 200);
        // Convert to array of objects for readability
        const { columns, rows } = result;
        const objects = rows.map((r) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((c, i) => {
            obj[c] = r[i];
          });
          return obj;
        });
        return { ok: true, data: { columns, rowCount: rows.length, rows: objects } };
      }
      case "youtube_trending": {
        const key = requireKey("youtube");
        const regionCode = typeof input.regionCode === "string" ? input.regionCode : "US";
        const categoryId = typeof input.categoryId === "string" ? input.categoryId : undefined;
        const maxResults = Math.min(50, Math.max(1, Number(input.maxResults) || 25));
        const vids = await fetchTrending(key, { regionCode, categoryId, maxResults });
        // Return compact shape
        return {
          ok: true,
          data: vids.map((v) => ({
            id: v.id,
            title: v.title,
            channel: v.channelId,
            views: v.views,
            likes: v.likes,
            duration: v.durationSeconds,
            publishedAt: v.publishedAt,
            tags: v.tags.slice(0, 6),
          })),
        };
      }
      case "niche_explorer": {
        const key = requireKey("youtube");
        const topic = String(input.topic ?? "").trim();
        if (!topic) return { ok: false, error: "topic required" };
        const maxChannels = Math.min(10, Math.max(1, Number(input.maxChannels) || 5));
        return {
          ok: true,
          data: await nicheExplorer(topic, key, { maxChannels }),
        };
      }
      case "fetch_transcript": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const lang = typeof input.lang === "string" ? input.lang : undefined;
        const cached = getTranscript(videoId);
        if (cached) {
          return {
            ok: true,
            data: { videoId, language: cached.language, text: cached.text.slice(0, 20_000), cached: true },
          };
        }
        const t = await fetchTranscriptFree(videoId, { lang });
        if (!t) return { ok: false, error: "no transcript available" };
        upsertTranscript(videoId, t.text, t.language);
        return {
          ok: true,
          data: { videoId, language: t.language, text: t.text.slice(0, 20_000), cached: false },
        };
      }
      case "youtube_suggest": {
        const query = String(input.query ?? "").trim();
        if (!query) return { ok: false, error: "query required" };
        const hl = typeof input.hl === "string" ? input.hl : "en";
        const gl = typeof input.gl === "string" ? input.gl : undefined;
        return { ok: true, data: await youtubeSuggest(query, { hl, gl }) };
      }
      // google_trends_* cases removed — the underlying scraper consistently
      // returns 429 and the tools aren't exposed to Claude anymore.
      case "get_youtube_transcript": {
        const key = requireKey("deepgram");
        const urls = Array.isArray(input.videoUrls)
          ? (input.videoUrls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 10)
          : [];
        if (!urls.length) return { ok: false, error: "videoUrls required" };
        // Extract the 11-char videoId from each URL and run Deepgram on
        // each in series. Sequential rather than parallel because (a)
        // yt-dlp + Deepgram per video is bursty CPU/network and we'd
        // rather not slam the local machine, and (b) Deepgram pre-recorded
        // tier limits concurrent jobs anyway.
        const results: Array<{
          url: string;
          videoId: string | null;
          transcript: string;
          language: string | null;
          error?: string;
        }> = [];
        for (const url of urls) {
          const m = /(?:youtu\.be\/|v=)([A-Za-z0-9_-]{11})/.exec(url);
          const videoId = m ? m[1] : null;
          if (!videoId) {
            results.push({ url, videoId: null, transcript: "", language: null, error: "could not extract videoId from URL" });
            continue;
          }
          // Serve from cache if we already have it — same DB the UI uses.
          const cached = getTranscript(videoId);
          if (cached) {
            results.push({ url, videoId, transcript: cached.text, language: cached.language });
            continue;
          }
          try {
            const r = await transcribeYouTubeVideo(videoId, key);
            upsertTranscript(videoId, r.text, r.language);
            recordDeepgramUsage({
              videoId,
              durationSeconds: r.durationSeconds,
              costCents: r.costCents,
              model: r.model,
            });
            results.push({ url, videoId, transcript: r.text, language: r.language });
          } catch (err) {
            results.push({
              url,
              videoId,
              transcript: "",
              language: null,
              error: err instanceof Error ? err.message : "transcription failed",
            });
          }
        }
        return { ok: true, data: results };
      }

      // ===== YouTube Analytics tools (Phase 6) =====
      // All four share the same pre-flight check: must be connected to
      // Google OAuth. We skip calling the wrapper if there's no token,
      // because the wrapper would throw a less helpful error.
      case "get_channel_analytics_overview":
      case "get_video_analytics":
      case "get_channel_audience":
      case "get_channel_revenue": {
        if (!getOAuthTokens()?.refresh_token) {
          return {
            ok: false,
            error:
              "YouTube Analytics is not connected. Tell the user to go to Integrations → YouTube Analytics (Google OAuth) and click Connect.",
          };
        }
        const period = (typeof input.period === "string" ? input.period : "28d") as
          | "7d"
          | "28d"
          | "90d"
          | "365d"
          | "all";
        const periodSpec: PeriodSpec = period === "all" ? "all" : Number(period.replace("d", ""));

        try {
          if (name === "get_channel_analytics_overview") {
            const data = await fetchChannelOverview(periodSpec);
            return { ok: true, data };
          }
          if (name === "get_video_analytics") {
            const videoId = String(input.videoId ?? "").trim();
            if (!videoId) return { ok: false, error: "videoId required" };
            const data = await fetchVideoAnalytics(videoId, periodSpec);
            return { ok: true, data };
          }
          if (name === "get_channel_audience") {
            const data = await fetchChannelAudience(periodSpec);
            return { ok: true, data };
          }
          // get_channel_revenue
          if (getRevenueAccessFlag() === "denied") {
            return {
              ok: false,
              error:
                "Revenue access denied for this account (Manager-tier or non-monetised channel). Tell the user this metric needs Owner-level access — you have no way to fetch it from this side. Continue with what you can get.",
            };
          }
          const data = await fetchChannelRevenue(periodSpec);
          return { ok: true, data };
        } catch (err) {
          if (err instanceof YtAnalyticsError) {
            // Translate 403 specifically — Claude should know this is a
            // permissions-not-bug situation and stop retrying.
            if (err.status === 403 || err.status === 401) {
              return {
                ok: false,
                error:
                  "YouTube Analytics 403/401 — the connected Google account doesn't have access to this data. This is a permissions issue, not a transient failure. Do NOT retry; tell the user the channel owner needs to elevate their role or reconnect with the owner's account.",
              };
            }
            return { ok: false, error: err.message };
          }
          throw err;
        }
      }

      // ===== Strategy tools (Phase D / E) =====
      case "list_competitors": {
        const competitors = listCompetitors();
        return {
          ok: true,
          data: competitors.map((c) => ({
            id: c.id,
            handle: c.handle,
            title: c.title,
            channelId: c.channel_id,
            subscribers: c.subscriber_count,
            videoCount: c.video_count,
            lastSyncAt: c.last_sync_at,
          })),
        };
      }
      case "list_competitor_alerts": {
        const unreadOnly = !!input.unreadOnly;
        const limit = Math.min(
          200,
          Math.max(1, Number(input.limit) || 50)
        );
        const alerts = listCompetitorAlerts({ unreadOnly, limit });
        return {
          ok: true,
          data: alerts.map((a) => ({
            id: a.id,
            competitor: a.competitor_title ?? a.competitor_handle,
            videoId: a.video_id,
            title: a.title,
            views: a.views,
            multiplier: a.multiplier,
            channelMedianViews: a.channel_median_views,
            detectedAt: a.detected_at,
            unread: !a.read_at,
          })),
        };
      }
      case "competitor_gap_analysis": {
        const topN = Math.min(50, Math.max(5, Number(input.topN) || 25));
        return { ok: true, data: competitorGapAnalysis({ topN }) };
      }
      case "get_hook_stats": {
        const overall = hookOverallStats();
        const formulas = hookFormulaStats();
        return { ok: true, data: { overall, formulas } };
      }
      case "list_hook_breakdowns": {
        const orderBy =
          input.orderBy === "views" || input.orderBy === "recent"
            ? (input.orderBy as "views" | "recent")
            : ("score" as const);
        const limit = Math.min(
          100,
          Math.max(1, Number(input.limit) || 30)
        );
        const hooks = listHooksWithVideos({ orderBy, limit });
        return {
          ok: true,
          data: hooks.map((h) => ({
            videoId: h.video_id,
            title: h.title,
            views: h.views,
            formula: h.formula_type,
            overallScore: h.overall_score,
            scores: {
              openLoop: h.score_open_loop,
              valuePromise: h.score_value_promise,
              conflict: h.score_conflict,
              specificLanguage: h.score_specific_language,
              identification: h.score_identification,
              pacing: h.score_pacing,
              benefit: h.score_benefit,
            },
            fortalezas: h.fortalezas,
            mejoras: h.mejoras,
          })),
        };
      }
      case "get_video_hook": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const h = getVideoHook(videoId);
        if (!h) {
          return {
            ok: false,
            error:
              "No hook analysis on file for this video. Open Hook Lab and click Analyse, or run the batch analyser.",
          };
        }
        return { ok: true, data: h };
      }
      case "get_formula_breakdown": {
        return {
          ok: true,
          data: {
            wordStats: titleWordStats({ minUses: 2, topN: 30 }),
            lengthBuckets: titleLengthBuckets(),
            topBottom: topVsBottomTitles(),
          },
        };
      }
      case "get_comment_analysis": {
        const videoId = String(input.videoId ?? "").trim();
        if (!videoId) return { ok: false, error: "videoId required" };
        const a = getCommentAnalysis(videoId);
        if (!a) {
          return {
            ok: false,
            error:
              "No comment analysis cached for this video. Open the Comments tab and click 'Analyse with AI' first.",
          };
        }
        const safe = <T,>(s: string | null, fb: T): T => {
          if (!s) return fb;
          try {
            return JSON.parse(s) as T;
          } catch {
            return fb;
          }
        };
        return {
          ok: true,
          data: {
            sentimentScore: a.sentiment_score,
            themes: safe(a.themes, [] as string[]),
            objections: safe(a.objections, [] as unknown[]),
            futureIdeas: safe(a.future_ideas, [] as unknown[]),
            hookCandidates: safe(a.hook_candidates, [] as unknown[]),
            summary: a.summary,
            analyzedAt: a.analyzed_at,
            commentsCount: a.comments_count,
          },
        };
      }
      case "list_saved_hooks": {
        const hooks = listHooksLibrary();
        return {
          ok: true,
          data: hooks.map((h) => ({
            id: h.id,
            quote: h.quote,
            author: h.author,
            status: h.status,
            score: h.score,
            sourceVideoId: h.source_video_id,
            sourceVideoTitle: h.source_video_title,
            note: h.note,
            addedAt: h.added_at,
          })),
        };
      }

      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "tool execution failed",
    };
  }
}

// ---------------------------------------------------------------------------
// System prompt (context-aware)
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  activeGroups: ToolGroup[],
  opts: { advisorEnabled?: boolean } = {}
): string {
  const channel = getChannel();
  const bound = getSetting("youtube.channelId");
  // Pull the full list of connected channels too — when the user has
  // more than one, we have to make it crystal clear which one is
  // currently active, otherwise Claude has historically confused them.
  const allChannels = listAllChannels();
  const lines: string[] = [
    `You are "YT Channel AI", Head of Research + Ideation for the creator using this local desktop app. Think MrBeast-caliber packager × subject-matter expert: every title/idea you propose must hook in 2 seconds AND hold up when scrutinised by someone who knows the topic. No filler, no hype without truth.`,
    ``,
    `## Mission`,
    `This tool exists for ONE reason: to help THIS specific YouTube channel grow. Your output must be practical, specific, and usable. A creator reading your response should know exactly what to do tomorrow. If your answer could fit any channel in any niche, you failed — rewrite it with channel-specific evidence.`,
    ``,
    `## Quality bar — non-negotiable`,
    `- **No banal advice.** Forbidden phrases and any paraphrase of them: "post consistently", "optimize your titles", "engage with your audience", "understand your niche", "be authentic", "create quality content", "use SEO", "thumbnails matter". If you catch yourself writing something that sounds like generic creator-coach content, delete it and replace with a data-backed claim.`,
    `- **Every number must come from a tool call**, not from your training knowledge. If you don't have the number, say so.`,
    `- **Every recommendation must name a specific action.** Bad: "Try longer videos". Good: "Make a 15-20 min video titled 'X' — your 3 longest videos (>12min) have 2.4× the watch time of your Shorts, and competitor @Y publishes only this format."`,
    `- **Honesty over polish.** If the channel is small/inactive/wrong-niche, say it directly. Don't soften bad news. Creators paying for this tool want the truth, not a hype letter.`,
    `- **No preamble.** Don't open with "Great question!" or "Let me analyse…". Go straight to the work.`,
    ``,
    `## When you don't have the data`,
    `Never invent. You have exactly two moves when key information is missing:`,
    `1. **ASK the user a tight clarifying question** — one sentence, one specific thing. Use this when the missing data is something only the user knows (their goals, constraints, preferences, what they've already tried, target audience, language of channel content).`,
    `2. **SEARCH the web** with the built-in \`web_search\` tool. Use this when the missing data is factual / public (current trends, what a named channel is doing, a stat about a niche, news, what a term means). web_search is Anthropic's native server-side tool — pass a focused query string; results come back in the same turn. Cap yourself at ~3 searches per question; if 3 searches don't answer it, escalate to step 1 (ask the user).`,
    `Never split the difference by guessing. "I don't have data on X — should I look it up or do you want to give me the answer?" is always better than fabrication.`,
    ``,
    `## User context`,
  ];
  if (channel) {
    lines.push(
      `- **Active channel** (this is the one every local-DB tool is scoped to right now): "${channel.title ?? "(unknown)"}"${channel.handle ? ` — ${channel.handle}` : ""}, id \`${channel.id}\``,
      `- Subscribers: ${channel.subscriber_count ?? "?"}, total views: ${channel.view_count ?? "?"}, videos in DB: ${channel.video_count ?? "?"}`,
      `- When the user says "my channel" they mean THIS one — never another channel from the list below.`
    );
    if (allChannels.length > 1) {
      const others = allChannels
        .filter((c) => c.id !== channel.id)
        .map((c) => `"${c.title ?? c.id}"${c.handle ? ` (${c.handle})` : ""}`)
        .join(", ");
      lines.push(
        `- The user has **${allChannels.length} channels connected** in this app. Other connected channels (NOT active right now): ${others}.`,
        `- **CRITICAL multi-channel rule:** every local-DB tool (list_videos, search_transcripts, search_comments, video_stats, hooks_*, formula_*, raw_sql, etc.) returns data from the ACTIVE channel only. The other channels' videos/transcripts/comments are NOT visible to these tools until the user switches the active channel. If the user asks "ideas based on our channel" or "what's worked for us", that always means the ACTIVE channel — never an aggregate across all of them, and never a different one.`,
        `- If the user names a specific channel by handle/title that matches one of their OTHER connected channels, tell them to switch to it in the sidebar first. Do not silently answer with the active channel's data and pretend it's the other one.`
      );
    }
    lines.push(
      `- When the user asks about a channel that is NOT in the connected list (a competitor, a reference channel they admire), use external tools (web_search / search_youtube / apify scrape) — do NOT confuse it with the active channel's local data.`
    );
  } else if (bound) {
    lines.push(`- A channel is bound (${bound}) but not yet synced — suggest running a sync.`);
  } else {
    lines.push(`- No channel is bound yet. Suggest connecting a YouTube channel in Integrations before deep analysis.`);
  }

  lines.push(``, `## Available tools in this conversation`);
  // web_search is always-on when the model is Claude. The provider
  // adapter attaches Anthropic's server-side search tool regardless of
  // which user-toggleable groups are active, so we advertise it
  // unconditionally here.
  lines.push(
    `- **web_search** — Anthropic-managed web search. Always available. Use whenever you need a public fact, news, current trend data, what a specific external channel is doing, or anything outside the user's local DB. No setup, no API key for the user.`
  );
  if (activeGroups.length === 0) {
    lines.push(
      `- That's it. Local-DB tool groups are disabled in this chat — tell the user to enable a group via the "+" menu (Strategy + YouTube cover most ideation questions).`
    );
  } else {
    if (activeGroups.includes("youtube"))
      lines.push(
        `- **YouTube** — local DB queries on the USER'S OWN videos/transcripts/comments, fetch live comments, search YouTube.`
      );
    if (activeGroups.includes("analytics"))
      lines.push(
        `- **Analytics** — execute_sql over local DB (use this for correlations, cohort analysis, outliers), youtube_trending, niche_explorer (top channels + outlier videos in a niche), fetch_transcript.`
      );
    if (activeGroups.includes("research"))
      lines.push(
        `- **Research** — youtube_suggest (autocomplete → real search demand, what people actually type when looking for content in this niche).`
      );
    if (activeGroups.includes("apify"))
      lines.push(`- **Apify** — scrape competitor YouTube channels + transcripts. Use when you need competitor data that isn't in the user's DB.`);
    if (activeGroups.includes("yt_analytics"))
      lines.push(
        `- **YouTube Analytics** — live data from the user's connected channel: channel overview (views/watch time/subs Δ over a period), per-video analytics (retention curve, traffic sources, demographics, geography), channel-wide audience (demographics, devices, top countries, traffic), and revenue (only if Owner). This is the ground truth for "how is my channel actually doing" — use it before relying on stale local DB stats.`
      );
    if (activeGroups.includes("strategy"))
      lines.push(
        `- **Strategy** — read-only access to the platform's own analysis surfaces: tracked competitors + their outlier alerts + gap-analysis keywords, the channel's Hook Lab breakdowns (per-video formula + 7 quality scores + suggested improvements), the Formula Analyzer's title-word success rates and length buckets, AI Comment Analysis (sentiment / themes / objections / future-video ideas / best hook candidates), and the Hooks Library (saved comment quotes the creator plans to reuse). Use these when answering "what kind of hook works for me", "what should I make next", "what are competitors doing I'm not", "what does my audience actually want" — every dashboard the creator sees, you can read.`
      );
  }

  // Tell the executor about the advisor ONLY when it's actually wired up for
  // this request — otherwise we'd be encouraging calls to a non-existent tool.
  if (opts.advisorEnabled) {
    lines.push(
      ``,
      `## The \`advisor\` tool (your strategic escalation path)`,
      `You have access to an \`advisor\` tool that routes a question to a stronger reasoning model (Claude Opus) and returns a short strategic opinion — a plan, a correction, or a stop signal.`,
      `- **Budget: 3 calls** per turn, use them well.`,
      `- **DO call advisor** when you face: synthesis of contradictory evidence, multi-factor strategic tradeoffs, final recommendations where stakes are high, or when you suspect your current plan is wrong.`,
      `- **DO NOT call advisor** for simple lookups, data gathering, or formatting questions — you handle those yourself.`,
      `- When you call advisor, phrase the question tightly. Example: "Given channel X has declining Shorts performance but growing long-form retention, and competitor Y switched to long-form 6 months ago with 3× subscriber growth — should this creator pivot fully away from Shorts, or split 30/70?"`,
      `- Treat the advisor's answer as input to your reasoning, not as the final output. You still own the final answer to the user.`
    );
  }

  lines.push(
    ``,
    `## Workflow for non-trivial questions`,
    `1. **Plan in 1 line**: what 3-5 tool calls give evidence for this question?`,
    `2. **Gather parallel when possible** — issue independent tool calls in ONE turn (multiple tool_use blocks in the same response), not serial. Both Claude and Gemini support this; serial is 5-10× slower and the user notices.`,
    `3. **Start local, then external** — channel_summary / execute_sql / strategy tools before niche_explorer / web_search / apify. Free data before paid.`,
    `4. **Synthesise before you write** — look at all your results, find the pattern, THEN open your answer.`,
    `5. **Structure the answer**: TL;DR (3 bullets max) → evidence sections with tables → concrete action list → the ONE thing to do this week.`,
    ``,
    `## Ideation playbook — when the user asks for video ideas / themes / "what should I make next"`,
    `Do NOT improvise. Follow this 6-step pipeline; ideas that don't trace back to a tool result are not allowed.`,
    ``,
    `**Step 1 — What's already working on THIS channel.** Parallel batch:`,
    `  • \`get_hook_stats\` → winning hook formula, avg score`,
    `  • \`get_formula_breakdown\` → top-success title words + length buckets`,
    `  • \`list_my_videos limit=10\` (the user's actual hits — read titles)`,
    ``,
    `**Step 2 — What the audience explicitly wants.** Parallel batch:`,
    `  • \`get_comment_analysis\` on the user's top 3 videos — each returns futureIdeas with demand level`,
    `  • \`search_my_comments\` for "how", "tutorial", "next video", "please", "can you" — capture explicit requests`,
    ``,
    `**Step 3 — What's working in the niche RIGHT NOW.** Parallel batch:`,
    `  • \`list_competitor_alerts unreadOnly=true limit=30\` → recent outliers (≥2× competitor median)`,
    `  • \`competitor_gap_analysis topN=30\` → keywords competitors win on, user hasn't used`,
    `  • \`youtube_suggest\` with the user's top 2-3 winning words → live search demand`,
    ``,
    `**Step 4 — Title Pattern Bank.** Compile a flat list of every outlier title surfaced in step 3 across all competitors. This is the pool you draw hooks from in step 5 — do NOT make up new hook patterns from scratch; copy from titles that already proved they work.`,
    ``,
    `**Step 5 — Generate 3 spinoffs PER outlier you want to recommend.** Each outlier → three variants:`,
    `  1. **NEAR-CLONE** — same structure, same topic. Swap 1-2 words with true synonyms. Don't dilute the hook.`,
    `  2. **SAME HOOK, DIFFERENT TOPIC** — keep the hook pattern; swap the subject to something realistic for THIS channel's niche.`,
    `  3. **SAME TOPIC, NEW HOOK** — keep the outlier's topic. Pull a hook pattern from a DIFFERENT entry in your pattern bank. Then sanity-check the claim: reject and rewrite if the title implies a fabricated authority quote ("Nobel Prize winner said…"), a physically/historically impossible event, or a technically true but silly claim. If a subject-matter expert would feel insulted reading it, rewrite.`,
    ``,
    `**Step 6 — Final output.** For each idea give 5 fields:`,
    `  - **Title** — the proposed video title (target the channel's winning length bucket)`,
    `  - **Hook formula** — direct_question / statistic / mystery / character_place_date / personal_story / comment_reference / provocation`,
    `  - **Why it'll work** — ONE sentence quoting specific tool-call evidence ("uses 'shocking' which has 67% success on this channel, plus fills the gap that competitor @X is winning on")`,
    `  - **Source signal** — which tool result triggered this (gap_analysis word X / alert from competitor Y / comment request from video Z / channel's own top-performer pattern)`,
    `  - **Estimated demand** — high / medium / low, justified by either comment-request frequency or youtube_suggest volume`,
    ``,
    `**Hard ban:** No "general advice" ideas. If an idea can't cite a specific tool result, drop it. **3 grounded ideas beat 10 generic ones.**`,
    ``,
    `## Cost & failure discipline`,
    `- You have a research budget of 12 rounds of tool calls. Don't waste rounds.`,
    `- **If a tool fails, do not retry it more than once.** After a second failure the system will refuse the call and tell you to move on — respect that signal, note the limitation in your final answer, and continue from other sources.`,
    `- **Never repeat an identical tool+input combination** in the same turn — the system tracks and rejects duplicates.`,
    `- If data you need is missing, ASK the user or USE web_search. Don't invent numbers, don't paraphrase from training knowledge.`,
    ``,
    `## Style`,
    `- Markdown tables for data. Bullets for insights. Headings for structure.`,
    `- Match the user's language (UA / EN) in responses.`,
    `- End every analytical task with a short "Next step this week:" section naming ONE concrete action.`
  );

  return lines.join("\n");
}
