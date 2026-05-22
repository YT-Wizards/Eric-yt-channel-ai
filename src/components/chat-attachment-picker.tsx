"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  X,
  PlaySquare,
  Loader2,
  Eye,
  MessageCircle,
  ThumbsUp,
  ImageIcon,
  Check,
  Lock,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";

export type AttachmentRef =
  | { type: "video"; id: string; title: string; thumbnail: string | null }
  | { type: "comment"; id: string; title: string; thumbnail: null }
  | {
      type: "image";
      id: string;
      title: string;
      // Object URL we use for the chip preview while the page is open.
      // Server gets `data` (base64) and `mediaType` separately on send.
      thumbnail: string | null;
      data: string;
      mediaType: string;
    };

type Tab = "videos" | "comments";

type VideoLite = {
  id: string;
  title: string;
  views: number;
  likes: number;
  published_at: number | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
};

type CommentRow = {
  id: string;
  video_id: string;
  parent_id: string | null;
  author: string | null;
  text: string;
  like_count: number;
  reply_count: number;
  published_at: number | null;
};

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

/**
 * Attachment picker for the chat composer.
 *
 * Two tabs:
 *  - **Videos** — search + pin any of the user's videos. Pinning a
 *    video also makes the AI see that video's transcript AND its top
 *    comments automatically (handled server-side in attachments.ts).
 *  - **Comments** — GATED behind the Videos tab. It stays disabled
 *    until at least one video is attached, then it lists the comments
 *    of those specific attached videos so the user can pin individual
 *    threads for extra emphasis. This replaces the old global comment
 *    full-text search, which let users attach comments with no video
 *    context — confusing both for them and the model.
 *
 * The component takes the live `attachments` array (not just an id
 * Set) so it can tell which attachments are videos and drive the
 * gating + per-video comment fetch.
 */
