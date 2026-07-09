"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Plus,
  X,
  MoreHorizontal,
  Link2,
  Search,
  AlertTriangle,
  MessageSquare,
  MessagesSquare,
  PenLine,
  Plug,
  LayoutDashboard,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Board tab of the Ideation hub — a 6-column kanban that walks a video
 * idea from a raw spark through to a published video. Everything here
 * talks to /api/ideas: GET on mount, then optimistic PATCH/POST/DELETE
 * with a revert-on-failure so the board never lies about server state
 * for long. Drag & drop is plain HTML5 (no deps) with a "Move to →"
 * menu as the non-drag fallback for every card.
 */

type IdeaStage =
  | "idea"
  | "research"
  | "script"
  | "voiceover"
  | "editing"
  | "published";

type Demand = "high" | "medium" | "low";

type Idea = {
  id: number;
  channel_id: string;
  title: string;
  notes: string | null;
  stage: IdeaStage;
  category: string | null;
  demand: Demand | null;
  source_type: string | null;
  source_ref: string | null;
  position: number;
  linked_video_id: string | null;
  created_at: number;
  updated_at: number;
};

const PIPELINE: { stage: IdeaStage; label: string }[] = [
  { stage: "idea", label: "Idea" },
  { stage: "research", label: "Research" },
  { stage: "script", label: "Script" },
  { stage: "voiceover", label: "Voiceover" },
  { stage: "editing", label: "Editing" },
  { stage: "published", label: "Published" },
];

const DEMAND_OPTIONS: Demand[] = ["high", "medium", "low"];

const DEMAND_STYLES: Record<Demand, string> = {
  high: "bg-red-500/15 text-red-700 dark:text-red-400",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  low: "bg-muted text-muted-foreground",
};

/** Maps a raw source_type onto a short badge word + icon. Unknown /
 * missing source types render nothing rather than guessing. */
const SOURCE_BADGES: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  gap: { label: "gap", icon: Search },
  competitor_alert: { label: "alert", icon: AlertTriangle },
  comment: { label: "comment", icon: MessageSquare },
  chat: { label: "chat", icon: MessagesSquare },
  manual: { label: "manual", icon: PenLine },
};

