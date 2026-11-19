'use client';

import * as React from 'react';

import { type UseChatHelpers, useChat as useBaseChat } from '@ai-sdk/react';
import { type AIChatPluginConfig, AIChatPlugin } from '@platejs/ai/react';
import { type UIMessage, DefaultChatTransport } from 'ai';
import { useEditorRef, usePluginOption } from 'platejs/react';

import { aiChatPlugin } from '@/components/editor/plugins/ai-kit';

export type ToolName = 'comment' | 'edit' | 'generate';

export type AIComment = { blockId: string; comment: string; content: string };
export type AITableCellUpdate = { id: string; content: string };
type StreamStatus = 'streaming' | 'finished';

/** Data parts streamed by /api/ai/command (as `data-${key}` chunks). */
export type MessageDataPart = {
  toolName: ToolName;
  comment: { comment: AIComment | null; status: StreamStatus };
  table: { cellUpdate: AITableCellUpdate | null; status: StreamStatus };
};

export type ChatMessage = UIMessage<unknown, MessageDataPart>;

export type Chat = UseChatHelpers<ChatMessage>;

/**
 * Plate types its `chat` option with its own message type, whose data parts
 * omit our `table` and streaming-status payloads. Plate only reads the shared
 * fields (status, messages, sendMessage...), so the narrowing cast is safe.
 */
type PluginChat = AIChatPluginConfig['options']['chat'];

export const useChat = () => {
  const editor = useEditorRef();
  const options = usePluginOption(aiChatPlugin, 'chatOptions');

  const chat = useBaseChat<ChatMessage>({
    id: 'editor',
    transport: new DefaultChatTransport({ api: options.api }),
    onData(dataPart) {
      if (dataPart.type === 'data-toolName') {
        editor.setOption(AIChatPlugin, 'toolName', dataPart.data);
      }
    },
  });

  React.useEffect(() => {
    editor.setOption(AIChatPlugin, 'chat', chat as unknown as PluginChat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.status, chat.messages, chat.error]);

  return chat;
};
