"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Loader2,
  TrendingUp,
  TrendingDown,
  Ruler,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type WordStat = {
  word: string;
  uses: number;
  totalViews: number;
  avgViews: number;
  successRate: number;
  exampleTitle: string;
};

type LengthBucket = {
  bucket: string;
  videos: number;
  avgViews: number;
};

type TopBottom = {
  top: Array<{ id: string; title: string; views: number }>;
  bottom: Array<{ id: string; title: string; views: number }>;
};

function fmtCount(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export default function FormulaAnalyzerPage() {
  const [wordStats, setWordStats] = useState<WordStat[] | null>(null);
  const [lengthBuckets, setLengthBuckets] = useState<LengthBucket[] | null>(null);
  const [topBottom, setTopBottom] = useState<TopBottom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/formula-analyzer", { cache: "no-store" });
        const d = (await r.json()) as {
          wordStats: WordStat[];
          lengthBuckets: LengthBucket[];
          topBottom: TopBottom;
        };
        if (cancelled) return;
        setWordStats(d.wordStats);
        setLengthBuckets(d.lengthBuckets);
        setTopBottom(d.topBottom);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bar width scaling — every bar in a chart shares the same max so a
  // single dominant word/length doesn't flatten the rest into invisibility.
  const maxWordAvg = useMemo(
    () => Math.max(1, ...(wordStats?.map((w) => w.avgViews) ?? [1])),
    [wordStats]
  );
  const maxLenAvg = useMemo(
    () => Math.max(1, ...(lengthBuckets?.map((b) => b.avgViews) ?? [1])),
    [lengthBuckets]
  );

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

  if (error) {
    return (
      <div className="mx-auto max-w-6xl">
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="mb-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BarChart3 className="h-6 w-6" />
          Formula Analyzer
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Statistical view over your own video catalogue — which words and
          title lengths have actually pulled views on this channel.
        </p>
      </header>

      {/* ---- Title length ---- */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Ruler className="h-3.5 w-3.5" />
            Optimal title length
          </h2>
          {/* Beginner-friendly explainer for the buckets — Vlad's feedback:
              "шо це таке ≤8 / 17+ слів?". The buckets count the number of
              WORDS in each title and average the views of all your videos
              that fell in that bucket. Longer bar = a length that has
              historically pulled bigger views on YOUR channel. */}
          <p className="mb-3 text-[11px] text-muted-foreground">
            Buckets count how many <strong>words</strong> are in each title.
            We average the views of every video in each bucket — the longest
            bar is the length that has pulled the most views on this channel.
            Useful as a sanity check before titling your next video.
          </p>
          {lengthBuckets && lengthBuckets.length > 0 ? (
            <ul className="space-y-1.5">
              {lengthBuckets.map((b) => (
                <li key={b.bucket} className="flex items-center gap-3 text-xs">
                  <span className="w-24 shrink-0 font-medium">{b.bucket}</span>
                  <div className="relative h-5 flex-1 rounded bg-muted/40">
                    <div
                      className="h-full rounded bg-primary"
                      style={{
                        width: `${(b.avgViews / maxLenAvg) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                    {fmtCount(b.avgViews)} avg · {b.videos} vid
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

      {/* ---- Word stats ---- */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-2 text-sm font-semibold">
            Title words — ranked by aggregate views
          </h2>
          {/* Help block — explicitly names every column so non-technical
              users don't have to guess. Vlad's feedback: people don't
              read column headers, they read sentences. */}
          <p className="mb-3 text-[11px] text-muted-foreground">
            Every word that appeared in &ge;2 of your video titles. <strong>Uses</strong> =
            how many times you used the word; <strong>Avg views</strong> = average
            views across videos that contained it; <strong>Success</strong> = share of
            those videos that ended up &ge;1.5&times; your channel median (green =
            consistent winner). Use this to see which of your own words
            historically work.
          </p>
          {wordStats && wordStats.length > 0 ? (
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
                  {wordStats.map((w) => (
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
                              style={{
                                width: `${(w.avgViews / maxWordAvg) * 100}%`,
                              }}
                            />
                          </div>
                          <span className="tabular-nums">{fmtCount(w.avgViews)}</span>
                        </div>
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1.5 text-right font-semibold tabular-nums",
                          w.successRate >= 67
                            ? "text-emerald-600 dark:text-emerald-400"
                            : w.successRate >= 33
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground"
                        )}
                      >
                        {w.successRate}%
                      </td>
                      <td className="max-w-[280px] truncate px-2 py-1.5 text-muted-foreground">
                        {w.exampleTitle}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Need at least a few videos with views before this populates.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Top vs bottom ---- */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              <TrendingUp className="h-3.5 w-3.5" />
              Top 10 — highest views
            </h2>
            {topBottom?.top.length ? (
              <ul className="space-y-1.5 text-xs">
                {topBottom.top.map((v, i) => (
                  <li
                    key={v.id}
                    className="flex items-start gap-2 rounded-md p-1 hover:bg-accent/30"
                  >
                    <span className="w-5 shrink-0 text-right text-[10px] text-muted-foreground">
                      {i + 1}
                    </span>
                    <a
                      href={`/videos/${v.id}`}
                      className="min-w-0 flex-1 truncate hover:text-primary hover:underline"
                    >
                      {v.title}
                    </a>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {fmtCount(v.views)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No data.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-rose-600 dark:text-rose-400">
              <TrendingDown className="h-3.5 w-3.5" />
              Bottom 10 — lowest views
            </h2>
            {topBottom?.bottom.length ? (
              <ul className="space-y-1.5 text-xs">
                {topBottom.bottom.map((v, i) => (
                  <li
                    key={v.id}
                    className="flex items-start gap-2 rounded-md p-1 hover:bg-accent/30"
                  >
                    <span className="w-5 shrink-0 text-right text-[10px] text-muted-foreground">
                      {i + 1}
                    </span>
                    <a
                      href={`/videos/${v.id}`}
                      className="min-w-0 flex-1 truncate hover:text-primary hover:underline"
                    >
                      {v.title}
                    </a>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {fmtCount(v.views)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No data.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
