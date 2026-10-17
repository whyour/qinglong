const path = require('node:path');
require('../cli/node_modules/esbuild').buildSync({
  entryPoints: [path.resolve(__dirname, '../shell/install-bundle.cjs')],
  outfile: path.resolve(process.argv[2] || 'output/upgrade/install-bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: true,
  legalComments: 'inline',
});
const { spawnSync } = require('node:child_process');
const result = spawnSync(
  process.execPath,
  [path.resolve(process.argv[2] || 'output/upgrade/install-bundle.cjs')],
  { encoding: 'utf8' },
);
if (
  result.status !== 1 ||
  !result.stderr.includes('Usage: node install-bundle.cjs')
)
  throw new Error('Standalone offline installer did not start correctly');
