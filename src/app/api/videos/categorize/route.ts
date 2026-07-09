import {
  categorizeChannelVideos,
  CategorizerError,
} from "@/lib/categorizer";
import { getSetting, listChannelCategories, setSetting } from "@/lib/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Server-side fire-and-forget job with polled status — same pattern as
 * thumbnails-ocr/route.ts (see that file's doc comment for the full
 * rationale). Previously POST awaited `categorizeChannelVideos()` inline
 * and returned the result in one response; if the user navigated away
 * mid-request the fetch was aborted client-side and they never learned
 * whether it finished. Now POST kicks the job off, persists it to the
 * "categorize.job" setting, and returns immediately; the client polls GET.
 *
 * Job state lives in the `settings` table under key "categorize.job" as
 * JSON: { running, startedAt, finishedAt?, ok?, categories?, assigned?,
 * skipped?, error? }
 */

const JOB_KEY = "categorize.job";
// Same staleness guard as OCR — un-wedges a job whose process died before
// it could flip `running` back to false.
const STALE_JOB_MS = 2 * 60 * 60 * 1000; // 2 hours

type CategorizeJob = {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  categories?: string[];
  assigned?: number;
  skipped?: number;
  error?: string;
};

function readJob(): CategorizeJob | null {
  const raw = getSetting(JOB_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CategorizeJob;
  } catch {
    return null;
  }
}

function writeJob(job: CategorizeJob): void {
  setSetting(JOB_KEY, JSON.stringify(job));
}

/**
 * GET /api/videos/categorize
 *
 * Returns the categories currently in use across the active channel's
 * videos (feeds a category filter dropdown), plus the current/last
 * categorization job so the UI can show correct progress even after a
 * page navigation or reload.
 */
export async function GET() {
  return Response.json({ categories: listChannelCategories(), job: readJob() });
}

/**
 * POST /api/videos/categorize
 *
 * Kicks off a fresh categorization pass over the active channel's videos
 * (up to the 200 most recent) in the background and returns immediately.
 * Always overwrites previous assignments for videos in the batch.
 */
export async function POST() {
  const existing = readJob();
  if (existing?.running && Date.now() - existing.startedAt < STALE_JOB_MS) {
    return Response.json(
      { error: "Categorization already running" },
      { status: 409 }
    );
  }

  const startedAt = Date.now();
  writeJob({ running: true, startedAt });
  log.info("categorize", "Categorization job started");

  void categorizeChannelVideos()
    .then((result) => {
      writeJob({
        running: false,
        startedAt,
        finishedAt: Date.now(),
        ok: true,
        categories: result.categories,
        assigned: result.assigned,
        skipped: result.skipped,
      });
      log.info("categorize", "Categorization job finished", {
        assigned: result.assigned,
        skipped: result.skipped,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((e) => {
      const message =
        e instanceof CategorizerError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Categorization failed";
      writeJob({
        running: false,
        startedAt,
        finishedAt: Date.now(),
        ok: false,
        error: message,
      });
      log.warn("categorize", "Categorization job failed", { error: message });
    });

  return Response.json({ ok: true, started: true });
}
