"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { useTheme } from "@/lib/theme-provider";
import { useUiPref } from "@/lib/ui-prefs";

export default function SettingsPage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  // Optional UI surfaces — hidden by default to keep the app simple for
  // non-technical users. Power users (and Vlad's own workflows) flip
  // them on here.
  const [showEditorBilling, setShowEditorBilling] = useUiPref("showEditorBilling");
  const [showLogs, setShowLogs] = useUiPref("showLogs");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t.settings.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.settings.subtitle}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.theme}</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            variant={theme === "light" ? "default" : "outline"}
            size="sm"
            onClick={() => setTheme("light")}
          >
            {t.settings.themeLight}
          </Button>
          <Button
            variant={theme === "dark" ? "default" : "outline"}
            size="sm"
            onClick={() => setTheme("dark")}
          >
            {t.settings.themeDark}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Optional sections</CardTitle>
          <CardDescription>
            Power-user surfaces that stay hidden by default. Flip them on if you
            need them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            label="Editor billing card"
            description="Show the editor payouts widget on the Dashboard. Useful only if you pay an editor per video."
            value={showEditorBilling}
            onChange={setShowEditorBilling}
          />
          <ToggleRow
            label="Logs in sidebar"
            description="Show the Logs entry in the left navigation. The /logs route always works via direct URL — this just controls visibility."
            value={showLogs}
            onChange={setShowLogs}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Generic on/off row. Pure presentation — wired to ui-prefs.tsx
 * via two `useUiPref` hooks in the parent component. We render an
 * accessible button rather than the native checkbox so the click
 * target matches the rest of our Settings buttons.
 */
function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <Button
        type="button"
        size="sm"
        variant={value ? "default" : "outline"}
        onClick={() => onChange(!value)}
        className="shrink-0"
        aria-pressed={value}
      >
        {value ? "On" : "Off"}
      </Button>
    </div>
  );
}
