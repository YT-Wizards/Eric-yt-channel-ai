import { getActiveChannelId } from "@/lib/db";
import {
  channelViewStats,
  featureImpact,
  packagingFormulaSummary,
  thumbnailLengthBuckets,
  thumbnailWordStats,
  topPackages,
} from "@/lib/packaging";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * GET /api/packaging?refreshFormula=1
 *
 * One-shot aggregate payload for the Packaging Analysis page — the
 * title + thumbnail-text mirror of /api/formula-analyzer. Sections:
 *   - stats: channel-wide view baseline (avg/median/count/withThumbText).
 *   - topPackages: best-performing title+thumbnail-text pairs.
 *   - featureImpact: universal packaging features ranked by view lift.
 *   - thumbWords: per-word thumbnail-text stats (OCR'd videos only).
 *   - thumbLengthBuckets: avg views by thumbnail-text length, incl. "no text".
 *   - formula: cached Claude-written "winning formula" prose, or null if
 *     no Claude key is configured. `?refreshFormula=1` forces a recompute.
 *
 * 400s when there's no active channel selected — every stat below is
 * scoped to one channel and returns empty/neutral data without one.
 */
export async function GET(req: Request) {
  if (!getActiveChannelId()) {
    return Response.json(
      { error: "No active channel selected." },
      { status: 400 }
    );
  }

  const url = new URL(req.url);
  const refresh = url.searchParams.get("refreshFormula") === "1";

  return Response.json({
    stats: channelViewStats(),
    topPackages: topPackages(15),
    featureImpact: featureImpact(),
    thumbWords: thumbnailWordStats(),
    thumbLengthBuckets: thumbnailLengthBuckets(),
    formula: await packagingFormulaSummary({ refresh }),
  });
}
