import { z } from "zod";

/** Hard caps for untrusted chat payloads. */
export const MAX_MESSAGES = 60;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_QUESTION_CHARS = 4000;
export const MAX_DOCUMENT_IDS = 25;
export const MIN_SIMILARITY = 0.25;
export const RETRIEVAL_K = 6;

const uuid = z.string().uuid();

const textPart = z.object({
  type: z.literal("text"),
  text: z.string().max(MAX_MESSAGE_CHARS),
});

const otherPart = z
  .object({ type: z.string().min(1).max(64) })
  .passthrough()
  .refine((part) => part.type !== "text", { message: "handled by textPart" });

const uiMessage = z.object({
  id: z.string().min(1).max(128).optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z
    .array(z.union([textPart, otherPart]))
    .min(1)
    .max(40),
});

export const chatRequestSchema = z.object({
  threadId: uuid,
  messages: z.array(uiMessage).min(1).max(MAX_MESSAGES),
  documentIds: z.array(uuid).max(MAX_DOCUMENT_IDS).nullish(),
  id: z.string().max(128).optional(),
  trigger: z.string().max(64).optional(),
  messageId: z.string().max(128).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** Concatenated text of the most recent user turn, trimmed and length-checked. */
export function extractQuestion(messages: ChatRequest["messages"]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const text = message.parts
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join(" ")
      .trim();
    if (!text || text.length > MAX_QUESTION_CHARS) return null;
    return text;
  }
  return null;
}

export const GROUNDED_REFUSAL = "I don't know — that isn't covered in your documents.";
