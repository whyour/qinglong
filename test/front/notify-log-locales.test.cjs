const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('notification log column titles resolve in every supported locale', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/pages/setting/notifyLog.tsx'),
    'utf8',
  );
  const titles = [...source.matchAll(/title:\s*intl\.get\('([^']+)'\)/g)].map(
    (m) => m[1],
  );
  assert.ok(titles.includes('标题') && titles.includes('内容'));
  for (const locale of ['zh-CN', 'en-US']) {
    const messages = require(`../../src/locales/${locale}.json`);
    for (const title of titles)
      assert.ok(messages[title]?.trim(), `${locale}: ${title}`);
  }
});
