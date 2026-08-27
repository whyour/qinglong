#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILES = 640;
const MAX_BYTES = 6 * 1024 * 1024;
const EXPECTED_PACKAGES = Object.freeze([
  '@qinglong/local-admin',
  '@qinglong/local-api',
  '@qinglong/local-application',
  '@qinglong/local-command-file',
  '@qinglong/local-execution',
  '@qinglong/local-owner-console',
  '@qinglong/local-process',
  '@qinglong/local-secret',
  '@qinglong/local-sqlite',
  '@qinglong/runtime-core',
  'croner',
  'semver',
]);

function fail(message) {
  throw new Error(`QingLong local Console image inventory failed: ${message}`);
}

function inventoryRoot(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--inventory-root=')) {
    fail('usage: --inventory-root=/absolute/node_modules');
  }
  const root = argv[0].slice('--inventory-root='.length);
  if (
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    root === path.parse(root).root
  ) {
    fail('inventory root is invalid');
  }
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(root) !== root
  ) {
    fail('inventory root must be a canonical directory');
  }
  return root;
}

function packageNames(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail(`unexpected root entry ${entry.name}`);
    }
    if (!entry.name.startsWith('@')) {
      result.push(entry.name);
      continue;
    }
    const scope = path.join(root, entry.name);
    for (const child of fs.readdirSync(scope, { withFileTypes: true })) {
      if (
        child.name.startsWith('.') ||
        !child.isDirectory() ||
        child.isSymbolicLink()
      ) {
        fail(`unexpected scoped entry ${entry.name}/${child.name}`);
      }
      result.push(`${entry.name}/${child.name}`);
    }
  }
  return result.sort();
}

function usage(root) {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) fail('runtime inventory contains a symlink');
      if (stat.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!stat.isFile()) fail('runtime inventory contains a special file');
      files += 1;
      bytes += stat.size;
      if (files > MAX_FILES) fail('runtime file budget exceeded');
      if (bytes > MAX_BYTES) fail('runtime byte budget exceeded');
    }
  }
  return Object.freeze({ files, bytes });
}

function main() {
  const root = inventoryRoot(process.argv.slice(2));
  const packages = packageNames(root);
  if (JSON.stringify(packages) !== JSON.stringify(EXPECTED_PACKAGES)) {
    fail(`package closure drifted: ${packages.join(',')}`);
  }
  for (const packageName of packages) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, packageName, 'package.json'), 'utf8'),
    );
    if (
      manifest.name !== packageName ||
      typeof manifest.version !== 'string'
    ) {
      fail(`package identity drifted: ${packageName}`);
    }
  }
  const measured = usage(root);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      image: 'local-console',
      packages,
      packageCount: packages.length,
      files: measured.files,
      bytes: measured.bytes,
      maxFiles: MAX_FILES,
      maxBytes: MAX_BYTES,
      ai: 'excluded',
      listener: 'loopback-only',
      compatible: true,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
