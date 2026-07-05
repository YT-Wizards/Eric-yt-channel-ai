import {
  commentCount,
  createCommentSyncJob,
  getActiveChannelId,
  getActiveCommentSyncJob,
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  listChannelVideosForCommentSync,
  setActiveChannelId,
  setSetting,
  updateCommentSyncJob,
  upsertChannel,
  upsertComments,
  upsertVideo,
} from "@/lib/db";
import {
  fetchCommentThreads,
  fetchVideos,
  listUploadIds,
  resolveChannel,
  YouTubeApiError,
} from "@/lib/youtube";
import { log } from "@/lib/logger";

/**
 * After a channel sync brings in fresh videos, kick off a best-effort
 * comment sync for the ones that have NO comments yet. We don't block
 * on it — the sync route's `done` event already fired by the time this
 * starts — but we DO surface progress via a `comment_sync_jobs` row so
 * the /videos banner picks it up automatically.
 *
 * Scope: only "missing-comments" videos (HAVING comments_count = 0),
 * cap at AUTO_COMMENT_SYNC_LIMIT, gentle pacing. With the default cap
 * of 20 videos × 1 commentThreads.list call = 20 quota units, this
 * doesn't meaningfully dent the 10k/day free quota.
 */
const AUTO_COMMENT_SYNC_LIMIT = 20;
const AUTO_COMMENT_THREADS_PER_VIDEO = 100;
const AUTO_COMMENT_PACE_MS = 200;

async function autoSyncNewVideoComments(apiKey: string): Promise<void> {
  // Bail if another comment-sync is already running — let it finish
  // instead of racing it.
  if (getActiveCommentSyncJob()) return;

  const targets = listChannelVideosForCommentSync({
    onlyMissing: true,
    orderBy: "recent",
    limit: AUTO_COMMENT_SYNC_LIMIT,
  });
  if (targets.length === 0) return;

  const jobId = createCommentSyncJob(targets.length);
  log.info("comments-sync", "Auto-sync after channel sync started", {
    jobId,
    videoCount: targets.length,
  });

  let done = 0;
  let failed = 0;
  let commentsAdded = 0;
  let lastError: string | null = null;

  for (const v of targets) {
    updateCommentSyncJob(jobId, { current_video_id: v.id });
    try {
      const before = commentCount(v.id).total;
      const threads = await fetchCommentThreads(v.id, apiKey, {
        maxThreads: AUTO_COMMENT_THREADS_PER_VIDEO,
        order: "relevance",
      });
      upsertComments(
        threads.map((c) => ({
          id: c.id,
          video_id: v.id,
          parent_id: c.parentId,
          author: c.author,
          author_channel_id: c.authorChannelId,
          text: c.text,
          like_count: c.likes,
          reply_count: c.replyCount,
          published_at: c.publishedAt,
          updated_at: c.updatedAt,
        }))
      );
      const after = commentCount(v.id).total;
      commentsAdded += Math.max(0, after - before);
      done++;
    } catch (err) {
      failed++;
      lastError = err instanceof Error ? err.message : String(err);
      // Per-video failures are common (comments disabled, removed
      // videos, etc.). Don't tear down the auto-sync over them.
    }
    updateCommentSyncJob(jobId, {
      done,
      failed,
      comments_added: commentsAdded,
      last_error: lastError,
    });
    await new Promise((r) => setTimeout(r, AUTO_COMMENT_PACE_MS));
  }

  updateCommentSyncJob(jobId, {
    status: failed === targets.length ? "failed" : "completed",
    completed_at: Math.floor(Date.now() / 1000),
    current_video_id: null,
  });
  log.info("comments-sync", "Auto-sync after channel sync finished", {
    jobId,
    done,
    failed,
    commentsAdded,
  });
}

export const runtime = "nodejs";

