import {
  getActiveChannelId,
  getIntegration,
  listVideosMissingThumbnailText,
  updateVideoThumbnailText,
} from "@/lib/db";
import { ocrThumbnail } from "@/lib/thumbnail-ocr";
import { log } from "@/lib/logger";

/**
 * Batch thumbnail OCR for the active channel's videos. GET is a cheap
 * "how many are left" count so the Videos page can label its button
 * ("Run OCR (42 pending)") without kicking off any Claude calls. POST
 * streams progress over SSE (same shape as /api/youtube/sync) while it
 * works through the backlog one thumbnail at a time — per-video failures
 * (broken image URL, transient Claude error, etc.) are logged and skipped
 * rather than aborting the whole batch, since a bad thumbnail from three
 * years ago shouldn't block OCR-ing the other 500.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const PACE_MS = 150;
const EVENT_TEXT_PREVIEW = 80;

function encodeSSE(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function GET() {
  if (!getActiveChannelId()) {
    return Response.json({ pending: 0 });
  }
  const pending = listVideosMissingThumbnailText(10_000).length;
  return Response.json({ pending });
}

export async function POST(req: Request) {
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return Response.json(
      { error: "Claude API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }
  if (!getActiveChannelId()) {
    return Response.json(
      { error: "No active channel selected." },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  const limit = Math.min(MAX_LIMIT, Math.max(1, body.limit ?? DEFAULT_LIMIT));

  const targets = listVideosMissingThumbnailText(limit);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encodeSSE(event));
      const startedAt = Date.now();
      const total = targets.length;
      let done = 0;
      let failed = 0;

      log.info("ocr", "Thumbnail OCR batch started", { total });
      try {
        send({ type: "start", total });

        for (const v of targets) {
          try {
            const text = await ocrThumbnail(v.thumbnail_url!, apiKey);
            updateVideoThumbnailText(v.id, text || null);
            done++;
            send({
              type: "progress",
              done,
              total,
              videoId: v.id,
              ok: true,
              text: text.slice(0, EVENT_TEXT_PREVIEW),
            });
          } catch (err) {
            failed++;
            done++;
            const message = err instanceof Error ? err.message : String(err);
            log.warn("ocr", "Thumbnail OCR failed for video", {
              videoId: v.id,
              error: message,
            });
            send({
              type: "progress",
              done,
              total,
              videoId: v.id,
              ok: false,
              error: message,
            });
          }
          await new Promise((r) => setTimeout(r, PACE_MS));
        }

        send({ type: "done", done, failed, total });
        log.info("ocr", "Thumbnail OCR batch finished", {
          done,
          failed,
          total,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
