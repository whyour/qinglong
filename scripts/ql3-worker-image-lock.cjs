#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const repositoryRoot = path.resolve(__dirname, '..');
const lock = yaml.load(
  fs.readFileSync(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'),
);

function packageKey(name, version) {
  const exact = `/${name}@${version}`;
  if (lock.packages[exact]) return exact;
  const matches = Object.keys(lock.packages).filter(
    (candidate) =>
      candidate.startsWith(`${exact}(`) ||
      candidate.startsWith(`${exact}_`),
  );
  assert.equal(
    matches.length,
    1,
    `expected one pnpm lock entry for ${name}@${version}`,
  );
  return matches[0];
}

function exactVersion(value) {
  assert.equal(typeof value, 'string');
  const version = value.replace(/\(.+$/, '').replace(/_.+$/, '');
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  return version;
}

function installedPackageJson(name, version) {
  const virtualStoreName = `${name.replace('/', '+')}@${version}`;
  const packageJsonPath = path.join(
    repositoryRoot,
    'node_modules',
    '.pnpm',
    virtualStoreName,
    'node_modules',
    name,
    'package.json',
  );
  assert.equal(
    fs.existsSync(packageJsonPath),
    true,
    `installed metadata is missing for ${name}@${version}`,
  );
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function resolvedTarball(name, version) {
  const leaf = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${leaf}-${version}.tgz`;
}

function graphNode(name, version) {
  const pnpm = lock.packages[packageKey(name, version)];
  const manifest = installedPackageJson(name, version);
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  return {
    name,
    version,
    pnpm,
    manifest,
    dependencies: Object.fromEntries(
      Object.entries({
        ...(pnpm.dependencies ?? {}),
        ...(pnpm.optionalDependencies ?? {}),
      }).map(([dependencyName, dependencyVersion]) => [
        dependencyName,
        exactVersion(dependencyVersion),
      ]),
    ),
  };
}

function createLock(manifestPath, includeDev) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const productionRoots = { ...(manifest.dependencies ?? {}) };
  const roots = {
    ...productionRoots,
    ...(includeDev ? manifest.devDependencies ?? {} : {}),
  };
  for (const [name, version] of Object.entries(roots)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    packageKey(name, version);
  }

  const nodes = new Map();
  const incoming = new Map();
  const visit = (name, version, production) => {
    const id = `${name}@${version}`;
    const current = nodes.get(id);
    if (current) {
      if (production) current.production = true;
      return;
    }
    const node = { ...graphNode(name, version), production };
    nodes.set(id, node);
    for (const [dependencyName, dependencyVersion] of Object.entries(
      node.dependencies,
    )) {
      const dependencyId = `${dependencyName}@${dependencyVersion}`;
      incoming.set(dependencyId, (incoming.get(dependencyId) ?? 0) + 1);
      visit(dependencyName, dependencyVersion, production);
    }
  };
  for (const [name, version] of Object.entries(roots)) {
    visit(name, version, Object.hasOwn(productionRoots, name));
  }

  const versionsByName = new Map();
  for (const node of nodes.values()) {
    const versions = versionsByName.get(node.name) ?? [];
    versions.push(node.version);
    versionsByName.set(node.name, versions);
  }
  const rootVersion = new Map();
  for (const [name, versions] of versionsByName) {
    if (Object.hasOwn(roots, name)) {
      rootVersion.set(name, roots[name]);
      continue;
    }
    versions.sort((left, right) => {
      const rightCount = incoming.get(`${name}@${right}`) ?? 0;
      const leftCount = incoming.get(`${name}@${left}`) ?? 0;
      return rightCount - leftCount || right.localeCompare(left);
    });
    rootVersion.set(name, versions[0]);
  }

  const packages = {
    '': {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      ...(manifest.dependencies
        ? { dependencies: manifest.dependencies }
        : {}),
      ...(includeDev && manifest.devDependencies
        ? { devDependencies: manifest.devDependencies }
        : {}),
      ...(manifest.engines ? { engines: manifest.engines } : {}),
    },
  };
  const emitted = new Set();
  const emit = (name, version, installPath) => {
    if (emitted.has(installPath)) return;
    emitted.add(installPath);
    const node = nodes.get(`${name}@${version}`);
    assert(node, `graph node is missing for ${name}@${version}`);
    const { manifest: dependencyManifest, pnpm } = node;
    const record = {
      version,
      resolved: resolvedTarball(name, version),
      integrity: pnpm.resolution?.integrity,
      ...(node.production ? {} : { dev: true }),
      ...(pnpm.optional ? { optional: true } : {}),
      ...(dependencyManifest.license
        ? { license: dependencyManifest.license }
        : {}),
      ...(dependencyManifest.dependencies
        ? { dependencies: dependencyManifest.dependencies }
        : {}),
      ...(dependencyManifest.optionalDependencies
        ? { optionalDependencies: dependencyManifest.optionalDependencies }
        : {}),
      ...(dependencyManifest.peerDependencies
        ? { peerDependencies: dependencyManifest.peerDependencies }
        : {}),
      ...(dependencyManifest.peerDependenciesMeta
        ? { peerDependenciesMeta: dependencyManifest.peerDependenciesMeta }
        : {}),
      ...(dependencyManifest.engines
        ? { engines: dependencyManifest.engines }
        : {}),
      ...(dependencyManifest.bin ? { bin: dependencyManifest.bin } : {}),
    };
    assert.equal(typeof record.integrity, 'string');
    packages[installPath] = record;
    for (const [dependencyName, dependencyVersion] of Object.entries(
      node.dependencies,
    )) {
      if (rootVersion.get(dependencyName) === dependencyVersion) continue;
      emit(
        dependencyName,
        dependencyVersion,
        `${installPath}/node_modules/${dependencyName}`,
      );
    }
  };

  for (const [name, version] of rootVersion) {
    emit(name, version, `node_modules/${name}`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}

const buildManifest = path.join(
  repositoryRoot,
  'deploy',
  'containers',
  'ql3-worker',
  'package.json',
);
const runtimeManifest = path.join(
  repositoryRoot,
  'deploy',
  'containers',
  'ql3-worker',
  'runtime-dependencies',
  'package.json',
);

for (const [manifestPath, outputPath, includeDev] of [
  [
    buildManifest,
    path.join(path.dirname(buildManifest), 'package-lock.json'),
    true,
  ],
  [
    runtimeManifest,
    path.join(path.dirname(runtimeManifest), 'package-lock.json'),
    false,
  ],
]) {
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(createLock(manifestPath, includeDev), null, 2)}\n`,
    { mode: 0o644 },
  );
}