function encodeSSE(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    input?: string;
    max?: number;
  };

  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return Response.json(
      { error: "YouTube API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }

  // Determine what channel to sync. Precedence:
  //   1. explicit body.input — the "add a new channel" flow (Integrations)
  //      passes this and DOES intend to switch the active channel to it.
  //   2. the ACTIVE channel — via its recorded per-channel input, falling
  //      back to the active channel ID itself (resolveChannel accepts a raw
  //      UC… id, no search-quota cost).
  //   3. the legacy global binding, only as a last resort.
  //
  // Using the active channel (NOT the global `youtube.channelInput`) is what
  // makes the Videos-page "Sync channel" button re-sync the channel the user
  // is actually looking at. `youtube.channelInput` holds the LAST-SYNCED
  // channel, and switching the active channel never updates it — so on a
  // multi-channel account the old `body.input || youtube.channelInput` logic
  // synced, and then `setActiveChannelId(ch.id)` below switched to, the WRONG
  // channel every time (the "sync jumps me to another channel" bug).
  const activeId = getActiveChannelId();
  const input =
    body.input?.trim() ||
    (activeId ? getSetting(`youtube.channelInput.${activeId}`) : null) ||
    activeId ||
    getSetting("youtube.channelInput");
  if (!input) {
    return Response.json(
      { error: "No channel bound. Provide input (handle/URL/ID) or bind a channel first." },
      { status: 400 }
    );
  }

  // Refuse to sync while a transcription batch is running. Concurrent
  // writes (sync upserting videos / transcripts and the batch writing
  // transcripts for the same rows) historically tripped SQLite's
  // "database disk image is malformed" error. Easier to block than to
  // orchestrate cancellation.
  const activeJob = getActiveTranscriptionJob();
  if (activeJob) {
    return Response.json(
      {
        error:
          "A transcription batch is currently running — wait for it to finish (or cancel it from /videos) before switching or re-syncing the channel.",
        jobId: activeJob.id,
      },
      { status: 409 }
    );
  }

  const max = Math.min(5000, Math.max(1, body.max ?? 1000));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encodeSSE(event));
      const startedAt = Date.now();
      // Raise a flag that `POST /api/deepgram/transcribe-batch` checks
      // before it starts — mirror of the job-in-progress check that sync
      // already respects. Cleared in `finally`.
      setSetting("sync.inProgress", "1");
      log.info("sync", "Sync started", { input, max });
      try {
        send({ type: "status", step: "resolving", message: "Resolving channel…" });
        const ch = await resolveChannel(input, apiKey);

        // Multi-channel: we *append* this channel rather than purging the
        // previous one. The user may legitimately want analytics for several
        // channels at once and switch between them via the channel switcher.
        // Every query that consumes `videos` / `transcripts` / `comments` is
        // already scoped through `getActiveChannelId()`, so cross-channel
        // bleed isn't possible.
        const previousChannelId = getSetting("youtube.channelId");
        const newBinding = previousChannelId !== ch.id;
        if (newBinding) {
          log.info("sync", "Active channel changed (appended, no purge)", {
            previousChannelId,
            newChannelId: ch.id,
          });
        }

        // Persist binding + channel row. `channelInput` is recorded
        // per-channel so re-syncs of any channel can recover the original
        // user input (handle/URL/ID); the legacy `youtube.channelInput` is
        // updated to the active channel's input so older code paths keep
        // working.
        setSetting("youtube.channelInput", input);
        setSetting(`youtube.channelInput.${ch.id}`, input);
        setActiveChannelId(ch.id);
        upsertChannel({
          id: ch.id,
          title: ch.title,
          handle: ch.handle,
          description: ch.description,
          subscriber_count: ch.subscribers,
          view_count: ch.views,
          video_count: ch.videoCount,
        });
        send({
          type: "channel",
          channel: {
            id: ch.id,
            title: ch.title,
            handle: ch.handle,
            subscribers: ch.subscribers,
            views: ch.views,
            videoCount: ch.videoCount,
            thumbnail: ch.thumbnail,
          },
        });

        send({ type: "status", step: "listing", message: "Listing uploads…" });
        const ids = await listUploadIds(ch.uploadsPlaylistId, apiKey, {
          max,
          onPage: (n) => send({ type: "progress", phase: "listing", count: n }),
        });
        send({ type: "status", step: "listed", total: ids.length });

        send({ type: "status", step: "fetching", message: "Fetching video details…" });
        let saved = 0;
        const videos = await fetchVideos(ids, apiKey, {
          onBatch: (done) =>
            send({ type: "progress", phase: "fetching", count: done, total: ids.length }),
        });

        for (const v of videos) {
          upsertVideo({
            id: v.id,
            channel_id: v.channelId,
            title: v.title,
            description: v.description,
            published_at: v.publishedAt,
            duration_seconds: v.durationSeconds,
            views: v.views,
            likes: v.likes,
            comments: v.comments,
            thumbnail_url: v.thumbnail,
            tags: v.tags.length ? JSON.stringify(v.tags) : null,
          });
          saved++;
        }

        // Transcripts are NOT auto-fetched during sync anymore.
        // Transcription is Deepgram-only and explicit — the user runs it
        // from the Videos page (bulk) or a video's Transcript tab.

        send({
          type: "done",
          saved,
          total: ids.length,
        });
        log.info("sync", "Sync completed", {
          channelId: ch.id,
          videosSaved: saved,
          idsListed: ids.length,
          durationMs: Date.now() - startedAt,
        });

        // Best-effort: auto-sync comments for the newest videos that
        // don't have any in the local DB yet. FIRE-AND-FORGET so the
        // SSE stream closes immediately and the user isn't kept
        // waiting on the comment polls. The user-visible signal is the
        // comment_sync_jobs row that the /videos banner picks up.
        void autoSyncNewVideoComments(apiKey).catch((err) => {
          log.warn("sync", "Auto-comment-sync after channel sync failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (err) {
        const status = err instanceof YouTubeApiError ? err.status : 500;
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", status, message });
        log.error("sync", `Sync failed: ${message}`, err, {
          input,
          status,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        // Always clear the sync flag, success or error.
        setSetting("sync.inProgress", "0");
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

export async function GET() {
  const input = getSetting("youtube.channelInput");
  const id = getSetting("youtube.channelId");
  return Response.json({ bound: !!id, input, channelId: id });
}
