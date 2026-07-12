import { NextResponse } from "next/server";
import {
  getIntegration,
  getSetting,
  listWatchNiches,
  pruneNicheHits,
  setSetting,
  type WatchNicheSummary,
} from "@/lib/db";
import { scanOneNiche } from "@/lib/niche-watch";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/niche-watch/scan — scan every configured watch niche for
 * the active channel and store fresh hits.
 *
 * Fire-and-forget, same shape as /api/competitors/sync-all and
 * /api/videos/thumbnails-ocr: the response returns immediately and
 * progress lives in the `settings` table under "nichewatch.scan.job" so
 * a poller sees accurate state regardless of whether the browser tab
 * that started the scan is still open, or whether the dev/prod process
 * got restarted mid-run (see STALE_JOB_MS below).
 *
 * The route drives scanOneNiche itself (rather than calling
 * scanWatchNiches in src/lib/niche-watch.ts) specifically so it can
 * stamp job.current with the niche currently being searched between
 * iterations — scanWatchNiches stays as a thin serial wrapper for
 * non-job callers that don't need that granularity.
 *
 * Niches are scanned serially, not in parallel — cleaner per-niche
 * error attribution in job.lastError / the logs, and it keeps quota
 * usage predictable (100 units/niche for search alone).
 */

const JOB_KEY = "nichewatch.scan.job";
// A job whose process died (server restarted, crashed) leaves
// `running:true` stuck forever with no updater left to flip it — treat
// it as stale after this long so a fresh scan isn't permanently blocked
// by a 409.
const STALE_JOB_MS = 2 * 60 * 60 * 1000; // 2 hours

type ScanJob = {
  running: boolean;
  done: number; // niches processed so far
  total: number;
  // Query currently being scanned, or null when idle / between niches
  // momentarily. Null rather than "" so the client can tell "no niche
  // yet" apart from a niche with an empty query.
  current: string | null;
  found: number; // hits found/updated so far across all niches
  startedAt: number;
  finishedAt?: number;
  lastError?: string | null;
};

function readJob(): ScanJob | null {
  const raw = getSetting(JOB_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScanJob;
  } catch {
    return null;
  }
}

function writeJob(job: ScanJob): void {
  setSetting(JOB_KEY, JSON.stringify(job));
}

/** Maps a thrown Error to the right HTTP status: known validation /
 * missing-channel messages are 400s, anything else is a 500. */
function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  const isClientError = message === "No active channel selected";
  return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
}

export async function GET() {
  return NextResponse.json({ job: readJob() });
}

export async function POST() {
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }

  let niches: WatchNicheSummary[];
  try {
    niches = listWatchNiches();
  } catch (err) {
    return errorResponse(err);
  }
  if (niches.length === 0) {
    return NextResponse.json(
      { error: "Add at least one niche first" },
      { status: 400 }
    );
  }

  const existing = readJob();
  if (existing?.running && Date.now() - existing.startedAt < STALE_JOB_MS) {
    return NextResponse.json({ error: "Scan already running" }, { status: 409 });
  }

  const startedAt = Date.now();
  const total = niches.length;

  writeJob({
    running: true,
    done: 0,
    total,
    current: null,
    found: 0,
    startedAt,
    lastError: null,
  });

  log.info("niche-watch", "Niche scan started", { total });

  void runScan(niches, apiKey, startedAt).catch((err) => {
    // Belt-and-braces: every per-niche failure inside runScan is already
    // caught, so this only fires on a genuinely unexpected bug (e.g. a
    // DB write itself throwing). Without this, that bug would leave the
    // job stuck at running:true forever with nothing left to flip it.
    const message = err instanceof Error ? err.message : String(err);
    log.error("niche-watch", `Niche scan crashed: ${message}`, err, { total });
    writeJob({
      running: false,
      done: 0,
      total,
      current: null,
      found: 0,
      startedAt,
      finishedAt: Date.now(),
      lastError: message,
    });
  });

  return NextResponse.json({ ok: true, started: true, total });
}

async function runScan(
  niches: WatchNicheSummary[],
  apiKey: string,
  startedAt: number
): Promise<void> {
  let done = 0;
  let found = 0;
  let lastError: string | null = null;

  for (const niche of niches) {
    // Stamp the in-progress niche BEFORE scanning so a poller sees
    // "Scanning X" for the whole duration of that niche's search, not
    // just a jump at the end.
    writeJob({
      running: true,
      done,
      total: niches.length,
      current: niche.query,
      found,
      startedAt,
      lastError,
    });
    try {
      const result = await scanOneNiche(niche, apiKey);
      found += result.found;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "scan failed";
      lastError = msg;
      log.warn("niche-watch", `Scan skipped niche ${niche.id}: ${msg}`, {
        nicheId: niche.id,
        query: niche.query,
      });
    }
    done++;
    writeJob({
      running: true,
      done,
      total: niches.length,
      current: niche.query,
      found,
      startedAt,
      lastError,
    });
  }

  try {
    pruneNicheHits();
  } catch (err) {
    log.warn("niche-watch", "pruneNicheHits failed (ignored)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  writeJob({
    running: false,
    done,
    total: niches.length,
    current: null,
    found,
    startedAt,
    finishedAt: Date.now(),
    lastError,
  });

  log.info("niche-watch", "Niche scan finished", {
    total: niches.length,
    done,
    found,
    lastError,
  });
}
