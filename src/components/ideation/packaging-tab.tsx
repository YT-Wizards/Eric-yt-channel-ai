"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Layers,
  Loader2,
  PackageOpen,
  Plug,
  RefreshCw,
  Ruler,
  Sparkles,
  Trophy,
  Type,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Packaging tab of the Ideation hub — the title + thumbnail-text
 * mirror of /formula-analyzer, scoped to the active channel via
 * /api/packaging. Visual language (bars, success-% color coding,
 * compact number formatting, table styles) is copied from
 * formula-analyzer/page.tsx so the two "which words/lengths pull
 * views" surfaces feel like the same product.
 */

type Stats = {
  avg: number;
  median: number;
  count: number;
  withThumbText: number;
};

type PackageRow = {
  id: string;
  title: string;
  thumbnailText: string;
  views: number;
  multiplier: number;
};

type TopPackages = {
  channelAvg: number;
  rows: PackageRow[];
};

type FeatureImpactRow = {
  feature: string;
  label: string;
  withCount: number;
  withoutCount: number;
  avgWith: number;
  avgWithout: number;
  deltaPct: number;
};

type ThumbWordStat = {
  word: string;
  uses: number;
  avgViews: number;
  successRate: number;
  exampleThumbText: string;
};

type LengthBucket = {
  bucket: string;
  count: number;
  avgViews: number;
};

type PackagingResponse = {
  stats: Stats;
  topPackages: TopPackages;
  featureImpact: FeatureImpactRow[];
  thumbWords: ThumbWordStat[];
  thumbLengthBuckets: LengthBucket[];
  formula: string | null;
};

