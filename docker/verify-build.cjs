const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const manifest = JSON.parse(fs.readFileSync('static/build-info.json', 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const lockfileSha256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync('pnpm-lock.yaml'))
  .digest('hex');
if (
  manifest.dirty !== false ||
  manifest.sourceCommit !== sourceCommit ||
  manifest.lockfileSha256 !== lockfileSha256
) {
  throw new Error(
    'Build artifacts do not match the checked-out source and lockfile. Rebuild from the same clean commit.',
  );
}

if (process.argv[2]) {
  const dependencyLock = crypto
    .createHash('sha256')
    .update(fs.readFileSync(process.argv[2]))
    .digest('hex');
  if (dependencyLock !== manifest.lockfileSha256)
    throw new Error(
      'Production dependencies were built from a different lockfile.',
    );
}

for (const [file, key] of [
  ['static/build/app.js', 'backendSha256'],
  ['static/dist/index.html', 'frontendSha256'],
]) {
  const hash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
  if (hash !== manifest[key])
    throw new Error(`Build output checksum mismatch: ${file}`);
}
console.log(`Verified build artifacts for ${sourceCommit}`);
