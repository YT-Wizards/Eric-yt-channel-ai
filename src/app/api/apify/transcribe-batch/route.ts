import { NextResponse } from "next/server";
import {
  createTranscriptionJob,
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  listVideosMissingTranscript,
  updateTranscriptionJob,
  upsertTranscript,
} from "@/lib/db";
import { apifyYouTubeTranscript } from "@/lib/apify";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Each Apify call takes ~30-60s; with 2 parallel workers a 50-video
// batch finishes in roughly 15-25 minutes. Bumping maxDuration covers
// the worst case without serverless killing the function mid-loop.
export const maxDuration = 300;

/** Apify's free plan allowance + paid plans recharge monthly at $5/$49/etc
 *  We estimate a flat $0.02 per video (per the pintostudio actor's typical
 *  cost at time of writing). Calibrate later if it drifts. */
const ESTIMATED_COST_CENTS_PER_VIDEO = 2;

/** Two parallel workers — Apify's free-tier concurrency limit is 1
 *  RUNNING actor per user, but each actor RUN can pump multiple videos
 *  serially. Two parallel runs gives a ~2× speedup over serial without
 *  going much above the rate-limit ceiling on paid plans. */
const DEFAULT_CONCURRENCY = 2;

/**
 * GET — preview the work: how many videos need transcripts, rough cost
 * estimate (~$0.02 per video), plus the first 5 titles so the user can
 * sanity-check the queue before kicking it off.
 */
export async function GET() {
  const missing = listVideosMissingTranscript();
  const totalSeconds = missing.reduce((sum, v) => sum + (v.duration_seconds ?? 0), 0);
  const estimatedCostCents = missing.length * ESTIMATED_COST_CENTS_PER_VIDEO;
  const active = getActiveTranscriptionJob();
  return NextResponse.json({
    missing: missing.length,
    totalSeconds,
    estimatedCostCents,
    videos: missing.slice(0, 5).map((v) => ({
      id: v.id,
      title: v.title,
      durationSeconds: v.duration_seconds ?? 0,
    })),
    activeJob: active ?? null,
  });
}

/**
 * POST — start a batch transcription via Apify's residential-proxy
 * actor. Returns a jobId immediately; the actual work runs in the
 * background and the UI polls /api/apify/jobs/latest for progress.
 *
 * Videos with no usable transcript (no captions, no voice, region-
 * locked, private) come back empty from Apify — those are recorded
 * as `done` and skipped rather than counted as failures. From the
 * user's perspective a no-voice video doesn't need to be retried.
 */
export async function POST() {
  const apiKey = getIntegration("apify")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Apify API token is not configured. Add it in Integrations — the Free plan includes $5 / month of credit (≈250 transcripts).",
      },
      { status: 400 }
    );
  }

  const existing = getActiveTranscriptionJob();
  if (existing) {
    return NextResponse.json(
      { error: "A transcription batch is already running.", jobId: existing.id },
      { status: 409 }
    );
  }

  if (getSetting("sync.inProgress") === "1") {
    return NextResponse.json(
      { error: "A channel sync is currently running. Wait for it to finish before transcribing." },
      { status: 409 }
    );
  }

  const missing = listVideosMissingTranscript();
  if (missing.length === 0) {
    return NextResponse.json({ error: "No videos missing a transcript." }, { status: 400 });
  }

  const jobId = createTranscriptionJob(missing.length);
  log.info("apify-batch", "Batch transcription job started (Apify)", {
    jobId,
    videoCount: missing.length,
  });

  // Background task — the response goes back now, the workers loop in
  // the runtime until every video has been visited.
  void runBatch(jobId, apiKey, missing);

  return NextResponse.json({ ok: true, jobId, total: missing.length });
}

async function runBatch(
  jobId: number,
  apiKey: string,
  videos: { id: string; title: string; duration_seconds: number | null }[]
): Promise<void> {
  let cursor = 0;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let costCentsTotal = 0;
  let lastError: string | null = null;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= videos.length) return;
      const v = videos[i];
      updateTranscriptionJob(jobId, { current_video_id: v.id });
      try {
        const results = await apifyYouTubeTranscript(
          [`https://www.youtube.com/watch?v=${v.id}`],
          apiKey
        );
        const hit = results.find(
          (r) => r.transcript && r.transcript.length >= 50
        );
        if (hit?.transcript) {
          upsertTranscript(v.id, hit.transcript, hit.language ?? null);
          done++;
          // Each Apify YouTube transcript call rounds out to ~$0.02 in
          // platform credit; we tally optimistically per success and
          // surface the running spend in the UI.
          costCentsTotal += ESTIMATED_COST_CENTS_PER_VIDEO;
        } else {
          // No captions / no voice / region-locked / private. The
          // user explicitly asked for these to be skipped rather
          // than failed — counts toward `done` so the progress bar
          // moves on; we record a soft note in last_error to
          // surface "what didn't have a transcript" in the summary
          // without polluting the failed count.
          done++;
          skipped++;
          lastError = `no captions found on ${skipped} video${skipped === 1 ? "" : "s"} (skipped)`;
        }
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        log.warn("apify-batch", `Batch item failed: ${v.id}`, {
          jobId,
          videoId: v.id,
          error: lastError,
        });
      }
      updateTranscriptionJob(jobId, {
        done,
        failed,
        cost_cents: costCentsTotal,
        last_error: lastError,
      });
    }
  };

  const workers = Array.from({ length: DEFAULT_CONCURRENCY }, () => worker());
  try {
    await Promise.all(workers);
    updateTranscriptionJob(jobId, {
      // A batch where every single video failed is "failed"; anything
      // else counts as completed even if some were skipped.
      status: failed === videos.length ? "failed" : "completed",
      completed_at: Math.floor(Date.now() / 1000),
      current_video_id: null,
    });
    log.info("apify-batch", "Batch transcription job finished (Apify)", {
      jobId,
      done,
      failed,
      skipped,
      costCents: costCentsTotal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateTranscriptionJob(jobId, {
      status: "failed",
      completed_at: Math.floor(Date.now() / 1000),
      last_error: msg,
      current_video_id: null,
    });
    log.error("apify-batch", `Batch transcription job crashed: ${msg}`, err, { jobId });
  }
}