function fmtRelative(ts: number): string {
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 0 || sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  const days = Math.floor(sec / 86400);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Groups the flat idea list into the 6 pipeline columns, sorted by
 * position within each column. Never trusts cross-stage server order —
 * only within-stage `position ASC` is meaningful. */
function bucketByStage(ideas: Idea[]): Record<IdeaStage, Idea[]> {
  const buckets = {
    idea: [],
    research: [],
    script: [],
    voiceover: [],
    editing: [],
    published: [],
  } as Record<IdeaStage, Idea[]>;
  for (const idea of ideas) {
    (buckets[idea.stage] ??= []).push(idea);
  }
  for (const stage of Object.keys(buckets) as IdeaStage[]) {
    buckets[stage].sort((a, b) => a.position - b.position);
  }
  return buckets;
}

type NewIdeaForm = {
  title: string;
  notes: string;
  category: string;
  demand: Demand | "";
};

const EMPTY_FORM: NewIdeaForm = { title: "", notes: "", category: "", demand: "" };

export function BoardTab() {
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noChannel, setNoChannel] = useState(false);

  // Small inline "toast-line" for a failed background action (move,
  // patch, delete). Auto-clears on the next successful action.
  const [actionError, setActionError] = useState<string | null>(null);

  // Which column currently has its inline "add" form open.
  const [addingStage, setAddingStage] = useState<IdeaStage | null>(null);
  // Which card currently has its "⋯" menu open.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  // Which card currently has its edit panel expanded.
  const [editingId, setEditingId] = useState<number | null>(null);
  // Card id currently being dragged.
  const [draggingId, setDraggingId] = useState<number | null>(null);
  // Column currently under the dragged card (for the drop highlight).
  const [dragOverStage, setDragOverStage] = useState<IdeaStage | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/ideas", { cache: "no-store" });
      const d = (await r.json().catch(() => ({}))) as { ideas?: Idea[]; error?: string };
      if (!r.ok) {
        if (r.status === 400 && d.error === "No active channel selected") {
          setNoChannel(true);
          setIdeas([]);
        } else {
          setLoadError(d.error ?? `HTTP ${r.status}`);
        }
        return;
      }
      setNoChannel(false);
      setLoadError(null);
      setIdeas(d.ideas ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const buckets = useMemo(() => bucketByStage(ideas ?? []), [ideas]);

  /** Optimistically move a card to (stage, position); reverts the
   * whole list on a non-OK response and surfaces actionError.
   *
   * The snapshot read and the optimistic write are two separate,
   * side-effect-free setIdeas calls (mirroring patchIdea/deleteIdeaCard
   * below) and the fetch happens strictly outside any updater — React
   * may invoke a state-updater function more than once per commit
   * (StrictMode dev double-invoke, concurrent re-renders), and a fetch
   * embedded inside one would fire duplicate PATCH requests. */
  const moveCard = useCallback(
    async (id: number, stage: IdeaStage, position: number) => {
      const snapshot = await new Promise<Idea[] | null>((resolve) =>
        setIdeas((prev) => {
          resolve(prev);
          return prev;
        })
      );
      if (!snapshot) return;
      const card = snapshot.find((i) => i.id === id);
      if (!card) return;

      // Recompute local positions for the (possibly new) column so the
      // UI reorders instantly, mirroring the server's renumbering.
      const withoutCard = snapshot.filter((i) => i.id !== id);
      const destSiblings = withoutCard
        .filter((i) => i.stage === stage)
        .sort((a, b) => a.position - b.position);
      const clamped = Math.max(0, Math.min(position, destSiblings.length));
      const reordered = [
        ...destSiblings.slice(0, clamped),
        { ...card, stage },
        ...destSiblings.slice(clamped),
      ].map((c, idx) => ({ ...c, position: idx }));
      const others = withoutCard.filter((i) => i.stage !== stage);
      setIdeas([...others, ...reordered]);

      try {
        const res = await fetch(`/api/ideas/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ move: { stage, position } }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setActionError(d.error ?? `Move failed (HTTP ${res.status})`);
          setIdeas(snapshot);
          return;
        }
        setActionError(null);
        // Reconcile with server truth (position renumbering of
        // siblings) without hand-rolling it a second time here.
        refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Move failed");
        setIdeas(snapshot);
      }
    },
    [refresh]
  );

  const addIdea = useCallback(
    async (stage: IdeaStage, form: NewIdeaForm) => {
      const title = form.title.trim();
      if (!title) return;
      try {
        const r = await fetch("/api/ideas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            notes: form.notes.trim() || undefined,
            stage,
            category: form.category.trim() || undefined,
            demand: form.demand || undefined,
            source_type: "manual",
          }),
        });
        const d = (await r.json().catch(() => ({}))) as { idea?: Idea; error?: string };
        if (!r.ok || !d.idea) {
          setActionError(d.error ?? `Add failed (HTTP ${r.status})`);
          return;
        }
        setActionError(null);
        // The server always assigns new cards the highest position in
        // their stage (appended), but the UX contract is "new card
        // appears at the top of the column, right under the form that
        // created it." Override position locally so it sorts first in
        // its bucket; a future refresh() reconciles with true DB order.
        const created: Idea = { ...d.idea, position: -1 };
        setIdeas((prev) => (prev ? [created, ...prev] : [created]));
        setAddingStage(null);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Add failed");
      }
    },
    []
  );

  const patchIdea = useCallback(async (id: number, patch: Record<string, unknown>) => {
    const snapshot = await new Promise<Idea[] | null>((resolve) =>
      setIdeas((prev) => {
        resolve(prev);
        return prev;
      })
    );
    try {
      const r = await fetch(`/api/ideas/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => ({}))) as { idea?: Idea; error?: string };
      if (!r.ok || !d.idea) {
        setActionError(d.error ?? `Update failed (HTTP ${r.status})`);
        return false;
      }
      setActionError(null);
      const updated = d.idea;
      setIdeas((prev) =>
        prev ? prev.map((i) => (i.id === id ? updated : i)) : prev
      );
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed");
      setIdeas(snapshot);
      return false;
    }
  }, []);

  const deleteIdeaCard = useCallback(async (id: number) => {
    const snapshot = await new Promise<Idea[] | null>((resolve) =>
      setIdeas((prev) => {
        resolve(prev);
        return prev;
      })
    );
    setIdeas((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
    try {
      const r = await fetch(`/api/ideas/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setActionError(d.error ?? `Delete failed (HTTP ${r.status})`);
        setIdeas(snapshot);
        return;
      }
      setActionError(null);
      if (editingId === id) setEditingId(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
      setIdeas(snapshot);
    }
  }, [editingId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (noChannel) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="text-sm text-muted-foreground">
            No videos yet for this channel. Connect a channel and sync it
            to populate the idea pipeline.
          </div>
          <Link href="/integrations">
            <Button size="sm" className="gap-2">
              <Plug className="h-4 w-4" />
              Go to Integrations
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-destructive">
          Failed to load ideas: {loadError}
        </CardContent>
      </Card>
    );
  }

  const isEmpty = (ideas?.length ?? 0) === 0;

  return (
    <div className="space-y-3">
      {isEmpty && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <LayoutDashboard className="h-6 w-6" />
            </div>
            <p className="max-w-sm text-sm text-muted-foreground">
              No ideas yet. Feed the board from the Signals tab, the AI
              chat, or add one by hand.
            </p>
            <Button size="sm" className="gap-1.5" onClick={() => setAddingStage("idea")}>
              <Plus className="h-3.5 w-3.5" />
              New idea
            </Button>
          </CardContent>
        </Card>
      )}

      {actionError && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="rounded p-0.5 hover:bg-destructive/10"
            aria-label="Dismiss error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="overflow-x-auto pb-2">
        <div className="flex gap-3">
          {PIPELINE.map(({ stage, label }) => (
            <Column
              key={stage}
              stage={stage}
              label={label}
              cards={buckets[stage]}
              isAdding={addingStage === stage}
              onStartAdd={() => setAddingStage(stage)}
              onCancelAdd={() => setAddingStage(null)}
              onSubmitAdd={(form) => addIdea(stage, form)}
              menuFor={menuFor}
              onSetMenuFor={setMenuFor}
              editingId={editingId}
              onSetEditingId={setEditingId}
              draggingId={draggingId}
              onSetDraggingId={setDraggingId}
              isDragOver={dragOverStage === stage}
              onSetDragOverStage={setDragOverStage}
              onMove={moveCard}
              onPatch={patchIdea}
              onDelete={deleteIdeaCard}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Column({
  stage,
  label,
  cards,
  isAdding,
  onStartAdd,
  onCancelAdd,
  onSubmitAdd,
  menuFor,
  onSetMenuFor,
  editingId,
  onSetEditingId,
  draggingId,
  onSetDraggingId,
  isDragOver,
  onSetDragOverStage,
  onMove,
  onPatch,
  onDelete,
}: {
  stage: IdeaStage;
  label: string;
  cards: Idea[];
  isAdding: boolean;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onSubmitAdd: (form: NewIdeaForm) => void;
  menuFor: number | null;
  onSetMenuFor: (id: number | null) => void;
  editingId: number | null;
  onSetEditingId: (id: number | null) => void;
  draggingId: number | null;
  onSetDraggingId: (id: number | null) => void;
  isDragOver: boolean;
  onSetDragOverStage: (stage: IdeaStage | null) => void;
  onMove: (id: number, stage: IdeaStage, position: number) => void;
  onPatch: (id: number, patch: Record<string, unknown>) => Promise<boolean>;
  onDelete: (id: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onSetDragOverStage(stage);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when actually leaving the column container (not just
    // moving between its children).
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      onSetDragOverStage(null);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    onSetDragOverStage(null);
    const idStr = e.dataTransfer.getData("text/plain");
    const id = Number(idStr);
    if (!Number.isInteger(id)) return;

    // Compute the drop index by comparing the pointer's Y position
    // against each card's vertical midpoint. Falls back to "append to
    // end" when dropped below the last card or on empty column space.
    const container = listRef.current;
    let targetIndex = cards.length;
    if (container) {
      const cardEls = Array.from(
        container.querySelectorAll<HTMLElement>("[data-card-id]")
      ).filter((el) => Number(el.dataset.cardId) !== id);
      for (let i = 0; i < cardEls.length; i++) {
        const rect = cardEls[i].getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        if (e.clientY < midpoint) {
          targetIndex = i;
          break;
        }
        targetIndex = i + 1;
      }
    }
    onSetDraggingId(null);
    onMove(id, stage, targetIndex);
  };

  return (
    <div className="flex w-[260px] shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            {cards.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onStartAdd}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Add idea to ${label}`}
          title={`Add idea to ${label}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={listRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex min-h-[120px] flex-1 flex-col gap-2 rounded-lg border border-dashed border-transparent p-1.5 transition-colors",
          isDragOver && "border-primary/50 bg-primary/5"
        )}
      >
        {isAdding && (
          <AddIdeaForm onCancel={onCancelAdd} onSubmit={onSubmitAdd} />
        )}

        {cards.length === 0 && !isAdding ? (
          <div className="rounded-md border border-dashed border-border/60 p-3 text-center text-[11px] text-muted-foreground">
            No cards
          </div>
        ) : (
          cards.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              isDragging={draggingId === idea.id}
              onDragStartCard={() => onSetDraggingId(idea.id)}
              onDragEndCard={() => onSetDraggingId(null)}
              menuOpen={menuFor === idea.id}
              onToggleMenu={() => onSetMenuFor(menuFor === idea.id ? null : idea.id)}
              onCloseMenu={() => onSetMenuFor(null)}
              isEditing={editingId === idea.id}
              onToggleEdit={() =>
                onSetEditingId(editingId === idea.id ? null : idea.id)
              }
              onMoveTo={(destStage) => {
                onSetMenuFor(null);
                onMove(idea.id, destStage, 0);
              }}
              onPatch={(patch) => onPatch(idea.id, patch)}
              onDelete={() => onDelete(idea.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function AddIdeaForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (form: NewIdeaForm) => void;
}) {
  const [form, setForm] = useState<NewIdeaForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!form.title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(form);
      setForm(EMPTY_FORM);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-2 p-2.5">
        <Input
          autoFocus
          placeholder="Idea title…"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            if (e.key === "Escape") onCancel();
          }}
          className="h-8 text-xs"
        />
        <Textarea
          placeholder="Notes (optional)…"
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          className="min-h-[48px] text-xs"
        />
        <div className="flex gap-1.5">
          <Input
            placeholder="Category"
            maxLength={40}
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            className="h-8 flex-1 text-xs"
          />
          <select
            value={form.demand}
            onChange={(e) =>
              setForm((f) => ({ ...f, demand: e.target.value as Demand | "" }))
            }
            className="h-8 rounded-md border border-input bg-background px-1.5 text-xs"
          >
            <option value="">Demand —</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className="flex justify-end gap-1.5 pt-0.5">
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!form.title.trim() || submitting}
            onClick={submit}
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function IdeaCard({
  idea,
  isDragging,
  onDragStartCard,
  onDragEndCard,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  isEditing,
  onToggleEdit,
  onMoveTo,
  onPatch,
  onDelete,
}: {
  idea: Idea;
  isDragging: boolean;
  onDragStartCard: () => void;
  onDragEndCard: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  isEditing: boolean;
  onToggleEdit: () => void;
  onMoveTo: (stage: IdeaStage) => void;
  onPatch: (patch: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
}) {
  const sourceBadge = idea.source_type ? SOURCE_BADGES[idea.source_type] : undefined;

  return (
    <Card
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(idea.id));
        e.dataTransfer.effectAllowed = "move";
        onDragStartCard();
      }}
      onDragEnd={onDragEndCard}
      data-card-id={idea.id}
      className={cn(
        "relative cursor-grab p-0 transition-opacity active:cursor-grabbing",
        isDragging && "opacity-40"
      )}
    >
      <CardContent className="space-y-1.5 p-2.5">
        <div className="flex items-start justify-between gap-1.5">
          <button
            type="button"
            onClick={onToggleEdit}
            className="line-clamp-2 flex-1 text-left text-sm font-medium leading-snug hover:text-primary"
            title={idea.title}
          >
            {idea.title}
          </button>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={onToggleMenu}
              className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Card menu"
              title="More"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <CardMenu
                currentStage={idea.stage}
                onMoveTo={onMoveTo}
                onClose={onCloseMenu}
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {idea.category && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {idea.category}
            </span>
          )}
          {idea.demand && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium capitalize",
                DEMAND_STYLES[idea.demand]
              )}
            >
              {idea.demand}
            </span>
          )}
          {sourceBadge && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <sourceBadge.icon className="h-2.5 w-2.5" />
              {sourceBadge.label}
            </span>
          )}
          {idea.linked_video_id && (
            <Link
              href={`/videos/${idea.linked_video_id}`}
              className="inline-flex items-center text-muted-foreground hover:text-primary"
              title="Open linked video"
              aria-label="Open linked video"
            >
              <Link2 className="h-2.5 w-2.5" />
            </Link>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {fmtRelative(idea.created_at)}
          </span>
        </div>

        {isEditing && (
          <EditPanel idea={idea} onPatch={onPatch} onDelete={onDelete} onClose={onToggleEdit} />
        )}
      </CardContent>
    </Card>
  );
}

function CardMenu({
  currentStage,
  onMoveTo,
  onClose,
}: {
  currentStage: IdeaStage;
  onMoveTo: (stage: IdeaStage) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Move to →
      </div>
      {PIPELINE.filter((p) => p.stage !== currentStage).map((p) => (
        <button
          key={p.stage}
          type="button"
          onClick={() => onMoveTo(p.stage)}
          className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function EditPanel({
  idea,
  onPatch,
  onDelete,
  onClose,
}: {
  idea: Idea;
  onPatch: (patch: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(idea.title);
  const [notes, setNotes] = useState(idea.notes ?? "");
  const [category, setCategory] = useState(idea.category ?? "");
  const [demand, setDemand] = useState<Demand | "">(idea.demand ?? "");
  const [stage, setStage] = useState<IdeaStage>(idea.stage);
  const [linkedVideoId, setLinkedVideoId] = useState(idea.linked_video_id ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        title: title.trim(),
        notes: notes.trim() || null,
        category: category.trim() || null,
        demand: demand || null,
        stage,
      };
      if (stage === "published") {
        patch.linked_video_id = linkedVideoId.trim() || null;
      }
      const ok = await onPatch(patch);
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-background p-2 pt-2.5"
      onClick={(e) => e.stopPropagation()}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="h-8 text-xs"
      />
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes"
        className="min-h-[48px] text-xs"
      />
      <div className="flex gap-1.5">
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category"
          maxLength={40}
          className="h-8 flex-1 text-xs"
        />
        <select
          value={demand}
          onChange={(e) => setDemand(e.target.value as Demand | "")}
          className="h-8 rounded-md border border-input bg-background px-1.5 text-xs"
        >
          <option value="">Demand —</option>
          {DEMAND_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d[0].toUpperCase() + d.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <select
        value={stage}
        onChange={(e) => setStage(e.target.value as IdeaStage)}
        className="h-8 w-full rounded-md border border-input bg-background px-1.5 text-xs"
      >
        {PIPELINE.map((p) => (
          <option key={p.stage} value={p.stage}>
            {p.label}
          </option>
        ))}
      </select>
      {stage === "published" && (
        <Input
          value={linkedVideoId}
          onChange={(e) => setLinkedVideoId(e.target.value)}
          placeholder="Linked video ID (optional)"
          className="h-8 text-xs"
        />
      )}

      <div className="flex items-center justify-between gap-1.5 pt-0.5">
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onDelete}
            >
              Confirm
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            Delete?
          </Button>
        )}
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!title.trim() || saving}
            onClick={save}
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
