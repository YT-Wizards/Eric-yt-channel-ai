import {
  getActiveChannelId,
  getIntegration,
  getSetting,
  listVideosMissingThumbnailText,
  setSetting,
  updateVideoThumbnailText,
} from "@/lib/db";
import { ocrThumbnail } from "@/lib/thumbnail-ocr";
import { log } from "@/lib/logger";

/**
 * Batch thumbnail OCR for the active channel's videos, run as a server-side
 * fire-and-forget job with polled status — NOT an SSE stream. This used to
 * push progress over SSE that the client read directly, which meant the
 * batch's fate was tied to the browser tab: navigating to another page
 * unmounted the reader, the SSE connection dropped, `controller.enqueue`
 * started throwing, and the loop died mid-batch (users reported ~76 of 91
 * thumbnails left unprocessed). Now the loop runs to completion on the
 * server regardless of who's watching; the client just polls GET for
 * progress and can navigate away freely without killing the job.
 *
 * Job state lives in the `settings` table under key "ocr.job" as JSON:
 *   { running, done, failed, total, startedAt, finishedAt?, lastError? }
 *
 * GET is also the cheap "how many are left" count so the Videos page can
 * label its button ("Detect thumbnail text (42 pending)") without kicking
 * off any Claude calls.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const PACE_MS = 150;
const JOB_KEY = "ocr.job";
// A job whose process died (server restarted, crashed) leaves `running:true`
// stuck forever with no updater left to flip it — stale after this long.
const STALE_JOB_MS = 2 * 60 * 60 * 1000; // 2 hours

type OcrJob = {
  running: boolean;
  done: number;
  failed: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  lastError?: string | null;
};

function readJob(): OcrJob | null {
  const raw = getSetting(JOB_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OcrJob;
  } catch {
    return null;
  }
}

function writeJob(job: OcrJob): void {
  setSetting(JOB_KEY, JSON.stringify(job));
}

export async function GET() {
  const pending = getActiveChannelId()
    ? listVideosMissingThumbnailText(10_000).length
    : 0;
  return Response.json({ pending, job: readJob() });
}

export async function POST(req: Request) {
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return Response.json(
      { error: "Claude API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }
  if (!getActiveChannelId()) {
    return Response.json(
      { error: "No active channel selected." },
      { status: 400 }
    );
  }

  const existing = readJob();
  if (
    existing?.running &&
    Date.now() - existing.startedAt < STALE_JOB_MS
  ) {
    return Response.json(
      { error: "OCR batch already running" },
      { status: 409 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  const limit = Math.min(MAX_LIMIT, Math.max(1, body.limit ?? DEFAULT_LIMIT));

  const targets = listVideosMissingThumbnailText(limit);
  const startedAt = Date.now();
  const total = targets.length;

  writeJob({
    running: true,
    done: 0,
    failed: 0,
    total,
    startedAt,
    lastError: null,
  });

  log.info("ocr", "Thumbnail OCR batch started", { total });

  // Fire-and-forget: the loop below runs to completion on the server no
  // matter what the client does. Progress is persisted to the "ocr.job"
  // setting after every item so a poller (or a fresh page load) always
  // sees accurate running totals.
  void (async () => {
    let done = 0;
    let failed = 0;
    let lastError: string | null = null;

    for (const v of targets) {
      try {
        const text = await ocrThumbnail(v.thumbnail_url!, apiKey);
        updateVideoThumbnailText(v.id, text || null);
        done++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        log.warn("ocr", "Thumbnail OCR failed for video", {
          videoId: v.id,
          error: message,
        });
      }
      writeJob({
        running: true,
        done,
        failed,
        total,
        startedAt,
        lastError,
      });
      await new Promise((r) => setTimeout(r, PACE_MS));
    }

    writeJob({
      running: false,
      done,
      failed,
      total,
      startedAt,
      finishedAt: Date.now(),
      lastError,
    });
    log.info("ocr", "Thumbnail OCR batch finished", {
      done,
      failed,
      total,
      durationMs: Date.now() - startedAt,
    });
  })().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error("ocr", `Thumbnail OCR batch crashed: ${message}`, err, { total });
    writeJob({
      running: false,
      done: 0,
      failed: 0,
      total,
      startedAt,
      finishedAt: Date.now(),
      lastError: message,
    });
  });

  return Response.json({ ok: true, started: true, total });
}
