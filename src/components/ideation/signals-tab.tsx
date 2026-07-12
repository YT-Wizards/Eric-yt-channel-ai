"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Flame,
  Loader2,
  Plug,
  Radar,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AudienceRequest, FreshOutlier } from "@/app/api/signals/route";

/**
 * Signals tab of the Ideation hub — one actionable feed answering
 * "what should I make next, based on data". Four sections: three are
 * sourced from /api/signals (itself scoped to the active channel) —
 * competitor outliers worth reacting to, content gaps competitors
 * cover and this channel doesn't, and audience requests mined out of
 * comment analysis — plus Niche Watch, which fetches independently
 * from /api/niche-watch (user-defined search phrases scanned for
 * fresh, hot videos). Every row can either generate 3 grounded title
 * variants (via /api/signals/generate-title) or go straight to the
 * idea board (via /api/ideas).
 *
 * Universal by construction: nothing here hardcodes a topic, word, or
 * niche — every string rendered comes from the API response, which is
 * itself derived entirely from the channel's own data.
 */

type Gap = {
  word: string;
  competitorUses: number;
  competitorTotalViews: number;
  avgViews: number;
  exampleCompetitorTitle: string;
};

type SignalsResponse = {
  freshOutliers: FreshOutlier[];
  gaps: Gap[];
  audienceRequests: AudienceRequest[];
};

/** A configured watch niche for the active channel — mirrors
 * WatchNicheSummary in src/lib/db.ts as returned by GET /api/niche-watch.
 * Redefined locally (rather than imported) so this file never pulls in
 * db.ts's "server-only" module graph — same reasoning as the job types
 * below. */
type WatchNiche = {
  id: number;
  query: string;
  created_at: number;
  hitCount: number;
};

/** A single ranked "trending in my niche right now" hit — mirrors
 * NicheHit in src/lib/db.ts as returned by GET /api/niche-watch. */
type NicheHit = {
  nicheId: number;
  nicheQuery: string;
  videoId: string;
  title: string | null;
  channelTitle: string | null;
  views: number | null;
  publishedAt: number | null;
  vph: number | null;
  firstSeenAt: number;
};

/** Server-side job state for the niche-watch scan batch — mirrors the
 * shape POSTed/GETed from /api/niche-watch/scan (same settings-backed
 * job pattern as the OCR/categorize/sync-all jobs elsewhere in the app:
 * the scan keeps running server-side regardless of who's watching, this
 * type just describes what a poller reads back). */
type NicheScanJob = {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  found: number;
  startedAt: number;
  finishedAt?: number;
  lastError?: string | null;
};

