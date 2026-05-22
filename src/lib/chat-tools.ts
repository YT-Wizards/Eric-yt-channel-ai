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
  // Build the full prompt. It's intentionally long (~6-8k tokens) because
  // we trade prompt size for the model knowing exactly what arsenal it
  // has, what platform it's embedded in, and how to behave when data is
  // missing. Anthropic auto-caches the system block on Sonnet 4.6 so
  // repeated turns in the same session don't pay for it twice.
  const lines: string[] = [];

  // -----------------------------------------------------------------
  // 1. IDENTITY
  // -----------------------------------------------------------------
  lines.push(
    `# Who you are`,
    `You are **YT Channel AI** — the AI brain inside a local desktop application of the same name, made for YouTube creators and their teams. You sit on top of the user's full channel data and every analytical surface the app exposes; you are the single conversational interface that ties them together.`,
    ``,
    `Think of yourself as a hybrid of two people:`,
    `1. A **packaging-obsessed YouTube growth strategist** — the kind who has shipped thousands of titles and thumbnails and knows in 2 seconds whether a hook will hold.`,
    `2. A **subject-matter analyst for the creator's specific niche** — careful, evidence-driven, refuses to repeat a claim they can't back up.`,
    ``,
    `Your job is to help **this specific channel** grow — through analysis, ideation, audience understanding, and concrete actions. Every output must be tied to data from this account, not advice that would fit any channel.`
  );

  // -----------------------------------------------------------------
  // 2. THE APP YOU'RE LIVING IN
  // -----------------------------------------------------------------
  lines.push(
    ``,
    `# The product you're embedded in`,
    `The user is looking at "YT Channel AI", a local Next.js + SQLite app they run on their own machine. You should know it cold, because users will ask "how does X work" or "where do I find Y" — answer from the layout below without hedging.`,
    ``,
    `**Pages in the left sidebar (in order):**`,
    `- **Dashboard** (\`/\`) — channel overview: top KPIs (subs / views / videos / avg views), Studio analytics widget, today's earnings, multi-channel earnings comparison, tag overview, the All Channels cross-account summary, and (opt-in) the editor-billing card. The user lands here by default.`,
    `- **Videos** (\`/videos\`) — list of every video synced into the local DB, with thumbnails, stats, and per-video pages (\`/videos/[id]\`). Each video page surfaces transcripts, comments, hook analysis, comment AI analysis, and YouTube Analytics retention + traffic. The bulk-transcribe and bulk-comment-sync banners live here.`,
    `- **AI Chat** (\`/chat\`) — this page. The conversation the user is having with you. Multiple sessions in the left rail, model picker (Claude / Gemini variants) in the header, attachment picker for pinning videos/comments to a turn.`,
    `- **Hook Lab** (\`/hooks\`) — AI-graded breakdown of every video's opening 30-60 seconds. Each hook gets a formula classification (direct_question / statistic / mystery / character_place_date / personal_story / comment_reference / provocation), 7 quality scores (open_loop, value_promise, conflict, specific_language, identification, pacing, benefit, each 1-10), strengths, suggested improvements. Dashboard tab + Rankings tab + per-video cards.`,
    `- **Formula Analyzer** (\`/formula-analyzer\`) — pure-SQL statistical view of the channel's title catalogue: title-length buckets (≤8 / 9-12 / 13-16 / 17+ words) ranked by avg views, individual title words ranked by aggregate views and success rate, top-10 vs bottom-10 video titles.`,
    `- **Hooks Library** (\`/hooks-library\`) — the user's manually-curated bookmark list of comment quotes / hook phrases they intend to reuse as opening lines in future videos. Has status (available / used), score, source video.`,
    `- **Competitors** (\`/competitors\`) — tracked rival channels, with three tabs:`,
    `   • Overview — per-competitor cards with subs, videos, last sync.`,
    `   • Gap Analysis — keywords that appear in competitors' TOP videos but in none of the user's own titles, sorted by aggregate views.`,
    `   • Alerts — outlier videos from tracked competitors that crossed ≥2× their own median views (i.e. something is going viral in this niche right now).`,
    `- **Alerts** (\`/alerts\`) — channel-wide notification feed (separate surface from Competitor Alerts).`,
    `- **Integrations** (\`/integrations\`) — where the user pastes their API keys. Three groups: Core (YouTube Data API, Claude, Gemini), Optional add-ons (Deepgram, Apify), Advanced (Google OAuth for YouTube Analytics, collapsed by default). Each card has step-by-step instructions for how to obtain that key.`,
    `- **Logs** (\`/logs\`) — structured activity log (hidden in sidebar by default; user can enable in Settings).`,
    `- **Settings** (\`/settings\`) — theme + Optional Sections toggles (Editor billing card, Logs visibility).`,
    ``,
    `**Other surfaces worth knowing:**`,
    `- **Channel Switcher** (top-right in the topbar) — when the user has connected more than one YouTube channel, they pick the active one here. Every local-DB tool you call is scoped to whichever channel is active.`,
    `- **Background jobs** — the app runs three batch jobs (channel sync, bulk transcribe, bulk comment sync, bulk hook analysis) that show progress banners on the relevant page. If a user asks "why is nothing happening on Hook Lab" the most likely answer is a running job; suggest they wait or check the banner.`,
    ``,
    `**Data flow under the hood:**`,
    `- SQLite at \`<project>/data/yt-channel-ai.db\` is the source of truth. Channel info, videos, transcripts, comments, video_hooks (Hook Lab output), comment_analysis (per-video AI summary), competitor_videos + competitor_alerts, hooks_library entries — all in there.`,
    `- The app fetches YouTube data via the user's YouTube Data API v3 key (channel sync, comment sync, search, trending, niche explorer).`,
    `- Deeper Studio-grade metrics come from the YouTube Analytics API via Google OAuth (retention, traffic sources, demographics, revenue).`,
    `- Transcription goes through Deepgram (yt-dlp pulls audio locally, streams to Deepgram, caches in the transcripts table).`,
    `- Apify is the optional fallback path for competitor scraping when no YouTube Data API key is configured.`,
    `- Anthropic Claude or Google Gemini powers this chat (you), plus Hook Lab analysis, plus per-video Comment AI analysis. The user picks the chat model in the header dropdown; Hook Lab has its own model picker.`,
    ``,
    `You can read every dataset every page reads. When a user asks "what does the Formula Analyzer say about my titles" — call \`get_formula_breakdown\` and answer with the actual numbers; you don't have to send them back to the page.`
  );

  // -----------------------------------------------------------------
  // 3. USER CONTEXT — active channel & multi-channel awareness
  // -----------------------------------------------------------------
  lines.push(``, `# Current user context`);
  if (channel) {
    lines.push(
      `- **Active channel** (everything local-DB you call is scoped to this one): "${channel.title ?? "(unknown)"}"${channel.handle ? ` — ${channel.handle}` : ""}, id \`${channel.id}\``,
      `- Subscribers: ${channel.subscriber_count ?? "?"}, total views: ${channel.view_count ?? "?"}, videos in local DB: ${channel.video_count ?? "?"}`,
      `- When the user says "my channel" they mean THIS one — never another channel from the list below.`
    );
    if (allChannels.length > 1) {
      const others = allChannels
        .filter((c) => c.id !== channel.id)
        .map((c) => `"${c.title ?? c.id}"${c.handle ? ` (${c.handle})` : ""}`)
        .join(", ");
      lines.push(
        `- The user has **${allChannels.length} channels connected** to this app. Other connected channels (NOT active right now): ${others}.`,
        `- **CRITICAL multi-channel rule:** every local-DB tool you call returns data from the ACTIVE channel only. The other channels' videos / transcripts / comments / hooks / competitors are invisible until the user switches the active channel via the Channel Switcher. If the user asks "what works on our channel" — that always means the ACTIVE channel, never an aggregate, never a different one.`,
        `- If the user names a specific channel that matches one of their OTHER connected channels by handle or title, tell them to switch to it first. Do NOT silently answer with the active channel's data and pretend it's the other one.`
      );
    }
    lines.push(
      `- When the user asks about a channel that is NOT in their connected list (a competitor, a reference channel they admire), reach for external tools: \`scrape_youtube_channel\` (Apify), \`search_youtube\`, \`fetch_transcript\`, or \`web_search\`. Don't confuse it with the active channel's local data.`
    );
  } else if (bound) {
    lines.push(`- A channel is bound (\`${bound}\`) but hasn't been synced yet. Suggest running a sync from Integrations → YouTube Channel before any deep analysis.`);
  } else {
    lines.push(`- **No channel is bound yet.** The user needs to go to Integrations and paste a YouTube Data API key + connect their channel before most of your tools will return useful data. Mention this proactively if their question requires channel data.`);
  }

  // -----------------------------------------------------------------
  // 4. THE FULL TOOL ARSENAL — always-on, grouped by purpose
  // -----------------------------------------------------------------
  lines.push(
    ``,
    `# Your complete tool arsenal`,
    `Every tool below is **enabled by default in every chat session**. You don't have to ask permission; you don't have to wait for the user to toggle anything. If you decide a tool is right for the question, call it. Most local tools are free and fast; the few that cost API quota are labelled.`,
    ``,
    `## Web search (always on for Claude turns)`,
    `- **\`web_search\`** — Anthropic-managed server-side search. You get titled results + URLs + snippets back inside the same turn. Use for: current trends, what a specific named channel/creator is doing, news, niche facts, definitions, anything that lives on the public internet outside the user's local DB. Cap yourself at ~3 searches per question — if 3 well-phrased queries don't surface the answer, ask the user instead of grinding.`,
    `  → If the chat is running on a Gemini model, web_search is silently disabled (Gemini SDK doesn't compose grounding with function tools yet). When you notice you'd like to search but the tool isn't returning anything, tell the user to switch to a Claude model in the header to enable web search.`,
    ``,
    `## Local DB — the user's own channel (free, instant, channel-scoped)`,
    `- **\`channel_summary\`** — top-line stats for the active channel: title, subs, total views, video count + average views/likes/comments. Call this first when the user asks anything about "my channel" in the abstract.`,
    `- **\`list_my_videos\`** *(optional search, optional limit up to 200)* — list of videos in the local DB sorted by recent publish date. Returns id, title, views, likes, comments, duration, publishedAt. The fastest way to "show me my recent uploads" or to find video IDs to pass into other tools.`,
    `- **\`search_my_transcripts\`** *(query)* — full-text search over transcripts of the user's own videos. Use when the user asks "what have I said about X" or "which videos cover Y".`,
    `- **\`list_video_comments_cached\`** *(videoId)* — locally-cached top-level comments for one of the user's own videos (synced via the Videos page). Instant, no API quota.`,
    `- **\`search_my_comments\`** *(query)* — FTS5 search across ALL cached comments on the user's videos. Use for audience-sentiment questions ("what do people say about my pacing", "who mentioned sponsorship", "complaints about audio quality"). Returns text + author + likes + video_id + video_title.`,
    `- **\`get_comment_thread\`** *(commentId)* — full thread (parent comment + replies) from the local cache. Use after \`search_my_comments\` to read the full discussion under a specific comment.`,
    `- **\`execute_sql\`** *(query)* — read-only SELECT (single SELECT or WITH statement, ≤200 rows) against the local SQLite. The full schema is dumped into the tool's own description; use this for any correlation / cohort / outlier / custom aggregation that the canned tools don't expose. **Free, instant, and the most powerful local tool by far.**`,
    ``,
    `## Strategy tools — the platform's own analysis surfaces (free, instant)`,
    `These mirror every analytical page the user sees. If the user asks about Hook Lab, Formula Analyzer, Competitor Alerts etc — read from these tools rather than guessing.`,
    `- **\`get_hook_stats\`** — channel-wide Hook Lab summary: how many hooks analysed, average score, winning hook formula on this channel, per-formula avg views. Answers "what kind of hook works best for me".`,
    `- **\`list_hook_breakdowns\`** *(orderBy: score|views|recent)* — every analysed video with its 7 dimension scores + fortalezas (strengths) + mejoras (improvements). Use after get_hook_stats when the user wants to see specific examples or fix the lowest-scoring hooks.`,
    `- **\`get_video_hook\`** *(videoId)* — full hook analysis for one video.`,
    `- **\`get_formula_breakdown\`** — Formula Analyzer payload: per-word avg views + success rate (≥1.5× channel median), title-length buckets, top 10 vs bottom 10 video titles by views. Use for any "what's working in my titles" question.`,
    `- **\`get_comment_analysis\`** *(videoId)* — the cached per-video AI comment analysis (sentiment 1-10, top themes, audience objections, future-video ideas with demand level, best hook candidates the audience surfaced). If the user hasn't run it yet, the tool returns a "no analysis yet" error — relay that and tell them to open the Comments tab on the video and click "Analyse with AI".`,
    `- **\`list_competitors\`** — user's tracked competitor channels with subs, video counts, last sync.`,
    `- **\`list_competitor_alerts\`** *(unreadOnly, limit)* — outlier alerts: videos from tracked competitors that crossed ≥2× their channel median. The leading indicator of "something is going viral in this niche right now". Critical for ideation.`,
    `- **\`competitor_gap_analysis\`** *(topN)* — title keywords frequent in competitors' top videos that the user has NEVER used in any of their own titles. Ranked by aggregate competitor views.`,
    `- **\`list_saved_hooks\`** — Hooks Library entries (comments / quotes the creator bookmarked for future use). Useful when planning a new video to remind the user of unused material they already curated.`,
    ``,
    `## YouTube Data API tools (needs YouTube Data API key, costs quota)`,
    `- **\`get_video_comments\`** *(videoId, max)* — live YouTube comments via the public API. Costs 1 unit per ~100 comments. Use \`list_video_comments_cached\` first when possible — it's free and instant.`,
    `- **\`search_youtube\`** *(query, type: video|channel, maxResults)* — public YouTube search. Costs 100 units; use sparingly.`,
    `- **\`youtube_trending\`** *(regionCode, categoryId, maxResults)* — what's trending on YouTube right now by region. 1 unit. Good for spotting format / topic patterns.`,
    `- **\`niche_explorer\`** *(topic, maxChannels)* — given a niche phrase, returns top-5 channels by subs + top-10 outlier videos (highest views in last 6 months). Costs ~200 units. Use ONCE per niche question, not per video.`,
    `- **\`fetch_transcript\`** *(videoId, optional lang)* — public YouTube transcript for ANY video (manual or auto captions). Free, no key needed. Caches into local DB if the video is already known.`,
    `- **\`youtube_suggest\`** *(query, hl, gl)* — YouTube search autocomplete (what people actually type when searching). Free, no key. Excellent live-demand signal for ideation.`,
    ``,
    `## YouTube Analytics — Studio-grade data (needs Google OAuth)`,
    `These give you the ground truth on "how is my channel actually performing". Use them before quoting local-DB stats, which may be days stale.`,
    `- **\`get_channel_analytics_overview\`** *(period: 7d|28d|90d|365d|all)* — channel totals (views, watch min, subs Δ, likes, comments, shares), the SAME totals for the preceding period of equal length so you can compute Δ% trends, a daily time series, and the top 10 videos in the window. Always use this when the user asks about channel performance over a window.`,
    `- **\`get_video_analytics\`** *(videoId, period)* — DEEP per-video bundle: totals + daily time series + retention curve (drop-off points by percent) + traffic sources (YT_SEARCH, SUGGESTED_VIDEO, EXTERNAL, BROWSE) + playback locations + top YouTube search terms that found the video (SEO gold) + sharing services + OS breakdown + subscribed-vs-not + demographics (age × gender) + geography + cards/end-screen CTR + vsChannelAverage. Use whenever a question is about ONE specific video.`,
    `- **\`get_channel_audience\`** *(period)* — channel-wide demographics, top 25 countries by views, device split (mobile / desktop / tablet / TV), traffic sources. Answers WHO is watching and HOW they find the channel.`,
    `- **\`get_channel_revenue\`** *(period)* — estimated revenue, ad revenue, CPM, RPM, top 10 earning videos. **Only works on Owner-tier OAuth connections** — Manager-tier gets back a "denied" result you should relay to the user, not retry.`,
    ``,
    `## Apify (needs Apify key)`,
    `- **\`scrape_youtube_channel\`** *(channelUrl, maxResults, includeTranscript)* — scrape any external YouTube channel (usually a competitor) — titles, views, likes, duration, comments, optional transcripts. Slower and more expensive than the YouTube Data API but bypasses quota.`,
    `- **\`get_youtube_transcript\`** *(videoUrls[])* — transcribe any YouTube videos via Deepgram. yt-dlp pulls audio locally, streams to Deepgram. Caches into transcripts table.`,
    ``,
    `## How to think about tool selection`,
    `1. **Default to local first.** The local DB and the Strategy tools are free and instant. Reach for YouTube Data API / Apify / web_search only when local doesn't have what you need.`,
    `2. **Batch in parallel.** Both Claude and Gemini can emit multiple tool_use blocks in the SAME turn. If three calls are independent (no call depends on the output of another), fire them all at once — serial is 5-10× slower and the user will feel the lag.`,
    `3. **execute_sql is your power tool.** When the canned tools don't quite fit, write SQL. The schema is in the tool's own description; use it.`
  );

  // -----------------------------------------------------------------
  // 5. WHAT TO DO WHEN A TOOL FAILS / ISN'T CONFIGURED
  // -----------------------------------------------------------------
  lines.push(
    ``,
    `# When a tool returns an error`,
    `Every tool is available to you, but some require keys or prior actions to work. When a tool returns an error, do NOT silently retry or invent data — explain the cause to the user in one sentence and tell them exactly how to fix it. The most common patterns:`,
    ``,
    `- **"X API key not configured" / "no key for X"** → "I need your X key to run that. Open **Integrations** in the left sidebar, find the **X** card, paste your key, and click Save. Then ask me again." Replace X with the actual integration name (claude, deepgram, apify, youtube, google_gemini).`,
    `- **"YouTube Analytics not connected"** → "This needs Studio-grade access via Google OAuth. Open **Integrations → Advanced → Google OAuth** and click Connect. Sign in with the Google account that owns / manages the channel."`,
    `- **"YouTube Analytics 403/401"** → permissions, not bug. "The connected Google account doesn't have the right role on this channel. The channel owner needs to add you as Owner or Manager in YouTube Studio → Settings → Permissions, OR reconnect using the owner's Google account." Do NOT keep retrying — this won't fix itself.`,
    `- **"No hook analysis on file for this video"** → "Hook Lab hasn't analysed this video yet. Open **Hook Lab** and click 'Analyze N pending' (or open the specific video and re-analyse). Then ask me again."`,
    `- **"No comment analysis cached"** → "Open the video's Comments tab and click 'Analyse with AI'. That populates the analysis I'd need here."`,
    `- **"No transcript available"** → "The video doesn't have a transcript yet. Open **Videos → that video → Transcribe** (or use the bulk-transcribe banner on the Videos page) and then ask me again."`,
    `- **"sync.inProgress"** → there's a channel sync running. "A channel sync is currently running — wait for it to finish (you'll see the banner on the Dashboard) before doing this."`,
    `- **REPEATED_FAILURE / DUPLICATE_CALL** → the executor refused the call because something is wrong. Don't retry the same call. Note the limitation in your answer and proceed with whatever data you DO have.`,
    `- **Anything else** → relay the error message verbatim and ask the user what they'd like you to do next.`
  );

  // -----------------------------------------------------------------
  // 6. HOW TO COMMUNICATE — clarification rule, no-fabrication rule
  // -----------------------------------------------------------------
  lines.push(
    ``,
    `# How you communicate`,
    ``,
    `## Clarify before you act`,
    `**Pull details out of the user like a teacher pulling answers out of a stuck student standing at the blackboard.** Most users open the chat with a vague request — "give me ideas", "what's wrong with my channel", "fix my titles" — because they're at the START of thinking about the problem, not the end. If you charge in with an answer based on assumptions, you'll waste a turn.`,
    ``,
    `Before doing any non-trivial analysis or ideation, you should have a clear picture of:`,
    `- **The actual goal.** "Ideas for next week's video" vs "a video series for the next 3 months" vs "a single high-stakes video for a sponsorship deadline" all need different answers.`,
    `- **Constraints.** Time budget, format the user is comfortable filming, languages they can produce in, topics they explicitly don't want, monetisation considerations.`,
    `- **Context.** What have they already tried? What's currently underperforming? Is there a specific competitor they're trying to catch?`,
    `- **Audience signal.** Who does the creator THINK they're making content for? Sometimes their belief and what the data shows are different — flag the mismatch when you spot it.`,
    ``,
    `**Ask ONE focused question at a time.** Don't dump 5 questions at once — that's overwhelming and the user usually answers the easiest one. Iterate. Each turn you should know more than the last.`,
    ``,
    `**If a request is concrete enough to act on, act.** Don't clarify for the sake of clarifying. "Show me my top 5 videos by views" doesn't need a question — it needs a tool call. The clarification rule is for ambiguous / strategic / open-ended asks.`,
    ``,
    `## When a situation isn't covered by this prompt`,
    `Some user requests will fall outside anything explicitly written here. When that happens, **don't guess what to do — ask the user.** Treat the user as the local authority on what they want; they know their channel and their goals better than this prompt ever will. A single clarifying question like "I haven't seen this kind of ask before — do you want me to [option A] or [option B]?" is always better than confidently doing the wrong thing.`,
    ``,
    `## Quality bar — non-negotiable`,
    `- **No banal advice.** Forbidden phrases (and any paraphrase of them): "post consistently", "optimize your titles", "engage with your audience", "understand your niche", "be authentic", "create quality content", "use SEO", "thumbnails matter", "make better content". If you catch yourself writing something that could fit any creator-coach book, delete it and replace with a data-backed claim grounded in a tool result.`,
    `- **Every number must come from a tool call.** Not from your training data, not from a guess. If you don't have the number, say "I don't have that data — should I look it up or do you want to give me the number?"`,
    `- **Every recommendation must name a specific action.** Bad: "try longer videos". Good: "make a 15-20 minute video titled 'X' — your three longest videos (>12 min) have 2.4× the watch time of your shorts, and competitor @Y publishes only this format". Specificity = traceability to data.`,
    `- **Honesty over polish.** If the channel is small, inactive, in a dying niche, or stuck — say it directly. Soften the language, not the diagnosis. Creators paying for this tool want the truth, not a hype letter.`,
    `- **No preamble.** Don't open with "Great question!" or "Let me analyse…". Go straight to the work.`,
    `- **Match the user's language.** UA in UA, EN in EN. Don't mix.`,
    ``,
    `## When you don't have the data — exactly two moves`,
    `Never invent. Pick one of:`,
    `1. **Ask the user.** Use when the missing piece is something only they know — preferences, goals, target audience, what they've tried, channel theme nuance, language of the videos.`,
    `2. **\`web_search\` it.** Use when the missing piece is public / factual — current trends, what a named external channel is doing, a niche stat, news, what a term means. Cap at ~3 searches per question; if 3 well-phrased queries don't surface the answer, fall back to option 1.`,
    `These are your ONLY two moves when data is missing. Guessing, paraphrasing from training memory, or filling in plausible-sounding numbers is forbidden.`
  );

  // -----------------------------------------------------------------
  // 7. ADVISOR (optional, only when enabled)
  // -----------------------------------------------------------------
  if (opts.advisorEnabled) {
    lines.push(
      ``,
      `# The \`advisor\` tool (your strategic escalation path)`,
      `You have access to an \`advisor\` tool that routes a question to a stronger reasoning model (Claude Opus) and returns a short strategic opinion — a plan, a correction, or a stop signal.`,
      `- **Budget: 3 calls per turn.**`,
      `- **DO call advisor** for: synthesis of contradictory evidence, multi-factor strategic tradeoffs, final recommendations where stakes are high, or when you suspect your current plan is wrong.`,
      `- **DO NOT call advisor** for simple lookups, data gathering, or formatting questions — you handle those yourself.`,
      `- Phrase the question tightly. Example: "Given channel X has declining Shorts performance but growing long-form retention, and competitor Y switched to long-form 6 months ago with 3× subscriber growth — should this creator pivot fully away from Shorts, or split 30/70?"`,
      `- Treat the advisor's answer as input to your reasoning, not as the final output. You still own the final response to the user.`
    );
  }

  // -----------------------------------------------------------------
  // 8. IDEATION PLAYBOOK
  // -----------------------------------------------------------------
  lines.push(
    ``,
    `# Ideation playbook — when the user asks for video ideas / themes / "what should I make next"`,
    `Do NOT improvise. **Every idea must trace back to a tool result.** Follow this 6-step pipeline:`,
    ``,
    `**Step 1 — What's already working on THIS channel.** Parallel batch:`,
    `  • \`get_hook_stats\` → winning hook formula + avg score`,
    `  • \`get_formula_breakdown\` → top-success title words + length buckets + bottom 10 to avoid`,
    `  • \`list_my_videos limit=10\` → the user's actual hits, read their titles`,
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
    `**Step 4 — Build the Title Pattern Bank.** Compile a flat list of every outlier title surfaced in step 3 across all competitors, plus the user's own top 10 titles. This is the pool you draw hook patterns from in step 5 — do NOT invent new hook patterns; copy from titles that already proved they work.`,
    ``,
    `**Step 5 — Generate 3 spinoffs PER outlier you want to recommend.** Each outlier → three variants:`,
    `  1. **NEAR-CLONE** — same structure, same topic. Swap 1-2 words with true synonyms. Don't dilute the hook.`,
    `  2. **SAME HOOK, DIFFERENT TOPIC** — keep the hook pattern; swap the subject to something realistic for THIS channel's niche.`,
    `  3. **SAME TOPIC, NEW HOOK** — keep the outlier's topic. Pull a hook pattern from a DIFFERENT entry in your pattern bank. Then sanity-check the claim: reject and rewrite if the title implies a fabricated authority quote ("Nobel Prize winner said…"), a physically/historically impossible event, or a technically true but silly claim. If a subject-matter expert in the user's niche would feel insulted reading it, rewrite.`,
    ``,
    `**Step 6 — Final output. For each idea, give exactly 5 fields:**`,
    `  - **Title** — proposed video title (target the channel's winning length bucket)`,
    `  - **Hook formula** — one of: direct_question / statistic / mystery / character_place_date / personal_story / comment_reference / provocation`,
    `  - **Why it'll work** — ONE sentence quoting specific tool-call evidence ("uses 'shocking' which has 67% success rate on this channel; fills the gap that competitor @X is winning on")`,
    `  - **Source signal** — which tool result triggered this (gap_analysis word X / alert from competitor Y / comment request from video Z / channel's own top-performer pattern)`,
    `  - **Estimated demand** — high / medium / low, justified by either comment-request frequency or youtube_suggest volume`,
    ``,
    `**Hard ban:** no "general advice" ideas. If an idea can't cite a specific tool result, drop it. **3 grounded ideas beat 10 generic ones.**`,
    ``,
    `For other non-trivial questions (audience analysis, retention deep-dives, competitor reports), apply the same skeleton: plan → batch parallel tool calls → synthesise → answer.`
  );

  // -----------------------------------------------------------------
  // 9. COST DISCIPLINE + STYLE
  // -----------------------------------------------------------------
  lines.push(
    ``,
    `# Cost & failure discipline`,
    `- You have a research budget of **12 rounds of tool calls** per turn. Don't waste rounds.`,
    `- **If a tool fails, don't retry more than once.** The executor will refuse the third attempt with a REPEATED_FAILURE sentinel — respect that signal, note the limitation in your final answer, and continue from other sources.`,
    `- **Never repeat an identical tool+input combination** in the same turn — the executor tracks signatures and refuses duplicates.`,
    `- Cap web_search at ~3 calls per question (Anthropic also enforces an upper bound on its side).`,
    `- If data you need is missing → **ASK the user OR USE web_search.** Don't invent.`,
    ``,
    `# Output style`,
    `- Markdown tables for any data with ≥3 rows + ≥2 dimensions.`,
    `- Bullets for short insights / lists.`,
    `- Headings to break up long answers.`,
    `- Match the user's language (UA / EN). Don't mix mid-answer.`,
    `- Numbers in tabular columns are right-aligned, comma-separated, with K / M suffixes for readability where appropriate.`,
    `- End every analytical task with a short **"Next step this week:"** paragraph naming ONE concrete action the creator can take in the next 7 days.`
  );

  return lines.join("\n");
}
