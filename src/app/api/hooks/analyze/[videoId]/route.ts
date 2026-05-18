import { NextResponse } from "next/server";
import { analyzeVideoHook } from "@/lib/hook-analyzer";
import { PROVIDER_CHOICES, type ProviderChoice } from "@/lib/ai-provider-types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/hooks/analyze/[videoId]
 *
 * Body (optional): { provider?: ProviderChoice }
 *
 * The provider is threaded from the Hook Lab UI dropdown. When omitted,
 * the analyzer picks Claude if configured, else Gemini 2.5 Pro — same
 * auto-resolve logic the batch endpoint uses, so single-video and bulk
 * runs behave identically.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;

  let provider: ProviderChoice | undefined;
  try {
    const text = await req.text();
    if (text.trim()) {
      const body = JSON.parse(text) as { provider?: string };
      if (
        typeof body.provider === "string" &&
        PROVIDER_CHOICES.includes(body.provider as ProviderChoice)
      ) {
        provider = body.provider as ProviderChoice;
      }
    }
  } catch {
    /* empty body is fine — analyzer falls back to its default provider */
  }

  const result = await analyzeVideoHook(videoId, provider);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, overallScore: result.overallScore });
}
