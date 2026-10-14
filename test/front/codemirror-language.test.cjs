const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const { EditorState } = require('@codemirror/state');
const load = require('../helpers/load-security-module.cjs');
const { getCodeMirrorExtensions } = load(
  path.resolve(__dirname, '../../src/utils/codemirror/language.ts'),
);
const { LANG_MAP } = load(path.resolve(__dirname, '../../src/utils/const.ts'));
const languageRequire = createRequire(
  require.resolve('@uiw/codemirror-extensions-langs'),
);
const { syntaxTree } = languageRequire('@codemirror/language');

test('INI documents load and remain editable with CodeMirror syntax support', () => {
  const doc = '; comment\n[section]\nkey=value\n';
  const state = EditorState.create({
    doc,
    extensions: getCodeMirrorExtensions(LANG_MAP['.ini']),
  });
  assert.ok(syntaxTree(state).length > 0);
  assert.ok(syntaxTree(state).topNode.firstChild, 'INI tokens were parsed');
  const updated = state.update({
    changes: {
      from: doc.indexOf('value'),
      to: doc.indexOf('value') + 5,
      insert: 'edited',
    },
  }).state;
  assert.equal(updated.doc.toString(), '; comment\n[section]\nkey=edited\n');
});

test('every configured script language supplies a valid CodeMirror extension', () => {
  for (const mode of new Set(Object.values(LANG_MAP))) {
    const extensions = getCodeMirrorExtensions(mode);
    assert.equal(extensions.length, 1, mode);
    assert.doesNotThrow(
      () => EditorState.create({ doc: 'sample', extensions }),
      mode,
    );
  }
});

test('unknown or empty languages fall back to editable plain text', () => {
  for (const mode of ['', undefined, 'unknown', 'constructor', 'toString']) {
    const extensions = getCodeMirrorExtensions(mode);
    assert.deepEqual(extensions, []);
    const state = EditorState.create({ doc: 'text', extensions });
    assert.equal(
      state
        .update({ changes: { from: 4, insert: ' edited' } })
        .state.doc.toString(),
      'text edited',
    );
  }
});
