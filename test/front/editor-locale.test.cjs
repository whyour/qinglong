const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');
for (const [locale, expected] of [
  ['en', 'i-default'],
  ['zh', 'zh-cn'],
])
  test(`Monaco uses the matching bundled locale for ${locale}`, () => {
    let options;
    const { init } = load('src/utils/init.ts', {
      '@monaco-editor/react': {
        loader: {
          config: (value) => {
            options = value;
          },
        },
      },
      './config': { baseUrl: '/panel/' },
      'react-intl-universal': {
        getInitOptions: () => ({ currentLocale: locale }),
      },
    });
    init('2.23.0');
    assert.equal(options.paths.vs, '/panel/monaco-editor/min/vs');
    assert.equal(options['vs/nls'].availableLanguages['*'], expected);
    const fs = require('node:fs');
    assert.ok(
      fs.existsSync(
        'node_modules/monaco-editor/min/vs/editor/editor.main.nls' +
          (expected === 'i-default' ? '' : '.' + expected) +
          '.js',
      ),
    );
  });
