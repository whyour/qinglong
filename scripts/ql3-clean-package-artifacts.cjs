#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function removeEmittedSourceArtifacts(sourceDirectory) {
  if (!fs.existsSync(sourceDirectory)) return;
  const pending = [sourceDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const source = target.replace(
        /\.d\.ts(?:\.map)?$|\.js(?:\.map)?$/,
        '.ts',
      );
      if (source === target || !fs.existsSync(source)) continue;
      fs.rmSync(target);
    }
  }
}

function cleanQingLong3PackageArtifacts(root) {
  const packagesDirectory = path.join(root, 'packages');
  const removed = [];
  for (const entry of fs.readdirSync(packagesDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !entry.name.startsWith('ql3-')) continue;
    const packageDirectory = path.join(packagesDirectory, entry.name);
    const manifestPath = path.join(packageDirectory, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const artifactDirectory = path.join(packageDirectory, 'dist');
    const relativeArtifactDirectory = path.relative(root, artifactDirectory);
    if (
      relativeArtifactDirectory === '..' ||
      relativeArtifactDirectory.startsWith(`..${path.sep}`) ||
      path.basename(artifactDirectory) !== 'dist'
    ) {
      throw new Error('Refusing to clean an invalid QL3 artifact directory');
    }
    fs.rmSync(artifactDirectory, { force: true, recursive: true });
    removeEmittedSourceArtifacts(path.join(packageDirectory, 'src'));
    removed.push(relativeArtifactDirectory);
  }
  return Object.freeze(removed.sort());
}

module.exports = { cleanQingLong3PackageArtifacts };

if (require.main === module) {
  const removed = cleanQingLong3PackageArtifacts(process.cwd());
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, removed, compatible: true })}\n`,
  );
}
