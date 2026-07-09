"use client";

import { useState } from "react";
import { Lightbulb, LayoutDashboard, Video, PackageOpen, Radar } from "lucide-react";
import { cn } from "@/lib/utils";
import { VideosTab } from "@/components/ideation/videos-tab";
import { BoardTab } from "@/components/ideation/board-tab";
import { PackagingTab } from "@/components/ideation/packaging-tab";
import { SignalsTab } from "@/components/ideation/signals-tab";

/**
 * Ideation hub — the single sidebar destination that holds the whole
 * idea pipeline: Board (kanban), Videos (command-center table),
 * Packaging (title/thumbnail), Signals (trend/competitor feeds).
 *
 * This page is intentionally thin — state + layout only. Each tab owns
 * its own data fetching and UI.
 */

type Tab = "board" | "videos" | "packaging" | "signals";

export default function IdeationPage() {
  // TODO: default to "board" once the Board tab is real (it's the
  // natural entry point for the idea pipeline) — for now it's a stub,
  // so "videos" is the default until that build step lands.
  const [tab, setTab] = useState<Tab>("videos");

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Lightbulb className="h-6 w-6" />
          Ideation
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          From signals to published videos — your idea pipeline in one place.
        </p>
      </header>

      <div className="mb-4 flex gap-4 border-b border-border">
        <TabButton active={tab === "board"} onClick={() => setTab("board")}>
          <LayoutDashboard className="h-3.5 w-3.5" />
          Board
        </TabButton>
        <TabButton active={tab === "videos"} onClick={() => setTab("videos")}>
          <Video className="h-3.5 w-3.5" />
          Videos
        </TabButton>
        <TabButton active={tab === "packaging"} onClick={() => setTab("packaging")}>
          <PackageOpen className="h-3.5 w-3.5" />
          Packaging
        </TabButton>
        <TabButton active={tab === "signals"} onClick={() => setTab("signals")}>
          <Radar className="h-3.5 w-3.5" />
          Signals
        </TabButton>
      </div>

      {tab === "board" && <BoardTab />}
      {tab === "videos" && <VideosTab />}
      {tab === "packaging" && <PackagingTab />}
      {tab === "signals" && <SignalsTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
