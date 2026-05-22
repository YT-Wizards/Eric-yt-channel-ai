"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookmarkPlus,
  Trash2,
  Loader2,
  Star,
  Check,
  RotateCcw,
  Plus,
  X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Hook = {
  id: number;
  comment_id: string | null;
  source_video_id: string | null;
  source_video_title: string | null;
  quote: string;
  author: string | null;
  score: number | null;
  status: "available" | "used";
  used_in_video_id: string | null;
  note: string | null;
  added_at: number;
};

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function HooksLibraryPage() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "available" | "used">("all");
  const [error, setError] = useState<string | null>(null);
  // "Add hook" inline form — lets the user put their own idea / quote
  // straight into the library, without it having to come from a video
  // comment. The POST endpoint already accepts a comment-less entry.
  const [addOpen, setAddOpen] = useState(false);
  const [draftQuote, setDraftQuote] = useState("");
  const [draftAuthor, setDraftAuthor] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/hooks-library", { cache: "no-store" });
      const d = (await r.json()) as { hooks: Hook[] };
      setHooks(d.hooks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered =
    filter === "all" ? hooks : hooks.filter((h) => h.status === filter);

  const setStatus = async (id: number, status: "available" | "used") => {
    await fetch(`/api/hooks-library/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    refresh();
  };

  const setScore = async (id: number, score: number) => {
    await fetch(`/api/hooks-library/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ score }),
    });
    refresh();
  };

  const remove = async (id: number) => {
    if (!confirm("Remove this hook from the library?")) return;
    await fetch(`/api/hooks-library/${id}`, { method: "DELETE" });
    refresh();
  };

  // Save a hand-typed hook. quote is the only required field; author /
  // note are optional context for the user's own reference.
  const addManualHook = async () => {
    const quote = draftQuote.trim();
    if (!quote) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/hooks-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote,
          author: draftAuthor.trim() || null,
          note: draftNote.trim() || null,
        }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      setDraftQuote("");
      setDraftAuthor("");
      setDraftNote("");
      setAddOpen(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to add hook");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  const availableCount = hooks.filter((h) => h.status === "available").length;
  const usedCount = hooks.filter((h) => h.status === "used").length;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BookmarkPlus className="h-6 w-6" />
            Hooks Library
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Comments and quotes you saved to reuse as hooks in future videos.
            Available {availableCount} · Used {usedCount}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(["all", "available", "used"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors",
                  filter === f
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            onClick={() => setAddOpen((v) => !v)}
            className="gap-1.5"
          >
            {addOpen ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {addOpen ? "Cancel" : "Add hook"}
          </Button>
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Inline "add your own hook" form. The library isn't only for
          comment-sourced quotes — you can drop any idea / line you want
          to reuse straight in here. */}
      {addOpen && (
        <Card className="mb-3">
          <CardContent className="space-y-3 p-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Hook / quote <span className="text-destructive">*</span>
              </label>
              <Textarea
                value={draftQuote}
                onChange={(e) => setDraftQuote(e.target.value)}
                placeholder="The opening line or idea you want to reuse in a future video…"
                className="min-h-[80px] text-sm"
                autoFocus
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Author / source <span className="text-muted-foreground/60">(optional)</span>
                </label>
                <Input
                  value={draftAuthor}
                  onChange={(e) => setDraftAuthor(e.target.value)}
                  placeholder="e.g. a viewer's name, a book, yourself"
                  className="text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Note <span className="text-muted-foreground/60">(optional)</span>
                </label>
                <Input
                  value={draftNote}
                  onChange={(e) => setDraftNote(e.target.value)}
                  placeholder="Why it works / where to use it"
                  className="text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAddOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={addManualHook}
                disabled={saving || !draftQuote.trim()}
                className="gap-1.5"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save to library
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No hooks saved yet. Click <strong>+ Add hook</strong> above to type
            in your own idea, or open a video&apos;s Comments tab and click{" "}
            <strong>Save as hook</strong> on any comment.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Quote</th>
                  <th className="px-3 py-2 text-left">Author</th>
                  <th className="px-3 py-2 text-left">Source video</th>
                  <th className="px-3 py-2 text-right">Score</th>
                  <th className="px-3 py-2 text-right">Status</th>
                  <th className="px-3 py-2 text-right">Date</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((h) => (
                  <tr
                    key={h.id}
                    className="border-b border-border/40 hover:bg-accent/30"
                  >
                    <td className="max-w-[420px] px-3 py-2">
                      <div className="line-clamp-3 text-xs leading-relaxed">
                        {h.quote}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {h.author ?? "—"}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-xs">
                      {h.source_video_id ? (
                        <a
                          href={`/videos/${h.source_video_id}`}
                          className="text-primary hover:underline"
                        >
                          {h.source_video_title ?? h.source_video_id}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-0.5">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            onClick={() => setScore(h.id, n)}
                            className={cn(
                              "p-0.5 transition-colors",
                              (h.score ?? 0) >= n
                                ? "text-amber-500"
                                : "text-muted-foreground/30 hover:text-amber-500/70"
                            )}
                            title={`Rate ${n}/5`}
                          >
                            <Star className="h-3.5 w-3.5 fill-current" />
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() =>
                          setStatus(
                            h.id,
                            h.status === "available" ? "used" : "available"
                          )
                        }
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          h.status === "used"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground hover:bg-accent"
                        )}
                      >
                        {h.status === "used" ? (
                          <>
                            <Check className="h-2.5 w-2.5" />
                            Used
                          </>
                        ) : (
                          <>
                            <RotateCcw className="h-2.5 w-2.5" />
                            Available
                          </>
                        )}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right text-[11px] text-muted-foreground">
                      {fmtDate(h.added_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => remove(h.id)}
                        className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