function fmtCompact(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function successColor(rate: number): string {
  if (rate >= 67) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 33) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

function multiplierBadge(m: number): string {
  if (m >= 2) {
    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  }
  if (m >= 1) {
    return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  }
  return "bg-muted text-muted-foreground";
}

export function PackagingTab() {
  const [data, setData] = useState<PackagingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [noActiveChannel, setNoActiveChannel] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshingFormula, setRefreshingFormula] = useState(false);
  // Formula card is collapsed by default — see the comment on the card.
  const [formulaOpen, setFormulaOpen] = useState(false);

  const load = useCallback(async (opts: { refreshFormula?: boolean } = {}) => {
    try {
      const qs = opts.refreshFormula ? "?refreshFormula=1" : "";
      const r = await fetch(`/api/packaging${qs}`, { cache: "no-store" });
      if (r.status === 400) {
        setNoActiveChannel(true);
        setLoadError(null);
        return;
      }
      const d = (await r.json()) as PackagingResponse & { error?: string };
      if (!r.ok) {
        setLoadError(d.error ?? `Failed to load (HTTP ${r.status})`);
        return;
      }
      setNoActiveChannel(false);
      setLoadError(null);
      setData(d);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const refreshFormula = useCallback(async () => {
    setRefreshingFormula(true);
    try {
      await load({ refreshFormula: true });
    } finally {
      setRefreshingFormula(false);
    }
  }, [load]);

  // Bar width scaling — every bar in a chart shares the same max so a
  // single dominant word/length/feature doesn't flatten the rest into
  // invisibility.
  const maxWordAvg = useMemo(
    () => Math.max(1, ...(data?.thumbWords.map((w) => w.avgViews) ?? [1])),
    [data]
  );
  const maxLenAvg = useMemo(
    () => Math.max(1, ...(data?.thumbLengthBuckets.map((b) => b.avgViews) ?? [1])),
    [data]
  );

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
          <div className="text-sm text-muted-foreground">
            No active channel selected. Connect a channel and sync it to
            populate packaging analysis.
          </div>
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
          Failed to load packaging analysis: {loadError}
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return null;
  }

  const { stats, topPackages, featureImpact, thumbWords, thumbLengthBuckets, formula } = data;
  const coverageGap = stats.withThumbText < stats.count;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <PackageOpen className="h-5 w-5" />
          Packaging
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Which title + thumbnail-text combinations have actually pulled
          views on this channel.
        </p>
      </header>

      {coverageGap && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Thumbnail text detected on <strong>{stats.withThumbText}</strong>{" "}
            of <strong>{stats.count}</strong>{" "}
            videos — run &ldquo;Detect thumbnail text&rdquo; in the Videos tab
            for full coverage.
            Packaging stats below only cover OCR&rsquo;d videos.
          </span>
        </div>
      )}

      {/* ---- Winning formula ----
          Collapsed by default: on channels with an established format the
          prose mostly restates their own habits, so it reads as clutter.
          The formula's real job is invisible anyway — it grounds the AI
          "Generate title" calls in Signals — so the card stays one quiet
          line until someone actually wants to read or refresh it. */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setFormulaOpen((v) => !v)}
              className="flex min-w-0 items-center gap-1.5 text-left"
            >
              <Trophy className="h-3.5 w-3.5 shrink-0" />
              <span className="text-sm font-semibold">Winning formula</span>
              <span className="truncate text-[11px] text-muted-foreground">
                — feeds the AI &ldquo;Generate title&rdquo; in Signals ·{" "}
                {formulaOpen ? "hide" : "show"}
              </span>
            </button>
            {formulaOpen && formula !== null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={refreshFormula}
                disabled={refreshingFormula}
                className="h-7 shrink-0 gap-1.5 px-2 text-xs"
              >
                {refreshingFormula ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Refresh
              </Button>
            )}
          </div>
          {formulaOpen && (
            <div className="mt-2">
              <p className="mb-2 text-[11px] text-muted-foreground">
                Rules cite sample sizes — small samples are listed as
                &ldquo;worth testing&rdquo;, not facts.
              </p>
              {formula !== null ? (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                  {formula}
                </p>
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  Add your Claude key in Integrations to generate the
                  channel&rsquo;s winning-formula summary.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ---- Feature impact ---- */}
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="h-3.5 w-3.5" />
              Feature impact
            </h2>
            <p className="mb-3 text-[11px] text-muted-foreground">
              For each packaging trait, videos that have it vs. don&rsquo;t —
              the bar length is the size of the view swing either way. Only
              features with &ge;3 videos on each side, videos &ge;14 days old.
            </p>
            {featureImpact.length > 0 ? (
              <ul className="space-y-2.5">
                {featureImpact.map((f) => {
                  const positive = f.deltaPct >= 0;
                  const barWidth = Math.min(100, Math.abs(f.deltaPct));
                  return (
                    <li key={f.feature} className="text-xs">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="font-medium">{f.label}</span>
                        <span
                          className={cn(
                            "shrink-0 font-semibold tabular-nums",
                            positive
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-rose-600 dark:text-rose-400"
                          )}
                        >
                          {positive ? "+" : "−"}
                          {Math.abs(f.deltaPct)}%
                        </span>
                      </div>
                      <div className="relative h-2 w-full overflow-hidden rounded bg-muted/40">
                        <div
                          className={cn(
                            "h-full",
                            positive ? "bg-emerald-500" : "bg-rose-500"
                          )}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        with: {f.withCount} avg {fmtCompact(f.avgWith)} ·
                        without: {f.withoutCount} avg {fmtCompact(f.avgWithout)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                Need more videos with views before this populates.
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---- Optimal thumbnail length ---- */}
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <Ruler className="h-3.5 w-3.5" />
              Optimal thumbnail length
            </h2>
            <p className="mb-3 text-[11px] text-muted-foreground">
              Buckets count how many <strong>words</strong> are in each
              video&rsquo;s thumbnail text. &ldquo;No text&rdquo; is the
              baseline — compare every other bar against it to see whether
              adding thumbnail text (and how much) has helped on this
              channel.
            </p>
            {thumbLengthBuckets.length > 0 ? (
              <ul className="space-y-1.5">
                {thumbLengthBuckets.map((b) => (
                  <li key={b.bucket} className="flex items-center gap-3 text-xs">
                    <span className="w-16 shrink-0 font-medium">{b.bucket}</span>
                    <div className="relative h-5 flex-1 rounded bg-muted/40">
                      <div
                        className="h-full rounded bg-primary"
                        style={{ width: `${(b.avgViews / maxLenAvg) * 100}%` }}
                      />
                    </div>
                    <span className="w-28 shrink-0 text-right tabular-nums text-muted-foreground">
                      {fmtCompact(b.avgViews)} avg · {b.count} vid
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No videos yet.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Top packages ---- */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <Layers className="h-3.5 w-3.5" />
            Top packages
          </h2>
          <p className="mb-3 text-[11px] text-muted-foreground">
            Best-performing title + thumbnail-text pairs, vs. channel average
            of {fmtCompact(topPackages.channelAvg)}.
          </p>
          {topPackages.rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 text-left">#</th>
                    <th className="px-2 py-2 text-left">Title</th>
                    <th className="px-2 py-2 text-left">Thumb text</th>
                    <th className="px-2 py-2 text-right">Views</th>
                    <th className="px-2 py-2 text-right">Multiplier</th>
                  </tr>
                </thead>
                <tbody>
                  {topPackages.rows.map((row, i) => (
                    <tr key={row.id} className="border-b border-border/40 hover:bg-accent/30">
                      <td className="px-2 py-2 align-top text-[10px] text-muted-foreground">
                        {i + 1}
                      </td>
                      <td className="max-w-[280px] px-2 py-2 align-top">
                        <Link
                          href={`/videos/${row.id}`}
                          className="line-clamp-2 font-medium leading-snug hover:text-primary hover:underline"
                          title={row.title}
                        >
                          {row.title}
                        </Link>
                      </td>
                      <td
                        className="max-w-[220px] truncate px-2 py-2 align-top text-muted-foreground"
                        title={row.thumbnailText}
                      >
                        {row.thumbnailText || "—"}
                      </td>
                      <td className="px-2 py-2 text-right align-top tabular-nums">
                        {fmtCompact(row.views)}
                      </td>
                      <td className="px-2 py-2 text-right align-top">
                        <span
                          className={cn(
                            "inline-block rounded px-1.5 py-0.5 font-semibold tabular-nums",
                            multiplierBadge(row.multiplier)
                          )}
                        >
                          {row.multiplier}×
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No OCR&rsquo;d packages yet — run &ldquo;Detect thumbnail
              text&rdquo; in the Videos tab.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Thumbnail words ---- */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Type className="h-3.5 w-3.5" />
            Thumbnail words — ranked by aggregate views
          </h2>
          <p className="mb-3 text-[11px] text-muted-foreground">
            Every word that appeared in &ge;2 of your OCR&rsquo;d thumbnails,
            videos &ge;14 days old (younger uploads haven&rsquo;t had time to
            accumulate views, so they&rsquo;re excluded to keep this fair).{" "}
            <strong>Uses</strong> = how many times you used the word;{" "}
            <strong>Avg views</strong> = average views across videos that
            contained it; <strong>Success</strong> = share of those videos
            that ended up &ge;1.5&times; your channel median (green =
            consistent winner). Small use-counts can just mean the word
            names a one-off topic, not a repeatable formula.
          </p>
          {thumbWords.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 text-left">Word</th>
                    <th className="px-2 py-2 text-right">Uses</th>
                    <th className="px-2 py-2 text-right">Avg views</th>
                    <th className="px-2 py-2 text-right">Success</th>
                    <th className="px-2 py-2 text-left">Example</th>
                  </tr>
                </thead>
                <tbody>
                  {thumbWords.slice(0, 30).map((w) => (
                    <tr key={w.word} className="border-b border-border/40 hover:bg-accent/30">
                      <td className="px-2 py-1.5">
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono font-medium text-primary">
                          {w.word}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{w.uses}</td>
                      <td className="px-2 py-1.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="relative h-3 w-20 overflow-hidden rounded bg-muted/40">
                            <div
                              className="h-full bg-primary"
                              style={{ width: `${(w.avgViews / maxWordAvg) * 100}%` }}
                            />
                          </div>
                          <span className="tabular-nums">{fmtCompact(w.avgViews)}</span>
                        </div>
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1.5 text-right font-semibold tabular-nums",
                          successColor(w.successRate)
                        )}
                      >
                        {w.successRate}%
                      </td>
                      <td className="max-w-[280px] truncate px-2 py-1.5 text-muted-foreground">
                        {w.exampleThumbText}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Need at least a few OCR&rsquo;d thumbnails with views before
              this populates.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
