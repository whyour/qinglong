const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { collectBuildFiles } = require('../docker/build-manifest.cjs');

const root = process.cwd();
for (const output of ['static/build/app.js', 'static/dist/index.html']) {
  if (!fs.existsSync(path.join(root, output)))
    throw new Error(`Missing build output: ${output}`);
}
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const manifest = {
  version: 1,
  files: collectBuildFiles(),
  sourceCommit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=all') !== '',
  lockfileSha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync('pnpm-lock.yaml'))
    .digest('hex'),
};
fs.writeFileSync(
  'static/build-info.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
