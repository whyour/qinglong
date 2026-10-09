#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (['--verify-only', '--allow-host-smoke'].includes(name)) options[name.slice(2)] = true;
  else if (['--archive', '--proof', '--prefix'].includes(name) && process.argv[index + 1]) options[name.slice(2)] = process.argv[++index];
  else throw new Error('Unknown or incomplete argument: ' + name);
}
const prefix = options.prefix || '/usr/local';
const archivePath = options.archive || path.resolve(__dirname, '../static/runtime-tools.tgz');
const proofPath = options.proof || path.resolve(__dirname, '../static/runtime-tools-proof.json');
for (const [name, value] of Object.entries({ prefix, archive: archivePath, proof: proofPath })) if (!path.isAbsolute(value)) throw new Error(name + ' must be absolute');
if (prefix === '/') throw new Error('A filesystem root is not an installation prefix');
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (!((major === 22 && (minor > 22 || minor === 22 && patch >= 2)) || major === 24 && minor >= 15 || major >= 26)) throw new Error('Node ^22.22.2 || ^24.15.0 || >=26.0.0 is required');
const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
if (proof.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(proof.sourceCommit) || !Array.isArray(proof.files)) throw new Error('Invalid runtime tools proof');
if (!options['allow-host-smoke'] && (process.platform !== 'linux' || !proof.builder.releaseBuild || !proof.sourceAttestation?.verified || proof.sourceAttestation.head !== proof.sourceCommit || !proof.supportedPlatforms.includes('linux'))) throw new Error('This archive is a Linux release artifact; host smoke must be explicit');
const hash = (buffer, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(buffer).digest(encoding);
const archive = fs.readFileSync(archivePath);
if (archive.length !== proof.archive.bytes || hash(archive) !== proof.archive.sha256 || 'sha512-' + hash(archive, 'sha512', 'base64') !== proof.archive.integrity) throw new Error('Runtime archive integrity mismatch');
const expectedEmbedded = { ...proof }; delete expectedEmbedded.archive;
const embeddedBytes = Buffer.from(JSON.stringify(expectedEmbedded, null, 2) + '\n');
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\n') && !value.includes('\\') && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
const records = new Map();
for (const record of proof.files) {
  if (!safeRelative(record.path) || !/^(npm|tools)\//.test(record.path) || records.has(record.path)) throw new Error('Unsafe or duplicate proof path');
  if (record.type === 'file') {
    if (!Number.isSafeInteger(record.size) || record.size < 0 || !/^[0-9a-f]{64}$/.test(record.sha256) || ![0o644, 0o755].includes(record.mode)) throw new Error('Invalid file proof: ' + record.path);
  } else if (record.type === 'symlink') {
    if (typeof record.target !== 'string' || path.posix.isAbsolute(record.target) || record.target.includes('\0') || record.target.includes('\n')) throw new Error('Unsafe symlink proof');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(record.path), record.target));
    if (!resolved.startsWith(record.path.split('/')[0] + '/')) throw new Error('Escaping symlink proof');
  } else throw new Error('Unsupported proof type');
  records.set(record.path, record);
}
records.set('proof.json', { path: 'proof.json', type: 'file', size: embeddedBytes.length, mode: 0o644, sha256: hash(embeddedBytes) });
for (const record of records.values()) {
  let parent = path.posix.dirname(record.path);
  while (parent !== '.') {
    if (records.get(parent)?.type === 'symlink') throw new Error('Archive child beneath symlink');
    parent = path.posix.dirname(parent);
  }
}
const maximum = proof.archive.unpackedBytes + records.size * 1024 + 2048;
if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Invalid unpacked size');
const tar = zlib.gunzipSync(archive, { maxOutputLength: maximum });
const decoded = [];
const seen = new Set();
const string = (buffer, start, length) => buffer.subarray(start, start + length).toString('utf8').split('\0', 1)[0];
const number = (buffer, start, length) => {
  const text = string(buffer, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Invalid normalized USTAR numeric field');
  return Number.parseInt(text, 8);
};
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) {
    if (tar.subarray(offset).some(byte => byte !== 0)) throw new Error('Data after archive terminator');
    break;
  }
  if (string(header, 257, 6) !== 'ustar' || string(header, 263, 2) !== '00') throw new Error('Only normalized USTAR is supported');
  let checksum = 0; for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
  if (number(header, 148, 8) !== checksum) throw new Error('USTAR checksum mismatch');
  const leaf = string(header, 0, 100), parent = string(header, 345, 155);
  const name = parent ? parent + '/' + leaf : leaf;
  if (!name.startsWith('runtime-tools/')) throw new Error('Unexpected archive root');
  const relative = name.slice('runtime-tools/'.length);
  const record = records.get(relative);
  if (!safeRelative(relative) || !record || seen.has(relative)) throw new Error('Unknown, unsafe or duplicate archive entry');
  seen.add(relative);
  const size = number(header, 124, 12), mode = number(header, 100, 8), type = string(header, 156, 1), target = string(header, 157, 100);
  offset += 512;
  if (size > tar.length - offset) throw new Error('Truncated runtime archive');
  const bytes = tar.subarray(offset, offset + size);
  if (record.type === 'file') {
    if (type !== '0' || size !== record.size || mode !== record.mode || target || hash(bytes) !== record.sha256) throw new Error('File checksum or metadata mismatch: ' + relative);
  } else if (type !== '2' || size !== 0 || target !== record.target) throw new Error('Symlink mismatch: ' + relative);
  decoded.push({ ...record, bytes });
  offset += Math.ceil(size / 512) * 512;
}
if (seen.size !== records.size) throw new Error('Missing runtime archive files');
if (options['verify-only']) {
  console.log(JSON.stringify({ verified: true, sourceCommit: proof.sourceCommit, archiveSha256: proof.archive.sha256, entries: seen.size }));
  process.exit(0);
}
const existed = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const createdDirectories = [];
function ensureDirectory(directory) {
  if (existed(directory)) { if (!fs.statSync(directory).isDirectory()) throw new Error('Expected directory: ' + directory); return; }
  ensureDirectory(path.dirname(directory)); fs.mkdirSync(directory); fs.chmodSync(directory, 0o755); createdDirectories.push(directory);
}
let transaction;
let installLock;
let lockOwner;
const swapped = [];
function replace(source, destination) {
  ensureDirectory(path.dirname(destination));
  const backup = path.join(transaction, 'backup-' + swapped.length);
  const previous = existed(destination);
  if (previous) fs.renameSync(destination, backup);
  const operation = { destination, backup, previous, installed: false };
  swapped.push(operation);
  fs.renameSync(source, destination); operation.installed = true;
}
function assertTree(npmRoot, toolsRoot) {
  const readVersion = file => JSON.parse(fs.readFileSync(file, 'utf8')).version;
  if (readVersion(path.join(npmRoot, 'package.json')) !== '12.2.0') throw new Error('Wrong npm version');
  for (const [name, version] of Object.entries({ pnpm: '10.34.6', pm2: '7.0.4', 'node-gyp': '12.4.0', 'ts-node': '10.9.2', typescript: '5.9.3' })) if (readVersion(path.join(toolsRoot, 'node_modules', name, 'package.json')) !== version) throw new Error('Wrong tool version: ' + name);
  for (const [root, expected] of [
    [npmRoot, { 'brace-expansion': '5.0.12', 'http-cache-semantics': '4.3.0', undici: '6.29.0', tar: '7.5.22' }],
    [path.join(toolsRoot, 'node_modules/pm2'), { 'js-yaml': '4.3.2', 'basic-ftp': '6.2.1' }],
    [path.join(toolsRoot, 'node_modules/pnpm/dist'), { 'node-gyp': '12.4.0', tar: '7.5.22' }],
  ]) {
    const requireFrom = createRequire(path.join(root, 'package.json'));
    for (const [name, version] of Object.entries(expected)) if (readVersion(requireFrom.resolve(name + '/package.json')) !== version) throw new Error('Wrong actual runtime dependency: ' + name);
  }
}
try {
  ensureDirectory(prefix);
  installLock = path.join(prefix, '.qinglong-runtime-install.lock');
  try { fs.mkdirSync(installLock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('Runtime tools install is busy: existing prefix lock; no stale lock is automatically removed'); throw error; }
  lockOwner = JSON.stringify({ pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') });
  fs.writeFileSync(path.join(installLock, 'owner.json'), lockOwner, { flag: 'wx', mode: 0o600 });
  transaction = fs.mkdtempSync(path.join(prefix, '.qinglong-runtime-'));
  const stage = path.join(transaction, 'stage'); fs.mkdirSync(stage);
  for (const entry of decoded.filter(record => record.type === 'file')) {
    const destination = path.join(stage, entry.path); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.bytes, { flag: 'wx', mode: entry.mode }); fs.chmodSync(destination, entry.mode);
  }
  for (const entry of decoded.filter(record => record.type === 'symlink')) {
    const destination = path.join(stage, entry.path); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.symlinkSync(entry.target, destination);
  }
  // Artifact directories need stable permissions even when the installing user has umask 077.
  const chmodArchiveDirectories = directory => { fs.chmodSync(directory, 0o755); for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) chmodArchiveDirectories(path.join(directory, item.name)); };
  chmodArchiveDirectories(stage);
  assertTree(path.join(stage, 'npm'), path.join(stage, 'tools'));
  const modules = path.join(prefix, 'lib/node_modules');
  const npmRoot = path.join(modules, 'npm'), toolsRoot = path.join(modules, 'qinglong-runtime-tools');
  replace(path.join(stage, 'npm'), npmRoot);
  replace(path.join(stage, 'tools'), toolsRoot);
  const links = path.join(transaction, 'links'); fs.mkdirSync(links);
  const toolNames = ['pnpm', 'pm2', 'node-gyp', 'ts-node', 'typescript'];
  for (const name of toolNames) {
    const source = path.join(links, 'module-' + name); fs.symlinkSync('qinglong-runtime-tools/node_modules/' + name, source);
    replace(source, path.join(modules, name));
  }
  const bins = new Map();
  for (const [name, root] of [['npm', npmRoot], ...toolNames.map(name => [name, path.join(toolsRoot, 'node_modules', name)])]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const declarations = typeof manifest.bin === 'string' ? { [name]: manifest.bin } : manifest.bin;
    for (const [command, relative] of Object.entries(declarations || {})) {
      if (!/^[A-Za-z0-9_.-]+$/.test(command) || !safeRelative(relative.replace(/^\.\//, ''))) throw new Error('Unsafe tool bin');
      const executable = command === 'pnpm' ? path.join(toolsRoot, 'bin/pnpm.cjs') : path.join(root, relative);
      if (!fs.statSync(executable).isFile()) throw new Error('Missing executable: ' + command);
      bins.set(command, executable);
    }
  }
  for (const [command, executable] of bins) {
    const destination = path.join(prefix, 'bin', command), source = path.join(links, 'bin-' + command);
    fs.symlinkSync(path.relative(path.dirname(destination), executable), source); replace(source, destination);
  }
  assertTree(npmRoot, toolsRoot);
  const emptyUserConfig = path.join(transaction, 'empty-user.npmrc'); fs.writeFileSync(emptyUserConfig, '', { flag: 'wx', mode: 0o600 });
  const safeEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: emptyUserConfig, NPM_CONFIG_GLOBALCONFIG: '/dev/null', NPM_CONFIG_CACHE: path.join(transaction, 'npm-cache'), PNPM_HOME: path.join(transaction, 'pnpm-home'), NODE_COMPILE_CACHE: path.join(transaction, 'compile-cache') };
  for (const [file, arguments_, expected] of [
    [path.join(npmRoot, 'bin/npm-cli.js'), ['--version'], '12.2.0'],
    [path.join(toolsRoot, 'node_modules/pnpm/bin/pnpm.cjs'), ['--config.manage-package-manager-versions=false', '--config.cache-dir=' + path.join(transaction, 'pnpm-cache'), '--config.state-dir=' + path.join(transaction, 'pnpm-state'), '--version'], '10.34.6'],
    [path.join(toolsRoot, 'node_modules/node-gyp/bin/node-gyp.js'), ['--version'], 'v12.4.0'],
  ]) {
    const child = spawnSync(process.execPath, [file, ...arguments_], { cwd: transaction, env: safeEnvironment, encoding: 'utf8' });
    if (child.status !== 0 || child.stdout.trim() !== expected) throw new Error('Installed tool smoke failed: ' + path.basename(file));
  }
  if (fs.readFileSync(path.join(installLock, 'owner.json'), 'utf8') !== lockOwner) throw new Error('Installation lock ownership changed');
  fs.rmSync(transaction, { recursive: true, force: true }); transaction = undefined;
  fs.rmSync(installLock, { recursive: true }); installLock = undefined;
  console.log(JSON.stringify({ installed: true, prefix, npmRoot, toolsRoot, sourceCommit: proof.sourceCommit, archiveSha256: proof.archive.sha256, components: proof.components, persistedGlobalDirectoryChanged: false }));
} catch (error) {
  const failures = [];
  for (const operation of swapped.reverse()) {
    try { if (operation.installed) fs.rmSync(operation.destination, { recursive: true, force: true }); if (operation.previous) fs.renameSync(operation.backup, operation.destination); }
    catch (rollbackError) { failures.push({ path: operation.destination, error: rollbackError.message }); }
  }
  if (installLock && lockOwner) { try { if (fs.readFileSync(path.join(installLock, 'owner.json'), 'utf8') === lockOwner) { fs.rmSync(installLock, { recursive: true }); installLock = undefined; } else failures.push({ path: installLock, error: 'Installation lock ownership changed' }); } catch (lockError) { failures.push({ path: installLock, error: lockError.message }); } }
  if (transaction && !failures.length) fs.rmSync(transaction, { recursive: true, force: true });
  if (!failures.length) for (const directory of createdDirectories.reverse()) { try { fs.rmdirSync(directory); } catch (cleanupError) { if (!['ENOTEMPTY', 'ENOENT'].includes(cleanupError.code)) failures.push({ path: directory, error: cleanupError.message }); } }
  console.error(JSON.stringify({ installed: false, error: error.message, rollbackComplete: failures.length === 0, rollbackFailures: failures, recoveryDirectory: failures.length ? transaction : undefined }));
  process.exitCode = 1;
}
