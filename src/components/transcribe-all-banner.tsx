"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Preview = {
  missing: number;
  totalSeconds: number;
  estimatedCostCents: number;
  videos: { id: string; title: string; durationSeconds: number }[];
  activeJob: TranscriptionJob | null;
};

type TranscriptionJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  total: number;
  done: number;
  failed: number;
  cost_cents: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

type ApifyUsageLite = {
  configured: boolean;
  usage: {
    remainingUsd: number | null;
    estimatedTranscriptsRemaining: number | null;
  } | null;
};

/**
 * "Transcribe all missing" entrypoint on /videos.
 *
 * Switched in May 2026 from Deepgram (which couldn't reach YouTube
 * audio from datacenter IPs) to Apify's residential-proxy actor.
 * Same UX, different backend: button → confirm modal showing cost
 * estimate → background job → live progress bar → result summary.
 *
 * Videos without usable captions (no voice, region-locked, captions
 * disabled) are reported by Apify as empty transcripts and the batch
 * SKIPS them — they count as `done` so progress moves forward, but a
 * note like "12 videos had no captions" appears in the final summary
 * so the user knows the queue didn't silently fail.
 *
 * Four UI states:
 *   1. Active batch job → progress bar, poll every 2s.
 *   2. Job just finished → result summary until user dismisses it.
 *   3. There are videos without transcripts and Apify is configured
 *      → show CTA + cost preview.
 *   4. Apify not configured (yet have missing videos) → soft hint
 *      pointing at /integrations.
 *   5. Nothing to do → render nothing (banner stays invisible).
 */
