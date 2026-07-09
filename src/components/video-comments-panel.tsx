"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MessageCircle,
  ThumbsUp,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Search,
  Download,
  BookmarkPlus,
  Sparkles,
  Check,
  Lightbulb,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type Comment = {
  id: string;
  video_id: string;
  parent_id: string | null;
  author: string | null;
  author_channel_id: string | null;
  text: string;
  like_count: number;
  reply_count: number;
  published_at: number | null;
  updated_at: number | null;
  fetched_at: number;
};

type Summary = { total: number; topLevel: number; fetchedAt: number | null };

type ListResponse = {
  comments: Comment[];
  summary: Summary;
  pagination: { limit: number; offset: number; returned: number };
};

const PAGE_SIZE = 50;

/** Quick-tag triage labels — kept in sync with the CHECK-style list in db.ts. */
const QUICK_TAGS = [
  { tag: "hook", label: "Hook" },
  { tag: "objection", label: "Objection" },
  { tag: "question", label: "Question" },
  { tag: "praise", label: "Praise" },
  { tag: "attack", label: "Attack" },
] as const;
type QuickTag = (typeof QUICK_TAGS)[number]["tag"];

export function VideoCommentsPanel({
  videoId,
  initialSummary,
}: {
  videoId: string;
  initialSummary: Summary;
}) {
  const { t } = useI18n();
  const [comments, setComments] = useState<Comment[]>([]);
  const [summary, setSummary] = useState<Summary>(initialSummary);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");

  // Quick-tag triage — comment_id -> tag[] for every cached comment on
  // this video, plus the "All / Hook / Objection / ..." filter pill.
  const [tagsByComment, setTagsByComment] = useState<Record<string, string[]>>({});
  const [tagFilter, setTagFilter] = useState<QuickTag | "all">("all");

  const loadTags = useCallback(async () => {
    try {
      const res = await fetch(`/api/videos/${videoId}/comment-tags`);
      if (!res.ok) return;
      const data = (await res.json()) as { tags?: Record<string, string[]> };
      setTagsByComment(data.tags ?? {});
    } catch {
      /* tag chips are additive — a failed fetch just leaves them empty */
    }
  }, [videoId]);

  const loadPage = useCallback(
    async (nextOffset: number, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/videos/${videoId}/comments?limit=${PAGE_SIZE}&offset=${nextOffset}`
        );
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as ListResponse;
        setComments((prev) => (replace ? data.comments : [...prev, ...data.comments]));
        setSummary(data.summary);
        setHasMore(data.pagination.returned === PAGE_SIZE);
        setOffset(nextOffset + data.pagination.returned);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setLoading(false);
      }
    },
    [videoId]
  );

  useEffect(() => {
    loadPage(0, true);
    loadTags();
  }, [loadPage, loadTags]);

  // Optimistic toggle — flip the chip locally right away, then
  // POST/DELETE in the background. On failure we roll the local map
  // back so the chip doesn't lie about server state.
  const toggleTag = useCallback(
    async (commentId: string, tag: QuickTag) => {
      const wasActive = (tagsByComment[commentId] ?? []).includes(tag);
      setTagsByComment((prev) => {
        const current = prev[commentId] ?? [];
        const next = wasActive ? current.filter((tt) => tt !== tag) : [...current, tag];
        return { ...prev, [commentId]: next };
      });
      try {
        const res = await fetch(`/api/comments/${commentId}/tags`, {
          method: wasActive ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        // Roll back to the pre-toggle state.
        setTagsByComment((prev) => {
          const current = prev[commentId] ?? [];
          const rolledBack = wasActive
            ? [...current, tag]
            : current.filter((tt) => tt !== tag);
          return { ...prev, [commentId]: rolledBack };
        });
      }
    },
    [tagsByComment]
  );

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxThreads: 200, order: "relevance" }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      await loadPage(0, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = comments;
    if (q) {
      rows = rows.filter(
        (c) => c.text.toLowerCase().includes(q) || (c.author ?? "").toLowerCase().includes(q)
      );
    }
    if (tagFilter !== "all") {
      rows = rows.filter((c) => (tagsByComment[c.id] ?? []).includes(tagFilter));
    }
    return rows;
  }, [comments, query, tagFilter, tagsByComment]);

  const fetchedLabel = summary.fetchedAt ? fmtRelative(summary.fetchedAt) : t.comments.neverSynced;

  // We treat "AI can't see these comments" as the case where nothing's been
  // synced yet — `fetchedAt` null AND zero rows in the local cache. Once at
  // least one sync has happened (even if YouTube returned 0 comments), the
  // local DB has *some* state and the AI can call `list_video_comments_cached`
  // / `search_my_comments` without surprises, so we drop the banner.
  const showSyncBanner = summary.fetchedAt === null && summary.total === 0;

  // AI Comment Analysis (Phase D) — cached one-per-video Claude breakdown
  // that surfaces sentiment, themes, objections, future-video ideas, and
  // best hook candidates. Lives in this panel because the input is the
  // comments themselves; we only fire on click to keep Claude billing
  // predictable, and remember the result so re-opening the tab doesn't
  // re-bill.
  const [analysis, setAnalysis] = useState<{
    sentiment_score: number;
    themes: string[];
    objections: { text: string; severity: string }[];
    future_ideas: { title: string; demand: string; evidence: string }[];
    hook_candidates: { author: string; quote: string; why: string }[];
    summary: string;
    analyzed_at: number;
    comments_count: number;
  } | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/videos/${videoId}/comment-analysis`)
      .then((r) => r.json())
      .then((d) => setAnalysis(d.analysis ?? null))
      .catch(() => setAnalysis(null));
  }, [videoId]);

  const runAnalysis = async () => {
    setAnalysing(true);
    setAnalysisError(null);
    try {
      const r = await fetch(`/api/videos/${videoId}/comment-analysis`, {
        method: "POST",
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      // Re-read the cached row so we get the parsed sub-fields too.
      const cachedRes = await fetch(`/api/videos/${videoId}/comment-analysis`);
      const cachedJson = await cachedRes.json();
      setAnalysis(cachedJson.analysis ?? null);
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : "failed");
    } finally {
      setAnalysing(false);
    }
  };

  // Hooks Library — when the user clicks "+ Save" we POST to the
  // library API, then locally mark this commentId so the button
  // becomes "Saved" without a full refetch.
  const [savedHookIds, setSavedHookIds] = useState<Set<string>>(new Set());
  const saveAsHook = async (
    commentId: string,
    quote: string,
    author: string | null
  ) => {
    try {
      const res = await fetch("/api/hooks-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment_id: commentId,
          source_video_id: videoId,
          quote,
          author,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setSavedHookIds((prev) => new Set(prev).add(commentId));
    } catch (e) {
      // Previously this was swallowed silently — the button just didn't
      // flip and the user couldn't tell if it worked. Surface the
      // failure so "Save as hook" is never a mystery no-op.
      alert(
        `Couldn't save this comment to Hooks Library: ${
          e instanceof Error ? e.message : "unknown error"
        }`
      );
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        {/* Quick-tag filter pills — client-side filter of already-loaded
            comments by their tag map, no server round-trip. */}
        {comments.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <FilterPill active={tagFilter === "all"} onClick={() => setTagFilter("all")}>
              All
            </FilterPill>
            {QUICK_TAGS.map(({ tag, label }) => (
              <FilterPill
                key={tag}
                active={tagFilter === tag}
                onClick={() => setTagFilter(tag)}
              >
                {label}
              </FilterPill>
            ))}
          </div>
        )}
        {showSyncBanner && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <div className="flex min-w-0 items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                <div className="font-medium text-foreground">
                  {t.comments.notSyncedTitle}
                </div>
                <div className="text-muted-foreground">
                  {t.comments.notSyncedDescription}
                </div>
              </div>
            </div>
            <Button
              size="sm"
              onClick={sync}
              disabled={syncing}
              className="shrink-0 gap-1.5"
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {syncing ? t.comments.syncing : t.comments.syncFromYouTube}
            </Button>
          </div>
        )}
        {/* Header: stats + sync */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <MessageCircle className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">
              {summary.topLevel} {t.comments.topLevelSuffix}
            </span>
            <span className="text-muted-foreground">
              · {summary.total - summary.topLevel} {t.comments.repliesSuffix}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {t.comments.lastSynced}: {fetchedLabel}
          </span>
          <div className="ml-auto">
            <Button
              size="sm"
              variant="outline"
              onClick={sync}
              disabled={syncing}
              className="gap-1.5"
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {syncing ? t.comments.syncing : t.comments.syncFromYouTube}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        {/* AI Comment Analysis */}
        {summary.total > 0 && (
          <div className="mb-3 rounded-md border border-border bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                AI Comment Analysis
                {analysis && (
                  <span
                    className={cn(
                      "ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                      analysis.sentiment_score >= 8
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : analysis.sentiment_score >= 5
                          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          : "bg-rose-500/15 text-rose-700 dark:text-rose-400"
                    )}
                  >
                    Sentiment {analysis.sentiment_score}/10
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={runAnalysis}
                disabled={analysing}
                className="h-7 gap-1 text-[11px]"
              >
                {analysing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {analysis ? "Re-analyse" : "Analyse with AI"}
              </Button>
            </div>

            {analysisError && (
              <div className="mt-2 text-[11px] text-destructive">
                {analysisError}
              </div>
            )}

            {analysis && (
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                {/* Themes */}
                {analysis.themes.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Top themes
                    </div>
                    <ul className="space-y-0.5 text-xs">
                      {analysis.themes.map((t, i) => (
                        <li key={i} className="text-foreground">
                          · {t}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Objections */}
                {analysis.objections.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Credibility objections
                    </div>
                    <ul className="space-y-0.5 text-xs">
                      {analysis.objections.map((o, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <span
                            className={cn(
                              "mt-0.5 inline-block shrink-0 rounded px-1 py-0 text-[9px] font-bold uppercase",
                              o.severity === "high"
                                ? "bg-rose-500/15 text-rose-700 dark:text-rose-400"
                                : o.severity === "medium"
                                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                  : "bg-muted text-muted-foreground"
                            )}
                          >
                            {o.severity}
                          </span>
                          <span>{o.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Future ideas */}
                {analysis.future_ideas.length > 0 && (
                  <div className="md:col-span-2">
                    <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Lightbulb className="h-2.5 w-2.5" />
                      Future video ideas
                    </div>
                    <ul className="space-y-1.5 text-xs">
                      {analysis.future_ideas.map((idea, i) => (
                        <li
                          key={i}
                          className="rounded border border-border/60 p-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium">{idea.title}</span>
                            <span
                              className={cn(
                                "shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase",
                                idea.demand === "high"
                                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                  : idea.demand === "medium"
                                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                    : "bg-muted text-muted-foreground"
                              )}
                            >
                              {idea.demand} demand
                            </span>
                          </div>
                          {idea.evidence && (
                            <div className="mt-0.5 text-[11px] italic text-muted-foreground">
                              &ldquo;{idea.evidence}&rdquo;
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Hook candidates */}
                {analysis.hook_candidates.length > 0 && (
                  <div className="md:col-span-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Best hook candidates
                    </div>
                    <ul className="space-y-1.5 text-xs">
                      {analysis.hook_candidates.map((h, i) => (
                        <li
                          key={i}
                          className="rounded border border-border/60 p-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium">@{h.author}</span>
                            <HookCandidateSaveButton
                              videoId={videoId}
                              quote={h.quote}
                              author={h.author}
                              why={h.why}
                            />
                          </div>
                          <div className="mt-0.5 text-foreground">
                            &ldquo;{h.quote}&rdquo;
                          </div>
                          {h.why && (
                            <div className="mt-0.5 text-[10px] italic text-muted-foreground">
                              Why: {h.why}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Summary */}
                {analysis.summary && (
                  <div className="md:col-span-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Summary
                    </div>
                    <p className="text-xs leading-relaxed text-foreground">
                      {analysis.summary}
                    </p>
                  </div>
                )}

                <div className="md:col-span-2 text-[10px] text-muted-foreground">
                  Analysed {fmtRelative(analysis.analyzed_at)} from{" "}
                  {analysis.comments_count} comments.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Search */}
        {comments.length > 0 && (
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={t.comments.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        {/* List */}
        {comments.length === 0 && !loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t.comments.empty}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((c) => (
              <CommentItem
                key={c.id}
                videoId={videoId}
                comment={c}
                isSaved={savedHookIds.has(c.id)}
                onSaveAsHook={() => saveAsHook(c.id, c.text, c.author)}
                tags={tagsByComment[c.id] ?? []}
                onToggleTag={(tag) => toggleTag(c.id, tag)}
              />
            ))}
          </ul>
        )}

        {/* Loader */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t.comments.loading}
          </div>
        )}

        {/* Load more */}
        {hasMore && !loading && query.trim() === "" && (
          <div className="mt-3 flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => loadPage(offset, false)}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              {t.comments.loadMore}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Save button for an AI-surfaced hook candidate. Has its own state so
 * the click gives real feedback — previously this was a bare fetch()
 * with no .then/.catch, so saving a candidate looked like a no-op
 * (nothing flipped, no error, no confirmation).
 */
function HookCandidateSaveButton({
  videoId,
  quote,
  author,
  why,
}: {
  videoId: string;
  quote: string;
  author: string;
  why?: string;
}) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle"
  );

  const save = async () => {
    setState("saving");
    try {
      const res = await fetch("/api/hooks-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_video_id: videoId,
          quote,
          author,
          note: why,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState("saved");
    } catch {
      setState("error");
      // Let the user retry — drop back to idle after a moment.
      setTimeout(() => setState("idle"), 2500);
    }
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={save}
      disabled={state === "saving" || state === "saved"}
      className="h-5 gap-1 text-[10px]"
      title={
        state === "saved"
          ? "Saved to Hooks Library"
          : "Save this candidate to Hooks Library"
      }
    >
      {state === "saving" ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      ) : state === "saved" ? (
        <Check className="h-2.5 w-2.5" />
      ) : (
        <BookmarkPlus className="h-2.5 w-2.5" />
      )}
      {state === "saving"
        ? "Saving…"
        : state === "saved"
          ? "Saved"
          : state === "error"
            ? "Retry"
            : "Save"}
    </Button>
  );
}

/** A top-level comment with collapsible replies (YT-style). */
function CommentItem({
  videoId,
  comment,
  isSaved,
  onSaveAsHook,
  tags,
  onToggleTag,
}: {
  videoId: string;
  comment: Comment;
  isSaved: boolean;
  onSaveAsHook: () => void;
  tags: string[];
  onToggleTag: (tag: QuickTag) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [replies, setReplies] = useState<Comment[] | null>(null);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const [fetchingFresh, setFetchingFresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFullText, setShowFullText] = useState(false);

  const isLongText = comment.text.length > 400;
  const visibleText = showFullText || !isLongText ? comment.text : comment.text.slice(0, 400) + "…";

  const loadReplies = useCallback(async () => {
    setLoadingReplies(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments/${comment.id}/replies`);
      const data = (await res.json().catch(() => ({}))) as {
        replies?: Comment[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setReplies(data.replies ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoadingReplies(false);
    }
  }, [videoId, comment.id]);

  const fetchFreshReplies = async () => {
    setFetchingFresh(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments/${comment.id}/replies`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        unavailable?: boolean;
        error?: string;
      };
      // Server returns 200 + { unavailable: true } for the YouTube-says-404
      // case (deleted parent, locked thread, etc.) — surface as a friendly
      // message rather than a scary error tone.
      if (data.unavailable) {
        setError(data.error ?? "Replies unavailable on YouTube.");
        return;
      }
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadReplies();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setFetchingFresh(false);
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && replies === null) {
      loadReplies();
    }
  };

  const cachedRepliesCount = replies?.length ?? 0;
  const missingReplies =
    replies !== null && comment.reply_count > cachedRepliesCount;

  return (
    <li className="py-3">
      <div className="flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {(comment.author ?? "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-medium text-foreground">{comment.author ?? "—"}</span>
            <span className="text-muted-foreground">
              {comment.published_at ? fmtRelative(comment.published_at) : ""}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {visibleText}
          </p>
          {isLongText && (
            <button
              type="button"
              className="mt-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowFullText((v) => !v)}
            >
              {showFullText ? t.comments.showLess : t.comments.showMore}
            </button>
          )}
          <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ThumbsUp className="h-3 w-3" />
              {formatCount(comment.like_count)}
            </span>
            {comment.reply_count > 0 && (
              <button
                type="button"
                onClick={toggle}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10"
              >
                {expanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {expanded
                  ? t.comments.hideReplies
                  : t.comments.viewReplies.replace("{n}", String(comment.reply_count))}
              </button>
            )}
            <button
              type="button"
              onClick={onSaveAsHook}
              disabled={isSaved}
              className={cn(
                "ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                isSaved
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
              )}
              title={
                isSaved
                  ? "Already in Hooks Library"
                  : "Save this comment to Hooks Library"
              }
            >
              {isSaved ? (
                <>
                  <Check className="h-3 w-3" />
                  Saved
                </>
              ) : (
                <>
                  <BookmarkPlus className="h-3 w-3" />
                  Save as hook
                </>
              )}
            </button>
          </div>

          {/* Quick-tag triage chips — toggle hook/objection/question/
              praise/attack on this comment. When "Hook" is active, the
              save-as-hook button above is the panel's existing save
              affordance for exactly this case, so we don't add a second
              save control here — just call it out. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {QUICK_TAGS.map(({ tag, label }) => (
              <TagChip
                key={tag}
                active={tags.includes(tag)}
                onClick={() => onToggleTag(tag)}
              >
                {label}
              </TagChip>
            ))}
            {tags.includes("hook") && !isSaved && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                Tagged as a hook — consider &ldquo;Save as hook&rdquo; above.
              </span>
            )}
          </div>

          {expanded && (
            <div className="mt-3 space-y-3 border-l-2 border-border pl-4">
              {loadingReplies && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t.comments.loadingReplies}
                </div>
              )}
              {error && (
                <div className="text-xs text-destructive">{error}</div>
              )}
              {replies?.map((r) => (
                <ReplyItem key={r.id} comment={r} />
              ))}
              {replies && replies.length === 0 && !loadingReplies && (
                <div className="text-xs text-muted-foreground">
                  {t.comments.repliesNotCached}
                </div>
              )}
              {missingReplies && !loadingReplies && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={fetchFreshReplies}
                  disabled={fetchingFresh}
                  className="h-7 gap-1.5 text-xs"
                >
                  {fetchingFresh ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  {fetchingFresh
                    ? t.comments.fetching
                    : t.comments.fetchAllReplies.replace(
                        "{n}",
                        String(comment.reply_count - cachedRepliesCount)
                      )}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** Filter pill for the "All / Hook / Objection / ..." row at the panel top. */
function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/** Tiny per-comment toggle chip (Hook/Objection/Question/Praise/Attack). */
function TagChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function ReplyItem({ comment }: { comment: Comment }) {
  const [showFullText, setShowFullText] = useState(false);
  const { t } = useI18n();
  const isLongText = comment.text.length > 300;
  const visibleText = showFullText || !isLongText ? comment.text : comment.text.slice(0, 300) + "…";

  return (
    <div className="flex gap-2">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
        {(comment.author ?? "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="font-medium text-foreground">{comment.author ?? "—"}</span>
          <span className="text-muted-foreground">
            {comment.published_at ? fmtRelative(comment.published_at) : ""}
          </span>
        </div>
        <p className={cn("mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed")}>
          {visibleText}
        </p>
        {isLongText && (
          <button
            type="button"
            className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowFullText((v) => !v)}
          >
            {showFullText ? t.comments.showLess : t.comments.showMore}
          </button>
        )}
        {comment.like_count > 0 && (
          <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ThumbsUp className="h-2.5 w-2.5" />
            {formatCount(comment.like_count)}
          </div>
        )}
      </div>
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}
