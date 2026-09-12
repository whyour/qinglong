const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = process.cwd();
for (const output of ['static/build/app.js', 'static/dist/index.html']) {
  if (!fs.existsSync(path.join(root, output)))
    throw new Error(`Missing build output: ${output}`);
}
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hashFile = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = {
  backendSha256: hashFile('static/build/app.js'),
  frontendSha256: hashFile('static/dist/index.html'),
  sourceCommit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  lockfileSha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync('pnpm-lock.yaml'))
    .digest('hex'),
};
fs.writeFileSync(
  'static/build-info.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
