"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Search,
  ScanText,
  Sparkles,
  AlertCircle,
  X,
  Plug,
  Download,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SyncChannelButton } from "@/components/sync-channel-button";
import { cn } from "@/lib/utils";
import type { IdeationVideo } from "@/app/api/ideation/videos/route";

/**
 * Videos tab of the Ideation hub — a command-center table over the
 * active channel's videos. Everything below the header (search,
 * category, min-views, sort) is a client-side filter/sort over the
 * rows already loaded from /api/ideation/videos; there's no per-filter
 * round trip because 1000 rows is small enough to slice in the browser
 * and it keeps every control instantly responsive.
 */

type Sort = "newest" | "views" | "vph";

const MILESTONE_LABEL: Record<number, string> = {
  1_000_000: "1M",
  500_000: "500K",
  250_000: "250K",
  100_000: "100K",
};

function fmtCompact(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtVph(n: number | null): string {
  if (n === null) return "—";
  return Math.round(n).toLocaleString();
}

function fmtRelative(ts: number | null): string {
  if (!ts) return "—";
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 0) return "just now";
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  const days = Math.floor(sec / 86400);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function fmtDuration(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function VideosTab() {
  const [videos, setVideos] = useState<IdeationVideo[] | null>(null);
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters — all client-side over the loaded rows.
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [minViews, setMinViews] = useState("");
  const [sort, setSort] = useState<Sort>("newest");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/ideation/videos", { cache: "no-store" });
      const d = (await r.json()) as {
        videos: IdeationVideo[];
        categories: { category: string; count: number }[];
      };
      setVideos(d.videos);
      setCategories(d.categories);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Optimistic per-row category update — flips the row locally right
  // away, PATCHes in the background. Errors just leave the row as-is;
  // a manual refresh() would pick up the true server state if needed.
  const updateCategory = useCallback((videoId: string, newCategory: string | null) => {
    setVideos((prev) =>
      prev
        ? prev.map((v) => (v.id === videoId ? { ...v, category: newCategory } : v))
        : prev
    );
    // Brand-new category (typed via the "+ New category…" prompt) — add it
    // to the shared list now so every row's dropdown offers it right away,
    // instead of waiting on a full refresh().
    if (newCategory) {
      setCategories((prev) =>
        prev.some((c) => c.category === newCategory)
          ? prev
          : [...prev, { category: newCategory, count: 1 }]
      );
    }
    fetch(`/api/videos/${videoId}/category`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: newCategory }),
    }).catch(() => {
      /* optimistic — a background refresh would reconcile if this fails */
    });
  }, []);

  const filtered = useMemo(() => {
    if (!videos) return [];
    const needle = q.trim().toLowerCase();
    const minViewsNum = minViews.trim() ? Number(minViews) : null;
    let rows = videos.filter((v) => {
      if (needle) {
        const inTitle = v.title.toLowerCase().includes(needle);
        const inThumb = (v.thumbnail_text ?? "").toLowerCase().includes(needle);
        if (!inTitle && !inThumb) return false;
      }
      if (category !== "all") {
        if (category === "__none__") {
          if (v.category) return false;
        } else if (v.category !== category) {
          return false;
        }
      }
      if (minViewsNum !== null && !Number.isNaN(minViewsNum)) {
        if ((v.views ?? 0) < minViewsNum) return false;
      }
      return true;
    });
    rows = [...rows].sort((a, b) => {
      if (sort === "views") return (b.views ?? 0) - (a.views ?? 0);
      if (sort === "vph") return (b.vph ?? -1) - (a.vph ?? -1);
      // newest
      return (b.published_at ?? 0) - (a.published_at ?? 0);
    });
    return rows;
  }, [videos, q, category, minViews, sort]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-destructive">
          Failed to load videos: {loadError}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <VideosHeader onSynced={refresh} onCategorized={refresh} />

      {videos && videos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="text-sm text-muted-foreground">
              No videos yet for this channel. Connect a channel and sync it
              to populate the idea pipeline.
            </div>
            <Link href="/integrations">
              <Button size="sm" className="gap-2">
                <Plug className="h-4 w-4" />
                Go to Integrations
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <FiltersRow
            q={q}
            onQ={setQ}
            category={category}
            onCategory={setCategory}
            categories={categories}
            minViews={minViews}
            onMinViews={setMinViews}
            sort={sort}
            onSort={setSort}
          />

          <p className="text-xs text-muted-foreground">
            {filtered.length} of {videos?.length ?? 0} videos
          </p>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-sm">
                  <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Thumbnail</th>
                      <th className="px-3 py-2 text-left">Title</th>
                      <th className="px-3 py-2 text-left">Thumb text</th>
                      <th className="px-3 py-2 text-left">Category</th>
                      <th className="px-3 py-2 text-right">Views</th>
                      <th className="px-3 py-2 text-right">VPH</th>
                      <th className="px-3 py-2 text-right">Published</th>
                      <th className="px-3 py-2 text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((v) => (
                      <VideoRow
                        key={v.id}
                        video={v}
                        categories={categories}
                        onCategoryChange={(c) => updateCategory(v.id, c)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function VideoRow({
  video: v,
  categories,
  onCategoryChange,
}: {
  video: IdeationVideo;
  categories: { category: string; count: number }[];
  onCategoryChange: (category: string | null) => void;
}) {
  const milestoneLabel = v.milestone ? MILESTONE_LABEL[v.milestone] : null;
  return (
    <tr className="border-b border-border/60 hover:bg-accent/30">
      <td className="px-3 py-2">
        {v.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={v.thumbnail_url}
            alt=""
            className="h-14 w-24 rounded object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="h-14 w-24 rounded bg-muted" />
        )}
      </td>
      <td className="max-w-[280px] px-3 py-2 align-top">
        <Link
          href={`/videos/${v.id}`}
          className="line-clamp-2 text-sm font-medium leading-snug hover:text-primary hover:underline"
          title={v.title}
        >
          {v.title}
        </Link>
        {milestoneLabel && (
          <span className="ml-1.5 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-amber-700 dark:text-amber-400">
            {milestoneLabel}
          </span>
        )}
      </td>
      <td
        className="max-w-[220px] truncate px-3 py-2 text-xs text-muted-foreground"
        title={v.thumbnail_text ?? undefined}
      >
        {v.thumbnail_text
          ? v.thumbnail_text.length > 60
            ? `${v.thumbnail_text.slice(0, 60)}…`
            : v.thumbnail_text
          : "—"}
      </td>
      <td className="px-3 py-2">
        <select
          value={v.category ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "__new__") {
              const name = window.prompt("New category name:");
              if (!name || !name.trim()) {
                e.target.value = v.category ?? "";
                return;
              }
              onCategoryChange(name.trim().slice(0, 40));
              return;
            }
            onCategoryChange(val || null);
          }}
          className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
        >
          <option value="">—</option>
          {categories.map((c) => (
            <option key={c.category} value={c.category}>
              {c.category}
            </option>
          ))}
          {v.category && !categories.some((c) => c.category === v.category) && (
            <option value={v.category}>{v.category}</option>
          )}
          <option value="__new__">+ New category…</option>
        </select>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(v.views)}</td>
      <td
        className="px-3 py-2 text-right tabular-nums text-muted-foreground"
        title="lifetime views per hour"
      >
        {fmtVph(v.vph)}
      </td>
      <td className="px-3 py-2 text-right text-xs text-muted-foreground">
        {fmtRelative(v.published_at)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {fmtDuration(v.duration_seconds)}
      </td>
    </tr>
  );
}