function fmtCompact(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function demandChipClass(demand: "high" | "medium" | "low"): string {
  if (demand === "high") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  if (demand === "medium") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// Days above which a competitor outlier is treated as "old but still a
// proven hit" rather than a live spike — see PROVEN_HIT_DAYS usage below.
const PROVEN_HIT_DAYS = 30;

/**
 * Human-friendly "how long ago" for a video's own publish date — mirrors
 * the `fmtRelative` idiom in src/app/videos/page.tsx, but (unlike that
 * one) never returns null for old videos: a competitor outlier that's
 * months old is exactly the case this feature needs to label clearly
 * ("video: 8mo ago"), not hide.
 */
function fmtVideoAge(publishedAt: number | null): string | null {
  if (!publishedAt) return null;
  const sec = Math.floor(Date.now() / 1000) - publishedAt;
  if (sec < 0) return null;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  const days = Math.floor(sec / 86400);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** True once a video is old enough that the outlier is historical
 * reference material rather than a current spike (see OutlierRow). */
function isProvenHit(publishedAt: number | null): boolean {
  if (!publishedAt) return false;
  const days = (Date.now() / 1000 - publishedAt) / 86400;
  return days > PROVEN_HIT_DAYS;
}

// Mirrors MAX_WATCH_NICHES_PER_CHANNEL in src/lib/db.ts — not exported
// from there, so kept in sync here as a plain literal.
const MAX_WATCH_NICHES = 6;

// Poll cadence + staleness window for the niche-watch scan job — same
// values/idiom as SYNC_JOB_POLL_MS / SYNC_JOB_STALE_MS in
// src/app/competitors/page.tsx (which itself mirrors the server's own
// STALE_JOB_MS in scan/route.ts).
const SCAN_JOB_POLL_MS = 3000;
const SCAN_JOB_STALE_MS = 2 * 60 * 60 * 1000;

// "Fresh enough, no need to auto-scan again yet" window used by
// NicheWatchSection's auto-freshness effect below.
const AUTO_SCAN_FRESH_MS = 12 * 60 * 60 * 1000;

/** Truncates a niche query for the "Scanning N/M — {current}…" label —
 * same idiom as truncateCurrent in src/app/competitors/page.tsx. */
function truncateNiche(query: string): string {
  return query.length > 18 ? `${query.slice(0, 18)}…` : query;
}

/** Same rounding/formatting as fmtVph in
 * src/components/ideation/videos-tab.tsx, redefined locally since that
 * one isn't exported. */
function fmtVph(n: number | null): string {
  if (n === null) return "—";
  return Math.round(n).toLocaleString();
}

/** Median of a numeric list — used by NicheWatchSection to flag hits
 * whose vph is "exploding" (>= 3x the median of the hits shown). */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** What "→ Ideas" needs to build the /api/ideas POST body. Kept generic
 * across every signal kind so one button component + one submit
 * function handles every row. */
type IdeaDraft = {
  title: string;
  notes: string;
  demand?: "high" | "medium" | "low";
  source_type: "competitor_alert" | "gap" | "comment";
  source_ref: unknown;
};

export function SignalsTab() {
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [noActiveChannel, setNoActiveChannel] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/signals", { cache: "no-store" });
      if (r.status === 400) {
        setNoActiveChannel(true);
        setLoadError(null);
        return;
      }
      const d = (await r.json()) as SignalsResponse & { error?: string };
      if (!r.ok) {
        setLoadError(d.error ?? `Failed to load (HTTP ${r.status})`);
        return;
      }
      setNoActiveChannel(false);
      setLoadError(null);
      setData(d);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (noActiveChannel) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Radar className="h-6 w-6" />
          </div>
          <h2 className="text-base font-semibold">No active channel</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Connect and select a channel to see data-driven signals for it.
          </p>
          <Link href="/integrations">
            <Button size="sm" className="gap-2">
              <Plug className="h-4 w-4" />
              Go to Integrations
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-destructive">
          Failed to load signals: {loadError}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing} className="gap-1.5">
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      <NicheWatchSection />
      <OutliersSection outliers={data?.freshOutliers ?? []} />
      <GapsSection gaps={data?.gaps ?? []} />
      <AudienceSection requests={data?.audienceRequests ?? []} />
    </div>
  );
}

/* ============================================================
 * Section 0 — Niche watch (broadest signal, placed above outliers).
 * User-defined search phrases scanned for videos from the last 7 days,
 * ranked by views-per-hour. Fetches independently of /api/signals (its
 * own GET /api/niche-watch), so it has its own loading/error state
 * rather than sharing SignalsTab's.
 * ============================================================ */

function NicheWatchSection() {
  const [niches, setNiches] = useState<WatchNiche[]>([]);
  const [hits, setHits] = useState<NicheHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [chipError, setChipError] = useState<string | null>(null);

  const [job, setJob] = useState<NicheScanJob | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanFlash, setScanFlash] = useState<string | null>(null);

  // Guards the auto-freshness effect further down so it fires at most
  // once per mount, even though its own dependencies (job, hits) change
  // as the scan it kicks off runs and updates state.
  const autoScanFired = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/niche-watch", { cache: "no-store" });
      if (r.status === 400) {
        // SignalsTab's own noActiveChannel screen already gates this
        // whole section behind an active-channel check (it returns
        // early, before any section — including this one — ever
        // renders). This branch is just a defensive no-op for the rare
        // race of the active channel changing after mount.
        setNiches([]);
        setHits([]);
        return;
      }
      const d = (await r.json()) as {
        niches?: WatchNiche[];
        hits?: NicheHit[];
        error?: string;
      };
      if (!r.ok) {
        setLoadError(d.error ?? `Failed to load (HTTP ${r.status})`);
        return;
      }
      setLoadError(null);
      setNiches(d.niches ?? []);
      setHits(d.hits ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  const refreshJob = useCallback(async () => {
    try {
      const r = await fetch("/api/niche-watch/scan", { cache: "no-store" });
      const d = (await r.json()) as { job?: NicheScanJob | null };
      setJob(d.job ?? null);
    } catch {
      /* keep current */
    }
  }, []);

  // Mount-time: load niches/hits plus whatever scan job state already
  // exists server-side — e.g. the user navigated away mid-scan and came
  // back, or reloaded the page. If a job is running, the poll effect
  // below (keyed on job?.running) resumes showing progress from here;
  // the server never stopped working regardless of who was watching.
  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([refresh(), refreshJob()]);
      setLoading(false);
    })();
  }, [refresh, refreshJob]);

  // While a scan is running, poll its GET every few seconds — same
  // idiom as the SyncAllJob poller in src/app/competitors/page.tsx. A
  // job stuck "running" past SCAN_JOB_STALE_MS is treated as dead
  // (process restarted mid-run) so this never polls forever.
  useEffect(() => {
    if (!job?.running) return;
    if (Date.now() - job.startedAt >= SCAN_JOB_STALE_MS) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/niche-watch/scan", { cache: "no-store" });
        const d = (await r.json()) as { job?: NicheScanJob | null };
        if (cancelled) return;
        setJob(d.job ?? null);
        if (d.job && !d.job.running) {
          await refresh(); // pick up whatever hits the scan just found
          setScanFlash(`found ${d.job.found}`);
          if (d.job.lastError) setScanError(d.job.lastError);
        }
      } catch {
        /* transient */
      }
    };
    const id = window.setInterval(tick, SCAN_JOB_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job?.running, job?.startedAt, refresh]);

  const runScan = useCallback(async () => {
    setScanError(null);
    setScanFlash(null);
    try {
      const r = await fetch("/api/niche-watch/scan", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as {
        error?: string;
        started?: boolean;
        total?: number;
      };
      if (r.status === 409) {
        // Already running (auto-freshness, another tab, or a click that
        // landed just before this one) — just start polling for it.
        await refreshJob();
        return;
      }
      if (!r.ok || !d.started) {
        setScanError(d.error ?? `Scan failed (HTTP ${r.status})`);
        return;
      }
      // Optimistic — the poll effect above (keyed on job?.running) takes
      // over from here, same idiom as Sync All / OCR elsewhere.
      setJob({
        running: true,
        done: 0,
        total: d.total ?? niches.length,
        current: null,
        found: 0,
        startedAt: Date.now(),
      });
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Scan failed");
    }
  }, [refreshJob, niches.length]);

  // Auto-freshness: there's no real background scheduler in this app
  // yet, so a visit to the Signals tab substitutes for one — once the
  // initial fetches resolve, if niches are configured, nothing is
  // already running, and everything looks stale (no hit first-seen and
  // no scan finished within AUTO_SCAN_FRESH_MS), kick a scan through the
  // exact same runScan() path as clicking "Scan now". autoScanFired
  // caps this at once per mount regardless of how often the effect's
  // own dependencies (job, hits) subsequently change.
  useEffect(() => {
    if (loading) return;
    if (autoScanFired.current) return;
    if (niches.length === 0) return;
    if (job?.running) return;

    const jobFresh =
      job !== null &&
      job.finishedAt !== undefined &&
      Date.now() - job.finishedAt < AUTO_SCAN_FRESH_MS;
    const hitCutoffSec = Math.floor((Date.now() - AUTO_SCAN_FRESH_MS) / 1000);
    const hitFresh = hits.some((h) => h.firstSeenAt > hitCutoffSec);
    if (jobFresh || hitFresh) return;

    autoScanFired.current = true;
    runScan();
  }, [loading, niches.length, job, hits, runScan]);

  const removeNiche = useCallback(
    async (id: number) => {
      setChipError(null);
      const removedNiche = niches.find((n) => n.id === id);
      const removedHits = hits.filter((h) => h.nicheId === id);
      // Optimistic — splice the niche (and its hits) out immediately,
      // put them back plus an inline error if the DELETE fails. Same
      // idiom as DismissAlertButton further down this file.
      setNiches((prev) => prev.filter((n) => n.id !== id));
      setHits((prev) => prev.filter((h) => h.nicheId !== id));
      try {
        const r = await fetch(`/api/niche-watch/${id}`, { method: "DELETE" });
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? `Failed (HTTP ${r.status})`);
        }
      } catch (e) {
        if (removedNiche) setNiches((prev) => [...prev, removedNiche]);
        setHits((prev) => [...prev, ...removedHits]);
        setChipError(e instanceof Error ? e.message : "Failed to remove niche");
      }
    },
    [niches, hits]
  );

  const submitAdd = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setAdding(true);
    setAddError(null);
    try {
      const r = await fetch("/api/niche-watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setAddError(d.error ?? `Failed (HTTP ${r.status})`);
        return;
      }
      setQuery("");
      // The POST response only echoes the raw niche row (no hitCount) —
      // simplest to just re-fetch the summary list rather than patch it
      // together locally.
      await refresh();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add niche");
    } finally {
      setAdding(false);
    }
  }, [query, refresh]);

  // Top 15 by vph — the API already returns hits ORDER BY vph DESC, so
  // this is purely a display cap, not a re-sort.
  const topHits = useMemo(() => hits.slice(0, 15), [hits]);

  // "Exploding" = vph at least 3x the median vph of the hits actually
  // shown. Guarded to n >= 3 (and a positive median) so a 1-2 hit list —
  // or a degenerate all-zero one — never trivially flags every row.
  const medianVph = useMemo(
    () => median(topHits.map((h) => h.vph).filter((v): v is number => v !== null)),
    [topHits]
  );
  const explodingEnabled = topHits.length >= 3 && medianVph > 0;

  const scanRunning =
    job !== null && job.running && Date.now() - job.startedAt < SCAN_JOB_STALE_MS;
  const scanLabel = `Scanning ${job?.done ?? 0}/${job?.total ?? 0}${
    job?.current ? ` — ${truncateNiche(job.current)}` : "…"
  }`;

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Radar className="h-4 w-4 text-sky-500" />
          Niche watch
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {hits.length}
          </span>
        </CardTitle>
        <CardDescription className="text-[11px]">
          Each scan ≈ 100 API units per niche.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {loadError && <p className="text-xs text-destructive">{loadError}</p>}

        <div className="flex flex-wrap items-center gap-1.5">
          {niches.map((n) => (
            <NicheChip key={n.id} niche={n} onRemove={() => removeNiche(n.id)} />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {niches.length < MAX_WATCH_NICHES ? (
            <>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitAdd();
                  }
                }}
                placeholder="Add a niche to watch — e.g. 'space documentary'"
                disabled={adding}
                className="h-8 w-72 max-w-full text-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={submitAdd}
                disabled={adding || !query.trim()}
                className="gap-1.5"
              >
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {niches.length}/{MAX_WATCH_NICHES}
            </span>
          )}
        </div>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
        {chipError && <p className="text-xs text-destructive">{chipError}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={runScan}
            disabled={scanRunning}
            className="gap-1.5"
          >
            {scanRunning && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {scanRunning ? scanLabel : "Scan now"}
          </Button>
          {scanFlash && (
            <span className="text-xs text-muted-foreground">{scanFlash}</span>
          )}
        </div>
        {(scanError ?? job?.lastError) && (
          <p className="text-xs text-destructive">{scanError ?? job?.lastError}</p>
        )}

        {niches.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Watch niches are search phrases the app scans every visit (12h
            cadence) for videos exploding right now — add up to 6.
          </p>
        ) : topHits.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No hits yet — run a scan.
          </p>
        ) : (
          <div className="space-y-1">
            {topHits.map((h) => (
              <NicheHitRow
                key={`${h.nicheId}-${h.videoId}`}
                hit={h}
                exploding={explodingEnabled && (h.vph ?? 0) >= medianVph * 3}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NicheChip({
  niche,
  onRemove,
}: {
  niche: WatchNiche;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs">
      {niche.query} ({niche.hitCount})
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
        aria-label={`Remove niche "${niche.query}"`}
        title="Remove niche"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function NicheHitRow({
  hit: h,
  exploding,
}: {
  hit: NicheHit;
  exploding: boolean;
}) {
  const videoAge = fmtVideoAge(h.publishedAt);
  const channel = h.channelTitle ?? "Unknown channel";
  const draft: IdeaDraft = {
    title: h.title ?? "Untitled video",
    notes: `Niche watch "${h.nicheQuery}" · ${channel} · ${fmtCompact(
      h.views
    )} views · ${fmtVph(h.vph)}/h`,
    source_type: "competitor_alert",
    source_ref: h,
  };

  return (
    <SignalRow
      draft={draft}
      generateType="fresh_outlier"
      generateSignal={{
        title: h.title,
        competitor: h.channelTitle,
        views: h.views,
        kind: "niche",
        vph: h.vph,
        niche: h.nicheQuery,
      }}
    >
      <div className="min-w-0 flex-1">
        <a
          href={youtubeUrl(h.videoId)}
          target="_blank"
          rel="noreferrer"
          className="line-clamp-2 text-sm font-medium leading-snug hover:text-primary hover:underline"
        >
          {h.title ?? "Untitled video"}
        </a>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {h.nicheQuery} · {channel} · {fmtCompact(h.views)} views ·{" "}
          {fmtVph(h.vph)}/h
          {videoAge && ` · video: ${videoAge}`}
        </p>
        {exploding && (
          <span
            className="mt-1 inline-flex w-fit items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
            title="Views-per-hour is at least 3x the median of the hits shown"
          >
            <Flame className="h-2.5 w-2.5" />
            exploding
          </span>
        )}
      </div>
    </SignalRow>
  );
}

/* ============================================================
 * Section 1 — Competitor outliers
 * ============================================================ */

function OutliersSection({ outliers }: { outliers: FreshOutlier[] }) {
  // Local copy so a dismissed alert can be spliced out immediately
  // (optimistic UI) without waiting on a full /api/signals refetch.
  // Re-synced from props whenever the parent reloads (e.g. Refresh
  // button, or the initial load resolving).
  const [rows, setRows] = useState(outliers);
  useEffect(() => setRows(outliers), [outliers]);

  const removeRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const restoreRow = useCallback((row: FreshOutlier) => {
    // Put it back in roughly the same place rather than always at the
    // end — cheap approximation: re-sort by the same "fresh first, then
    // detected_at desc" key the API already sorts by isn't worth
    // re-deriving here, so just re-insert and let the next Refresh
    // reconcile exact ordering.
    setRows((prev) => [...prev, row]);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Flame className="h-4 w-4 text-orange-500" />
          Competitor outliers
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {rows.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No competitor outliers detected yet. Add competitors and sync them to
            start catching viral hits.
          </p>
        ) : (
          rows.map((o) => (
            <OutlierRow
              key={o.id}
              outlier={o}
              onDismissed={() => removeRow(o.id)}
              onDismissFailed={() => restoreRow(o)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function OutlierRow({
  outlier: o,
  onDismissed,
  onDismissFailed,
}: {
  outlier: FreshOutlier;
  onDismissed: () => void;
  onDismissFailed: () => void;
}) {
  const videoAge = fmtVideoAge(o.publishedAt);
  const provenHit = isProvenHit(o.publishedAt);
  const draft: IdeaDraft = {
    title: o.title ?? "Untitled competitor video",
    notes: `Competitor outlier${o.competitor ? ` from ${o.competitor}` : ""} · ${fmtCompact(
      o.views
    )} views${
      o.kind === "fresh" && o.ageHours != null
        ? ` in ${Math.round(o.ageHours)}h`
        : o.multiplier != null
          ? ` · ${o.multiplier}× median`
          : ""
    }`,
    source_type: "competitor_alert",
    source_ref: {
      alertId: o.id,
      videoId: o.videoId,
      title: o.title,
      competitor: o.competitor,
      views: o.views,
      multiplier: o.multiplier,
      kind: o.kind,
      ageHours: o.ageHours,
    },
  };

  return (
    <SignalRow
      draft={draft}
      generateType="fresh_outlier"
      generateSignal={{
        title: o.title,
        competitor: o.competitor,
        views: o.views,
        multiplier: o.multiplier,
        kind: o.kind,
        ageHours: o.ageHours,
      }}
      endSlot={
        <DismissAlertButton
          alertId={o.id}
          onDismissed={onDismissed}
          onDismissFailed={onDismissFailed}
        />
      }
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {o.unread && (
          <span
            className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
            title="Unread"
          />
        )}
        <div className="min-w-0 flex-1">
          <a
            href={youtubeUrl(o.videoId)}
            target="_blank"
            rel="noreferrer"
            className="line-clamp-2 text-sm font-medium leading-snug hover:text-primary hover:underline"
          >
            {o.title ?? "Untitled video"}
          </a>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {o.competitor ?? "Unknown competitor"} · {fmtCompact(o.views)} views
            {o.kind === "fresh" && o.ageHours != null
              ? ` · in ${Math.round(o.ageHours)}h`
              : o.multiplier != null
                ? ` · ${o.multiplier}× median`
                : ""}
            {/* Video's own publish date — distinct from the "in Xh"
                above (which is age-since-publish for the fresh detector
                specifically). Omitted entirely when unknown, e.g. an
                alert recorded before this field existed and not yet
                backfilled. */}
            {videoAge && ` · video: ${videoAge}`}
          </p>
          {provenHit && (
            <span
              className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title={`Published over ${PROVEN_HIT_DAYS} days ago — historical reference, not a current spike`}
            >
              proven hit
            </span>
          )}
        </div>
      </div>
    </SignalRow>
  );
}

/* ============================================================
 * Section 2 — Content gaps
 * ============================================================ */

function GapsSection({ gaps }: { gaps: Gap[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          Content gaps
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {gaps.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {gaps.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No gaps found yet. Add competitors and sync them so we can compare
            their catalogue against yours.
          </p>
        ) : (
          gaps.map((g) => <GapRow key={g.word} gap={g} />)
        )}
      </CardContent>
    </Card>
  );
}

function GapRow({ gap: g }: { gap: Gap }) {
  const draft: IdeaDraft = {
    title: g.word,
    notes: `Gap keyword "${g.word}" · avg ${fmtCompact(g.avgViews)} across ${g.competitorUses} competitor vids`,
    source_type: "gap",
    source_ref: {
      word: g.word,
      avgViews: g.avgViews,
      competitorUses: g.competitorUses,
      competitorTotalViews: g.competitorTotalViews,
      exampleCompetitorTitle: g.exampleCompetitorTitle,
    },
  };

  return (
    <SignalRow
      draft={draft}
      generateType="gap"
      generateSignal={{
        word: g.word,
        avgViews: g.avgViews,
        competitorUses: g.competitorUses,
        competitorTotalViews: g.competitorTotalViews,
        exampleCompetitorTitle: g.exampleCompetitorTitle,
      }}
    >
      <div className="min-w-0 flex-1">
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
          {g.word}
        </code>
        <p className="mt-1 text-xs text-muted-foreground">
          in {g.competitorUses} competitor videos · avg {fmtCompact(g.avgViews)}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground/80" title={g.exampleCompetitorTitle}>
          e.g. &ldquo;{g.exampleCompetitorTitle}&rdquo;
        </p>
      </div>
    </SignalRow>
  );
}

/* ============================================================
 * Section 3 — Audience requests
 * ============================================================ */

function AudienceSection({ requests }: { requests: AudienceRequest[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          Audience requests
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {requests.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {requests.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No audience requests yet. Run AI comment analysis on your videos to
            surface what viewers are asking for.
          </p>
        ) : (
          requests.map((r, i) => <AudienceRow key={`${r.videoId}-${i}`} request={r} />)
        )}
      </CardContent>
    </Card>
  );
}

function AudienceRow({ request: r }: { request: AudienceRequest }) {
  const draft: IdeaDraft = {
    title: r.title,
    notes: `Audience request (${r.demand} demand) from comments on "${r.videoTitle}"${
      r.evidence ? ` · "${r.evidence}"` : ""
    }`,
    demand: r.demand,
    source_type: "comment",
    source_ref: {
      title: r.title,
      demand: r.demand,
      evidence: r.evidence,
      videoId: r.videoId,
      videoTitle: r.videoTitle,
    },
  };

  return (
    <SignalRow
      draft={draft}
      generateType="audience"
      generateSignal={{
        title: r.title,
        demand: r.demand,
        evidence: r.evidence,
        videoTitle: r.videoTitle,
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{r.title}</p>
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              demandChipClass(r.demand)
            )}
          >
            {r.demand}
          </span>
        </div>
        {r.evidence && (
          <p className="mt-1 truncate text-xs italic text-muted-foreground" title={r.evidence}>
            &ldquo;{r.evidence}&rdquo;
          </p>
        )}
        <Link
          href={`/videos/${r.videoId}`}
          className="mt-0.5 inline-block text-xs text-muted-foreground hover:text-primary hover:underline"
        >
          from &ldquo;{r.videoTitle}&rdquo;
        </Link>
      </div>
    </SignalRow>
  );
}

/* ============================================================
 * Shared row shell: [content] [Generate title] [→ Ideas] + expand panel
 * ============================================================ */

type GenerateType = "gap" | "fresh_outlier" | "audience";

type VariantsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; variants: Variant[] };

type Variant = { title: string; thumbText: string; rationale: string };

function SignalRow({
  draft,
  generateType,
  generateSignal,
  children,
  endSlot,
}: {
  draft: IdeaDraft;
  generateType: GenerateType;
  generateSignal: unknown;
  children: React.ReactNode;
  /** Optional trailing control rendered after the action buttons (e.g.
   * the outlier-only dismiss ✕). Kept generic/optional so Gap and
   * Audience rows — which don't have a dismiss action — render
   * identically to before. */
  endSlot?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [variantsState, setVariantsState] = useState<VariantsState>({ kind: "idle" });

  const runGenerate = useCallback(async () => {
    setExpanded(true);
    setVariantsState({ kind: "loading" });
    try {
      const r = await fetch("/api/signals/generate-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: generateType, signal: generateSignal }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        variants?: Variant[];
        error?: string;
      };
      if (!r.ok || !d.variants) {
        setVariantsState({
          kind: "error",
          message: d.error ?? `Generate failed (HTTP ${r.status})`,
        });
        return;
      }
      setVariantsState({ kind: "loaded", variants: d.variants });
    } catch (e) {
      setVariantsState({
        kind: "error",
        message: e instanceof Error ? e.message : "Generate failed",
      });
    }
  }, [generateType, generateSignal]);

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex items-start gap-3">
        {children}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={runGenerate} className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Generate title
          </Button>
          <AddToIdeasButton draft={draft} />
          {endSlot}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <VariantsPanel state={variantsState} onRetry={runGenerate} baseDraft={draft} />
        </div>
      )}
    </div>
  );
}

function VariantsPanel({
  state,
  onRetry,
  baseDraft,
}: {
  state: VariantsState;
  onRetry: () => void;
  baseDraft: IdeaDraft;
}) {
  if (state.kind === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Generating 3 title variants…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <div className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          {state.message}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="text-xs text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.kind === "idle") return null;

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {state.variants.map((v, i) => (
        <VariantCard key={i} variant={v} baseDraft={baseDraft} />
      ))}
    </div>
  );
}

function VariantCard({
  variant: v,
  baseDraft,
}: {
  variant: Variant;
  baseDraft: IdeaDraft;
}) {
  // Keep the ORIGINAL signal's source_type/demand — this is still the
  // same underlying signal, just packaged via an AI-generated title
  // variant. notes append the rationale; source_ref carries both the
  // original signal and the chosen variant for full provenance.
  const draft: IdeaDraft = {
    title: v.title,
    notes: `${baseDraft.notes} · AI variant: ${v.rationale || "no rationale given"}`,
    demand: baseDraft.demand,
    source_type: baseDraft.source_type,
    source_ref: { signal: baseDraft.source_ref, variant: v },
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
      <p className="text-sm font-medium leading-snug">{v.title}</p>
      {v.thumbText && (
        <code className="w-fit rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">
          {v.thumbText}
        </code>
      )}
      {v.rationale && (
        <p className="text-xs text-muted-foreground">{v.rationale}</p>
      )}
      <div className="mt-auto pt-1">
        <AddToIdeasButton draft={draft} />
      </div>
    </div>
  );
}

/* ============================================================
 * Add to Ideas — shared submit button used by every row + variant card
 * ============================================================ */

type AddState = "idle" | "adding" | "added" | "error";

function AddToIdeasButton({ draft }: { draft: IdeaDraft }) {
  const [state, setState] = useState<AddState>("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setState("adding");
    setError(null);
    try {
      const r = await fetch("/api/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          notes: draft.notes,
          stage: "idea",
          demand: draft.demand,
          source_type: draft.source_type,
          source_ref: JSON.stringify(draft.source_ref),
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setState("error");
        setError(d.error ?? `Failed (HTTP ${r.status})`);
        return;
      }
      setState("added");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Failed to add");
    }
  }, [draft]);

  if (state === "added") {
    return (
      <Button variant="outline" size="sm" disabled className="gap-1.5">
        Added ✓
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={submit}
        disabled={state === "adding"}
        className="gap-1.5"
      >
        {state === "adding" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          "→ Ideas"
        )}
      </Button>
      {state === "error" && error && (
        <span className="max-w-[160px] text-right text-[11px] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

/* ============================================================
 * Dismiss alert — outlier-only ✕, optimistically removes the row from
 * the local list then deletes server-side; restores the row (and shows
 * an inline error, matching AddToIdeasButton's style above) on failure.
 * ============================================================ */

function DismissAlertButton({
  alertId,
  onDismissed,
  onDismissFailed,
}: {
  alertId: number;
  onDismissed: () => void;
  onDismissFailed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const dismiss = useCallback(async () => {
    setError(null);
    // Optimistic: remove immediately, before the request even resolves.
    onDismissed();
    try {
      const r = await fetch(`/api/competitors/alerts/${alertId}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `Failed (HTTP ${r.status})`);
      }
    } catch (e) {
      onDismissFailed();
      setError(e instanceof Error ? e.message : "Failed to dismiss");
    }
  }, [alertId, onDismissed, onDismissFailed]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={dismiss}
        className="rounded-md p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
        aria-label="Dismiss alert"
        title="Dismiss alert"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {error && (
        <span className="max-w-[160px] text-right text-[11px] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
