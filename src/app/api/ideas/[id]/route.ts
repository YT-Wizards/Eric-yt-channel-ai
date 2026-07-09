import { NextResponse } from "next/server";
import { deleteIdea, Idea, IdeaStage, moveIdea, updateIdea } from "@/lib/db";

export const runtime = "nodejs";

/** Per-idea operations: partial update / move (PATCH), delete. */

type Ctx = { params: Promise<{ id: string }> };

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

type UpdateIdeaBody = {
  title?: unknown;
  notes?: unknown;
  stage?: unknown;
  category?: unknown;
  demand?: unknown;
  source_type?: unknown;
  source_ref?: unknown;
  linked_video_id?: unknown;
};

type MoveBody = {
  move: {
    stage?: unknown;
    position?: unknown;
  };
};

/** Shared validation for fields common to create + update payloads.
 * Returns an error message, or null if the body is valid. */
function validateIdeaFields(body: UpdateIdeaBody): string | null {
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

async function parseId(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

function isMoveBody(body: unknown): body is MoveBody {
  return (
    typeof body === "object" &&
    body !== null &&
    "move" in body &&
    typeof (body as MoveBody).move === "object" &&
    (body as MoveBody).move !== null
  );
}

export async function PATCH(req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as MoveBody | UpdateIdeaBody;

  try {
    if (isMoveBody(body)) {
      const { stage, position } = body.move;
      if (typeof stage !== "string" || !IDEA_STAGES.includes(stage as IdeaStage)) {
        return NextResponse.json({ error: `Invalid idea stage: ${stage}` }, { status: 400 });
      }
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0) {
        return NextResponse.json(
          { error: "move.position must be an integer >= 0" },
          { status: 400 }
        );
      }
      const idea = moveIdea(id, stage as IdeaStage, position);
      if (!idea) return NextResponse.json({ error: "Idea not found" }, { status: 404 });
      return NextResponse.json({ idea });
    }

    const patchBody = body as UpdateIdeaBody;
    if (patchBody.title !== undefined && !String(patchBody.title).trim()) {
      return NextResponse.json({ error: "Idea title is required" }, { status: 400 });
    }
    const fieldError = validateIdeaFields(patchBody);
    if (fieldError) {
      return NextResponse.json({ error: fieldError }, { status: 400 });
    }

    const patch: Partial<
      Pick<
        Idea,
        | "title"
        | "notes"
        | "stage"
        | "category"
        | "demand"
        | "source_type"
        | "source_ref"
        | "linked_video_id"
      >
    > = {};
    if (patchBody.title !== undefined) patch.title = String(patchBody.title).trim();
    if (patchBody.notes !== undefined) patch.notes = patchBody.notes as string | null;
    if (patchBody.stage !== undefined) patch.stage = patchBody.stage as IdeaStage;
    if (patchBody.category !== undefined) {
      patch.category =
        typeof patchBody.category === "string"
          ? patchBody.category.trim()
          : (patchBody.category as null);
    }
    if (patchBody.demand !== undefined) {
      patch.demand = patchBody.demand as "high" | "medium" | "low" | null;
    }
    if (patchBody.source_type !== undefined) {
      patch.source_type = patchBody.source_type as string | null;
    }
    if (patchBody.source_ref !== undefined) {
      patch.source_ref = patchBody.source_ref as string | null;
    }
    if (patchBody.linked_video_id !== undefined) {
      patch.linked_video_id = patchBody.linked_video_id as string | null;
    }

    const idea = updateIdea(id, patch);
    if (!idea) return NextResponse.json({ error: "Idea not found" }, { status: 404 });
    return NextResponse.json({ idea });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const ok = deleteIdea(id);
    if (!ok) return NextResponse.json({ error: "Idea not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
