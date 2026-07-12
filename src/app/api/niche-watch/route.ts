import { NextResponse } from "next/server";
import { addWatchNiche, listNicheHits, listWatchNiches } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Watch-niche collection for the active channel: list configured niches
 * (with hit counts) + the latest ranked hits in one payload, and add a
 * new niche. Deleting and scanning live under their own routes —
 * src/app/api/niche-watch/[id]/route.ts and
 * src/app/api/niche-watch/scan/route.ts.
 */

const HITS_LIMIT = 50;

type CreateNicheBody = { query?: unknown };

/** Maps a thrown Error to the right HTTP status: known validation /
 * missing-channel messages are 400s, anything else is a 500. */
function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  const isClientError =
    message === "No active channel selected" ||
    message.startsWith("Maximum") ||
    message.startsWith("Watch niche query");
  return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
}

export async function GET() {
  try {
    return NextResponse.json({
      niches: listWatchNiches(),
      hits: listNicheHits(HITS_LIMIT),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as CreateNicheBody;
  if (typeof body.query !== "string" || !body.query.trim()) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  try {
    const niche = addWatchNiche(body.query);
    return NextResponse.json({ niche });
  } catch (err) {
    return errorResponse(err);
  }
}
