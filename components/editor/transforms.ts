'use client';

import type { PlateEditor } from 'platejs/react';
import type { Path, TElement } from 'platejs';

import { KEYS } from 'platejs';
import { toggleList, unwrapList } from '@platejs/list-classic';

/**
 * Block transforms for the "Turn into" menu. The guide editor loads the
 * classic list plugins (ul/ol/li/lic), so lists are toggled with those; the
 * menu still uses the KEYS.ul / KEYS.ol values.
 */

/** Menu value → classic list container type. */
const CLASSIC_LIST: Record<string, string> = {
  [KEYS.ul]: KEYS.ulClassic,
  [KEYS.ol]: KEYS.olClassic,
};

/** Classic list container type → menu value. */
const MENU_VALUE: Record<string, string> = {
  [KEYS.ulClassic]: KEYS.ul,
  [KEYS.olClassic]: KEYS.ol,
};

const isInClassicList = (editor: PlateEditor) =>
  !!editor.api.some({ match: { type: [KEYS.ulClassic, KEYS.olClassic] } });

export const setBlockType = (
  editor: PlateEditor,
  type: string,
  { at }: { at?: Path } = {}
) => {
  if (at) editor.tf.select(at);

  const listType = CLASSIC_LIST[type] ?? (type in MENU_VALUE ? type : undefined);
  if (listType) {
    toggleList(editor, { type: listType });
    return;
  }

  editor.tf.withoutNormalizing(() => {
    if (isInClassicList(editor)) unwrapList(editor);
    editor.tf.setNodes({ type }, { match: (n) => editor.api.isBlock(n) && n.type !== type, mode: 'lowest' });
  });
};

export const getBlockType = (block: TElement) => MENU_VALUE[block.type] ?? block.type;

/** Links may only point to web pages or email addresses. */
export const isSafeLinkUrl = (url: string) => /^(https?:\/\/|mailto:)\S/i.test(url.trim());
