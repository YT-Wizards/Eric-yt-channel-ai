import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude-driven OCR for YouTube thumbnail images. Thumbnails routinely carry
 * the creator's actual hook copy ("3 SECRETS NOBODY TELLS YOU") baked into
 * the pixels — text a normal transcript/description pass never sees. This
 * module fetches one thumbnail image, hands it to Claude as an image block,
 * and asks for a single-line transcription of whatever text is printed on
 * it. The batch route (thumbnails-ocr) calls this once per video and writes
 * the result into `videos.thumbnail_text` so it can be searched/analyzed
 * alongside titles and descriptions.
 */

const OCR_MODEL = "claude-sonnet-4-6";

const OCR_PROMPT =
  "Extract ONLY the text overlaid/printed on this YouTube thumbnail image. " +
  "Return the exact visible text, preserving original casing, joining " +
  "separate text blocks with ' / '. Do not describe the image. If there is " +
  "no overlaid text, return exactly: NONE";

export class ThumbnailOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailOcrError";
  }
}

type SupportedImageMediaType = "image/jpeg" | "image/png" | "image/webp";

function mediaTypeFromContentType(contentType: string | null): SupportedImageMediaType {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "image/png") return "image/png";
  if (type === "image/webp") return "image/webp";
  // Default to jpeg — YouTube thumbnails are jpeg the overwhelming majority
  // of the time, and it's the safest fallback when the header is missing
  // or reports something Claude's image blocks don't accept.
  return "image/jpeg";
}

/**
 * Fetch one thumbnail image and ask Claude to transcribe whatever text is
 * printed on it. Returns "" when the thumbnail has no overlaid text at all
 * (the model's explicit NONE signal) — never returns the literal "NONE".
 *
 * Single attempt, no retries: the caller (the batch route) treats each
 * video independently and keeps going on a per-item failure.
 */
export async function ocrThumbnail(
  thumbnailUrl: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(thumbnailUrl);
  if (!res.ok) {
    throw new ThumbnailOcrError(`Thumbnail fetch ${res.status}`);
  }

  const mediaType = mediaTypeFromContentType(res.headers.get("content-type"));
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString("base64");

  const client = new Anthropic({ apiKey });
  let raw: string;
  try {
    const response = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            { type: "text", text: OCR_PROMPT },
          ],
        },
      ],
    });
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    throw new ThumbnailOcrError(
      `Claude call failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const trimmed = raw.trim();
  if (trimmed.toUpperCase() === "NONE") return "";
  return trimmed.replace(/\s*\n+\s*/g, " / ");
}
