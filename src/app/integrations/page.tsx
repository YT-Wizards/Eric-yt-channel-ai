"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, Check, Loader2, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n/provider";
import { YouTubeChannelBinder } from "@/components/youtube-channel-binder";
import { YouTubeCookies } from "@/components/youtube-cookies";
import { GoogleOAuthConnector } from "@/components/google-oauth-connector";
import { ClaudeUsage } from "@/components/claude-usage";
import { ApifyUsage } from "@/components/apify-usage";
import { DeepgramUsage } from "@/components/deepgram-usage";

type Name = "claude" | "deepgram" | "apify" | "youtube" | "google_gemini";

type StatusMap = Record<
  Name,
  { hasKey: boolean; masked: string; enabled: boolean }
>;

export default function IntegrationsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusMap | null>(null);

  const load = async () => {
    const res = await fetch("/api/integrations");
    const data = await res.json();
    setStatus(data.integrations);
  };

  useEffect(() => {
    load();
  }, []);

  type ItemMode = "key" | "oauth";
  type Help = {
    title: string;
    steps: string[];
    link: string;
    linkLabel: string;
  };
  type Item = {
    name: Name;
    label: string;
    desc: string;
    placeholder: string;
    mode: ItemMode;
    help: Help;
  };
  // Source-of-truth list. Grouping decisions below operate on these
  // entries by name so we don't repeat the help/label data.
  const items: Item[] = [
    {
      name: "claude",
      label: t.integrations.claude.name,
      desc: t.integrations.claude.desc,
      placeholder: t.integrations.claude.placeholder,
      mode: "key",
      help: {
        title: t.integrations.claude.helpTitle,
        steps: t.integrations.claude.helpSteps,
        link: t.integrations.claude.helpLink,
        linkLabel: t.integrations.claude.helpLinkLabel,
      },
    },
    {
      name: "deepgram",
      label: t.integrations.deepgram.name,
      desc: t.integrations.deepgram.desc,
      placeholder: t.integrations.deepgram.placeholder,
      mode: "key",
      help: {
        title: t.integrations.deepgram.helpTitle,
        steps: t.integrations.deepgram.helpSteps,
        link: t.integrations.deepgram.helpLink,
        linkLabel: t.integrations.deepgram.helpLinkLabel,
      },
    },
    {
      name: "google_gemini",
      label: t.integrations.gemini.name,
      desc: t.integrations.gemini.desc,
      placeholder: t.integrations.gemini.placeholder,
      mode: "key",
      help: {
        title: t.integrations.gemini.helpTitle,
        steps: t.integrations.gemini.helpSteps,
        link: t.integrations.gemini.helpLink,
        linkLabel: t.integrations.gemini.helpLinkLabel,
      },
    },
    {
      name: "apify",
      label: t.integrations.apify.name,
      desc: t.integrations.apify.desc,
      placeholder: t.integrations.apify.placeholder,
      mode: "key",
      help: {
        title: t.integrations.apify.helpTitle,
        steps: t.integrations.apify.helpSteps,
        link: t.integrations.apify.helpLink,
        linkLabel: t.integrations.apify.helpLinkLabel,
      },
    },
    {
      name: "youtube",
      label: t.integrations.youtube.name,
      desc: t.integrations.youtube.desc,
      placeholder: t.integrations.youtube.placeholder,
      mode: "key",
      help: {
        title: t.integrations.youtube.helpTitle,
        steps: t.integrations.youtube.helpSteps,
        link: t.integrations.youtube.helpLink,
        linkLabel: t.integrations.youtube.helpLinkLabel,
      },
    },
  ];

  // Group items by purpose so a non-technical user sees a shorter,
  // sequenced list instead of one undifferentiated stack of 6+ cards.
  // The order inside each group matters too: YouTube first in Core (the
  // very first thing a new user needs), then the AI providers stacked
  // as alternatives, then optional add-ons.
  const byName = (n: Name): Item | undefined => items.find((i) => i.name === n);
  const groups: {
    title: string;
    description: string;
    names: Name[];
  }[] = [
    {
      title: "Core — fill at least one AI key + YouTube",
      description:
        "The minimum to make the app useful: a YouTube Data API key to load videos and stats, plus an AI provider (Claude or Gemini) to power the chat / Hook Lab / advisor.",
      names: ["youtube", "claude", "google_gemini"],
    },
    {
      title: "Optional add-ons",
      description:
        "Add when you want the feature. Deepgram unlocks transcription for videos without YouTube captions. Apify is the competitor-sync fallback when no YouTube Data API key is set. (Web search in the AI Chat is now built in — no extra key needed.)",
      names: ["deepgram", "apify"],
    },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t.integrations.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.integrations.subtitle}</p>
      </header>

      <div className="space-y-8">
        {groups.map((g) => (
          <section key={g.title} className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {g.title}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{g.description}</p>
            </div>
            {g.names.map((n) => {
              const it = byName(n);
              if (!it) return null;
              return (
                <IntegrationCard
                  key={it.name}
                  name={it.name}
                  label={it.label}
                  desc={it.desc}
                  placeholder={it.placeholder}
                  mode={it.mode}
                  help={it.help}
                  status={status?.[it.name]}
                  onSaved={load}
                />
              );
            })}
          </section>
        ))}

        {/* Advanced — collapsed by default. Google OAuth is heavier
            (full Studio Analytics, private API access) and most
            beginners can ignore it; this prevents the page from
            scaring them with a wall of "Connect Google" UI before
            they've even pasted their first API key. */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Advanced
          </h2>
          <p className="text-xs text-muted-foreground">
            Heavier authentication flows. Skip unless you specifically need
            them.
          </p>
          <details className="rounded-md border border-border bg-muted/10">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium hover:bg-muted/30">
              Google OAuth — Studio Analytics & private API access
            </summary>
            <div className="border-t border-border/60 p-3">
              <GoogleOAuthConnector />
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}

