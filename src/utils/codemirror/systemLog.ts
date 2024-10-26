import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { RangeSet, RangeSetBuilder } from '@codemirror/state';

const infoWord = /\[\ue6f5info\]/g;
const debugWord = /\[\ue67fdebug\]/g;
const warnWord = /\[\ue880warn\]/g;
const errorWord = /\[\ue602error\]/g;

const customWordClassMap = {
  info: 'system-log-info',
  warn: 'system-warn-info',
  error: 'system-error-info',
  debug: 'system-debug-info',
};

export const systemLogInfoHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: RangeSet<Decoration>;

    constructor(view: EditorView) {
      this.decorations = this.getDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = this.getDecorations(update.view);
      }
    }

    getDecorations(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc.toString();
      let match;

      while ((match = infoWord.exec(doc)) !== null) {
        const deco = Decoration.mark({
          class: customWordClassMap.info,
        });

        builder.add(match.index, match.index + match[0].length, deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export const systemLogWarnHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: RangeSet<Decoration>;

    constructor(view: EditorView) {
      this.decorations = this.getDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = this.getDecorations(update.view);
      }
    }

    getDecorations(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc.toString();
      let match;

      while ((match = warnWord.exec(doc)) !== null) {
        const deco = Decoration.mark({
          class: customWordClassMap.warn,
        });

        builder.add(match.index, match.index + match[0].length, deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export const systemLogDebugHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: RangeSet<Decoration>;

    constructor(view: EditorView) {
      this.decorations = this.getDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = this.getDecorations(update.view);
      }
    }

    getDecorations(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc.toString();
      let match;

      while ((match = debugWord.exec(doc)) !== null) {
        const deco = Decoration.mark({
          class: customWordClassMap.debug,
        });

        builder.add(match.index, match.index + match[0].length, deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export const systemLogErrorHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: RangeSet<Decoration>;

    constructor(view: EditorView) {
      this.decorations = this.getDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = this.getDecorations(update.view);
      }
    }

    getDecorations(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc.toString();
      let match;

      while ((match = errorWord.exec(doc)) !== null) {
        const deco = Decoration.mark({
          class: customWordClassMap.error,
        });

        builder.add(match.index, match.index + match[0].length, deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export const systemLogTheme = EditorView.baseTheme({
  '.system-log-info': {
    color: '#2196F3',
  },
  '.system-warn-info': {
    color: '#FFB827',
  },
  '.system-error-info': {
    color: '#FA5151',
  },
  '.system-debug-info': {
    color: '#009A29',
  },
});
