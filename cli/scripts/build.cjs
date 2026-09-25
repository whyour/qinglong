const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Deleted commands must not survive incremental builds or npm prepack.
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ],
  { stdio: 'inherit' },
);
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'src/shared/cli/commander.ts')],
  outfile: path.join(root, 'dist/shared/cli/commander.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  sourcemap: true,
  legalComments: 'inline',
});
const license = path.join(
  path.dirname(require.resolve('commander')),
  'LICENSE',
);
fs.mkdirSync(path.join(root, 'dist/licenses'), { recursive: true });
fs.copyFileSync(license, path.join(root, 'dist/licenses/commander-LICENSE'));

// The public npm artifact must not contain or import local operational code.
const remote = require('esbuild').buildSync({
  entryPoints: [path.join(root, 'src/entrypoints/remote.ts')],
  outfile: path.join(root, 'dist/npm/ql.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  sourcemap: true,
  legalComments: 'inline',
  metafile: true,
});
for (const input of Object.keys(remote.metafile.inputs)) {
  if (/(?:^|[\\/])src[\\/](?:internal|compatibility|developer)[\\/]/.test(input))
    throw new Error(
      'Local implementation leaked into remote npm bundle: ' + input,
    );
}
fs.copyFileSync(license, path.join(root, 'dist/npm/commander-LICENSE'));

// Keep existing panel/cron executable paths stable after source reorganization.
for (const [name, entry] of Object.entries(require('./entrypoints.cjs'))) {
  const target = path.join(root, 'dist', name);
  let relative = path
    .relative(path.dirname(target), path.join(root, 'dist', entry.module))
    .split(path.sep)
    .join('/');
  if (!relative.startsWith('.')) relative = './' + relative;
  const run = entry.method
    ? `
if (require.main === module) void entry.${entry.method}().then(code => { process.exitCode = code; });`
    : '';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    '#!/usr/bin/env node\nconst entry = require(' +
      JSON.stringify(relative) +
      ');\nmodule.exports = entry;' +
      run +
      '\n',
    { mode: 0o755 },
  );
}
