const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { collectBuildFiles } = require('./build-manifest.cjs');

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

const actual = collectBuildFiles();
if (
  manifest.version !== 1 ||
  !manifest.files ||
  JSON.stringify(Object.keys(actual).sort()) !==
    JSON.stringify(Object.keys(manifest.files).sort())
)
  throw new Error(
    'Build output file set mismatch. Rebuild the complete artifacts.',
  );
for (const [file, hash] of Object.entries(actual)) {
  if (hash !== manifest.files[file])
    throw new Error(`Build output checksum mismatch: ${file}`);
}
console.log(`Verified build artifacts for ${sourceCommit}`);
