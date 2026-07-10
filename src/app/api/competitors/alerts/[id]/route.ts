import { NextResponse } from "next/server";
import { deleteCompetitorAlert } from "@/lib/db";

export const runtime = "nodejs";

/** Dismiss (permanently delete) a single competitor alert. */

type Ctx = { params: Promise<{ id: string }> };

async function parseId(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const ok = deleteCompetitorAlert(id);
  if (!ok) return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
