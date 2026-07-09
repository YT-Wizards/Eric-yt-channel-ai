import { NextResponse } from "next/server";
import { addCommentTag, removeCommentTag } from "@/lib/db";

export const runtime = "nodejs";

/** Quick-tag triage labels — kept in sync with the CHECK-style list in db.ts. */
const VALID_TAGS = ["hook", "objection", "question", "praise", "attack"] as const;
type ValidTag = (typeof VALID_TAGS)[number];

function isValidTag(tag: unknown): tag is ValidTag {
  return typeof tag === "string" && (VALID_TAGS as readonly string[]).includes(tag);
}

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/comments/:id/tags
 *
 * Attach a quick-tag (hook/objection/question/praise/attack) to a single
 * cached comment. Body: { tag: string }. 400 on a missing/invalid tag.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { tag?: string };
  if (!isValidTag(body.tag)) {
    return NextResponse.json(
      { error: `Invalid tag. Must be one of ${VALID_TAGS.join(", ")}` },
      { status: 400 }
    );
  }
  addCommentTag(id, body.tag);
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/comments/:id/tags
 *
 * Remove a quick-tag from a comment. Body: { tag: string }. 400 on a
 * missing/invalid tag.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { tag?: string };
  if (!isValidTag(body.tag)) {
    return NextResponse.json(
      { error: `Invalid tag. Must be one of ${VALID_TAGS.join(", ")}` },
      { status: 400 }
    );
  }
  removeCommentTag(id, body.tag);
  return NextResponse.json({ ok: true });
}
