"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Flame,
  Loader2,
  Plug,
  Radar,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AudienceRequest, FreshOutlier } from "@/app/api/signals/route";

/**
 * Signals tab of the Ideation hub — one actionable feed answering
 * "what should I make next, based on data". Three sections, all
 * sourced from /api/signals (itself scoped to the active channel):
 * competitor outliers worth reacting to, content gaps competitors
 * cover and this channel doesn't, and audience requests mined out of
 * comment analysis. Every row can either generate 3 grounded title
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

/** What "→ Ideas" needs to build the /api/ideas POST body. Kept generic
 * across all three signal kinds so one button component + one submit
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

      <OutliersSection outliers={data?.freshOutliers ?? []} />
      <GapsSection gaps={data?.gaps ?? []} />
      <AudienceSection requests={data?.audienceRequests ?? []} />
    </div>
  );
}

/* ============================================================
 * Section 1 — Competitor outliers
 * ============================================================ */

function OutliersSection({ outliers }: { outliers: FreshOutlier[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Flame className="h-4 w-4 text-orange-500" />
          Competitor outliers
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {outliers.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {outliers.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No competitor outliers detected yet. Add competitors and sync them to
            start catching viral hits.
          </p>
        ) : (
          outliers.map((o) => (
            <OutlierRow key={o.id} outlier={o} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function OutlierRow({ outlier: o }: { outlier: FreshOutlier }) {
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
          </p>
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
}: {
  draft: IdeaDraft;
  generateType: GenerateType;
  generateSignal: unknown;
  children: React.ReactNode;
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
