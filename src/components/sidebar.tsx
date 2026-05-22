"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Video,
  MessageSquare,
  Plug,
  Settings,
  PlaySquare,
  ScrollText,
  Bell,
  Search,
  Sparkles,
  BarChart3,
  BookmarkPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useUiPref } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";

/**
 * Left navigation. Items are grouped into named sections so the user
 * can find related pages without scanning the whole list — Vlad's
 * feedback: "все більше й більше і все якось незручно виглядає".
 *
 * Sections — and the routes that belong in them — are defined inline
 * in the component body so they can pick up live i18n strings and the
 * showLogs UI preference. Each section renders its label in muted
 * caps above its items; an empty section (all items hidden) renders
 * nothing at all.
 */

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge: number;
  /** Optional small text tag (e.g. "BETA") shown next to the label. */
  tag?: string;
};

type NavSection = {
  label: string | null; // null = no header (shown as the top "main" block)
  items: NavItem[];
};

export function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();
  // Logs is a power-user surface (raw activity stream). Hidden by
  // default to keep the sidebar approachable for non-technical users;
  // toggled on via Settings → Optional sections.
  const [showLogs] = useUiPref("showLogs");
  // Lightweight competitor-alerts badge. Polls every 60s so the user
  // notices viral hits in their niche without having to open the
  // Competitors page. Quiet failure — no badge if the fetch errors
  // (e.g. before the migration ran on a fresh database).
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        const r = await fetch("/api/competitors", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { unreadAlerts?: number };
        if (!cancelled) setUnreadAlerts(d.unreadAlerts ?? 0);
      } catch {
        /* ignore */
      }
    };
    fetchUnread();
    const interval = window.setInterval(fetchUnread, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // Grouped nav.
  //   Main         — the everyday entry points (Dashboard, Videos, Chat).
  //   Title Insights — anything that pokes at your titles/hooks: AI Hook
  //                  Lab scoring + statistical word/length analyzer +
  //                  manual library of saved hook quotes.
  //   Research     — looking outside your own channel (competitors and
  //                  their viral-alert feed; the per-channel /alerts page
  //                  is kept as a power-user surface).
  //   Config       — keys, settings, optional logs viewer.
  const sections: NavSection[] = [
    {
      label: null,
      items: [
        { href: "/", label: t.nav.dashboard, icon: LayoutDashboard, badge: 0 },
        { href: "/videos", label: t.nav.videos, icon: Video, badge: 0 },
        { href: "/chat", label: t.nav.chat, icon: MessageSquare, badge: 0 },
      ],
    },
    {
      label: "Title insights",
      items: [
        { href: "/hooks", label: "Hook Lab", icon: Sparkles, badge: 0 },
        {
          href: "/formula-analyzer",
          label: "Formula Analyzer",
          icon: BarChart3,
          badge: 0,
        },
        {
          href: "/hooks-library",
          label: "Hooks Library",
          icon: BookmarkPlus,
          badge: 0,
        },
      ],
    },
    {
      label: "Research",
      items: [
        {
          href: "/competitors",
          label: "Competitors",
          icon: Search,
          badge: unreadAlerts,
        },
        {
          href: "/alerts",
          label: "Alerts",
          icon: Bell,
          badge: 0,
          // Flagged BETA — the alerts surface is still rough and needs
          // more work; the tag sets expectations so users don't treat
          // it as finished.
          tag: "BETA",
        },
      ],
    },
    {
      label: "Config",
      items: [
        { href: "/integrations", label: t.nav.integrations, icon: Plug, badge: 0 },
        // Logs entry is opt-in — only rendered when the Settings toggle
        // flips `showLogs` on. The /logs route stays reachable by direct
        // URL either way.
        ...(showLogs
          ? [{ href: "/logs", label: t.nav.logs, icon: ScrollText, badge: 0 }]
          : []),
        { href: "/settings", label: t.nav.settings, icon: Settings, badge: 0 },
      ],
    },
  ];

  const isActive = (href: string): boolean =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(href + "/");

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <PlaySquare className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">{t.app.name}</div>
          <div className="text-xs text-muted-foreground">{t.app.tagline}</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {sections.map((section, sectionIdx) => {
          if (section.items.length === 0) return null;
          return (
            <div
              key={section.label ?? `main-${sectionIdx}`}
              className={cn(sectionIdx > 0 && "mt-4")}
            >
              {section.label && (
                <div className="mb-1 px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {section.label}
                </div>
              )}
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const active = isActive(item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                          active
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-sidebar-foreground/80 hover:bg-accent hover:text-accent-foreground"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="flex-1">{item.label}</span>
                        {item.tag && (
                          <span className="rounded border border-muted-foreground/30 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {item.tag}
                          </span>
                        )}
                        {item.badge > 0 && (
                          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                            {item.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="px-5 py-4 text-xs text-muted-foreground border-t border-sidebar-border">
        v0.1.0 · local
      </div>
    </aside>
  );
}
