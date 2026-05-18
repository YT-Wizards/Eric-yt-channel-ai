import { NextResponse } from "next/server";
import { listIntegrations, setIntegration } from "@/lib/db";

// Deepgram is the primary transcription path for this local-only build:
// yt-dlp pulls audio into RAM and streams it to Deepgram, transcripts
// land in SQLite. Apify is kept as an optional fallback for users who'd
// rather not run yt-dlp on their machine (uses residential proxies on
// Apify's side, no audio transit through this host).
// "exa" was removed when we wired Claude's native web_search server tool
// (see ai-provider.ts) — that obviates the third-party search key and a
// duplicate "Web search" toggle in the chat. Existing exa rows in old
// DBs are harmless; this list just stops accepting new ones and stops
// surfacing them in the UI.
const ALLOWED = [
  "claude",
  "deepgram",
  "apify",
  "youtube",
  "google_gemini",
] as const;
type Name = (typeof ALLOWED)[number];

function mask(key: string | null) {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}••••••${key.slice(-4)}`;
}

export async function GET() {
  const rows = listIntegrations();
  const map = Object.fromEntries(
    ALLOWED.map((name) => {
      const row = rows.find((r) => r.name === name);
      return [
        name,
        {
          name,
          hasKey: !!row?.api_key,
          masked: mask(row?.api_key ?? null),
          enabled: !!row?.enabled,
        },
      ];
    })
  );
  return NextResponse.json({ integrations: map });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { name?: string; api_key?: string };
  if (!body.name || !ALLOWED.includes(body.name as Name)) {
    return NextResponse.json({ error: "invalid integration name" }, { status: 400 });
  }
  if (typeof body.api_key !== "string") {
    return NextResponse.json({ error: "api_key required" }, { status: 400 });
  }
  setIntegration(body.name, body.api_key.trim());
  return NextResponse.json({ ok: true });
}
