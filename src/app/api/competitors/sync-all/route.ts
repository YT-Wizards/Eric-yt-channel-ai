import { NextResponse } from "next/server";
import { listCompetitors } from "@/lib/db";
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
 * "Sync All" button span forever until the user reloaded the page.
 *
 * Now the UI gets an instant ack and polls /api/competitors to watch
 * each competitor's last_sync_at advance as the background loop works
 * through them. Syncs are serialised (not parallel) on purpose — Apify
 * rate-limits per actor, and serial gives clean per-competitor error
 * attribution in the logs.
 */
export async function POST() {
  const competitors = listCompetitors();
  if (competitors.length === 0) {
    return NextResponse.json(
      { error: "No competitors to sync — add one first." },
      { status: 400 }
    );
  }

  log.info("competitors", "Bulk competitor sync started", {
    count: competitors.length,
  });

  void runAll(competitors.map((c) => c.id));

  return NextResponse.json({ ok: true, started: competitors.length });
}

async function runAll(ids: number[]): Promise<void> {
  let ok = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await syncCompetitor(id);
      ok++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : "sync failed";
      log.warn("competitors", `Bulk sync skipped competitor ${id}: ${msg}`);
    }
  }
  log.info("competitors", "Bulk competitor sync finished", {
    total: ids.length,
    ok,
    failed,
  });
}
