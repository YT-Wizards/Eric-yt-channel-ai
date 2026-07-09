import { NextResponse } from "next/server";
import { getYouTubeQuotaToday } from "@/lib/db";

export const runtime = "nodejs";

// YouTube Data API's default daily project quota. Not user-configurable
// today — hardcoded to match what Google grants a fresh project.
const DAILY_QUOTA_LIMIT = 10_000;

/**
 * GET /api/ideation/quota
 *
 * Rough "how much YouTube API quota have we burned today" counter for
 * the Ideation Videos tab header. See `addYouTubeQuotaUnits` in db.ts
 * for the day-bucketing scheme.
 */
export async function GET() {
  return NextResponse.json({
    used: getYouTubeQuotaToday(),
    limit: DAILY_QUOTA_LIMIT,
  });
}
