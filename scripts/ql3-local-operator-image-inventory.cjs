#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_PACKAGES = Object.freeze([
  '@qinglong/ai',
  '@qinglong/local-admin',
  '@qinglong/local-command-file',
  '@qinglong/local-owner-cli',
  '@qinglong/local-owner-console',
  '@qinglong/local-secret',
  '@qinglong/local-sqlite',
  '@qinglong/runtime-core',
  'semver',
]);
const MAX_FILES = 1024;
const MAX_BYTES = 12 * 1024 * 1024;

function fail(message) {
  throw new Error(`QingLong local operator image inventory failed: ${message}`);
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
  const packages = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink())
      fail('unexpected root entry');
    if (!entry.name.startsWith('@')) {
      packages.push(entry.name);
      continue;
    }
    for (const child of fs.readdirSync(path.join(root, entry.name), {
      withFileTypes: true,
    })) {
      if (
        child.name.startsWith('.') ||
        !child.isDirectory() ||
        child.isSymbolicLink()
      ) {
        fail('unexpected scoped entry');
      }
      packages.push(`${entry.name}/${child.name}`);
    }
  }
  return packages.sort();
}

function usage(root) {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    for (const entry of fs.readdirSync(pending.pop(), {
      withFileTypes: true,
    })) {
      const entryPath = path.join(entry.parentPath ?? entry.path, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) fail('inventory contains a symlink');
      if (stat.isDirectory()) pending.push(entryPath);
      else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
      } else fail('inventory contains a special file');
      if (files > MAX_FILES || bytes > MAX_BYTES)
        fail('inventory budget exceeded');
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
  const measured = usage(root);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      packages,
      packageCount: packages.length,
      files: measured.files,
      bytes: measured.bytes,
      maxFiles: MAX_FILES,
      maxBytes: MAX_BYTES,
      lifecycle: 'short-lived',
      network: 'none-by-default',
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
