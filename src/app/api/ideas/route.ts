import { NextResponse } from "next/server";
import { createIdea, Idea, IdeaStage, listIdeas } from "@/lib/db";

export const runtime = "nodejs";

/** Ideation kanban collection: list all cards, create a new card. */

const IDEA_STAGES: IdeaStage[] = [
  "idea",
  "research",
  "script",
  "voiceover",
  "editing",
  "published",
];
const DEMAND_LEVELS = ["high", "medium", "low"] as const;
const SOURCE_TYPES = ["gap", "competitor_alert", "comment", "chat", "manual"] as const;

type CreateIdeaBody = {
  title?: unknown;
  notes?: unknown;
  stage?: unknown;
  category?: unknown;
  demand?: unknown;
  source_type?: unknown;
  source_ref?: unknown;
};

/** Shared validation for fields common to create + update payloads.
 * Returns an error message, or null if the body is valid. */
function validateIdeaFields(body: CreateIdeaBody): string | null {
  if (body.stage !== undefined && !IDEA_STAGES.includes(body.stage as IdeaStage)) {
    return `Invalid idea stage: ${body.stage}`;
  }
  if (body.demand !== undefined && body.demand !== null) {
    if (!DEMAND_LEVELS.includes(body.demand as (typeof DEMAND_LEVELS)[number])) {
      return `Invalid idea demand: ${body.demand}`;
    }
  }
  if (body.source_type !== undefined && body.source_type !== null) {
    if (!SOURCE_TYPES.includes(body.source_type as (typeof SOURCE_TYPES)[number])) {
      return `Invalid idea source_type: ${body.source_type}`;
    }
  }
  if (body.source_ref !== undefined && body.source_ref !== null) {
    if (typeof body.source_ref !== "string" || body.source_ref.length > 2000) {
      return "Idea source_ref must be a string of at most 2000 characters";
    }
  }
  if (body.category !== undefined && body.category !== null) {
    if (typeof body.category !== "string" || body.category.trim().length > 40) {
      return "Idea category must be a string of at most 40 characters";
    }
  }
  return null;
}

/** Maps a thrown Error to the right HTTP status: known validation /
 * missing-channel messages are 400s, anything else is a 500. */
function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  const isClientError =
    message === "No active channel selected" ||
    message.startsWith("Invalid") ||
    message.startsWith("Idea title");
  return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
}

export async function GET() {
  try {
    return NextResponse.json({ ideas: listIdeas() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as CreateIdeaBody;

  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json({ error: "Idea title is required" }, { status: 400 });
  }
  const fieldError = validateIdeaFields(body);
  if (fieldError) {
    return NextResponse.json({ error: fieldError }, { status: 400 });
  }

  try {
    const idea: Idea = createIdea({
      title: body.title,
      notes: (body.notes as string | null | undefined) ?? undefined,
      stage: body.stage as IdeaStage | undefined,
      category:
        typeof body.category === "string" ? body.category.trim() : (body.category as null | undefined),
      demand: body.demand as "high" | "medium" | "low" | null | undefined,
      source_type: body.source_type as string | null | undefined,
      source_ref: body.source_ref as string | null | undefined,
    });
    return NextResponse.json({ idea });
  } catch (err) {
    return errorResponse(err);
  }
}
