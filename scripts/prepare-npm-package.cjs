// npm-packlist always excludes the root pnpm lockfile, even with a files entry.
// Carry a checked copy under a runtime filename and restore it after installation.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const copy = path.join(root, 'shell/upgrade-lock.yaml');
if (process.argv.includes('--clean')) {
  fs.rmSync(copy, { force: true });
} else {
  if (execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim())
    throw new Error('Pack only from a clean source checkout');
  // The native npm pack/publish hooks must enforce the same checks as CI:
  // current commit, clean build, lockfile and every output file's checksum.
  // Capture stdout so npm pack --json remains machine-readable.
  execFileSync(process.execPath, [path.join(root, 'docker/verify-build.cjs')], { cwd: root });
  const bytes = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'));
  fs.rmSync(copy, { force: true });
  fs.writeFileSync(copy, bytes, { flag: 'wx', mode: 0o644 });
}
