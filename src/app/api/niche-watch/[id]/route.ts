import { NextResponse } from "next/server";
import { deleteWatchNiche } from "@/lib/db";

export const runtime = "nodejs";

/** Per-niche operation: delete a watch niche (cascades to its hits). */

type Ctx = { params: Promise<{ id: string }> };

async function parseId(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  const isClientError = message === "No active channel selected";
  return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const ok = deleteWatchNiche(id);
    if (!ok) return NextResponse.json({ error: "Niche not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
