import { createOpenAI } from '@ai-sdk/openai';
import {
  type LanguageModel,
  type UIMessageStreamWriter,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateObject,
  streamObject,
  streamText,
  tool,
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

/** Server-side model allow-list: the client cannot choose the model. */
const MODEL_ID = 'gpt-5-mini';
const RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

type Writer = UIMessageStreamWriter<ChatMessage>;

export async function POST(req: Request) {
  return withRouteErrors('ai/command', async () => {
    // The editor AI is a paid feature (the menu shows an upgrade dialog to starter users).
    const auth = await requireUser({ requirePaid: true });
    if (!auth.ok) return auth.response;

    const limited = await checkRateLimit(`ai-command:${clientKey(req, auth.user.id)}`, RATE_LIMIT);
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

    if (!process.env.OPENAI_API_KEY) {
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
    const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(MODEL_ID);
    const isSelecting = editor.api.isExpanded();

    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        const toolName = requestedTool ?? (await chooseTool(model, isSelecting, messages));
        writer.write({ type: 'data-toolName', data: toolName });

        const result = streamText({
          model,
          prompt: '',
          tools: {
            comment: getCommentTool(editor, { messages, model, writer }),
            table: getTableTool(editor, { messages, model, writer }),
          },
          prepareStep: async (step) => {
            if (toolName === 'comment') {
              return { ...step, toolChoice: { toolName: 'comment', type: 'tool' } };
            }

            if (toolName === 'edit' && isSelecting) {
              try {
                const [editPrompt, editType] = getEditPrompt(editor, { isSelecting, messages });
                if (editType === 'table') {
                  return { ...step, toolChoice: { toolName: 'table', type: 'tool' } };
                }
                return {
                  ...step,
                  activeTools: [],
                  messages: [{ content: editPrompt, role: 'user' }],
                  model,
                };
              } catch {
                // Fall back to generate if the edit prompt fails (e.g. invalid selection)
              }
            }

            return {
              ...step,
              activeTools: [],
              messages: [
                { content: getGeneratePrompt(editor, { isSelecting, messages }), role: 'user' },
              ],
              model,
            };
          },
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
  });
  return object;
}

interface ToolContext {
  messages: ChatMessage[];
  model: LanguageModel;
  writer: Writer;
}

function getCommentTool(editor: SlateEditor, { messages, model, writer }: ToolContext) {
  return tool({
    description: 'Comment on the content',
    inputSchema: z.object({}),
    execute: async () => {
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
      });

      for await (const comment of elementStream) {
        writer.write({ id: nanoid(), type: 'data-comment', data: { comment, status: 'streaming' } });
      }
      writer.write({ id: nanoid(), type: 'data-comment', data: { comment: null, status: 'finished' } });
    },
  });
}

function getTableTool(editor: SlateEditor, { messages, model, writer }: ToolContext) {
  return tool({
    description: 'Edit table cells',
    inputSchema: z.object({}),
    execute: async () => {
      const { elementStream } = streamObject({
        model,
        output: 'array',
        schema: z.object({
          content: z.string().describe('The new content for the cell.'),
          id: z.string().describe('The id of the table cell to update.'),
        }),
        prompt: buildEditTableMultiCellPrompt(editor, messages),
      });

      for await (const cellUpdate of elementStream) {
        writer.write({ id: nanoid(), type: 'data-table', data: { cellUpdate, status: 'streaming' } });
      }
      writer.write({ id: nanoid(), type: 'data-table', data: { cellUpdate: null, status: 'finished' } });
    },
  });
}
