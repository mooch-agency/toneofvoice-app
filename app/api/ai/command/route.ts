import { type AnthropicProviderOptions, createAnthropic } from '@ai-sdk/anthropic';
import {
  type LanguageModel,
  type UIMessageStreamWriter,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateObject,
  streamObject,
  streamText,
} from 'ai';
import { type SlateEditor, createSlateEditor, nanoid } from 'platejs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { BaseEditorKit } from '@/components/editor/editor-base-kit';
import type { ChatMessage, ToolName } from '@/components/editor/use-chat';
import { requireUser, tooManyRequests, withRouteErrors } from '@/lib/api-auth';
import { clientKey } from '@/lib/rate-limit'
import { checkRateLimit } from '@/lib/rate-limit-durable';

import { MAX_BODY_BYTES, parseCommandBody } from './input';
import {
  buildEditTableMultiCellPrompt,
  getChooseToolPrompt,
  getCommentPrompt,
  getEditPrompt,
  getGeneratePrompt,
} from './prompt';

/**
 * Server-side model allow-list: the client cannot choose the model.
 * Moved off OpenAI gpt-5-mini (retired 11 Dec 2026) to Claude Sonnet 5.5 in Nov 2026.
 */
const MODEL_ID = 'claude-sonnet-5-5';
const RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

/**
 * Claude Sonnet 5.5 returns 400 for forced tool_choice (any/tool), non-default
 * temperature/top_p/top_k, `thinking: disabled` or `budget_tokens`, and an
 * assistant prefill. This route sends none of them: no sampling settings, no
 * `thinking` (the model's default adaptive thinking runs), no tools at all, and
 * prompts that are a single user message. route.test.ts asserts this against
 * the real outgoing request bodies.
 *
 * - structuredOutputMode 'outputFormat': generateObject/streamObject use native
 *   structured outputs (`output_config.format`) instead of the provider's legacy
 *   forced "json" tool, so object generation never forces a tool call.
 * - effort: 'low' for the one-word tool choice, 'medium' for writing. Sonnet 5.5
 *   defaults to 'high', which is slower than an inline editor command needs.
 * - fallbacks 'default': if a safety classifier declines, the API retries on a
 *   fallback model it picks by refusal category, inside the same call.
 */
const CLAUDE_OPTIONS = {
  fallbacks: 'default',
  structuredOutputMode: 'outputFormat',
} as const satisfies AnthropicProviderOptions;
const CHOOSE_TOOL_OPTIONS = { anthropic: { ...CLAUDE_OPTIONS, effort: 'low' } };
const WRITE_OPTIONS = { anthropic: { ...CLAUDE_OPTIONS, effort: 'medium' } };

type Writer = UIMessageStreamWriter<ChatMessage>;

export async function POST(req: Request) {
  return withRouteErrors('ai/command', async () => {
    // The editor AI is a paid feature (the menu shows an upgrade dialog to starter users).
    const auth = await requireUser({ requirePaid: true });
    if (!auth.ok) return auth.response;

    const limited = await checkRateLimit(`ai-command:${clientKey(req, auth.user.id)}`, RATE_LIMIT);
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'AI service not configured' }, { status: 503 });
    }

    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request is too large' }, { status: 413 });
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request is too large' }, { status: 413 });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const parsed = parseCommandBody(raw);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    }
    const { messages, children, selection, toolName: requestedTool } = parsed.input;

    const editor = createSlateEditor({ plugins: BaseEditorKit, selection, value: children });
    const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(MODEL_ID);
    const isSelecting = editor.api.isExpanded();

    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        const toolName = requestedTool ?? (await chooseTool(model, isSelecting, messages));
        writer.write({ type: 'data-toolName', data: toolName });

        // Comments and table edits stream structured objects as data parts. They used to run
        // as tools forced via toolChoice; Sonnet 5.5 rejects forced tool choice, and the client
        // only reads the data parts, so the route now calls them directly.
        const ctx: StreamContext = { messages, model, writer };
        if (toolName === 'comment') return streamComments(editor, ctx);

        let prompt: string | undefined;
        if (toolName === 'edit' && isSelecting) {
          try {
            const [editPrompt, editType] = getEditPrompt(editor, { isSelecting, messages });
            if (editType === 'table') return streamTableEdits(editor, ctx);
            prompt = editPrompt;
          } catch {
            // Fall back to generate if the edit prompt fails (e.g. invalid selection)
          }
        }

        const result = streamText({
          model,
          prompt: prompt ?? getGeneratePrompt(editor, { isSelecting, messages }),
          providerOptions: WRITE_OPTIONS,
        });
        writer.merge(result.toUIMessageStream({ sendFinish: false }));
      },
    });

    return createUIMessageStreamResponse({ stream });
  });
}

async function chooseTool(
  model: LanguageModel,
  isSelecting: boolean,
  messages: ChatMessage[]
): Promise<ToolName> {
  const options: ToolName[] = isSelecting ? ['generate', 'edit', 'comment'] : ['generate', 'comment'];
  const { object } = await generateObject({
    model,
    output: 'enum',
    enum: options,
    prompt: getChooseToolPrompt({ isSelecting, messages }),
    providerOptions: CHOOSE_TOOL_OPTIONS,
  });
  return object;
}

interface StreamContext {
  messages: ChatMessage[];
  model: LanguageModel;
  writer: Writer;
}

async function streamComments(editor: SlateEditor, { messages, model, writer }: StreamContext) {
  const { elementStream } = streamObject({
    model,
    output: 'array',
    schema: z.object({
      blockId: z.string().describe('The id of the starting block.'),
      comment: z.string().describe('A brief comment for this fragment.'),
      content: z
        .string()
        .describe(
          'The original document fragment. If spanning multiple blocks, separate with \\n\\n.'
        ),
    }),
    prompt: getCommentPrompt(editor, { messages }),
    providerOptions: WRITE_OPTIONS,
  });

  for await (const comment of elementStream) {
    writer.write({ id: nanoid(), type: 'data-comment', data: { comment, status: 'streaming' } });
  }
  writer.write({ id: nanoid(), type: 'data-comment', data: { comment: null, status: 'finished' } });
}

async function streamTableEdits(editor: SlateEditor, { messages, model, writer }: StreamContext) {
  const { elementStream } = streamObject({
    model,
    output: 'array',
    schema: z.object({
      content: z.string().describe('The new content for the cell.'),
      id: z.string().describe('The id of the table cell to update.'),
    }),
    prompt: buildEditTableMultiCellPrompt(editor, messages),
    providerOptions: WRITE_OPTIONS,
  });

  for await (const cellUpdate of elementStream) {
    writer.write({ id: nanoid(), type: 'data-table', data: { cellUpdate, status: 'streaming' } });
  }
  writer.write({ id: nanoid(), type: 'data-table', data: { cellUpdate: null, status: 'finished' } });
}
