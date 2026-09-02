#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'qinglong/local-legacy-panel-assets@v1';
const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 13 * 1024 * 1024;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const SUPPORTED_ROUTES = Object.freeze(['/login', '/crontab', '/error']);
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});
const HASHED_ASSET =
  /\.[0-9a-f]{8}(?:\.[A-Za-z0-9_-]+)*\.(?:css|js|ttf|woff2?)$/u;
const EXTERNAL_FAVICON =
  /<link rel="shortcut icon" href="https:\/\/qn\.whyour\.cn\/favicon\.svg">\r?\n?/u;
const ENVIRONMENT_SOURCE =
  "window.__ENV__ = Object.freeze({ QlBaseUrl: '/', DeployEnv: '', QL_DIR: '' });\n";

function fail(message) {
  throw new Error(`QingLong legacy panel bundle failed: ${message}`);
}

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function canonicalDirectory(directory, label) {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) fail(`${label} is too broad`);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail(`${label} must be a canonical directory`);
  }
  return resolved;
}

function outputDirectory(directory, sourceRoot) {
  const resolved = path.resolve(directory);
  if (
    resolved === path.parse(resolved).root ||
    resolved === sourceRoot ||
    resolved.startsWith(`${sourceRoot}${path.sep}`) ||
    sourceRoot.startsWith(`${resolved}${path.sep}`) ||
    fs.existsSync(resolved)
  ) {
    fail('output must be an absent directory outside the source closure');
  }
  const parent = canonicalDirectory(path.dirname(resolved), 'output parent');
  if (path.dirname(resolved) !== parent) fail('output parent drifted');
  return resolved;
}

function sourceFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) fail('source closure contains a symlink');
      if (stat.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!stat.isFile()) fail('source closure contains a special file');
      const relative = path.relative(root, filePath).split(path.sep).join('/');
      if (relative.endsWith('.gz') || relative.startsWith('monaco-editor/')) {
        continue;
      }
      const extension = path.extname(relative);
      if (!Object.hasOwn(CONTENT_TYPES, extension)) {
        fail(`unsupported source asset ${relative}`);
      }
      if (relative !== 'index.html' && !HASHED_ASSET.test(relative)) {
        fail(`mutable source asset ${relative}`);
      }
      files.push(
        Object.freeze({ filePath, relative, extension, bytes: stat.size }),
      );
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  if (
    files.length < 3 ||
    files.length > MAX_FILES - 1 ||
    files[0]?.relative === undefined ||
    !files.some(({ relative }) => relative === 'index.html')
  ) {
    fail('source asset count or entrypoint is invalid');
  }
  return files;
}

function normalizedIndex(source) {
  const index = source.toString('utf8');
  if (
    !index.includes('<div id="root"></div>') ||
    !index.includes('<script src="./api/env.js"></script>') ||
    !/<script src="\.\/umi\.[0-9a-f]{8}\.js"><\/script>/u.test(index) ||
    !/<link rel="stylesheet" href="\.\/umi\.[0-9a-f]{8}\.css">/u.test(index) ||
    !EXTERNAL_FAVICON.test(index)
  ) {
    fail('legacy panel entrypoint contract drifted');
  }
  const normalized = index.replace(EXTERNAL_FAVICON, '');
  if (/https?:\/\//u.test(normalized)) {
    fail('legacy panel entrypoint retains an external origin');
  }
  return Buffer.from(normalized, 'utf8');
}

function assetRecord(relative, body) {
  const extension = path.extname(relative);
  const requestPath = relative === 'index.html' ? '/' : `/${relative}`;
  return Object.freeze({
    requestPath,
    file: relative,
    bytes: body.byteLength,
    sha256: sha256(body),
    contentType: CONTENT_TYPES[extension],
    cacheControl:
      relative === 'index.html' || relative === 'api/env.js'
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
  });
}

