// Design system: see DESIGN_SYSTEM.md for typography/spacing decisions

"use client";

import * as React from "react";
import { useCallback, useEffect, useRef } from "react";
import { Plate, usePlateEditor } from "platejs/react";
import {
  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
  StrikethroughPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  BlockquotePlugin,
  HorizontalRulePlugin,
} from "@platejs/basic-nodes/react";
import {
  ListPlugin,
  BulletedListPlugin,
  NumberedListPlugin,
  ListItemPlugin,
  ListItemContentPlugin,
} from "@platejs/list-classic/react";
import { LinkPlugin } from "@platejs/link/react";
import { upsertLink } from "@platejs/link";
import { MarkdownPlugin } from "@platejs/markdown";
import { AIChatPlugin } from "@platejs/ai/react";
import remarkGfm from "remark-gfm";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Minus,
  Link as LinkIcon,
  WandSparkles,
} from "lucide-react";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { MarkToolbarButton } from "@/components/ui/mark-toolbar-button";
import { AIToolbarButton } from "@/components/ui/ai-toolbar-button";
import { UndoToolbarButton, RedoToolbarButton } from "@/components/ui/history-toolbar-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// UI node components — see DESIGN_SYSTEM.md
import { H1Element, H2Element, H2SectionElement, H3Element } from "@/components/ui/heading-node";
import { BlockquoteElement } from "@/components/ui/blockquote-node";
import { HrElement } from "@/components/ui/hr-node";
import { ParagraphElement } from "@/components/ui/paragraph-node";
import { CodeLeaf } from "@/components/ui/code-node";
import {
  BulletedListElement,
  NumberedListElement,
  ListItemElement,
} from "@/components/ui/list-classic-node";
import { LinkElement } from "@/components/ui/link-node";

// AI plugins
import { AIKit } from "@/components/editor/plugins/ai-kit";
// Plate-style SuggestionLeaf with hover/active (no DiscussionKit)
import { SuggestionAIKit } from "@/components/editor/plugins/suggestion-ai-kit";
// Floating toolbar (appears on text selection)
import { FloatingToolbarKit } from "@/components/editor/plugins/floating-toolbar-kit";
import { isSafeLinkUrl } from "@/components/editor/transforms";

/** Serialising the whole document is costly; wait for a short pause in typing. */
const CHANGE_DEBOUNCE_MS = 250;

interface GuideEditorProps {
  /** Initial markdown content */
  markdown: string;
  /** Called with the serialised markdown after edits (debounced, flushed on unmount) */
  onChange?: (markdown: string) => void;
  /** Optional class name */
  className?: string;
  /** Unique editor id when multiple editors on page (avoids Plate conflicts) */
  editorId?: string;
  /** Use H2SectionElement for section ids (sidebar jump, IntersectionObserver) */
  useSectionIds?: boolean;
  /** Enable AI features (Cmd+J menu, streaming). Only for paid users. */
  showAI?: boolean;
  /** Subscription tier for AI feature gating */
  subscriptionTier?: 'starter' | 'pro' | 'agency';
}

