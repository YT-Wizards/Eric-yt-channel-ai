import { NextResponse } from "next/server";
import { listCommentTagsForVideo } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/videos/:id/comment-tags
 *
 * Returns the quick-tag map for every cached comment on this video —
 * `{ tags: { [commentId]: tag[] } }` — in a single JOIN query so the
 * comments panel can annotate each comment's chip row without an N+1.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json({ tags: listCommentTagsForVideo(id) });
}
