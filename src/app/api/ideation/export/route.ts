import { NextResponse } from "next/server";
import { db, getActiveChannelId, getChannel } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/ideation/export?format=csv|json
 *
 * Bulk data export of the active channel's videos, scoped to whichever
 * channel is currently active (same scoping every other Ideation
 * endpoint uses). Two flavours:
 *  - csv: a spreadsheet-friendly download.
 *  - json: a "full export for AI" payload with channel + export metadata
 *    alongside the rows, for pasting into an external tool/LLM.
 * 400 when there's no active channel to scope to.
 */

type ExportRow = {
  id: string;
  title: string;
  thumbnail_text: string | null;
  category: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  duration_seconds: number | null;
  published_at: number | null;
};

const CSV_HEADERS = [
  "id",
  "title",
  "thumbnail_text",
  "category",
  "views",
  "likes",
  "comments",
  "duration_seconds",
  "published_at",
] as const;

/** RFC 4180 field-quoting: wrap in quotes (escaping embedded quotes) when
 * the value contains a comma, quote, or newline. */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function publishedAtIso(unixSeconds: number | null): string {
  if (unixSeconds === null) return "";
  return new Date(unixSeconds * 1000).toISOString();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";

  const activeId = getActiveChannelId();
  if (!activeId) {
    return NextResponse.json(
      { error: "No active channel to export videos from" },
      { status: 400 }
    );
  }

  const rows = db
    .prepare(
      `SELECT id, title, thumbnail_text, category, views, likes, comments, duration_seconds, published_at
       FROM videos
       WHERE channel_id = ?
       ORDER BY COALESCE(published_at, imported_at) DESC`
    )
    .all(activeId) as ExportRow[];

  if (format === "json") {
    const channel = getChannel();
    const payload = {
      channel: { id: activeId, title: channel?.title ?? null },
      exportedAt: new Date().toISOString(),
      videos: rows,
    };
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="videos-export.json"',
      },
    });
  }

  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.id),
        csvField(r.title),
        csvField(r.thumbnail_text),
        csvField(r.category),
        csvField(r.views),
        csvField(r.likes),
        csvField(r.comments),
        csvField(r.duration_seconds),
        csvField(publishedAtIso(r.published_at)),
      ].join(",")
    );
  }
  const csv = lines.join("\r\n") + "\r\n";

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="videos-export.csv"',
    },
  });
}
