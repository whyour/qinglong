import {
  definePluginCreator,
  FixedLayoutPluginContext,
  PluginCreator,
} from '@flowgram.ai/fixed-layout-editor';

import { readData } from '../../shortcuts/utils';

export const createClipboardPlugin: PluginCreator<void> = definePluginCreator<
  void,
  FixedLayoutPluginContext
>({
  async onInit(ctx) {
    const clipboard = ctx.clipboard;
    clipboard.writeText(await readData(clipboard));
    const clipboardListener = (e: any) => {
      clipboard.writeText(e.value);
    };
    navigator.clipboard.addEventListener('onchange', clipboardListener);
    ctx.playground.toDispose.onDispose(() => {
      navigator.clipboard.removeEventListener('onchange', clipboardListener);
    });
  },
});