function IntegrationCard({
  name,
  label,
  desc,
  placeholder,
  mode,
  help,
  status,
  onSaved,
}: {
  name: Name;
  label: string;
  desc: string;
  placeholder: string;
  mode: "key" | "oauth";
  help: { title: string; steps: string[]; link: string; linkLabel: string };
  status?: { hasKey: boolean; masked: string; enabled: boolean };
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, api_key: value }),
      });
      // Previously we ignored the response entirely and always showed
      // "Saved" — so a 500 (e.g. the local SQLite write failing) looked
      // identical to success and the key silently never persisted. Surface
      // the real error instead; that's what makes a stuck install
      // debuggable ("nothing happens" → an actual message).
      if (!res.ok) {
        let msg = `Save failed (HTTP ${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) msg = `Save failed: ${data.error}`;
        } catch {
          /* server returned a non-JSON crash page — keep the HTTP code */
        }
        setError(msg);
        return;
      }
      setValue("");
      setJustSaved(true);
      onSaved();
      setTimeout(() => setJustSaved(false), 1800);
    } catch {
      // fetch() itself threw → the local server isn't reachable.
      setError(
        "Couldn't reach the local server. Make sure the app window (the terminal that started it) is still open, then try again."
      );
    } finally {
      setSaving(false);
    }
  };

  const connected = !!status?.hasKey;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>{label}</CardTitle>
          <CardDescription className="mt-1">{desc}</CardDescription>
        </div>
        <span
          className={
            connected
              ? "inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400"
              : "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          }
        >
          {connected && <Check className="h-3 w-3" />}
          {connected ? t.integrations.status.connected : t.integrations.status.notConnected}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Expandable how-to block. Closed by default — power users don't
            need it, but new users get a step-by-step path to the key
            without leaving the page. */}
        <details className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none text-foreground">
            {help.title}
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
            {help.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <a
            href={help.link}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {help.linkLabel}
            <ExternalLink className="h-3 w-3" />
          </a>
        </details>

        {mode === "oauth" ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t.integrations.comingSoon}</p>
            <Button disabled variant="outline" size="sm">
              {t.integrations.connect}
            </Button>
          </div>
        ) : (
          <>
        {connected && (
          <div className="text-xs text-muted-foreground">
            <span className="font-mono">{status?.masked}</span>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor={`key-${name}`}>API key</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id={`key-${name}`}
                type={show ? "text" : "password"}
                placeholder={placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                aria-label={show ? t.integrations.hideKey : t.integrations.showKey}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button onClick={save} disabled={saving || !value.trim()}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : justSaved ? (
                <>
                  <Check className="h-4 w-4" />
                  {t.integrations.saved}
                </>
              ) : (
                t.integrations.save
              )}
            </Button>
          </div>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
          </>
        )}

        {name === "youtube" && (
          <>
            <YouTubeChannelBinder hasKey={!!status?.hasKey} />
            <YouTubeCookies />
          </>
        )}
        {name === "claude" && <ClaudeUsage enabled={!!status?.hasKey} />}
        {name === "deepgram" && <DeepgramUsage enabled={!!status?.hasKey} />}
        {name === "apify" && <ApifyUsage enabled={!!status?.hasKey} />}
      </CardContent>
    </Card>
  );
}
