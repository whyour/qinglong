'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Pass official source root and fresh output/dist');
const cliDir = path.join(source, 'pnpm');
const req = createRequire(path.join(cliDir, 'package.json'));
const { build } = req('esbuild');
fs.mkdirSync(output, { recursive: true });
// Upstream bundle.ts options, with the optional macOS/Windows reflink module external.
// Linux uses Node fs.COPYFILE_FICLONE_FORCE; no native payload is needed there.
const common = {
  absWorkingDir: cliDir,
  bundle: true,
  platform: 'node',
  external: ['@reflink/reflink'],
  loader: { '.node': 'copy' },
  nodePaths: [],
  plugins: [{
    name: 'only-recorded-source-tree',
    setup(builder) {
      builder.onLoad({ filter: /.*/ }, args => {
        const real = fs.realpathSync(args.path);
        if (real !== source && !real.startsWith(source + path.sep)) {
          return { errors: [{ text: 'Refusing unrecorded ancestor or global module: ' + args.path }] };
        }
        return undefined;
      });
    },
  }],
};
(async () => {
  await build({
    ...common,
    entryPoints: ['lib/pnpm.js'],
    outfile: path.join(output, 'pnpm.cjs'),
    external: [...common.external, 'node-gyp', './get-uid-gid.js'],
    define: {
      'process.env.npm_package_name': JSON.stringify('pnpm'),
      'process.env.npm_package_version': JSON.stringify('10.34.6'),
    },
  });
  await build({
    ...common,
    entryPoints: ['../worker/lib/worker.js'],
    outfile: path.join(output, 'worker.js'),
  });
  const binaries = fs.readdirSync(output).filter(name => name.endsWith('.node'));
  if (binaries.length) throw new Error(`Unexpected native outputs: ${binaries.join(', ')}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