export function GuideEditor({
  markdown,
  onChange,
  className,
  editorId = "style-guide-editor",
  useSectionIds = false,
  showAI = false,
  subscriptionTier = 'starter',
}: GuideEditorProps) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = usePlateEditor({
    id: editorId,
    plugins: [
      // Markdown serialisation (must come first for deserialize/serialize)
      MarkdownPlugin.configure({
        options: { remarkPlugins: [remarkGfm] },
      }),

      // Block elements with custom components
      H1Plugin.configure({
        node: { component: H1Element },
        shortcuts: { toggle: { keys: "mod+alt+1" } },
      }),
      H2Plugin.configure({
        node: { component: useSectionIds ? H2SectionElement : H2Element },
        shortcuts: { toggle: { keys: "mod+alt+2" } },
      }),
      H3Plugin.configure({
        node: { component: H3Element },
        shortcuts: { toggle: { keys: "mod+alt+3" } },
      }),
      BlockquotePlugin.configure({
        node: { component: BlockquoteElement },
      }),
      HorizontalRulePlugin.withComponent(HrElement),

      // Lists
      ListPlugin,
      ListItemPlugin.withComponent(ListItemElement),
      ListItemContentPlugin,
      BulletedListPlugin.configure({
        node: { component: BulletedListElement },
      }),
      NumberedListPlugin.configure({
        node: { component: NumberedListElement },
      }),

      // Links: only web and email links (FE-16)
      LinkPlugin.configure({
        render: { node: LinkElement },
        options: { allowedSchemes: ["http", "https", "mailto"] },
      }),

      // Inline marks
      BoldPlugin,
      ItalicPlugin,
      UnderlinePlugin,
      StrikethroughPlugin,
      CodePlugin.configure({
        node: { component: CodeLeaf },
      }),

      // AI plugins + Plate-style SuggestionAIKit (SuggestionLeaf, Accept/Reject)
      ...(showAI ? [...SuggestionAIKit, ...AIKit] : []),

      // Floating toolbar (appears on text selection)
      ...FloatingToolbarKit,
    ],
    value: (ed) => {
      try {
        const api = ed.getApi(MarkdownPlugin);
        return (
          api?.markdown?.deserialize?.(
            markdown || "# Style Guide\n\nEdit your content here.",
            { remarkPlugins: [remarkGfm] }
          ) ?? [{ type: "p", children: [{ text: markdown || "Empty" }] }]
        );
      } catch {
        return [{ type: "p", children: [{ text: markdown || "Empty" }] }];
      }
    },
  });

  // Set subscription tier on AI plugin when it changes
  React.useEffect(() => {
    if (showAI) {
      try {
        editor.setOption(AIChatPlugin, 'subscriptionTier' as any, subscriptionTier);
      } catch {
        // AIChatPlugin not loaded
      }
    }
  }, [editor, showAI, subscriptionTier]);

  const emitChange = useCallback(() => {
    if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
    changeTimerRef.current = null;
    try {
      const serialized = editor.api.markdown?.serialize?.() ?? "";
      if (serialized) onChangeRef.current?.(serialized);
    } catch (e) {
      console.warn("[GuideEditor] Serialize error:", e);
    }
  }, [editor]);

  // Deliver the last pending change when the editor unmounts (e.g. switch to preview).
  useEffect(
    () => () => {
      if (changeTimerRef.current) emitChange();
    },
    [emitChange]
  );

  const handleValueChange = useCallback(() => {
    // Skip propagation while AI is streaming to prevent saving partial content
    if (showAI) {
      try {
        if (editor.getOption(AIChatPlugin, "streaming")) return;
      } catch {
        // AIChatPlugin not loaded
      }
    }
    if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
    changeTimerRef.current = setTimeout(emitChange, CHANGE_DEBOUNCE_MS);
  }, [editor, showAI, emitChange]);

  /** Link the selection (or insert the URL) after checking the scheme. */
  const insertLink = () => {
    const url = window.prompt("Enter a link (https://… or mailto:…):")?.trim();
    if (!url) return;
    if (!isSafeLinkUrl(url)) {
      window.alert("Links must start with https://, http:// or mailto:");
      return;
    }
    upsertLink(editor, { url });
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-4", className)}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950">
        <Plate editor={editor} onValueChange={handleValueChange}>
          <TooltipProvider delayDuration={200}>
              <FixedToolbar className="pdf-exclude shrink-0 justify-start gap-1 flex-row flex-nowrap overflow-x-auto">
              {/* Undo / Redo */}
              <ToolbarGroup className="flex-nowrap">
                <UndoToolbarButton />
                <RedoToolbarButton />
              </ToolbarGroup>

              {/* Headings */}
              <ToolbarGroup className="flex-nowrap">
                <ToolbarButton
                  tooltip="Heading 1 (Cmd+Alt+1)"
                  onClick={() => editor.tf.h1.toggle()}
                >
                  <Heading1 className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                  tooltip="Heading 2 (Cmd+Alt+2)"
                  onClick={() => editor.tf.h2.toggle()}
                >
                  <Heading2 className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                  tooltip="Heading 3 (Cmd+Alt+3)"
                  onClick={() => editor.tf.h3.toggle()}
                >
                  <Heading3 className="size-4" />
                </ToolbarButton>
              </ToolbarGroup>

              {/* AI button — only for paid users with showAI enabled */}
              {showAI && (
                <ToolbarGroup className="flex-nowrap">
                  <AIToolbarButton tooltip="AI writing commands (Cmd+J)">
                    <WandSparkles className="size-4" />
                    <span className="ml-1 text-xs font-medium">Ask AI</span>
                  </AIToolbarButton>
                </ToolbarGroup>
              )}

              {/* Text formatting */}
              <ToolbarGroup className="flex-nowrap">
                <MarkToolbarButton nodeType="bold" tooltip="Bold (Cmd+B)">
                  <Bold className="size-4" />
                </MarkToolbarButton>
                <MarkToolbarButton nodeType="italic" tooltip="Italic (Cmd+I)">
                  <Italic className="size-4" />
                </MarkToolbarButton>
                <MarkToolbarButton
                  nodeType="underline"
                  tooltip="Underline (Cmd+U)"
                >
                  <Underline className="size-4" />
                </MarkToolbarButton>
                <MarkToolbarButton
                  nodeType="strikethrough"
                  tooltip="Strikethrough (Cmd+Shift+X)"
                >
                  <Strikethrough className="size-4" />
                </MarkToolbarButton>
                <MarkToolbarButton nodeType="code" tooltip="Inline code (Cmd+E)">
                  <Code className="size-4" />
                </MarkToolbarButton>
              </ToolbarGroup>

              {/* Lists */}
              <ToolbarGroup className="flex-nowrap">
                <ToolbarButton
                  tooltip="Bullet list"
                  onClick={() => editor.tf.bulleted_list.toggle()}
                >
                  <List className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                  tooltip="Numbered list"
                  onClick={() => editor.tf.numbered_list.toggle()}
                >
                  <ListOrdered className="size-4" />
                </ToolbarButton>
              </ToolbarGroup>

              {/* Block elements */}
              <ToolbarGroup className="flex-nowrap">
                <ToolbarButton
                  tooltip="Blockquote"
                  onClick={() => editor.tf.blockquote.toggle()}
                >
                  <Quote className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                  tooltip="Horizontal rule"
                  onClick={() => {
                    editor.tf.insertNodes(
                      { type: "hr", children: [{ text: "" }] },
                      { select: true }
                    );
                  }}
                >
                  <Minus className="size-4" />
                </ToolbarButton>
                <ToolbarButton tooltip="Insert link" onClick={insertLink}>
                  <LinkIcon className="size-4" />
                </ToolbarButton>
              </ToolbarGroup>
              </FixedToolbar>
          </TooltipProvider>

          <EditorContainer className="min-h-0 flex-1 overflow-y-auto">
            <Editor
              variant="default"
              placeholder="Type your style guide content..."
              className="prose prose-slate dark:prose-invert max-w-none style-guide-content style-guide-document px-8 py-6"
            />
          </EditorContainer>
        </Plate>
      </div>
    </div>
  );
}
