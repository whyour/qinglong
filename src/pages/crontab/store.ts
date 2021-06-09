import type { Pane } from './index';

const KEY_PANES = '__panes__';

export const store = {
  savePanes(panes: Pane[]) {
    localStorage.setItem(KEY_PANES, JSON.stringify({ data: panes }));
  },

  getPanes() {
    const panesStr = localStorage.getItem(KEY_PANES);
    try {
      if (panesStr) {
        let panes = JSON.parse(panesStr);
        return panes.data;
      }
    } catch (e) {}
    return null;
  },
};