export function TranscribeAllBanner() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [usage, setUsage] = useState<ApifyUsageLite | null>(null);
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [apifyReady, setApifyReady] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const loadPreview = useCallback(async () => {
    try {
      const [p, u, i] = await Promise.all([
        fetch("/api/apify/transcribe-batch").then((r) => r.json()),
        fetch("/api/integrations/apify/usage").then((r) => r.json()).catch(() => null),
        fetch("/api/integrations").then((r) => r.json()),
      ]);
      setPreview(p);
      setUsage(u);
      setApifyReady(!!i?.integrations?.apify?.hasKey);
      if (p.activeJob) setJob(p.activeJob);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  // Poll the latest transcription job while one is running. Server
  // shares the transcription_jobs table between Apify and Deepgram
  // batches, so the same endpoint surfaces whichever is active.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/apify/jobs/latest");
        if (!res.ok) return;
        const data = (await res.json()) as { job: TranscriptionJob | null };
        if (cancelled) return;
        if (data.job) {
          setJob(data.job);
          if (data.job.status !== "running") {
            loadPreview();
          }
        }
      } catch {
        /* transient */
      }
    };
    const id = window.setInterval(tick, 2000);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job, loadPreview]);

  const startBatch = async () => {
    setStarting(true);
    try {
      const res = await fetch("/api/apify/transcribe-batch", { method: "POST" });
      const data = await res.json();
      if (data.jobId) {
        setJob({
          id: data.jobId,
          started_at: Math.floor(Date.now() / 1000),
          completed_at: null,
          total: data.total ?? preview?.missing ?? 0,
          done: 0,
          failed: 0,
          cost_cents: 0,
          current_video_id: null,
          status: "running",
          last_error: null,
        });
        setModalOpen(false);
      } else if (data.error) {
        alert(data.error);
      }
    } finally {
      setStarting(false);
    }
  };

  const finishedJob = job && job.status !== "running" && !dismissed ? job : null;

  // Apify not configured but there ARE missing videos → soft hint.
  // Different copy from the old Deepgram banner because we point to
  // the Apify card with the credit progress bar, not Deepgram.
  if (apifyReady === false) {
    if (!preview || preview.missing === 0) return null;
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <div className="font-medium">
            {preview.missing} video{preview.missing === 1 ? "" : "s"} have no
            transcript
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Add an Apify API key in Integrations to batch-transcribe everything
            (~$0.02 / video; Apify Free plan includes $5 / month credit).
          </div>
        </div>
        <a
          href="/integrations"
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          Open Integrations →
        </a>
      </div>
    );
  }

  // Finished job summary
  if (finishedJob) {
    const ok = finishedJob.done;
    const bad = finishedJob.failed;
    const spent = (finishedJob.cost_cents / 100).toFixed(2);
    // last_error doubles as a "soft note" channel: skipped-no-captions
    // messages flow through it. We surface them at the end so the user
    // sees "12 had no captions" instead of being confused why some
    // videos still show "missing" in the list below.
    const note = finishedJob.last_error;
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-green-500/5 p-3 text-sm">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        <div className="flex-1">
          <div className="font-medium">
            Batch finished: {ok} / {finishedJob.total}
            {bad > 0 && (
              <span className="ml-2 text-destructive">({bad} failed)</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            ~${spent} of Apify credit used
            {note && note.includes("no captions") && (
              <> · {note}</>
            )}
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Running job — progress bar
  if (job && job.status === "running") {
    const pct = job.total > 0 ? (job.done / job.total) * 100 : 0;
    const spent = (job.cost_cents / 100).toFixed(2);
    return (
      <div className="mb-4 space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="inline-flex items-center gap-2 font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Transcribing: {job.done} / {job.total}
            {job.failed > 0 && (
              <span className="text-destructive">({job.failed} failed)</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            ~${spent} of Apify credit so far
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct.toFixed(1)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          You can leave this page — the batch runs in the background. Videos
          with no captions or no voice will be skipped automatically.
        </p>
      </div>
    );
  }

  // Nothing to do
  if (!preview || preview.missing === 0) return null;

  // CTA
  const costUsd = (preview.estimatedCostCents / 100).toFixed(2);
  const hours = Math.floor(preview.totalSeconds / 3600);
  const minutes = Math.floor((preview.totalSeconds % 3600) / 60);
  const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return (
    <>
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-card p-3">
        <FileText className="h-5 w-5 shrink-0 text-primary" />
        <div className="flex-1 text-sm">
          <div className="font-medium">
            {preview.missing} video{preview.missing === 1 ? "" : "s"} have no
            transcript
          </div>
          <div className="text-xs text-muted-foreground">
            ~{durationLabel} of audio · estimated ~${costUsd} of Apify credit
            (videos without captions or voice get skipped automatically).
          </div>
        </div>
        <Button size="sm" onClick={() => setModalOpen(true)} className="shrink-0 gap-2">
          <Sparkles className="h-4 w-4" />
          Transcribe all via Apify
        </Button>
      </div>

      {modalOpen && (
        <ConfirmModal
          onClose={() => setModalOpen(false)}
          onConfirm={startBatch}
          starting={starting}
          preview={preview}
          usage={usage}
        />
      )}
    </>
  );
}

function ConfirmModal({
  onClose,
  onConfirm,
  starting,
  preview,
  usage,
}: {
  onClose: () => void;
  onConfirm: () => void;
  starting: boolean;
  preview: Preview;
  usage: ApifyUsageLite | null;
}) {
  const costUsd = (preview.estimatedCostCents / 100).toFixed(2);
  const hours = Math.floor(preview.totalSeconds / 3600);
  const minutes = Math.floor((preview.totalSeconds % 3600) / 60);
  const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const remainingCents =
    usage?.usage?.remainingUsd != null
      ? Math.round(usage.usage.remainingUsd * 100)
      : null;
  const willOverrun =
    remainingCents != null && preview.estimatedCostCents > remainingCents;
  const afterCents =
    remainingCents != null
      ? Math.max(0, remainingCents - preview.estimatedCostCents)
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 className="text-lg font-semibold">Transcribe all via Apify</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sends every missing video through Apify&apos;s residential-proxy
            transcript actor. Videos without captions or voice are skipped
            (no charge for those). Runs in the background — you can leave
            this page.
          </p>
        </header>

        <dl className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <Row label="Videos to transcribe" value={String(preview.missing)} />
          <Row label="Total audio duration" value={durationLabel} />
          <Row
            label="Estimated cost"
            value={`~$${costUsd}`}
            valueClass="font-semibold"
          />
          {remainingCents != null && (
            <>
              <Row
                label="Apify credit remaining"
                value={`$${(remainingCents / 100).toFixed(2)}`}
              />
              {afterCents !== null && (
                <Row
                  label="After this batch"
                  value={`$${(afterCents / 100).toFixed(2)}`}
                  valueClass={cn(
                    willOverrun && "text-destructive font-semibold"
                  )}
                />
              )}
            </>
          )}
        </dl>

        {willOverrun && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            Estimated cost exceeds your remaining Apify credit. Continue
            anyway and Apify will start billing you per-run after the free
            allowance runs out.
          </div>
        )}

        {preview.videos.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              First few in the queue
            </summary>
            <ul className="mt-1.5 space-y-1">
              {preview.videos.map((v) => (
                <li key={v.id} className="truncate text-muted-foreground">
                  • {v.title}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={starting} className="gap-2">
            {starting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Start batch
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", valueClass)}>{value}</dd>
    </div>
  );
}