function FiltersRow({
  q,
  onQ,
  category,
  onCategory,
  categories,
  minViews,
  onMinViews,
  sort,
  onSort,
}: {
  q: string;
  onQ: (v: string) => void;
  category: string;
  onCategory: (v: string) => void;
  categories: { category: string; count: number }[];
  minViews: string;
  onMinViews: (v: string) => void;
  sort: Sort;
  onSort: (v: Sort) => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative max-w-xs flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search title or thumbnail text…"
          value={q}
          onChange={(e) => onQ(e.target.value)}
        />
      </div>
      <select
        value={category}
        onChange={(e) => onCategory(e.target.value)}
        className="h-9 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="all">All categories</option>
        <option value="__none__">Uncategorized</option>
        {categories.map((c) => (
          <option key={c.category} value={c.category}>
            {c.category} ({c.count})
          </option>
        ))}
      </select>
      <Input
        type="number"
        min={0}
        placeholder="Min views"
        value={minViews}
        onChange={(e) => onMinViews(e.target.value)}
        className="h-9 w-28 text-xs"
      />
      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as Sort)}
        className="h-9 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="newest">Newest</option>
        <option value="views">Views</option>
        <option value="vph">VPH</option>
      </select>
    </div>
  );
}

/** SSE progress state for the "Detect thumbnail text" (OCR) button. */
type OcrPhase =
  | { kind: "idle"; pending: number }
  | { kind: "running"; done: number; total: number }
  | { kind: "error"; message: string };

