import {
  categorizeChannelVideos,
  CategorizerError,
} from "@/lib/categorizer";
import { listChannelCategories } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/videos/categorize
 *
 * Returns the categories currently in use across the active channel's
 * videos, with counts — feeds a category filter dropdown.
 */
export async function GET() {
  return Response.json({ categories: listChannelCategories() });
}

/**
 * POST /api/videos/categorize
 *
 * Runs a fresh categorization pass over the active channel's videos
 * (up to the 200 most recent) and writes the resulting category per
 * video. Always overwrites previous assignments for videos in the batch.
 */
export async function POST() {
  try {
    const result = await categorizeChannelVideos();
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof CategorizerError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    return Response.json(
      { error: e instanceof Error ? e.message : "Categorization failed" },
      { status: 500 }
    );
  }
}
