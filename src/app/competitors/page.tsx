"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Search,
  Plus,
  RefreshCw,
  Trash2,
  Loader2,
  Users,
  AlertCircle,
  TrendingUp,
  Eye,
  ExternalLink,
  X,
  Check,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Competitor = {
  id: number;
  channel_id: string | null;
  handle: string | null;
  title: string | null;
  avatar_url: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  added_at: number;
  last_sync_at: number | null;
};

type Alert = {
  id: number;
  competitor_id: number;
  video_id: string;
  title: string | null;
  thumbnail_url: string | null;
  views: number | null;
  channel_median_views: number | null;
  multiplier: number | null;
  detected_at: number;
  read_at: number | null;
  competitor_title: string | null;
  competitor_handle: string | null;
};

type Gap = {
  word: string;
  competitorUses: number;
  competitorTotalViews: number;
  avgViews: number;
  exampleCompetitorTitle: string;
};

type Tab = "overview" | "gaps" | "alerts";

function fmtCount(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

export default function CompetitorsPage() {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [unread, setUnread] = useState(0);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/competitors", { cache: "no-store" });
      const d = (await r.json()) as { competitors: Competitor[]; unreadAlerts: number };
      setCompetitors(d.competitors);
      setUnread(d.unreadAlerts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAlerts = useCallback(async () => {
    try {
      const r = await fetch("/api/competitors/alerts?limit=100", {
        cache: "no-store",
      });
      const d = (await r.json()) as { alerts: Alert[] };
      setAlerts(d.alerts);
    } catch {
      /* keep current */
    }
  }, []);

  const refreshGaps = useCallback(async () => {
    try {
      const r = await fetch("/api/competitors/gaps?topN=30", { cache: "no-store" });
      const d = (await r.json()) as { gaps: Gap[] };
      setGaps(d.gaps);
    } catch {
      /* keep current */
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshAlerts();
    refreshGaps();
  }, [refresh, refreshAlerts, refreshGaps]);

  const addCompetitor = async () => {
    if (!identifier.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const r = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        syncError?: string;
      };
      if (!r.ok && !d.ok) {
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      setIdentifier("");
      // Surface a soft warning when the row was created but the first
      // sync failed (Apify down, bad handle, etc.) — user can hit
      // "Sync" manually to retry without re-adding.
      if (d.syncError) {
        setError(`Added, but first sync failed: ${d.syncError}`);
      }
      await refresh();
      await refreshAlerts();
      await refreshGaps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setAdding(false);
    }
  };

  const syncOne = async (id: number) => {
    setSyncingIds((prev) => new Set(prev).add(id));
    setError(null);
    try {
      const r = await fetch(`/api/competitors/${id}/sync`, { method: "POST" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      await refresh();
      await refreshAlerts();
      await refreshGaps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const syncAll = async () => {
    setSyncingAll(true);
    setError(null);
    const startedAt = Math.floor(Date.now() / 1000);
    try {
      const r = await fetch("/api/competitors/sync-all", { method: "POST" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      // The endpoint is fire-and-forget now — it returns instantly and
      // syncs competitors in the background. Poll the list every few
      // seconds so cards refresh as each competitor finishes. Stop once
      // every competitor's last_sync_at is newer than when we started,
      // or after a hard 3-minute ceiling so the button can't spin
      // forever if a competitor sync errors before stamping its time.
      const deadline = Date.now() + 3 * 60 * 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((res) => setTimeout(res, 4000));
        let list: { competitors: Competitor[]; unreadAlerts: number };
        try {
          const listRes = await fetch("/api/competitors", { cache: "no-store" });
          list = (await listRes.json()) as typeof list;
        } catch {
          if (Date.now() > deadline) break;
          continue;
        }
        setCompetitors(list.competitors);
        setUnread(list.unreadAlerts);
        refreshAlerts();
        refreshGaps();
        const allFresh =
          list.competitors.length > 0 &&
          list.competitors.every((c) => (c.last_sync_at ?? 0) >= startedAt);
        if (allFresh || Date.now() > deadline) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncingAll(false);
    }
  };

  const removeOne = async (id: number) => {
    if (!confirm("Remove this competitor and all its synced data?")) return;
    try {
      await fetch(`/api/competitors/${id}`, { method: "DELETE" });
      await refresh();
      await refreshAlerts();
      await refreshGaps();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  };

  const markAlertRead = async (id: number) => {
    await fetch(`/api/competitors/alerts/${id}/read`, { method: "POST" });
    await refreshAlerts();
    await refresh();
  };

  const totalSubs = useMemo(
    () => competitors.reduce((acc, c) => acc + (c.subscriber_count ?? 0), 0),
    [competitors]
  );
  const totalVideos = useMemo(
    () => competitors.reduce((acc, c) => acc + (c.video_count ?? 0), 0),
    [competitors]
  );
  const lastSync = useMemo(() => {
    const max = competitors.reduce(
      (acc, c) => (c.last_sync_at && c.last_sync_at > acc ? c.last_sync_at : acc),
      0
    );
    return max || null;
  }, [competitors]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Search className="h-6 w-6" />
            Competitor Tracking
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add rival channels, watch for viral hits in your niche, and find
            keywords you&apos;re missing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={syncAll}
            disabled={syncingAll || competitors.length === 0}
            className="gap-1.5"
          >
            {syncingAll ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync All
          </Button>
        </div>
      </header>

      {/* Unread alert nudge */}
      {unread > 0 && (
        <button
          type="button"
          onClick={() => setTab("alerts")}
          className="mb-4 flex w-full items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm hover:bg-amber-500/15"
        >
          <span className="inline-flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertCircle className="h-4 w-4" />
            {unread} unread {unread === 1 ? "alert" : "alerts"} — competitors hit
            viral views
          </span>
          <span className="text-xs text-amber-700/80 dark:text-amber-400/80">
            View →
          </span>
        </button>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-4 border-b border-border">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={tab === "gaps"} onClick={() => setTab("gaps")}>
          <TrendingUp className="h-3.5 w-3.5" />
          Gap Analysis
          {gaps.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
              {gaps.length}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === "alerts"} onClick={() => setTab("alerts")}>
          Alerts
          {unread > 0 && (
            <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              {unread}
            </span>
          )}
        </TabButton>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* ===== OVERVIEW ===== */}
      {tab === "overview" && (
        <div className="space-y-4">
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
              icon={Users}
              label="Competitors"
              value={String(competitors.length)}
            />
            <Kpi
              icon={Eye}
              label="Combined subs"
              value={fmtCount(totalSubs)}
            />
            <Kpi
              icon={TrendingUp}
              label="Videos tracked"
              value={fmtCount(totalVideos)}
            />
            <Kpi
              icon={RefreshCw}
              label="Last sync"
              value={fmtRelative(lastSync)}
            />
          </div>

          {/* Add competitor */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              <Plus className="h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="@handle, channel URL, or UCxxxx..."
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={adding}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !adding) addCompetitor();
                }}
                className="min-w-[260px] flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <Button
                onClick={addCompetitor}
                disabled={adding || !identifier.trim()}
                size="sm"
                className="gap-1.5"
              >
                {adding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Add Competitor
              </Button>
            </CardContent>
          </Card>

          {/* Competitor cards */}
          {competitors.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No competitors yet. Add one above to start tracking.
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {competitors.map((c) => (
                <CompetitorCard
                  key={c.id}
                  competitor={c}
                  syncing={syncingIds.has(c.id)}
                  onSync={() => syncOne(c.id)}
                  onRemove={() => removeOne(c.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== GAP ANALYSIS ===== */}
      {tab === "gaps" && (
        <Card>
          <CardContent className="p-4">
            {/* High-visibility "what is this tab" explainer. Vlad's
                feedback: nobody figures out Gap Analysis from the column
                headings alone. */}
            <div className="mb-4 flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <div className="font-medium">What is Gap Analysis?</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Keywords that competitors are getting views on but you&apos;ve
                  never used in any of your titles. The longer the bar / higher
                  the total views, the stronger the evidence that this word
                  pulls traffic in your niche. Use the list as a shopping list
                  for your next titles.
                </div>
              </div>
            </div>
            {gaps.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {competitors.length === 0 ? (
                  // Genuinely no competitors yet.
                  <>
                    No competitors tracked yet. Add at least one rival channel
                    on the Overview tab and sync it — this fills with keywords
                    you&apos;re missing.
                  </>
                ) : (
                  // Competitors exist, but the analysis produced nothing.
                  // Either their titles overlap yours heavily (common when a
                  // competitor is in the exact same niche) or there's only
                  // one competitor so no word clears the "used by ≥2 videos"
                  // bar. Be honest about it instead of telling them to add a
                  // competitor they already added.
                  <>
                    No keyword gaps surfaced. Your {competitors.length}{" "}
                    tracked competitor
                    {competitors.length === 1 ? "" : "s"} either use the same
                    title words you already do, or haven&apos;t been synced
                    recently. Hit <strong>Sync All</strong> to refresh them,
                    and add 2-3 more rival channels — more competitors = more
                    distinct keywords to compare against.
                  </>
                )}
              </div>
            ) : (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  Words that appear in your competitors&apos; TOP videos but{" "}
                  <strong>not in any of yours</strong>. Sorted by aggregate
                  views — the bigger the bar, the more proof the keyword
                  pulls in your niche.
                </p>
                <ul className="space-y-1">
                  {gaps.map((g) => (
                    <li
                      key={g.word}
                      className="flex flex-wrap items-center gap-3 rounded-md border border-border/70 p-3"
                    >
                      <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-sm font-medium text-primary">
                        {g.word}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        appears in{" "}
                        <strong className="text-foreground">
                          {g.competitorUses}
                        </strong>{" "}
                        competitor videos · avg{" "}
                        <strong className="text-foreground">
                          {fmtCount(g.avgViews)}
                        </strong>{" "}
                        views · total{" "}
                        <strong className="text-foreground">
                          {fmtCount(g.competitorTotalViews)}
                        </strong>
                      </span>
                      <span className="w-full truncate text-[11px] italic text-muted-foreground">
                        e.g. &ldquo;{g.exampleCompetitorTitle}&rdquo;
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ===== ALERTS ===== */}
      {tab === "alerts" && (
        <Card>
          <CardContent className="p-4">
            {/* "What are these alerts?" callout. Vlad's feedback:
                "Allorts це коли outlier появляється?" — yes, exactly,
                but you wouldn't know that from the empty state alone. */}
            <div className="mb-4 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <div className="font-medium">What are these alerts?</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Whenever a tracked competitor uploads a video that goes
                  &ge;2× their own typical view count, it lands here as an
                  &quot;outlier&quot;. These are the leading indicators of a
                  trend or a working hook in your niche — open the video, see
                  what they did differently, steal the format.
                </div>
              </div>
            </div>
            {alerts.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No viral alerts yet. They appear automatically when a tracked
                competitor&apos;s video crosses 2× their median views.
              </div>
            ) : (
              <ul className="space-y-2">
                {alerts.map((a) => {
                  const ytUrl = `https://www.youtube.com/watch?v=${a.video_id}`;
                  return (
                    <li
                      key={a.id}
                      className={cn(
                        "flex flex-wrap items-start gap-3 rounded-md border p-3",
                        a.read_at
                          ? "border-border bg-background"
                          : "border-amber-500/40 bg-amber-500/5"
                      )}
                    >
                      {a.thumbnail_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={a.thumbnail_url}
                          alt=""
                          className="h-16 w-28 shrink-0 rounded object-cover"
                          referrerPolicy="no-referrer"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <a
                          href={ytUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                        >
                          {a.title ?? "(untitled)"}
                          <ExternalLink className="h-3 w-3 opacity-60" />
                        </a>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            <strong className="text-foreground">
                              {a.competitor_title ?? a.competitor_handle ?? "?"}
                            </strong>
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Eye className="h-3 w-3" />
                            {fmtCount(a.views)} views
                          </span>
                          {a.multiplier && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono font-medium text-amber-700 dark:text-amber-400">
                              {a.multiplier.toFixed(1)}× median
                            </span>
                          )}
                          <span>· {fmtRelative(a.detected_at)}</span>
                        </div>
                      </div>
                      {!a.read_at && (
                        <button
                          type="button"
                          onClick={() => markAlertRead(a.id)}
                          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label="Mark read"
                          title="Mark read"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Footnote pointing to /integrations. Backend: YouTube Data
          API primary, Apify only as a fallback when no YT key is set
          (or quota is exhausted). The old footer claimed "uses your
          Apify integration" which is no longer accurate. */}
      <p className="mt-6 text-center text-[11px] text-muted-foreground">
        Competitor sync uses your{" "}
        <Link href="/integrations" className="text-primary hover:underline">
          YouTube Data API key
        </Link>{" "}
        (Apify is only a fallback if you haven&apos;t configured one). Gap
        analysis and alerts keep working on already-synced data even if a
        future sync fails.
      </p>
    </div>
  );
}

function TabButton({
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
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="truncate text-base font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function CompetitorCard({
  competitor,
  syncing,
  onSync,
  onRemove,
}: {
  competitor: Competitor;
  syncing: boolean;
  onSync: () => void;
  onRemove: () => void;
}) {
  const initial = (competitor.title ?? competitor.handle ?? "?").slice(0, 1).toUpperCase();
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {competitor.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={competitor.avatar_url}
              alt=""
              className="h-10 w-10 shrink-0 rounded-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
              {initial}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              {competitor.title ?? "(syncing…)"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {competitor.handle ?? competitor.channel_id ?? "—"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onSync}
              disabled={syncing}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              title="Sync now"
              aria-label="Sync"
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Remove"
              aria-label="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Subs
            </div>
            <div className="font-semibold">
              {fmtCount(competitor.subscriber_count)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Videos
            </div>
            <div className="font-semibold">
              {fmtCount(competitor.video_count)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Synced
            </div>
            <div className="font-semibold">
              {fmtRelative(competitor.last_sync_at)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