function writeAsset(outputRoot, relative, body) {
  const target = path.join(outputRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.writeFileSync(target, body, { flag: 'wx', mode: 0o444 });
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function readManifest(root) {
  const manifestPath = path.join(root, 'manifest.json');
  const stat = fs.lstatSync(manifestPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 256 ||
    stat.size > 128 * 1024
  ) {
    fail('manifest identity is invalid');
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function auditLegacyPanelBundle(directory) {
  const root = canonicalDirectory(directory, 'bundle root');
  const manifest = readManifest(root);
  if (
    !exactKeys(manifest, [
      'schema',
      'source',
      'supportedRoutes',
      'fileCount',
      'totalBytes',
      'limits',
      'files',
    ]) ||
    manifest.schema !== SCHEMA ||
    manifest.source !== 'qinglong-2.x-capability-gated-panel' ||
    JSON.stringify(manifest.supportedRoutes) !==
      JSON.stringify(SUPPORTED_ROUTES) ||
    !exactKeys(manifest.limits, [
      'maxFiles',
      'maxTotalBytes',
      'maxFileBytes',
    ]) ||
    manifest.limits.maxFiles !== MAX_FILES ||
    manifest.limits.maxTotalBytes !== MAX_TOTAL_BYTES ||
    manifest.limits.maxFileBytes !== MAX_FILE_BYTES ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 4 ||
    manifest.files.length > MAX_FILES
  ) {
    fail('manifest contract drifted');
  }
  const observed = [];
  let totalBytes = 0;
  let previousPath = '';
  const seenFiles = new Set(['manifest.json']);
  for (const entry of manifest.files) {
    if (
      !exactKeys(entry, [
        'requestPath',
        'file',
        'bytes',
        'sha256',
        'contentType',
        'cacheControl',
      ]) ||
      typeof entry.requestPath !== 'string' ||
      !entry.requestPath.startsWith('/') ||
      entry.requestPath.includes('?') ||
      entry.requestPath <= previousPath ||
      typeof entry.file !== 'string' ||
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(entry.file) ||
      entry.file.split('/').includes('..') ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_FILE_BYTES ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      !Object.values(CONTENT_TYPES).includes(entry.contentType) ||
      (entry.cacheControl !== 'no-store' &&
        entry.cacheControl !== 'public, max-age=31536000, immutable') ||
      seenFiles.has(entry.file)
    ) {
      fail(
        `manifest asset entry is invalid after ${previousPath}: ${String(
          entry?.requestPath,
        ).slice(0, 256)}`,
      );
    }
    previousPath = entry.requestPath;
    seenFiles.add(entry.file);
    const filePath = path.join(root, ...entry.file.split('/'));
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(filePath) !== filePath ||
      stat.size !== entry.bytes
    ) {
      fail(`asset identity drifted: ${entry.file}`);
    }
    const body = fs.readFileSync(filePath);
    if (sha256(body) !== entry.sha256) {
      fail(`asset digest drifted: ${entry.file}`);
    }
    totalBytes += body.byteLength;
    observed.push(entry.requestPath);
  }
  const diskFiles = sourceFilesForAudit(root);
  if (
    diskFiles.length !== seenFiles.size ||
    diskFiles.some((relative) => !seenFiles.has(relative)) ||
    manifest.fileCount !== manifest.files.length ||
    manifest.totalBytes !== totalBytes ||
    totalBytes > MAX_TOTAL_BYTES ||
    !observed.includes('/') ||
    !observed.includes('/api/env.js')
  ) {
    fail('bundle closure or budget drifted');
  }
  return Object.freeze({
    schema: manifest.schema,
    files: manifest.fileCount,
    bytes: manifest.totalBytes,
    maxFiles: MAX_FILES,
    maxBytes: MAX_TOTAL_BYTES,
    supportedRoutes: Object.freeze([...SUPPORTED_ROUTES]),
    compatible: true,
  });
}

function sourceFilesForAudit(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail('bundle contains a symlink');
      if (stat.isDirectory()) pending.push(target);
      else if (stat.isFile()) {
        result.push(path.relative(root, target).split(path.sep).join('/'));
      } else fail('bundle contains a special file');
    }
  }
  return result.sort();
}

function bundleLegacyPanel(sourceDirectory, outputDirectoryPath) {
  const sourceRoot = canonicalDirectory(sourceDirectory, 'source root');
  const outputRoot = outputDirectory(outputDirectoryPath, sourceRoot);
  const files = sourceFiles(sourceRoot);
  fs.mkdirSync(outputRoot, { mode: 0o755 });
  try {
    const records = [];
    for (const file of files) {
      const source = fs.readFileSync(file.filePath);
      if (
        source.byteLength !== file.bytes ||
        source.byteLength > MAX_FILE_BYTES
      ) {
        fail(`source asset size drifted: ${file.relative}`);
      }
      const body =
        file.relative === 'index.html' ? normalizedIndex(source) : source;
      writeAsset(outputRoot, file.relative, body);
      records.push(assetRecord(file.relative, body));
    }
    writeAsset(outputRoot, 'api/env.js', Buffer.from(ENVIRONMENT_SOURCE));
    records.push(assetRecord('api/env.js', Buffer.from(ENVIRONMENT_SOURCE)));
    records.sort((left, right) =>
      left.requestPath < right.requestPath
        ? -1
        : left.requestPath > right.requestPath
        ? 1
        : 0,
    );
    const totalBytes = records.reduce((total, entry) => total + entry.bytes, 0);
    if (records.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
      fail('output asset budget exceeded');
    }
    const manifest = {
      schema: SCHEMA,
      source: 'qinglong-2.x-capability-gated-panel',
      supportedRoutes: [...SUPPORTED_ROUTES],
      fileCount: records.length,
      totalBytes,
      limits: {
        maxFiles: MAX_FILES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxFileBytes: MAX_FILE_BYTES,
      },
      files: records,
    };
    fs.writeFileSync(
      path.join(outputRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o444 },
    );
    return auditLegacyPanelBundle(outputRoot);
  } catch (error) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function argumentsFrom(argv) {
  if (argv.length === 1 && argv[0].startsWith('--audit=')) {
    const directory = argv[0].slice('--audit='.length);
    if (!path.isAbsolute(directory)) fail('audit root must be absolute');
    return Object.freeze({ mode: 'audit', directory });
  }
  if (
    argv.length !== 2 ||
    !argv[0].startsWith('--source=') ||
    !argv[1].startsWith('--output=')
  ) {
    fail('usage: --source=/absolute/static/dist --output=/absolute/bundle');
  }
  const source = argv[0].slice('--source='.length);
  const output = argv[1].slice('--output='.length);
  if (!path.isAbsolute(source) || !path.isAbsolute(output)) {
    fail('source and output must be absolute');
  }
  return Object.freeze({ mode: 'bundle', source, output });
}

if (require.main === module) {
  try {
    const options = argumentsFrom(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify(
        options.mode === 'audit'
          ? auditLegacyPanelBundle(options.directory)
          : bundleLegacyPanel(options.source, options.output),
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  auditLegacyPanelBundle,
  bundleLegacyPanel,
});
