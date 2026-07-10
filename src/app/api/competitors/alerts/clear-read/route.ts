import { NextResponse } from "next/server";
import { clearReadCompetitorAlerts } from "@/lib/db";

export const runtime = "nodejs";

/** Bulk-remove every already-read competitor alert. Unread alerts are
 * left untouched — see clearReadCompetitorAlerts in db.ts. */
export async function POST() {
  const removed = clearReadCompetitorAlerts();
  return NextResponse.json({ removed });
}
