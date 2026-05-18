"use client";

import * as React from "react";

/**
 * Client-side UI preferences — small toggles like "show Editor Billing
 * card on dashboard" or "show Logs in sidebar".
 *
 * These live in localStorage (not the SQLite settings table) because:
 *   - They're personal to each browser/device, not channel state.
 *   - Sync-free read on mount avoids a server roundtrip + flash of the
 *     wrong UI on every nav (the sidebar would flicker the Logs entry
 *     in then out as the settings row arrived).
 *   - This is a single-user local app — no multi-user reconciliation to
 *     worry about.
 *
 * Mirrors the pattern in theme-provider.tsx so the dev experience is
 * consistent.
 */

const PREFIX = "yt-channel-ai.ui.";

/** Keys + their human-meaningful defaults. Add new ones here. */
export const UI_PREF_DEFAULTS = {
  showEditorBilling: false,
  showLogs: false,
} as const satisfies Record<string, boolean>;

export type UiPrefKey = keyof typeof UI_PREF_DEFAULTS;

function read(key: UiPrefKey): boolean {
  if (typeof window === "undefined") return UI_PREF_DEFAULTS[key];
  const raw = window.localStorage.getItem(PREFIX + key);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return UI_PREF_DEFAULTS[key];
}

function write(key: UiPrefKey, value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PREFIX + key, value ? "1" : "0");
  // Broadcast so other components mounted in the same tab pick up the
  // change without a page reload — the `storage` event normally only
  // fires for OTHER tabs, so we dispatch a custom one for ourselves.
  window.dispatchEvent(new CustomEvent("yt-channel-ai:ui-pref", { detail: { key, value } }));
}

/**
 * React hook for a single UI preference.
 *
 * Initial render returns the default (no SSR mismatch — we don't read
 * localStorage server-side); the actual stored value lands after the
 * first useEffect tick. Components calling this should be tolerant of
 * a single-frame flash of the default state on mount.
 */
export function useUiPref(key: UiPrefKey): [boolean, (value: boolean) => void] {
  const [value, setValue] = React.useState<boolean>(UI_PREF_DEFAULTS[key]);

  React.useEffect(() => {
    setValue(read(key));
    const onChange = (ev: Event) => {
      const detail = (ev as CustomEvent<{ key: UiPrefKey; value: boolean }>).detail;
      if (detail?.key === key) setValue(detail.value);
    };
    // Cross-tab change (storage event) — also keeps multiple tabs in
    // sync if the user runs the app in two windows.
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === PREFIX + key) setValue(read(key));
    };
    window.addEventListener("yt-channel-ai:ui-pref", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("yt-channel-ai:ui-pref", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);

  const update = React.useCallback(
    (next: boolean) => {
      write(key, next);
      setValue(next);
    },
    [key]
  );

  return [value, update];
}
