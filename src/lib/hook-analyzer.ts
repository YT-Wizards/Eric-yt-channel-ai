import "server-only";
import {
  HOOK_FORMULAS,
  type HookFormula,
  getIntegration,
  getTranscript,
  getVideo,
  upsertVideoHook,
} from "./db";
import {
  providerIntegrationName,
  providerLabel,
  providerModelId,
  streamTurn,
  type ProviderChoice,
} from "./ai-provider";
import { log } from "./logger";

/**
 * AI-driven hook analysis. Pulls the first ~700 words (~60 seconds at
 * typical speech rate) from a video's transcript and asks the configured
 * LLM (Claude or any Gemini variant) to:
 *
 *   1. Classify the hook into one of seven canonical formulas
 *      (direct_question, statistic, comment_reference, personal_story,
 *      mystery, character_place_date, provocation) — same taxonomy
 *      the Eli Yoder Secrets framework uses.
 *   2. Score the hook on 7 quality dimensions, 1-10:
 *        - open_loop: does it set up curiosity that demands resolution?
 *        - value_promise: is the payoff clearly hinted?
 *        - conflict: is there tension/problem/surprise in the first 30s?
 *        - specific_language: concrete details vs vague claims?
 *        - identification: does the viewer see themselves in the setup?
 *        - pacing: short, punchy sentences early on?
 *        - benefit: is the "what's in it for me" telegraphed by 60s?
 *   3. Surface 2-3 strengths (fortalezas) and 2-3 improvement ideas
 *      (mejoras) so the user gets actionable feedback per video.
 *
 * Output is strict JSON — we parse it and persist into the video_hooks
 * table. One call per video; the batch endpoint handles the iteration so
 * we can rate-limit gently against the upstream API.
 *
 * History: this module used to hardcode Anthropic Sonnet only. Vlad's
 * feedback was that Eric (and other users on a Gemini-only setup) had
 * no way to use Hook Lab. Now it routes through ai-provider.ts and
 * accepts any of the same provider choices the chat header offers,
 * with auto-fallback to whichever provider has a key configured.
 */

// Trim transcripts to roughly the first minute. Hook quality is about
// what the viewer hears BEFORE they decide to keep watching — anything
// past 60s is body content, irrelevant for hook scoring. ~750 chars
// is a generous upper bound on ~60s of typical YouTube speech.
const HOOK_CHAR_CAP = 750;

const SYSTEM_PROMPT = `You are a YouTube hook coach. You analyze the opening 30-60 seconds of YouTube videos and grade them against a strict rubric used by professional creator-growth coaches.

Your output MUST be a single valid JSON object with this exact schema, and nothing else:

{
  "formula_type": one of ${JSON.stringify(HOOK_FORMULAS)},
  "scores": {
    "open_loop": integer 1-10,
    "value_promise": integer 1-10,
    "conflict": integer 1-10,
    "specific_language": integer 1-10,
    "identification": integer 1-10,
    "pacing": integer 1-10,
    "benefit": integer 1-10
  },
  "fortalezas": [string, string, string]   // 2-3 specific strengths, each 5-15 words
  "mejoras": [string, string, string]      // 2-3 specific improvements, each 5-15 words
}

Formula definitions:
- direct_question: opens with a question aimed at the viewer ("Did you know...?", "Have you ever...?")
- statistic: leads with a concrete number or stat that grounds the topic ("In 1937, 8 pence per litre...")
- comment_reference: opens by quoting a viewer comment or community member ("One of my subscribers wrote...")
- personal_story: leads with a first-person anecdote ("This happened to me last year...")
- mystery: opens with intrigue or "you won't believe" framing ("What you're about to learn was banned in 17 states")
- character_place_date: starts with a vivid scene rooted in time/place/people ("Lancaster County, 1942, an Amish family discovered...")
- provocation: opens with a controversial or risk-laden claim ("YouTube will delete this video in 24 hours")
- other: doesn't cleanly fit any of the above

Rubric guidance for scoring 1-10:
- 1-3: Banal, vague, or missing entirely
- 4-6: Present but generic or weak
- 7-8: Solid execution with clear intent
- 9-10: Exceptional — would force most viewers to keep watching

Be tough. Most hooks score 5-7 on most dimensions. A 10 is rare. Calibrate to channel-growth standards, not encouragement.

Strengths and improvements MUST cite specific elements of the hook text — quoting a phrase or pointing at a concrete moment. Generic advice ("be more specific") is forbidden; say WHICH part to make specific.

Match the language of the source hook in your fortalezas/mejoras strings (English hooks → English feedback, Ukrainian → Ukrainian, etc.).`;

