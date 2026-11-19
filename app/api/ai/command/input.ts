import type { TSelection, Value } from 'platejs';
import { z } from 'zod';

import type { ChatMessage, ToolName } from '@/components/editor/use-chat';

/** Limits for /api/ai/command requests. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Only the most recent messages are sent to the model. */
export const MAX_MESSAGES = 10;
/** Total characters across the text parts of the kept messages. */
export const MAX_MESSAGE_CHARS = 50_000;
/** Top-level blocks in the editor document (`ctx.children`). */
export const MAX_DOC_BLOCKS = 5_000;

const PointSchema = z.object({
  path: z.array(z.number().int().nonnegative()).max(50),
  offset: z.number().int().nonnegative(),
});

const MessageSchema = z.looseObject({
  id: z.string().max(200),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).max(200),
});

const BodySchema = z.object({
  messages: z.array(MessageSchema).max(500),
  ctx: z
    .object({
      children: z.array(z.looseObject({ children: z.array(z.unknown()) })),
      selection: z.object({ anchor: PointSchema, focus: PointSchema }).nullable().optional(),
      toolName: z.enum(['comment', 'edit', 'generate']).nullable().optional(),
    })
    .optional(),
});

export interface CommandInput {
  messages: ChatMessage[];
  children: Value;
  selection: TSelection;
  toolName?: ToolName;
}

export type ParseResult =
  | { ok: true; input: CommandInput }
  | { ok: false; status: 400 | 413; error: string };

const EMPTY_DOC: Value = [{ type: 'p', children: [{ text: '' }] }];

function messageChars(messages: z.infer<typeof MessageSchema>[]): number {
  return messages.reduce(
    (sum, m) => sum + m.parts.reduce((s, p) => s + (p.text?.length ?? 0), 0),
    0
  );
}

/** Validate and trim an /api/ai/command body. Never trusts a client-chosen model. */
export function parseCommandBody(raw: unknown): ParseResult {
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: 'Invalid request' };

  const { ctx } = parsed.data;
  const messages = parsed.data.messages.slice(-MAX_MESSAGES);
  if (messageChars(messages) > MAX_MESSAGE_CHARS) {
    return { ok: false, status: 413, error: 'Request is too long' };
  }
  if (ctx && ctx.children.length > MAX_DOC_BLOCKS) {
    return { ok: false, status: 413, error: 'Document is too large' };
  }

  return {
    ok: true,
    input: {
      // Shape checked above; the remaining part fields are opaque to the server.
      messages: messages as ChatMessage[],
      children: ctx?.children.length ? (ctx.children as Value) : EMPTY_DOC,
      selection: ctx?.selection ?? null,
      toolName: ctx?.toolName ?? undefined,
    },
  };
}
