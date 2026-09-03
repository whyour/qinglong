'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  auditLegacyPanelBundle,
  bundleLegacyPanel,
} = require('../../scripts/ql3-legacy-panel-bundle.cjs');

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-panel-bundle-')),
  );
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(source, 'monaco-editor'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'index.html'),
    '<!DOCTYPE html>\n' +
      '<html><head>\n' +
      '<link rel="shortcut icon" href="https://qn.whyour.cn/favicon.svg">\n' +
      '<link rel="stylesheet" href="./umi.1234abcd.css">\n' +
      '<script src="./api/env.js"></script>\n' +
      '</head><body><div id="root"></div>\n' +
      '<script src="./umi.1234abcd.js"></script></body></html>\n',
  );
  fs.writeFileSync(
    path.join(source, 'umi.1234abcd.css'),
    'body { color: #123; }\n',
  );
  fs.writeFileSync(
    path.join(source, 'umi.1234abcd.js'),
    'globalThis.__panel = true;\n',
  );
  fs.writeFileSync(path.join(source, 'umi.1234abcd.js.gz'), 'not shipped');
  fs.writeFileSync(
    path.join(source, 'monaco-editor', 'editor.1234abcd.js'),
    'not shipped',
  );
  return {
    root,
    source,
    output,
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('materializes one bounded offline legacy panel closure', (t) => {
  const current = fixture();
  t.after(() => current.close());
  const report = bundleLegacyPanel(current.source, current.output);
  assert.deepEqual(report, {
    schema: 'qinglong/local-legacy-panel-assets@v1',
    files: 4,
    bytes: report.bytes,
    maxFiles: 256,
    maxBytes: 13 * 1024 * 1024,
    supportedRoutes: ['/login', '/crontab', '/error'],
    compatible: true,
  });
  assert.ok(report.bytes > 200);
  assert.equal(
    fs.existsSync(path.join(current.output, 'umi.1234abcd.js.gz')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(current.output, 'monaco-editor')),
    false,
  );
  const index = fs.readFileSync(
    path.join(current.output, 'index.html'),
    'utf8',
  );
  assert.equal(index.includes('https://'), false);
  const environment = fs.readFileSync(
    path.join(current.output, 'api/env.js'),
    'utf8',
  );
  assert.equal(environment.includes("QlBaseUrl: '/'"), true);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(current.output, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.files[0].requestPath, '/');
  assert.equal(
    manifest.files.find(({ requestPath }) => requestPath === '/api/env.js')
      .cacheControl,
    'no-store',
  );
  assert.equal(
    manifest.files.find(({ requestPath }) =>
      /\.[0-9a-f]{8}\.js$/u.test(requestPath),
    ).cacheControl,
    'public, max-age=31536000, immutable',
  );
  assert.deepEqual(auditLegacyPanelBundle(current.output), report);
});

test('rejects bundle replacement and post-build asset drift', (t) => {
  const current = fixture();
  t.after(() => current.close());
  bundleLegacyPanel(current.source, current.output);
  assert.throws(
    () => bundleLegacyPanel(current.source, current.output),
    /output must be an absent directory/u,
  );
  const assetPath = path.join(current.output, 'umi.1234abcd.js');
  fs.chmodSync(assetPath, 0o600);
  fs.appendFileSync(assetPath, 'drift');
  assert.throws(
    () => auditLegacyPanelBundle(current.output),
    /asset identity drifted|asset digest drifted/u,
  );
});

test('rejects mutable assets and external entrypoint drift', (t) => {
  const mutable = fixture();
  t.after(() => mutable.close());
  fs.writeFileSync(path.join(mutable.source, 'runtime.js'), 'mutable');
  assert.throws(
    () => bundleLegacyPanel(mutable.source, mutable.output),
    /mutable source asset/u,
  );

  const external = fixture();
  t.after(() => external.close());
  fs.appendFileSync(
    path.join(external.source, 'index.html'),
    '<script src="https://example.invalid/panel.js"></script>\n',
  );
  assert.throws(
    () => bundleLegacyPanel(external.source, external.output),
    /retains an external origin/u,
  );
});

test('keeps the QL3 legacy panel log journey canonical, bounded and caller-driven', () => {
  const crontab = fs.readFileSync(
    path.resolve(__dirname, '../../src/pages/crontab/index.tsx'),
    'utf8',
  );
  const logModal = fs.readFileSync(
    path.resolve(__dirname, '../../src/pages/crontab/logModal.tsx'),
    'utf8',
  );

  assert.match(
    crontab,
    /\['name', 'command', 'status', 'schedule', 'action'\]/u,
  );
  assert.match(crontab, /!qingLong3ReadOnly && record\.status/u);
  assert.match(crontab, /qingLong3=\{qingLong3\}/u);
  assert.match(
    crontab,
    /useEffect\(\(\) => \{\s+if \(qingLong3ReadOnly\) return;[\s\S]+setTimeout\(poll, 10000\)/u,
  );

  assert.match(logModal, /qingLong3Credential\(\)/u);
  assert.match(
    logModal,
    /Math\.min\(capabilities\.limits\.cronPageSize, remaining\)/u,
  );
  assert.match(logModal, /\/api\/v3\/projects\/\$\{projectId\}\/runs\?/u);
  assert.match(logModal, /run\?\.triggerId === triggerId/u);
  assert.match(logModal, /attempts\/\$\{attempt\.id\}\/log\?offset=0&length=/u);
  assert.match(
    logModal,
    /if \(qingLong3\) \{[\s\S]+readQingLong3CronLog[\s\S]+return;\s+\}\s+request/u,
  );
  assert.match(logModal, />\s*刷新\s*<\/Button>/u);
});
