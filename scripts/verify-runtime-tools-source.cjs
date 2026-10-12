'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
function verifyRuntimeToolsSource(payload, sourceCommit) {
  const scripts = path.resolve(payload, '..');
  const paths = [];
  const collect = directory => { for (const name of fs.readdirSync(directory).sort()) { const file = path.join(directory, name), stat = fs.lstatSync(file); if (stat.isDirectory()) collect(file); else if (stat.isFile()) paths.push(file); else throw new Error('Build inputs must be regular tracked files: ' + file); } };
  collect(payload);
  for (const name of ['build-runtime-tools.sh', 'pack-runtime-tools.cjs', 'install-runtime-tools.cjs', 'verify-runtime-tools-source.cjs']) paths.push(path.join(scripts, name));
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  if (process.env.QL_TOOLS_ALLOW_HOST_SMOKE === '1') return { verified: false, previewOnly: true, inputs: paths.map(file => ({ path: 'scripts/' + path.relative(scripts, file), sha256: digest(fs.readFileSync(file)) })) };
  const git = arguments_ => execFileSync('git', ['-C', scripts, ...arguments_], { maxBuffer: 8 * 1024 * 1024 });
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  if (head !== sourceCommit) throw new Error('QL_TOOLS_SOURCE_COMMIT does not match actual Git HEAD');
  git(['diff', '--exit-code', '--quiet', 'HEAD', '--']);
  const inputs = paths.map(file => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.startsWith('../')) throw new Error('Build input outside Git tree');
    const actual = fs.readFileSync(file), blob = git(['cat-file', 'blob', sourceCommit + ':' + relative]);
    if (!actual.equals(blob)) throw new Error('Build input does not match source Git blob: ' + relative);
    return { path: relative, sha256: digest(actual), gitBlob: git(['rev-parse', sourceCommit + ':' + relative]).toString().trim() };
  });
  return { verified: true, head, inputs };
}
module.exports = verifyRuntimeToolsSource;
if (require.main === module) console.log(JSON.stringify(verifyRuntimeToolsSource(process.argv[2], process.argv[3])));