export function ChatAttachmentPicker({
  open,
  onClose,
  onPick,
  attachments,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (ref: AttachmentRef) => void;
  attachments: AttachmentRef[];
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("videos");
  const [q, setQ] = useState("");
  const [videos, setVideos] = useState<VideoLite[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Derived: ids already attached (for the "added" badge + disabling),
  // and the subset of attachments that are videos (drives the Comments
  // tab gate).
  const alreadyAttachedIds = useMemo(
    () => new Set(attachments.map((a) => a.id)),
    [attachments]
  );
  const attachedVideos = useMemo(
    () =>
      attachments.filter(
        (a): a is Extract<AttachmentRef, { type: "video" }> =>
          a.type === "video"
      ),
    [attachments]
  );
  const commentsUnlocked = attachedVideos.length > 0;

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // If the Comments tab is open and the user removes the last video,
  // bounce them back to Videos — the tab no longer has anything to show.
  useEffect(() => {
    if (tab === "comments" && !commentsUnlocked) setTab("videos");
  }, [tab, commentsUnlocked]);

  // Reset the search box when switching tabs so stale queries don't
  // carry across.
  useEffect(() => {
    setQ("");
  }, [tab]);

  // Videos tab — debounced search against /api/videos/search.
  useEffect(() => {
    if (!open || tab !== "videos") return;
    const ctrl = new AbortController();
    setLoading(true);
    const id = setTimeout(() => {
      const url = new URL("/api/videos/search", window.location.origin);
      if (q.trim()) url.searchParams.set("q", q.trim());
      url.searchParams.set("limit", "30");
      fetch(url, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => setVideos(d.videos ?? []))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 180);
    return () => {
      ctrl.abort();
      clearTimeout(id);
    };
  }, [q, open, tab]);

  const onEsc = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );
  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onEsc]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mt-24 w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tabs */}
        <div className="flex gap-1 border-b border-border px-2 pt-2">
          <PickerTab active={tab === "videos"} onClick={() => setTab("videos")}>
            <PlaySquare className="h-3.5 w-3.5" />
            {t.attachPicker.tabVideos}
          </PickerTab>
          <PickerTab
            active={tab === "comments"}
            disabled={!commentsUnlocked}
            onClick={() => commentsUnlocked && setTab("comments")}
            title={
              commentsUnlocked
                ? undefined
                : "Pick a video first — comments are tied to a video"
            }
          >
            {commentsUnlocked ? (
              <MessageCircle className="h-3.5 w-3.5" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            {t.attachPicker.tabComments}
            {commentsUnlocked && (
              <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
                {attachedVideos.length}
              </span>
            )}
          </PickerTab>
        </div>

        {/* Search — only the Videos tab has a top-level search box.
            The Comments tab does its own inline filter. */}
        {tab === "videos" && (
          <div className="flex items-center gap-2 border-b border-border p-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t.attachPicker.searchPlaceholder}
              className="border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto p-1">
          {tab === "videos" ? (
            <VideosList
              videos={videos}
              loading={loading}
              alreadyAttachedIds={alreadyAttachedIds}
              onPick={onPick}
            />
          ) : (
            <CommentsForAttachedVideos
              attachedVideos={attachedVideos}
              alreadyAttachedIds={alreadyAttachedIds}
              onPick={onPick}
            />
          )}
        </div>

        <div className="border-t border-border bg-muted/30 p-2 text-center">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t.attachPicker.done}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PickerTab({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors",
        disabled
          ? "cursor-not-allowed border-transparent text-muted-foreground/50"
          : active
            ? "border-primary text-foreground"
            : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function VideosList({
  videos,
  loading,
  alreadyAttachedIds,
  onPick,
}: {
  videos: VideoLite[] | null;
  loading: boolean;
  alreadyAttachedIds: Set<string>;
  onPick: (ref: AttachmentRef) => void;
}) {
  const { t } = useI18n();
  if (loading && videos === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t.comments.loading}
      </div>
    );
  }
  if (videos && videos.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {t.attachPicker.empty}
      </div>
    );
  }
  return (
    <ul className="space-y-0.5">
      {videos?.map((v) => {
        const attached = alreadyAttachedIds.has(v.id);
        return (
          <li key={v.id}>
            <button
              type="button"
              disabled={attached}
              onClick={() => {
                onPick({
                  type: "video",
                  id: v.id,
                  title: v.title,
                  thumbnail: v.thumbnail_url,
                });
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors",
                attached ? "cursor-not-allowed opacity-50" : "hover:bg-accent"
              )}
            >
              {v.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={v.thumbnail_url}
                  alt=""
                  className="h-10 w-16 shrink-0 rounded object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-muted">
                  <PlaySquare className="h-4 w-4 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{v.title}</div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Eye className="h-2.5 w-2.5" />
                    {fmt(v.views)}
                  </span>
                  {v.published_at && (
                    <span>
                      {new Date(v.published_at * 1000).toLocaleDateString("en-US", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  )}
                </div>
              </div>
              {attached && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  {t.attachPicker.added}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Comments tab body. Only ever rendered when ≥1 video is attached.
 * Fetches the cached comments of each attached video and lets the user
 * pin individual threads. The header reassures the user that the AI
 * already sees these comments (the video attachment carries its top
 * comments automatically — see attachments.ts), so pinning here is
 * purely for emphasis on a specific thread.
 */
function CommentsForAttachedVideos({
  attachedVideos,
  alreadyAttachedIds,
  onPick,
}: {
  attachedVideos: Array<Extract<AttachmentRef, { type: "video" }>>;
  alreadyAttachedIds: Set<string>;
  onPick: (ref: AttachmentRef) => void;
}) {
  const [byVideo, setByVideo] = useState<
    Record<string, { comments: CommentRow[]; total: number } | "loading" | "error">
  >({});
  const [filter, setFilter] = useState("");

  // Fetch comments for each attached video once. Keyed by video id so
  // adding another video only fetches the new one.
  useEffect(() => {
    let cancelled = false;
    for (const v of attachedVideos) {
      if (byVideo[v.id]) continue; // already fetched / fetching
      setByVideo((prev) => ({ ...prev, [v.id]: "loading" }));
      fetch(`/api/videos/${v.id}/comments?limit=100`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          setByVideo((prev) => ({
            ...prev,
            [v.id]: {
              comments: (d.comments ?? []) as CommentRow[],
              total: d.summary?.total ?? 0,
            },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setByVideo((prev) => ({ ...prev, [v.id]: "error" }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachedVideos]);

  const totalLoaded = attachedVideos.reduce((sum, v) => {
    const entry = byVideo[v.id];
    return sum + (entry && entry !== "loading" && entry !== "error" ? entry.comments.length : 0);
  }, 0);

  const q = filter.trim().toLowerCase();

  return (
    <div className="space-y-2">
      {/* Reassurance banner — the AI already sees these. */}
      <div className="mx-1 mt-1 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-[11px] text-muted-foreground">
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          The AI already sees the top comments of your{" "}
          {attachedVideos.length} attached video
          {attachedVideos.length === 1 ? "" : "s"} automatically. Pin a
          specific thread below only if you want the AI to focus on it.
        </span>
      </div>

      {/* Inline filter across the loaded comments. */}
      <div className="mx-1 flex items-center gap-2 rounded-md border border-border px-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter these comments…"
          className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
      </div>

      {attachedVideos.map((v) => {
        const entry = byVideo[v.id];
        return (
          <div key={v.id} className="px-1">
            <div className="px-1 py-1 text-[11px] font-medium text-muted-foreground">
              {v.title}
            </div>
            {entry === "loading" || entry === undefined ? (
              <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading comments…
              </div>
            ) : entry === "error" ? (
              <div className="py-4 text-center text-xs text-destructive">
                Couldn&apos;t load comments for this video.
              </div>
            ) : entry.comments.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                No comments cached for this video. Sync them from the
                video&apos;s Comments tab first.
              </div>
            ) : (
              <ul className="space-y-0.5">
                {entry.comments
                  .filter(
                    (c) =>
                      !q ||
                      c.text.toLowerCase().includes(q) ||
                      (c.author ?? "").toLowerCase().includes(q)
                  )
                  .map((c) => (
                    <CommentRowButton
                      key={c.id}
                      comment={c}
                      attached={alreadyAttachedIds.has(c.id)}
                      onPick={onPick}
                    />
                  ))}
              </ul>
            )}
          </div>
        );
      })}

      {totalLoaded === 0 &&
        attachedVideos.every(
          (v) => byVideo[v.id] && byVideo[v.id] !== "loading"
        ) && (
          <div className="py-2 text-center text-[11px] text-muted-foreground">
            Nothing to pin — but that&apos;s fine, the AI still has the
            video context.
          </div>
        )}
    </div>
  );
}

function CommentRowButton({
  comment: c,
  attached,
  onPick,
}: {
  comment: CommentRow;
  attached: boolean;
  onPick: (ref: AttachmentRef) => void;
}) {
  const { t } = useI18n();
  const preview = c.text.replace(/\s+/g, " ").trim().slice(0, 80);
  const chipTitle = `${c.author ?? "?"}: ${preview}${c.text.length > 80 ? "…" : ""}`;
  return (
    <li>
      <button
        type="button"
        disabled={attached}
        onClick={() =>
          onPick({ type: "comment", id: c.id, title: chipTitle, thumbnail: null })
        }
        className={cn(
          "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors",
          attached ? "cursor-not-allowed opacity-50" : "hover:bg-accent"
        )}
      >
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="font-medium text-foreground">{c.author ?? "?"}</span>
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <ThumbsUp className="h-2.5 w-2.5" />
              {fmt(c.like_count)}
            </span>
            {c.reply_count > 0 && (
              <span className="text-muted-foreground">
                {c.reply_count} {c.reply_count === 1 ? "reply" : "replies"}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-foreground">
            {c.text}
          </p>
        </div>
        {attached && (
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {t.attachPicker.added}
          </span>
        )}
      </button>
    </li>
  );
}

/** The chip shown above the chat input once an item is attached. */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: AttachmentRef;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-border bg-background py-0.5 pl-1 pr-1.5 text-xs">
      {attachment.type === "image" && attachment.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.thumbnail}
          alt=""
          className="h-5 w-5 shrink-0 rounded-sm object-cover"
        />
      ) : attachment.type === "image" ? (
        <ImageIcon className="h-3 w-3 text-muted-foreground" />
      ) : attachment.type === "video" && attachment.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.thumbnail}
          alt=""
          className="h-5 w-8 shrink-0 rounded-sm object-cover"
          referrerPolicy="no-referrer"
        />
      ) : attachment.type === "video" ? (
        <PlaySquare className="h-3 w-3 text-muted-foreground" />
      ) : (
        <MessageCircle className="h-3 w-3 text-muted-foreground" />
      )}
      <span className="truncate">{attachment.title}</span>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
