import { setVideoCategory } from "@/lib/db";

export const runtime = "nodejs";

/**
 * PATCH /api/videos/:id/category
 *
 * Manual override for a single video's category — lets the user
 * relabel/clear an AI-assigned category from the UI without re-running
 * the full channel categorization pass. Body: { category: string | null }.
 * Empty/whitespace-only strings are treated the same as null (clears it);
 * anything else is trimmed and capped at 40 chars.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { category?: string | null };

  let category: string | null = null;
  if (typeof body.category === "string") {
    const trimmed = body.category.trim();
    category = trimmed.length > 0 ? trimmed.slice(0, 40) : null;
  }

  setVideoCategory(id, category);
  return Response.json({ ok: true, id, category });
}
