import { NextResponse } from "next/server";
import { getLatestTranscriptionJob } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Most-recent transcription job (Apify or Deepgram — they share the
 * transcription_jobs table). The /videos batch banner polls this every
 * 2s while a run is in progress for live "43 of 172 done, $0.86 spent"
 * progress numbers. Thin wrapper around the DB helper.
 */
export async function GET() {
  const job = getLatestTranscriptionJob();
  return NextResponse.json({ job: job ?? null });
}
