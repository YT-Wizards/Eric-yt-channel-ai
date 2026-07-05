"use client";

import { useCallback, useState } from "react";
import { RefreshCw, Loader2, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Sync channel" button for the Videos page header.
 *
 * Re-runs a full channel sync against the active channel's saved
 * binding: re-lists every upload, re-fetches video details (so view /
 * like counts on existing videos refresh too), pulls transcripts for
 * any new videos, and kicks off a best-effort comment sync. Because
 * every downstream surface — Hook Lab, Formula Analyzer, the Dashboard
 * aggregates, the AI chat's local-DB tools — reads the same `videos` /
 * `transcripts` / `comments` tables, one sync here propagates
 * everywhere.
 *
 * Why this exists: previously a channel was only ever synced once, at
 * the moment it was added on the Integrations page. New uploads after
 * that never appeared until the user manually re-synced from
 * Integrations — which most users never discovered. This button makes
 * "pull my latest videos" a one-click action from the page where the
 * user actually looks at their videos.
 *
 * The /api/youtube/sync endpoint streams Server-Sent Events; we read
 * the stream and surface a compact live status (Listing… / Fetching
 * 45/120 / Transcripts 12/120) right in the button, then fire
 * `onSynced` so the parent page re-fetches its list.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "done"; added: number; total: number }
  | { kind: "error"; message: string };

export function SyncChannelButton({ onSynced }: { onSynced: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const sync = useCallback(async () => {
    setPhase({ kind: "running", label: "Starting…" });
    try {
      const res = await fetch("/api/youtube/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Empty body → the endpoint syncs the ACTIVE channel (it resolves
        // the active channel's own binding server-side). We deliberately do
        // NOT pass an input here, so this always re-syncs whatever channel
        // the user is currently viewing — never a different one.
        body: "{}",
      });

      if (!res.ok || !res.body) {
        // Non-stream error (e.g. 400 no key, 409 transcription running).
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase({
          kind: "error",
          message: data.error ?? `Sync failed (HTTP ${res.status})`,
        });
        return;
      }

      // Read the SSE stream. Each event is a `data: {...}\n\n` chunk.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let savedCount = 0;
      let totalCount = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        // Last element is an incomplete chunk — keep it in the buffer.
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          switch (event.type) {
            case "status": {
              const step = String(event.step ?? "");
              if (step === "resolving")
                setPhase({ kind: "running", label: "Resolving channel…" });
              else if (step === "listing")
                setPhase({ kind: "running", label: "Listing uploads…" });
              else if (step === "listed")
                setPhase({
                  kind: "running",
                  label: `Found ${Number(event.total ?? 0)} videos…`,
                });
              else if (step === "fetching")
                setPhase({ kind: "running", label: "Fetching details…" });
              else if (step === "transcripts")
                setPhase({ kind: "running", label: "Fetching transcripts…" });
              break;
            }
            case "progress": {
              const phaseName = String(event.phase ?? "");
              const count = Number(event.count ?? 0);
              const total = Number(event.total ?? 0);
              if (phaseName === "fetching")
                setPhase({
                  kind: "running",
                  label: `Fetching ${count}/${total}…`,
                });
              else if (phaseName === "transcripts")
                setPhase({
                  kind: "running",
                  label: `Transcripts ${count}/${total}…`,
                });
              else if (phaseName === "listing")
                setPhase({ kind: "running", label: `Listing ${count}…` });
              break;
            }
            case "done": {
              savedCount = Number(event.saved ?? 0);
              totalCount = Number(event.total ?? 0);
              break;
            }
            case "error": {
              setPhase({
                kind: "error",
                message: String(event.message ?? "Sync failed"),
              });
              return;
            }
          }
        }
      }

      setPhase({ kind: "done", added: savedCount, total: totalCount });
      onSynced();
      // Auto-clear the success state after a few seconds so the button
      // returns to its normal label.
      setTimeout(() => {
        setPhase((p) => (p.kind === "done" ? { kind: "idle" } : p));
      }, 6000);
    } catch (err) {
      setPhase({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Sync failed — couldn't reach the server.",
      });
    }
  }, [onSynced]);

  const running = phase.kind === "running";

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={sync}
        disabled={running}
        className="gap-1.5"
        title="Pull the latest uploads + transcripts + comments for this channel. Updates Hook Lab, Formula Analyzer, the Dashboard and the AI chat."
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : phase.kind === "done" ? (
          <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        {running
          ? phase.label
          : phase.kind === "done"
            ? "Synced"
            : "Sync channel"}
      </Button>
      {phase.kind === "done" && (
        <span className="text-[11px] text-muted-foreground">
          {phase.added > 0
            ? `${phase.added} video${phase.added === 1 ? "" : "s"} updated/added`
            : "Already up to date"}
        </span>
      )}
      {phase.kind === "error" && (
        <span className="inline-flex max-w-[260px] items-start gap-1 text-[11px] text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {phase.message}
        </span>
      )}
    </div>
  );
}
