import { NextResponse } from "next/server";
import { getSetting, listCompetitors, setSetting } from "@/lib/db";
import { syncCompetitor } from "@/lib/competitor-sync";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/competitors/sync-all — kick off a fresh sync for every
 * tracked competitor.
 *
 * Fire-and-forget: the actual work runs in a background task and the
 * response returns immediately. Previously this awaited the entire
 * sequence inside the request handler — for even one competitor that's
 * resolve + 45 videos + 45 transcript probes + 45 comment calls, i.e.
 * 1-3 minutes — so the browser's fetch hung the whole time and the
 * "Sync All" button spun forever until the user reloaded the page.
 *
 * Progress now lives in the `settings` table under key
 * "competitors.syncall.job" (mirrors the ocr.job / thumbnails-ocr
 * pattern in src/app/api/videos/thumbnails-ocr/route.ts) instead of
 * relying on the client polling each competitor's last_sync_at. That
 * old approach silently hung forever if the dev/prod process restarted
 * mid-run: the client had no way to distinguish "still working" from
 * "the process that was doing the work is gone", so the UI just spun.
 * A job record polled from the server tells the truth regardless of
 * which process (if any) is still alive, and a stale job (process died
 * without writing running:false) unblocks a fresh start after
 * STALE_JOB_MS instead of wedging the button forever.
 *
 * Syncs are serialised (not parallel) on purpose — Apify rate-limits
 * per actor, and serial gives clean per-competitor error attribution in
 * the logs and in the job's `current` field.
 */

const JOB_KEY = "competitors.syncall.job";
// A job whose process died (server restarted, crashed) leaves
// `running:true` stuck forever with no updater left to flip it — treat
// it as stale after this long so a fresh "Sync All" click isn't
// permanently blocked by a 409.
const STALE_JOB_MS = 2 * 60 * 60 * 1000; // 2 hours

type SyncAllJob = {
  running: boolean;
  done: number;
  failed: number;
  total: number;
  // Title of the competitor currently being synced, or null when idle /
  // between competitors momentarily. Null rather than "" so the client
  // can tell "no competitor yet" apart from a competitor with an empty
  // title.
  current: string | null;
  startedAt: number;
  finishedAt?: number;
  lastError?: string | null;
};

function readJob(): SyncAllJob | null {
  const raw = getSetting(JOB_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncAllJob;
  } catch {
    return null;
  }
}

function writeJob(job: SyncAllJob): void {
  setSetting(JOB_KEY, JSON.stringify(job));
}

export async function GET() {
  return NextResponse.json({ job: readJob() });
}

export async function POST() {
  const existing = readJob();
  if (existing?.running && Date.now() - existing.startedAt < STALE_JOB_MS) {
    return NextResponse.json(
      { error: "Sync already running" },
      { status: 409 }
    );
  }

  const competitors = listCompetitors();
  if (competitors.length === 0) {
    return NextResponse.json(
      { error: "No competitors to sync — add one first." },
      { status: 400 }
    );
  }

  const startedAt = Date.now();
  const total = competitors.length;

  writeJob({
    running: true,
    done: 0,
    failed: 0,
    total,
    current: null,
    startedAt,
    lastError: null,
  });

  log.info("competitors", "Bulk competitor sync started", { count: total });

  void runAll(
    competitors.map((c) => ({ id: c.id, title: c.title ?? c.handle ?? `#${c.id}` })),
    startedAt
  );

  return NextResponse.json({ ok: true, started: true, total });
}

async function runAll(
  targets: Array<{ id: number; title: string }>,
  startedAt: number
): Promise<void> {
  let done = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const t of targets) {
    // Stamp the in-progress competitor BEFORE syncing so a poller sees
    // "Syncing X" for the whole duration of that competitor's sync, not
    // just a jump at the end.
    writeJob({
      running: true,
      done,
      failed,
      total: targets.length,
      current: t.title,
      startedAt,
      lastError,
    });
    try {
      await syncCompetitor(t.id);
      done++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : "sync failed";
      lastError = msg;
      log.warn("competitors", `Bulk sync skipped competitor ${t.id}: ${msg}`);
    }
    writeJob({
      running: true,
      done,
      failed,
      total: targets.length,
      current: t.title,
      startedAt,
      lastError,
    });
  }

  writeJob({
    running: false,
    done,
    failed,
    total: targets.length,
    current: null,
    startedAt,
    finishedAt: Date.now(),
    lastError,
  });

  log.info("competitors", "Bulk competitor sync finished", {
    total: targets.length,
    ok: done,
    failed,
  });
}
