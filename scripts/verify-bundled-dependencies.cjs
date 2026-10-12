#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// CI additionally anchors the archive/proof in the separately retained producer
// summary. This installed receipt detects damage; it is not a signature.
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, name) => name === root || name.startsWith(`${root}${path.sep}`);
function verifyBundledDependencies(root) {
  root = fs.realpathSync(root);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'qinglong-npm-dependency-proof.json')));
  assert.equal(receipt.version, 1);
  const checkedPath = (relative) => {
    assert(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), `Unsafe receipt path ${relative}`);
    const file = path.join(root, relative);
    assert(inside(root, fs.realpathSync(file)), `Payload escapes package root: ${relative}`);
    return file;
  };
  const matchesHash = (relative, expected) => assert.equal(hash(fs.readFileSync(checkedPath(relative))), expected, `Package payload changed: ${relative}`);
  matchesHash('package.json', receipt.publishedRootManifestSHA256);
  for (const item of receipt.applicationFiles) matchesHash(item.path, item.sha256);
  const shipped = new Map();
  for (const item of receipt.shipped) {
    const directory = checkedPath(item.path);
    assert.equal(fs.realpathSync(directory), directory, `Bundled package is a link: ${item.path}`);
    shipped.set(directory, item);
    matchesHash(`${item.path}/package.json`, item.publishedManifestSHA256);
    for (const file of item.shippedFiles) if (file.path !== 'package.json') matchesHash(`${item.path}/${file.path}`, file.sha256);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    assert.equal(pkg.name, item.package); assert.equal(pkg.version, item.version);
  }
  const resolve = (directory, name) => {
    assert(name && !name.split('/').includes('..') && !path.isAbsolute(name));
    for (let current = directory; inside(root, current); current = path.dirname(current)) {
      const candidate = path.join(current, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
      if (current === root) break;
    }
    throw new Error(`Missing bundled dependency ${name} from ${path.relative(root, directory)}`);
  };
  let edges = 0;
  for (const [directory, item] of shipped) {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    for (const edge of item.edges) {
      assert.equal(pkg[edge.category]?.[edge.name], edge.publishedSpec);
      assert.equal(resolve(directory, edge.name), checkedPath(edge.resolvedPath), `Bundled resolution changed ${item.path} -> ${edge.name}`);
      assert.equal(shipped.get(resolve(directory, edge.name))?.context, edge.context);
      edges++;
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), receipt.directDependencies.map((item) => item.name).sort());
  for (const edge of receipt.directDependencies) {
    assert.equal(pkg.dependencies[edge.name], edge.publishedSpec);
    assert.equal(resolve(root, edge.name), checkedPath(edge.resolvedPath));
    assert.equal(shipped.get(resolve(root, edge.name))?.context, edge.context);
  }
  return { receipt, verifiedPlacements: shipped.size, verifiedEdges: edges };
}
module.exports = { verifyBundledDependencies };
if (require.main === module) {
  const root = process.argv[2] || path.join(__dirname, '..');
  const result = verifyBundledDependencies(root);
  console.log(JSON.stringify({ verifiedPlacements: result.verifiedPlacements, verifiedEdges: result.verifiedEdges, productionLockSHA256: result.receipt.productionLockSHA256 }));
}
