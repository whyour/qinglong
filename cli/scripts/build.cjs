const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Deleted commands must not survive incremental builds or npm prepack.
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')], { stdio:'inherit' });
require('esbuild').buildSync({
  entryPoints:[path.join(root, 'src/framework/commander.ts')],
  outfile:path.join(root, 'dist/framework/commander.js'),
  bundle:true, platform:'node', format:'cjs', target:'node22',
  minify:true, sourcemap:true, legalComments:'inline',
});
const license = path.join(path.dirname(require.resolve('commander')), 'LICENSE');
fs.mkdirSync(path.join(root, 'dist/licenses'), {recursive:true});
fs.copyFileSync(license, path.join(root, 'dist/licenses/commander-LICENSE'));

// The public npm artifact must not contain or import local operational code.
const remote = require('esbuild').buildSync({
  entryPoints: [path.join(root, 'src/remote.ts')],
  outfile: path.join(root, 'dist/npm/ql.js'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  minify: true, sourcemap: true, legalComments: 'inline', metafile: true,
});
for (const input of Object.keys(remote.metafile.inputs)) {
  if (/[\\/]src[\\/](?:local|developer)[\\/]/.test(input))
    throw new Error('Local implementation leaked into remote npm bundle: ' + input);
}
fs.copyFileSync(license, path.join(root, 'dist/npm/commander-LICENSE'));
