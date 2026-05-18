import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  FinishReason as GeminiFinishReason,
  GoogleGenerativeAI,
  type Content as GeminiContent,
  type FunctionDeclaration as GeminiFunctionDeclaration,
  type Part as GeminiPart,
} from "@google/generative-ai";
import {
  providerModelId,
  type ProviderChoice,
} from "./ai-provider-types";

/**
 * Provider abstraction so the chat agent loop can drive either Anthropic
 * Claude or Google Gemini without branching at every callsite.
 *
 * Design choice: Anthropic's `MessageParam` shape is the canonical wire
 * format. The chat tools (`chat-tools.ts`), the executor loop, and the
 * stored history all already speak it. The Gemini adapter converts to
 * `Content[]` only at the SDK boundary — Anthropic content stays the
 * source of truth so we don't have to mirror state.
 *
 * Sessions are pinned to a provider on creation; the user can pick
 * Claude / Gemini Flash / Gemini Pro from the chat header, but switching
 * mid-session means starting fresh because the in-memory history wouldn't
 * round-trip cleanly between providers (tool_use_id ↔ function name
 * mapping is one-way).
 *
 * Constants and types live in `ai-provider-types.ts` (no `server-only`)
 * so client components can import them too — re-exported below for any
 * server-side caller already pointing at this file.
 */

export {
  DEFAULT_PROVIDER,
  PROVIDER_CHOICES,
  providerIntegrationName,
  providerLabel,
  providerModelId,
  type ProviderChoice,
} from "./ai-provider-types";

// ---------------------------------------------------------------------------
// Unified turn shape
// ---------------------------------------------------------------------------

export type UnifiedContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export type UnifiedStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "other";

export interface UnifiedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UnifiedTurnResult {
  /** Source-of-truth Anthropic-shaped content for the assistant's reply. */
  content: Anthropic.ContentBlock[];
  /** Same content, normalized into our smaller union for the loop's eyes. */
  blocks: UnifiedContentBlock[];
  stopReason: UnifiedStopReason;
  usage: UnifiedUsage;
}

export interface StreamTurnOpts {
  provider: ProviderChoice;
  apiKey: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  /**
   * Enable the provider's native server-side web search. When true:
   *   - Claude: attaches the `web_search_20260209` server tool. Anthropic
   *     executes the search and feeds results back to the model in the
   *     same turn — we see no extra function_call to dispatch, just
   *     extra server_tool_use + web_search_tool_result content blocks.
   *   - Gemini: not wired yet. The legacy SDK exposes
   *     `googleSearchRetrieval`, but that grounding mode doesn't compose
   *     with function declarations in one request and would break our
   *     existing local tools. Until we migrate to the newer @google/genai
   *     SDK and Gemini 2.0+ native `google_search` tool, we silently
   *     ignore this flag on Gemini turns. Users who specifically need
   *     web search can switch the chat header to Claude.
   */
  webSearch?: boolean;
  /** Called for every text delta — same shape both providers, raw text only. */
  onText: (delta: string) => void;
}