function VideosHeader({
  onSynced,
  onCategorized,
}: {
  onSynced: () => void;
  onCategorized: () => void;
}) {
  const [ocr, setOcr] = useState<OcrPhase>({ kind: "idle", pending: 0 });
  const [categorizing, setCategorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // YouTube API quota used today — fetched once on mount, purely
  // informational (subtle one-liner near the header controls).
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  useEffect(() => {
    fetch("/api/ideation/quota", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { used?: number; limit?: number }) =>
        setQuota({ used: d.used ?? 0, limit: d.limit ?? 10_000 })
      )
      .catch(() => {
        /* quota display is best-effort — leave it unset on failure */
      });
  }, []);

  const refreshOcrPending = useCallback(async () => {
    try {
      const r = await fetch("/api/videos/thumbnails-ocr", { cache: "no-store" });
      const d = (await r.json()) as { pending?: number };
      setOcr((prev) =>
        prev.kind === "running" ? prev : { kind: "idle", pending: d.pending ?? 0 }
      );
    } catch {
      /* keep current */
    }
  }, []);

  useEffect(() => {
    refreshOcrPending();
  }, [refreshOcrPending]);

  const runOcr = useCallback(async () => {
    setError(null);
    setOcr({ kind: "running", done: 0, total: 0 });
    try {
      const res = await fetch("/api/videos/thumbnails-ocr", { method: "POST" });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `OCR failed (HTTP ${res.status})`);
        await refreshOcrPending();
        return;
      }

      // Read the SSE stream — same idiom as SyncChannelButton: each event
      // is a `data: {...}\n\n` chunk.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          switch (event.type) {
            case "start":
              setOcr({ kind: "running", done: 0, total: Number(event.total ?? 0) });
              break;
            case "progress":
              setOcr({
                kind: "running",
                done: Number(event.done ?? 0),
                total: Number(event.total ?? 0),
              });
              break;
            case "done":
              onSynced(); // refresh the table with newly-OCR'd text
              break;
          }
        }
      }
      await refreshOcrPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OCR failed");
      await refreshOcrPending();
    }
  }, [onSynced, refreshOcrPending]);

  const runCategorize = useCallback(async () => {
    setError(null);
    setCategorizing(true);
    try {
      const r = await fetch("/api/videos/categorize", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) {
        setError(d.error ?? `Categorize failed (HTTP ${r.status})`);
        return;
      }
      onCategorized();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Categorize failed");
    } finally {
      setCategorizing(false);
    }
  }, [onCategorized]);

  const ocrRunning = ocr.kind === "running";
  const ocrPending = ocr.kind === "idle" ? ocr.pending : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {quota ? (
          <span className="text-[11px] text-muted-foreground">
            YouTube API today: {quota.used.toLocaleString()} / {quota.limit.toLocaleString()} units
          </span>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open("/api/ideation/export?format=csv", "_blank")}
            className="gap-1.5"
            title="Download the active channel's videos as CSV."
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open("/api/ideation/export?format=json", "_blank")}
            className="gap-1.5"
            title="Download the active channel's videos as JSON (full export for AI)."
          >
            <Download className="h-3.5 w-3.5" />
            Export JSON
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SyncChannelButton onSynced={onSynced} />
        <Button
          variant="outline"
          size="sm"
          onClick={runOcr}
          disabled={ocrRunning || ocrPending === 0}
          className="gap-1.5"
          title="OCR every video thumbnail missing cached text."
        >
          {ocrRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ScanText className="h-3.5 w-3.5" />
          )}
          {ocrRunning
            ? `OCR ${ocr.done}/${ocr.total}…`
            : `Detect thumbnail text (${ocrPending ?? 0} pending)`}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={runCategorize}
          disabled={categorizing}
          className="gap-1.5"
          title="Run AI content categorization across the channel's videos."
        >
          {categorizing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {categorizing ? "Categorizing…" : "Auto-categorize"}
        </Button>
      </div>
      {error && (
        <div className="flex items-start justify-end gap-1.5 text-right text-[11px] text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 hover:bg-destructive/10"
            aria-label="Dismiss error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
