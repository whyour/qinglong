const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function restorePackageLock(root = path.resolve(__dirname, '..')) {
  const copy = path.join(root, 'shell/upgrade-lock.yaml');
  const destination = path.join(root, 'pnpm-lock.yaml');
  if (!fs.existsSync(copy)) {
    // Source checkouts already have the canonical lock; no built artifacts yet.
    if (fs.existsSync(destination)) return;
    throw new Error('Missing npm package upgrade lockfile');
  }
  const bytes = fs.readFileSync(copy);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'static/build-info.json'), 'utf8'),
  );
  if (
    manifest.dirty !== false ||
    manifest.lockfileSha256 !== createHash('sha256').update(bytes).digest('hex')
  )
    throw new Error('npm package lockfile does not match its build manifest');
  const temporary = path.join(root, `.upgrade-lock-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { restorePackageLock };
if (require.main === module) restorePackageLock();
