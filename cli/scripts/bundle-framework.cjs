const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const dependencies = process.env.QL_FRAMEWORK_DEPS || '/tmp/ql-framework-eval';
const builder = createRequire(path.join(process.env.QL_FRAMEWORK_BUILDER || '/tmp/ql-framework-build', 'package.json'));
const esbuild = builder('esbuild');
const outfile = path.join(dependencies, 'commander-bundle.cjs');
esbuild.buildSync({
  stdin: { contents:'module.exports = require("commander");', resolveDir:dependencies, sourcefile:'commander-entry.cjs' },
  outfile, bundle:true, platform:'node', format:'cjs', target:'node22', minify:true, legalComments:'inline',
});
const bytes = fs.readFileSync(outfile);
console.log(JSON.stringify({ esbuild:esbuild.version, bytes:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex') }));
