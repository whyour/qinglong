'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].slice(2), process.argv[3 + i * 2]]));
for (const key of ['npm', 'tools', 'payload', 'output', 'source-commit']) if (!args[key]) throw new Error('Missing --' + key);
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const entries = [];
function scan(directory, prefix, records) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), relative = prefix + '/' + name;
    if (name.includes('\n') || name.includes('\r') || name.includes('\0')) throw new Error('Unsupported archive name');
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) scan(file, relative, records);
    else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      if (path.posix.isAbsolute(target)) throw new Error('Absolute symlink: ' + relative);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
      if (!resolved.startsWith(prefix.split('/')[0] + '/')) throw new Error('Escaping symlink: ' + relative);
      records.push({ path: relative, type: 'symlink', target });
    } else if (stat.isFile()) {
      if (name === 'pnpm-10.34.6-qinglong-security-linux.tgz' || name.startsWith('qinglong-runtime-') && name.endsWith('-proof.json')) continue;
      const bytes = fs.readFileSync(file);
      const magic = bytes.subarray(0, 4).toString('hex');
      if (/\.(node|exe|dll|so|dylib)$/.test(name) || ['7f454c46', 'cffaedfe', 'feedfacf', 'cafebabe'].includes(magic) || bytes.subarray(0, 2).toString() === 'MZ') throw new Error('Native/platform binary: ' + relative);
      records.push({ path: relative, type: 'file', size: bytes.length, mode: stat.mode & 0o111 ? 0o755 : 0o644, sha256: sha(bytes), bytes });
    } else throw new Error('Unsupported filesystem entry: ' + relative);
  }
}
scan(args.npm, 'npm', entries); scan(args.tools, 'tools', entries);
const inputs = [];
function inputScan(directory, prefix = '') {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), relative = prefix ? prefix + '/' + name : name;
    if (fs.statSync(file).isDirectory()) inputScan(file, relative);
    else inputs.push({ path: 'scripts/runtime-tools/' + relative, sha256: sha(fs.readFileSync(file)) });
  }
}
inputScan(args.payload);
for (const name of ['build-runtime-tools.sh', 'pack-runtime-tools.cjs', 'install-runtime-tools.cjs', 'verify-runtime-tools-source.cjs']) {
  const file = path.join(__dirname, name); if (fs.existsSync(file)) inputs.push({ path: 'scripts/' + name, sha256: sha(fs.readFileSync(file)) });
}
const sourceAttestation = require('./verify-runtime-tools-source.cjs')(args.payload, args['source-commit']);
const proof = {
  schemaVersion: 1, sourceCommit: args['source-commit'], supportedPlatforms: ['linux'],
  nodeEngine: '^22.22.2 || ^24.15.0 || >=26.0.0',
  builder: { node: process.version, platform: process.platform, releaseBuild: process.platform === 'linux' && sourceAttestation.verified, typescript: '5.5.4', esbuild: '0.25.12', bootstrapPnpm: '10.34.6', runtimeNpm: '12.2.0' },
  components: { npm: '12.2.0', pnpm: '10.34.6', pm2: '7.0.4', nodeGyp: '12.4.0', tsNode: '10.9.2', typescript: '5.9.3', pnpmUpstreamCommit: '9287c31cea69206c4eeca7f21cd21df81d0b93e7', pnpmSecurityTgzSha256: 'de1266186669300c0729f7f5671c97108379ec36afe17b6ec7caaf47091dd7d7' },
  inputs, sourceAttestation,
  residualAdvisories: [{ id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', version: '3.0.3', severity: 'high', patchedVersion: null }],
  files: entries.map(({ bytes, ...record }) => record),
};
const proofBytes = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
entries.push({ path: 'proof.json', type: 'file', mode: 0o644, size: proofBytes.length, bytes: proofBytes });
function header(name, mode, size, type, link = '') {
  const buffer = Buffer.alloc(512), octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
  let leaf = name, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    for (let index = name.length - 1; index >= 0; index--) if (name[index] === '/' && Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100) { prefix = name.slice(0, index); leaf = name.slice(index + 1); break; }
    if (!prefix) throw new Error('Path too long for normalized USTAR: ' + name);
  }
  if (Buffer.byteLength(link) > 100) throw new Error('Symlink target too long: ' + name);
  buffer.write(leaf, 0, 100); buffer.write(octal(mode, 8), 100, 8); buffer.write(octal(0, 8), 108, 8); buffer.write(octal(0, 8), 116, 8);
  buffer.write(octal(size, 12), 124, 12); buffer.write(octal(0, 12), 136, 12); buffer.fill(32, 148, 156); buffer.write(type, 156, 1); buffer.write(link, 157, 100);
  buffer.write('ustar\0', 257, 6); buffer.write('00', 263, 2); buffer.write(prefix, 345, 155);
  const checksum = buffer.reduce((sum, byte) => sum + byte, 0); buffer.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buffer;
}
const chunks = [];
for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
  const file = entry.type === 'file'; chunks.push(header('runtime-tools/' + entry.path, entry.mode || 0o777, file ? entry.size : 0, file ? '0' : '2', entry.target || ''));
  if (file) { chunks.push(entry.bytes); const padding = (512 - entry.size % 512) % 512; if (padding) chunks.push(Buffer.alloc(padding)); }
}
chunks.push(Buffer.alloc(1024));
const archive = zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
fs.mkdirSync(args.output);
fs.writeFileSync(path.join(args.output, 'runtime-tools.tgz'), archive);
const published = { ...proof, archive: { name: 'runtime-tools.tgz', sha256: sha(archive), integrity: 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64'), bytes: archive.length, unpackedBytes: proof.files.filter(x => x.type === 'file').reduce((sum, x) => sum + x.size, 0) + proofBytes.length } };
fs.writeFileSync(path.join(args.output, 'runtime-tools-proof.json'), JSON.stringify(published, null, 2) + '\n');
console.log(JSON.stringify({ archive: published.archive, sourceCommit: proof.sourceCommit, fileCount: proof.files.length, releaseBuild: proof.builder.releaseBuild }));
