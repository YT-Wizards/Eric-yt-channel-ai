import Anthropic from "@anthropic-ai/sdk";
import {
  getActiveChannelId,
  getIntegration,
  titleWordStats,
  topVsBottomTitles,
} from "@/lib/db";
import { packagingFormulaSummary } from "@/lib/packaging";

export const runtime = "nodejs";
export const maxDuration = 60;

const ANALYZER_MODEL = "claude-sonnet-4-6";

const SIGNAL_TYPES = ["gap", "fresh_outlier", "audience"] as const;
type SignalType = (typeof SIGNAL_TYPES)[number];

type GenerateTitleBody = {
  type?: unknown;
  signal?: unknown;
};

type Variant = { title: string; thumbText: string; rationale: string };

/**
 * POST /api/signals/generate-title
 *
 * Turns one Signals-tab row (a competitor gap keyword, a fresh
 * competitor outlier, or an audience request mined from comments) into
 * 3 grounded title candidates for THIS channel, using the channel's own
 * proven title patterns as the only source of "what works" — no
 * hardcoded topical assumptions, so this works for any niche/language.
 *
 * Body: { type: "gap" | "fresh_outlier" | "audience", signal: object }
 * where `signal` is whatever row shape the UI clicked (passed through
 * verbatim into the Claude prompt — see BUILD 3 for the exact shapes
 * each signal type carries).
 *
 * Response: { variants: [{ title, thumbText, rationale }] } (1-3 items)
 * 400: no active channel / no Claude key / bad body.
 * 502: Claude responded but we couldn't parse 1-3 valid variants out of it.
 */
export async function POST(req: Request) {
  if (!getActiveChannelId()) {
    return Response.json(
      { error: "No active channel selected." },
      { status: 400 }
    );
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return Response.json(
      { error: "Claude API key not configured." },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as GenerateTitleBody;
  if (
    typeof body.type !== "string" ||
    !SIGNAL_TYPES.includes(body.type as SignalType)
  ) {
    return Response.json(
      { error: `Invalid signal type: ${String(body.type)}` },
      { status: 400 }
    );
  }
  if (typeof body.signal !== "object" || body.signal === null) {
    return Response.json(
      { error: "Missing signal payload." },
      { status: 400 }
    );
  }

  // Grounding: the channel's own proven patterns — top titles only (the
  // "what wins here" side of topVsBottomTitles), top title words, and the
  // cached Claude-written packaging formula (may be null; that's an
  // absent-context signal, not an error — the prompt below still works
  // with just ownTopTitles + topTitleWords).
  const ownTopTitles = topVsBottomTitles().top;
  const topTitleWords = titleWordStats({ minUses: 2, topN: 15 });
  const packagingFormula = await packagingFormulaSummary();

  const instruction =
    "You are titling the NEXT video for this specific YouTube channel. " +
    "Using the channel's own proven patterns (data below) and the given " +
    "signal, produce EXACTLY 3 title candidates: (1) NEAR-CLONE of the " +
    "channel's winning structure applied to the signal, (2) SAME " +
    "structure, different angle on the signal, (3) SAME signal topic, a " +
    "different proven hook pattern from the data. Same language as the " +
    "channel's titles. Each with a matching short THUMBNAIL TEXT (<=6 " +
    "words, punchy) and a one-sentence rationale that cites the data. " +
    'STRICT JSON only: {"variants":[{"title":"...","thumbText":"...",' +
    '"rationale":"..."}]}';

  const payload = {
    signal: body.signal,
    ownTopTitles,
    topTitleWords,
    packagingFormula,
  };

  const client = new Anthropic({ apiKey });
  let raw: string;
  try {
    const response = await client.messages.create({
      model: ANALYZER_MODEL,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: `${instruction}\n\n${JSON.stringify(payload)}`,
        },
      ],
    });
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    return Response.json(
      {
        error: `Claude call failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 }
    );
  }

  const variants = parseVariants(raw);
  if (!variants) {
    return Response.json(
      { error: "AI returned unparseable output — try again" },
      { status: 502 }
    );
  }

  return Response.json({ variants });
}

/** Same fenced-block-then-brace-span tolerant extraction used across the
 * codebase's other Claude call sites (comment-analyzer.ts). */
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/** Parses + validates the model's JSON into 1-3 variants with non-empty
 * title strings. Returns null on any structural failure (caller maps
 * that to a 502 asking the user to retry). thumbText/rationale are
 * coerced to "" if missing/non-string rather than failing the whole
 * variant — a title with a blank rationale is still usable. */
function parseVariants(raw: string): Variant[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const variantsRaw = (parsed as { variants?: unknown }).variants;
  if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) return null;

  const variants: Variant[] = [];
  for (const v of variantsRaw) {
    if (typeof v !== "object" || v === null) continue;
    const title = (v as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) continue;
    const thumbText = (v as { thumbText?: unknown }).thumbText;
    const rationale = (v as { rationale?: unknown }).rationale;
    variants.push({
      title: title.trim(),
      thumbText: typeof thumbText === "string" ? thumbText.trim() : "",
      rationale: typeof rationale === "string" ? rationale.trim() : "",
    });
  }

  if (variants.length === 0 || variants.length > 3) return null;
  return variants;
}
