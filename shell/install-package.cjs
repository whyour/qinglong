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

function restoreEnvironment(root = path.resolve(__dirname, '..')) {
  // npm's Arborist keeps this exact retirement directory until lifecycle scripts
  // succeed, then deletes it. Never search other installations or sibling backups.
  const suffix = createHash('sha1').update(root).digest('base64')
    .replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8);
  const retired = path.join(path.dirname(root), `.${path.basename(root)}-${suffix}`);
  const destination = path.join(root, '.env');
  const exists = (file) => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  };
  if (exists(destination)) return;
  const directory = exists(retired);
  if (!directory) return;
  if (!directory.isDirectory()) throw new Error('Invalid npm retirement directory');
  const metadata = path.join(retired, 'package.json');
  if (!exists(metadata)?.isFile()) throw new Error('Invalid retired npm package');
  if (JSON.parse(fs.readFileSync(metadata, 'utf8')).name !== '@whyour/qinglong')
    throw new Error('Unexpected retired npm package');
  const source = path.join(retired, '.env');
  const stat = exists(source);
  if (!stat) return;
  if (!stat.isFile()) throw new Error('Retired npm .env must be a regular file');
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const temporary = path.join(root, `.upgrade-env-${randomUUID()}`);
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid retired npm .env');
    fs.writeFileSync(temporary, fs.readFileSync(descriptor), { flag: 'wx', mode: 0o600 });
    // Linking publishes a complete file without replacing a concurrently created .env.
    try { fs.linkSync(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function installPackage(root = path.resolve(__dirname, '..')) {
  restorePackageLock(root);
  restoreEnvironment(root);
}

module.exports = { restorePackageLock, restoreEnvironment, installPackage };
if (require.main === module) installPackage();