export class HookAnalyzerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookAnalyzerError";
  }
}

type AnalyzerOutput = {
  formula_type: HookFormula;
  scores: {
    open_loop: number;
    value_promise: number;
    conflict: number;
    specific_language: number;
    identification: number;
    pacing: number;
    benefit: number;
  };
  fortalezas: string[];
  mejoras: string[];
};

/**
 * Extract the longest plausible JSON object out of the model's response.
 * We ask for strict JSON only, but both Sonnet and Gemini occasionally
 * add a stray preamble or wrap in a code fence; defending against both
 * is cheap.
 */
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]+?)\n```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function validateOutput(parsed: unknown): AnalyzerOutput {
  if (typeof parsed !== "object" || parsed === null) {
    throw new HookAnalyzerError("Analyzer returned non-object JSON");
  }
  const p = parsed as Record<string, unknown>;
  const formula = p.formula_type as string;
  if (!HOOK_FORMULAS.includes(formula as HookFormula)) {
    throw new HookAnalyzerError(`Unknown formula_type: ${formula}`);
  }
  const scores = p.scores as Record<string, unknown>;
  if (!scores || typeof scores !== "object") {
    throw new HookAnalyzerError("Missing scores object");
  }
  const required = [
    "open_loop",
    "value_promise",
    "conflict",
    "specific_language",
    "identification",
    "pacing",
    "benefit",
  ];
  for (const k of required) {
    const v = scores[k];
    if (typeof v !== "number" || v < 1 || v > 10) {
      throw new HookAnalyzerError(`Bad score for ${k}: ${v}`);
    }
  }
  const fort = Array.isArray(p.fortalezas) ? (p.fortalezas as string[]) : [];
  const mej = Array.isArray(p.mejoras) ? (p.mejoras as string[]) : [];
  return {
    formula_type: formula as HookFormula,
    scores: {
      open_loop: Math.round(scores.open_loop as number),
      value_promise: Math.round(scores.value_promise as number),
      conflict: Math.round(scores.conflict as number),
      specific_language: Math.round(scores.specific_language as number),
      identification: Math.round(scores.identification as number),
      pacing: Math.round(scores.pacing as number),
      benefit: Math.round(scores.benefit as number),
    },
    fortalezas: fort.filter((s) => typeof s === "string").slice(0, 5),
    mejoras: mej.filter((s) => typeof s === "string").slice(0, 5),
  };
}

/**
 * Resolve which provider to use for this analysis call.
 *
 *   - If the user passed an explicit provider, honor it (but bail
 *     if its API key isn't configured).
 *   - Otherwise prefer Claude when its key exists (the original
 *     behaviour pre-Gemini), fall back to Gemini 2.5 Pro when only
 *     Gemini is configured. The user can flip the explicit picker
 *     in the Hook Lab header to override.
 *
 * Returns `null` if neither provider has a key — caller surfaces a
 * clear "configure a key in Integrations" message.
 */
function resolveProvider(
  explicit: ProviderChoice | undefined
): { provider: ProviderChoice; apiKey: string } | null {
  if (explicit) {
    const key = getIntegration(providerIntegrationName(explicit))?.api_key;
    if (!key) return null;
    return { provider: explicit, apiKey: key };
  }
  const claudeKey = getIntegration("claude")?.api_key;
  if (claudeKey) return { provider: "claude", apiKey: claudeKey };
  const geminiKey = getIntegration("google_gemini")?.api_key;
  if (geminiKey) return { provider: "gemini-2.5-pro", apiKey: geminiKey };
  return null;
}

/**
 * Run hook analysis for a single video and persist the result. Re-runs
 * overwrite previous scores — the user can hit "Re-analyze" any time
 * to get fresh feedback (useful after a transcript correction or to
 * sanity-check a previous low score).
 *
 *   provider — optional ProviderChoice. When omitted, picks Claude if
 *   its key is configured, else Gemini 2.5 Pro. The batch endpoint
 *   threads the user's pick from the Hook Lab UI through here.
 */
export async function analyzeVideoHook(
  videoId: string,
  provider?: ProviderChoice
): Promise<{ ok: true; overallScore: number } | { ok: false; reason: string }> {
  const video = getVideo(videoId);
  if (!video) return { ok: false, reason: "video not found" };

  const transcript = getTranscript(videoId);
  if (!transcript || !transcript.text.trim()) {
    return { ok: false, reason: "no transcript on file" };
  }
  // Take the opening ~750 chars (~60s of speech) — that's the hook.
  // If we cut mid-word, drop the dangling partial word so the stored +
  // displayed hook ends on a clean word instead of "...civilizati".
  let hookText = transcript.text.slice(0, HOOK_CHAR_CAP).trim();
  if (transcript.text.length > HOOK_CHAR_CAP) {
    const lastSpace = hookText.lastIndexOf(" ");
    if (lastSpace > HOOK_CHAR_CAP * 0.8) {
      hookText = hookText.slice(0, lastSpace).trim();
    }
  }
  if (hookText.length < 80) {
    return { ok: false, reason: "transcript too short for hook analysis" };
  }

  const resolved = resolveProvider(provider);
  if (!resolved) {
    return {
      ok: false,
      reason:
        "No AI provider configured. Add a Claude or Gemini API key in Integrations.",
    };
  }

  let raw: string;
  try {
    // streamTurn handles both Claude and Gemini through the same shape.
    // We don't actually need streaming for hook analysis (it's batch
    // and the output is JSON, not user-facing prose), so onText is a
    // no-op — we read the accumulated text from result.content after
    // the turn finishes.
    const result = await streamTurn({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Video title: "${video.title}"\n\nHook text (first ~60 seconds of transcript):\n"""\n${hookText}\n"""\n\nReturn the JSON analysis now.`,
        },
      ],
      tools: [],
      maxTokens: 2048,
      onText: () => {},
    });
    raw = result.content
      .filter((b): b is { type: "text"; text: string; citations: null } =>
        b.type === "text"
      )
      .map((b) => b.text)
      .join("");
    if (!raw.trim()) {
      return {
        ok: false,
        reason: `${providerLabel(resolved.provider)} returned an empty response`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `${providerLabel(resolved.provider)} call failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  let parsed: AnalyzerOutput;
  try {
    const json = extractJson(raw);
    parsed = validateOutput(JSON.parse(json));
  } catch (e) {
    log.warn("hooks", `Hook analyzer JSON parse failed for ${videoId}`, {
      raw: raw.slice(0, 500),
      provider: resolved.provider,
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "JSON parse failed",
    };
  }

  const overallScore =
    (parsed.scores.open_loop +
      parsed.scores.value_promise +
      parsed.scores.conflict +
      parsed.scores.specific_language +
      parsed.scores.identification +
      parsed.scores.pacing +
      parsed.scores.benefit) /
    7;

  upsertVideoHook({
    video_id: videoId,
    hook_text: hookText,
    formula_type: parsed.formula_type,
    score_open_loop: parsed.scores.open_loop,
    score_value_promise: parsed.scores.value_promise,
    score_conflict: parsed.scores.conflict,
    score_specific_language: parsed.scores.specific_language,
    score_identification: parsed.scores.identification,
    score_pacing: parsed.scores.pacing,
    score_benefit: parsed.scores.benefit,
    overall_score: Math.round(overallScore * 10) / 10,
    fortalezas: JSON.stringify(parsed.fortalezas),
    mejoras: JSON.stringify(parsed.mejoras),
    analyzer_model: providerModelId(resolved.provider),
    analyzed_at: Math.floor(Date.now() / 1000),
  });

  log.info("hooks", "Video hook analyzed", {
    videoId,
    formula: parsed.formula_type,
    overallScore,
    provider: resolved.provider,
  });

  return { ok: true, overallScore };
}