/** Run one turn against the chosen provider, streaming text deltas live. */
export async function streamTurn(
  opts: StreamTurnOpts
): Promise<UnifiedTurnResult> {
  if (opts.provider === "claude") {
    return runClaudeTurn(opts);
  }
  return runGeminiTurn(opts);
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

async function runClaudeTurn(
  opts: StreamTurnOpts
): Promise<UnifiedTurnResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  // Compose the final tools list. Claude's `tools` array can mix our
  // local function tools with Anthropic-managed server tools (web_search,
  // web_fetch, code_execution, ...). When opts.webSearch is on we append
  // the 2026-02-09 web_search tool — Anthropic does the network call on
  // its side and feeds the results back into the model's context inside
  // the same turn. The resulting message contains extra content blocks
  // we just have to NOT mistake for function calls.
  // max_uses=5 is a safety cap so a single chat turn can't burn 50
  // searches via runaway prompting.
  const composedTools: Anthropic.ToolUnion[] = [...opts.tools];
  if (opts.webSearch) {
    composedTools.push({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
    } satisfies Anthropic.WebSearchTool20260209);
  }

  const stream = client.messages.stream({
    model: providerModelId("claude"),
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: opts.messages,
    tools: composedTools.length ? composedTools : undefined,
  });

  stream.on("text", (text) => opts.onText(text));
  const final = await stream.finalMessage();

  const blocks: UnifiedContentBlock[] = [];
  for (const b of final.content) {
    if (b.type === "text") {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      // FUNCTION call — our chat-tools dispatcher needs to run it.
      blocks.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      });
    }
    // server_tool_use + web_search_tool_result + web_fetch_tool_result
    // are intentionally NOT mapped into UnifiedContentBlock — they're
    // executed entirely by Anthropic; our loop doesn't need to dispatch
    // anything. They still live in `final.content` and get persisted
    // back to the next iteration's history along with everything else,
    // so the model sees the search results on subsequent turns.
  }

  const usage = final.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };

  return {
    content: final.content,
    blocks,
    stopReason: mapClaudeStop(final.stop_reason),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

function mapClaudeStop(s: Anthropic.Message["stop_reason"]): UnifiedStopReason {
  if (s === "end_turn") return "end_turn";
  if (s === "tool_use") return "tool_use";
  if (s === "max_tokens") return "max_tokens";
  return "other";
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function runGeminiTurn(
  opts: StreamTurnOpts
): Promise<UnifiedTurnResult> {
  const genAI = new GoogleGenerativeAI(opts.apiKey);
  const modelName = providerModelId(opts.provider);

  const tools = opts.tools.length
    ? [
        {
          functionDeclarations: opts.tools.map(
            anthropicToolToGeminiDecl
          ),
        },
      ]
    : undefined;

  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: opts.system,
    tools,
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
    },
  });

  const contents = anthropicMessagesToGeminiContents(opts.messages);

  const result = await model.generateContentStream({ contents });

  let textAcc = "";
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      textAcc += text;
      opts.onText(text);
    }
  }

  const final = await result.response;
  const calls = final.functionCalls() ?? [];

  // Build canonical Anthropic content + our normalized blocks in lockstep.
  const content: Anthropic.ContentBlock[] = [];
  const blocks: UnifiedContentBlock[] = [];
  if (textAcc) {
    content.push({ type: "text", text: textAcc, citations: null });
    blocks.push({ type: "text", text: textAcc });
  }
  // Gemini doesn't ship per-call ids — synthesise stable ones so the loop
  // can correlate tool_result blocks back to their tool_use blocks via the
  // same `tool_use_id` field that Anthropic uses.
  const turnSeed = Date.now().toString(36);
  calls.forEach((call, i) => {
    const id = `gemini_${turnSeed}_${i}`;
    const input = (call.args ?? {}) as Record<string, unknown>;
    // `caller: null` satisfies the Anthropic SDK's ToolUseBlock shape for
    // synthesised blocks — recent SDK versions added `caller` for nested
    // sub-agent attribution; we always emit top-level so null is correct.
    // Cast through `unknown` because Anthropic's ToolUseBlock now requires a
    // discriminated `caller` union (DirectCaller | ServerToolCaller…) we
    // can't satisfy from outside the SDK. Our synthesized block flows
    // straight back into chat-history persistence and re-serialisation, so
    // shape compatibility is what matters, not membership in the union.
    content.push({
      type: "tool_use",
      id,
      name: call.name,
      input,
    } as unknown as Anthropic.ContentBlock);
    blocks.push({ type: "tool_use", id, name: call.name, input });
  });

  const usage = final.usageMetadata;
  const finishReason = final.candidates?.[0]?.finishReason;
  let stopReason: UnifiedStopReason = "end_turn";
  if (calls.length > 0) stopReason = "tool_use";
  else if (finishReason === GeminiFinishReason.MAX_TOKENS) stopReason = "max_tokens";
  else if (finishReason === GeminiFinishReason.STOP) stopReason = "end_turn";
  else if (finishReason !== undefined) stopReason = "other";

  return {
    content,
    blocks,
    stopReason,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      // Gemini implicit caching billing exposes cachedContentTokenCount on
      // the usage metadata when prompt caching kicks in. We don't actively
      // configure caching yet, so this is usually 0/undefined.
      cacheReadTokens:
        (usage as { cachedContentTokenCount?: number } | undefined)
          ?.cachedContentTokenCount ?? 0,
      cacheWriteTokens: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic ↔ Gemini conversion
// ---------------------------------------------------------------------------

function anthropicToolToGeminiDecl(
  tool: Anthropic.Tool
): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description ?? "",
    // Anthropic input_schema is a JSON Schema (subset). Gemini accepts a
    // similar OpenAPI-shaped object — for the tools we ship (object types
    // with simple primitive properties + enums) it round-trips cleanly.
    parameters: tool.input_schema as unknown as GeminiFunctionDeclaration["parameters"],
  };
}

function anthropicMessagesToGeminiContents(
  messages: Anthropic.MessageParam[]
): GeminiContent[] {
  // Anthropic correlates tool_use ↔ tool_result via `tool_use_id`. Gemini
  // correlates by the function NAME on `functionResponse`. We pre-pass
  // through history to build id→name, then use it on the second pass.
  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") {
          idToName.set(b.id, b.name);
        }
      }
    }
  }

  return messages.map((msg) => {
    const role: "user" | "model" = msg.role === "user" ? "user" : "model";

    if (typeof msg.content === "string") {
      return { role, parts: [{ text: msg.content }] };
    }

    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        parts.push({
          functionCall: {
            name: block.name,
            args: (block.input ?? {}) as Record<string, unknown>,
          },
        });
      } else if (block.type === "tool_result") {
        // tool_result.content can be a string or an array of text/image
        // blocks; flatten to a single string for Gemini's response slot.
        const flattened = flattenToolResultContent(block.content);
        const name = idToName.get(block.tool_use_id) ?? "unknown_tool";
        parts.push({
          functionResponse: {
            name,
            response: block.is_error
              ? { error: flattened }
              : { content: flattened },
          },
        });
      } else if (block.type === "image") {
        // Multimodal — Phase 3. Anthropic ImageBlockParam holds either a
        // base64 source or a url source; Gemini's inlineData wants raw
        // base64 + mimeType. We only forward base64 sources because
        // url-mode images would need a server-side fetch + reupload, which
        // we'll add later if a use case demands it.
        const src = block.source;
        if (src.type === "base64") {
          parts.push({
            inlineData: {
              mimeType: src.media_type,
              data: src.data,
            },
          });
        }
      }
    }
    return { role, parts };
  });
}

function flattenToolResultContent(
  c: Anthropic.ToolResultBlockParam["content"]
): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return JSON.stringify(c ?? "");
  // Array of (text | image) blocks — keep text, drop images for now (tool
  // results that returned images aren't a thing we actually emit, but the
  // SDK's type union forces us to handle the case).
  const parts: string[] = [];
  for (const item of c) {
    if (item.type === "text") parts.push(item.text);
  }
  return parts.join("");
}
