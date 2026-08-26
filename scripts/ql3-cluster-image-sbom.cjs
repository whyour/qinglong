#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const IMAGE_PROFILES = Object.freeze({
  control: Object.freeze({
    id: 'control',
    buildManifestPath: 'deploy/containers/ql3-cluster-control/package.json',
    buildLockPath: 'deploy/containers/ql3-cluster-control/package-lock.json',
    imageManifestPath:
      'deploy/containers/ql3-cluster-control/runtime-dependencies/package.json',
    imageLockPath:
      'deploy/containers/ql3-cluster-control/runtime-dependencies/package-lock.json',
    internalManifestPaths: Object.freeze([
      'packages/ql3-runtime-core/package.json',
      'packages/ql3-cluster-postgres/package.json',
      'packages/ql3-cluster-control/package.json',
    ]),
    buildOnlyDependencies: Object.freeze({}),
  }),
  'control-ai': Object.freeze({
    id: 'control-ai',
    buildManifestPath: 'deploy/containers/ql3-cluster-control/package.json',
    buildLockPath: 'deploy/containers/ql3-cluster-control/package-lock.json',
    imageManifestPath:
      'deploy/containers/ql3-cluster-control/runtime-dependencies/package.json',
    imageLockPath:
      'deploy/containers/ql3-cluster-control/runtime-dependencies/package-lock.json',
    internalManifestPaths: Object.freeze([
      'packages/ql3-runtime-core/package.json',
      'packages/ql3-ai/package.json',
      'packages/ql3-cluster-postgres/package.json',
      'packages/ql3-cluster-control/package.json',
    ]),
    buildOnlyDependencies: Object.freeze({}),
  }),
  admin: Object.freeze({
    id: 'admin',
    buildManifestPath: 'deploy/containers/ql3-cluster-admin/package.json',
    buildLockPath: 'deploy/containers/ql3-cluster-admin/package-lock.json',
    imageManifestPath:
      'deploy/containers/ql3-cluster-admin/runtime-dependencies/package.json',
    imageLockPath:
      'deploy/containers/ql3-cluster-admin/runtime-dependencies/package-lock.json',
    internalManifestPaths: Object.freeze([
      'packages/ql3-runtime-core/package.json',
      'packages/ql3-ai/package.json',
      'packages/ql3-cluster-postgres/package.json',
      'packages/ql3-cluster-admin/package.json',
    ]),
    buildOnlyDependencies: Object.freeze({}),
  }),
  local: Object.freeze({
    id: 'local',
    buildManifestPath: 'deploy/containers/ql3-local-application/package.json',
    buildLockPath: 'deploy/containers/ql3-local-application/package-lock.json',
    imageManifestPath:
      'deploy/containers/ql3-local-application/runtime-dependencies/package.json',
    imageLockPath:
      'deploy/containers/ql3-local-application/runtime-dependencies/package-lock.json',
    internalManifestPaths: Object.freeze([
      'packages/ql3-runtime-core/package.json',
      'packages/ql3-local-admin/package.json',
      'packages/ql3-local-application/package.json',
      'packages/ql3-local-command-file/package.json',
      'packages/ql3-local-execution/package.json',
      'packages/ql3-local-process/package.json',
      'packages/ql3-local-secret/package.json',
      'packages/ql3-local-sqlite/package.json',
    ]),
    buildOnlyDependencies: Object.freeze({
      'drizzle-orm': '1.0.0-rc.4',
    }),
  }),
  'local-operator': Object.freeze({
    id: 'local-operator',
    buildManifestPath: 'deploy/containers/ql3-local-operator/package.json',
    buildLockPath: 'deploy/containers/ql3-local-operator/package-lock.json',
    imageManifestPath:
      'deploy/containers/ql3-local-operator/runtime-dependencies/package.json',
    imageLockPath:
      'deploy/containers/ql3-local-operator/runtime-dependencies/package-lock.json',
    internalManifestPaths: Object.freeze([
      'packages/ql3-runtime-core/package.json',
      'packages/ql3-ai/package.json',
      'packages/ql3-local-admin/package.json',
      'packages/ql3-local-command-file/package.json',
      'packages/ql3-local-owner-cli/package.json',
      'packages/ql3-local-owner-console/package.json',
      'packages/ql3-local-secret/package.json',
      'packages/ql3-local-sqlite/package.json',
    ]),
    buildOnlyDependencies: Object.freeze({
      'drizzle-orm': '1.0.0-rc.4',
    }),
  }),
  worker: Object.freeze({
    id: 'worker',
    buildManifestPath: 'deploy/containers/ql3-worker/package.json',
    buildLockPath: 'deploy/containers/ql3-worker/package-lock.json',
    imageManifestPath:
      'deploy/containers/ql3-worker/runtime-dependencies/package.json',
    imageLockPath:
      'deploy/containers/ql3-worker/runtime-dependencies/package-lock.json',
    internalManifestPaths: Object.freeze([
      'packages/ql3-runtime-core/package.json',
      'packages/ql3-local-process/package.json',
      'packages/ql3-worker-runtime/package.json',
    ]),
    buildOnlyDependencies: Object.freeze({}),
  }),
});
const INTERNAL_MANIFEST_PATHS = IMAGE_PROFILES.control.internalManifestPaths;
const ALLOWED_LICENSE_IDS = Object.freeze([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense',
]);
const MAX_INVENTORY_PACKAGES = 512;
const MAX_MANIFEST_BYTES = 256 * 1024;

function resolveImageProfile(value = 'control') {
  const profile = IMAGE_PROFILES[value];
  if (!profile) {
    throw new Error(
      'image profile must be exactly control, control-ai, admin, local, local-operator or worker',
    );
  }
  return profile;
}

function readJson(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`invalid bounded JSON file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function componentRef(name, version) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof version !== 'string' ||
    version.length === 0
  ) {
    throw new Error('component name and version must be non-empty strings');
  }
  const purlName = name.startsWith('@')
    ? name
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')
    : encodeURIComponent(name);
  return `pkg:npm/${purlName}@${encodeURIComponent(version)}`;
}

function dependencyLocations(parentLocation, dependencyName) {
  const candidates = [];
  const add = (base) => {
    const candidate = base
      ? `${base}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  add(parentLocation);
  let offset = 0;
  while (offset < parentLocation.length) {
    const index = parentLocation.indexOf('node_modules/', offset);
    if (index === -1) {
      break;
    }
    if (index === 0 || parentLocation[index - 1] === '/') {
      add(parentLocation.slice(0, index).replace(/\/$/, ''));
    }
    offset = index + 'node_modules/'.length;
  }
  return candidates;
}

function lockPackageName(location, lockPackage) {
  if (typeof lockPackage.name === 'string' && lockPackage.name.length > 0) {
    return lockPackage.name;
  }
  const marker = 'node_modules/';
  const index = location.lastIndexOf(marker);
  if (index === -1) {
    throw new Error(
      `cannot derive package name from lock location: ${location}`,
    );
  }
  const tail = location.slice(index + marker.length);
  const parts = tail.split('/');
  return tail.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveLockClosure(lock, rootDependencies) {
  if (
    lock.lockfileVersion !== 3 ||
    !lock.packages ||
    typeof lock.packages !== 'object'
  ) {
    throw new Error('image lock must use npm lockfileVersion 3');
  }

  const queue = Object.keys(rootDependencies)
    .sort()
    .map((name) => ({ parentLocation: '', name }));
  const packages = new Map();

  while (queue.length > 0) {
    const request = queue.shift();
    const location = dependencyLocations(
      request.parentLocation,
      request.name,
    ).find((candidate) => lock.packages[candidate]);
    if (!location) {
      throw new Error(
        `runtime dependency ${request.name} is absent from the image lock`,
      );
    }
    if (packages.has(location)) {
      continue;
    }

    const lockPackage = lock.packages[location];
    const name = lockPackageName(location, lockPackage);
    const version = lockPackage.version;
    if (name !== request.name || typeof version !== 'string' || !version) {
      throw new Error(`invalid locked package at ${location}`);
    }
    packages.set(location, { location, name, version, lockPackage });

    const childNames = Object.keys({
      ...(lockPackage.dependencies || {}),
      ...(lockPackage.optionalDependencies || {}),
    }).sort();
    for (const childName of childNames) {
      queue.push({ parentLocation: location, name: childName });
    }
  }

  return packages;
}

function integrityHash(integrity) {
  if (integrity === undefined) {
    return undefined;
  }
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) {
    throw new Error(`unsupported package integrity: ${integrity}`);
  }
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 64) {
    throw new Error('invalid SHA-512 package integrity length');
  }
  return digest.toString('hex').toUpperCase();
}

function componentFromManifest(manifest, extra = {}) {
  if (
    typeof manifest.license !== 'string' ||
    !ALLOWED_LICENSE_IDS.includes(manifest.license)
  ) {
    throw new Error(
      `component ${manifest.name || '<unknown>'} has an unreviewed license`,
    );
  }
  const ref = componentRef(manifest.name, manifest.version);
  const component = {
    type: 'library',
    'bom-ref': ref,
    name: manifest.name,
    version: manifest.version,
    purl: ref,
  };
  component.licenses = [{ license: { id: manifest.license } }];
  if (extra.integrity) {
    component.hashes = [{ alg: 'SHA-512', content: extra.integrity }];
  }
  if (extra.resolved) {
    component.externalReferences = [
      { type: 'distribution', url: extra.resolved },
    ];
  }
  return component;
}

function exactDependencyRef(
  dependencyName,
  dependencyRange,
  externalByName,
  internalByName,
) {
  const internal = internalByName.get(dependencyName);
  if (internal) {
    if (dependencyRange !== 'workspace:*') {
      throw new Error(
        `internal dependency ${dependencyName} must use workspace:*`,
      );
    }
    return componentRef(internal.name, internal.version);
  }

  const external = externalByName.get(dependencyName);
  if (!external || external.length !== 1) {
    throw new Error(
      `dependency ${dependencyName} does not resolve to one runtime component`,
    );
  }
  if (dependencyRange !== external[0].version) {
    throw new Error(
      `direct runtime dependency ${dependencyName} must be exactly pinned`,
    );
  }
  return componentRef(external[0].name, external[0].version);
}

function createClusterImageSbom(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const profile = resolveImageProfile(options.image);
  const imageManifest = readJson(path.join(root, profile.imageManifestPath));
  const buildManifest = readJson(path.join(root, profile.buildManifestPath));
  const buildLock = readJson(path.join(root, profile.buildLockPath));
  const lock = readJson(path.join(root, profile.imageLockPath));
  for (const field of ['name', 'version']) {
    if (
      JSON.stringify(imageManifest[field]) !==
      JSON.stringify(buildManifest[field])
    ) {
      throw new Error(
        `production and build image manifests differ for ${field}`,
      );
    }
  }
  if (
    JSON.stringify(Object.entries(buildManifest.dependencies || {}).sort()) !==
    JSON.stringify(
      Object.entries({
        ...(imageManifest.dependencies || {}),
        ...profile.buildOnlyDependencies,
      }).sort(),
    )
  ) {
    throw new Error(
      'build image dependencies must equal runtime roots plus reviewed build-only dependencies',
    );
  }
  if (imageManifest.devDependencies !== undefined) {
    throw new Error(
      'production image manifest must not declare devDependencies',
    );
  }
  const lockRoot = lock.packages?.[''];
  if (
    !lockRoot ||
    JSON.stringify(lockRoot.dependencies || {}) !==
      JSON.stringify(imageManifest.dependencies || {})
  ) {
    throw new Error('image manifest and lock root dependencies differ');
  }

  const closure = resolveLockClosure(lock, imageManifest.dependencies || {});
  const buildClosure = resolveLockClosure(
    buildLock,
    imageManifest.dependencies || {},
  );
  const closureIdentity = (entries) =>
    [...entries.values()]
      .map(
        (entry) =>
          `${entry.name}@${entry.version}:${entry.lockPackage.integrity || ''}`,
      )
      .sort();
  if (
    JSON.stringify(closureIdentity(closure)) !==
    JSON.stringify(closureIdentity(buildClosure))
  ) {
    throw new Error(
      'production and builder locks resolve different runtime closures',
    );
  }
  const externalByName = new Map();
  const externalComponents = [];
  for (const entry of closure.values()) {
    const existing = externalByName.get(entry.name) || [];
    existing.push(entry);
    externalByName.set(entry.name, existing);
    externalComponents.push(
      componentFromManifest(
        {
          name: entry.name,
          version: entry.version,
          license: entry.lockPackage.license,
        },
        {
          integrity: integrityHash(entry.lockPackage.integrity),
          resolved: entry.lockPackage.resolved,
        },
      ),
    );
  }

  const internalManifests = profile.internalManifestPaths.map((relativePath) =>
    readJson(path.join(root, relativePath)),
  );
  const internalByName = new Map(
    internalManifests.map((manifest) => [manifest.name, manifest]),
  );
  if (internalByName.size !== profile.internalManifestPaths.length) {
    throw new Error('internal image package names must be unique');
  }

  const dependencies = [];
  for (const entry of closure.values()) {
    const dependsOn = Object.keys({
      ...(entry.lockPackage.dependencies || {}),
      ...(entry.lockPackage.optionalDependencies || {}),
    })
      .sort()
      .map((dependencyName) => {
        const location = dependencyLocations(
          entry.location,
          dependencyName,
        ).find((candidate) => closure.has(candidate));
        if (!location) {
          throw new Error(
            `runtime dependency edge ${entry.name} -> ${dependencyName} is unresolved`,
          );
        }
        const child = closure.get(location);
        return componentRef(child.name, child.version);
      });
    dependencies.push({
      ref: componentRef(entry.name, entry.version),
      dependsOn: [...new Set(dependsOn)].sort(),
    });
  }

  for (const manifest of internalManifests) {
    const dependsOn = Object.entries(manifest.dependencies || {})
      .map(([name, range]) =>
        exactDependencyRef(name, range, externalByName, internalByName),
      )
      .sort();
    dependencies.push({
      ref: componentRef(manifest.name, manifest.version),
      dependsOn,
    });
  }

  const rootDependencies = [
    ...Object.entries(imageManifest.dependencies || {}),
    ...internalManifests.map((manifest) => [
      manifest.name,
      `workspace:${manifest.version}`,
    ]),
  ]
    .map(([name, range]) => {
      if (range.startsWith('workspace:')) {
        const manifest = internalByName.get(name);
        if (!manifest || range !== `workspace:${manifest.version}`) {
          throw new Error(`invalid internal root component ${name}`);
        }
        return componentRef(manifest.name, manifest.version);
      }
      return exactDependencyRef(name, range, externalByName, internalByName);
    })
    .sort();

  const rootRef = componentRef(imageManifest.name, imageManifest.version);
  dependencies.push({ ref: rootRef, dependsOn: rootDependencies });

  const components = [
    ...externalComponents,
    ...internalManifests.map((manifest) => componentFromManifest(manifest)),
  ].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref'], 'en'),
  );

  const componentRefs = new Set(
    components.map((component) => component['bom-ref']),
  );
  if (componentRefs.size !== components.length) {
    throw new Error('runtime component name and version pairs must be unique');
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        ...componentFromManifest(imageManifest),
        type: 'application',
      },
      properties: [
        {
          name: 'qinglong:runtime-closure-source',
          value: profile.imageLockPath,
        },
        {
          name: 'qinglong:image-profile',
          value: profile.id,
        },
      ],
    },
    components,
    dependencies: dependencies.sort((left, right) =>
      left.ref.localeCompare(right.ref, 'en'),
    ),
  };
}

function dependencyMap(document) {
  const result = new Map();
  for (const edge of document.dependencies || []) {
    if (
      typeof edge.ref !== 'string' ||
      !Array.isArray(edge.dependsOn) ||
      result.has(edge.ref)
    ) {
      throw new Error('SBOM dependency nodes must be unique and well formed');
    }
    const dependsOn = [...edge.dependsOn].sort();
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`SBOM dependency node ${edge.ref} has duplicate edges`);
    }
    result.set(edge.ref, dependsOn);
  }
  return result;
}

function componentMap(document) {
  const result = new Map();
  for (const component of document.components || []) {
    const ref = component?.['bom-ref'];
    if (typeof ref !== 'string' || result.has(ref)) {
      throw new Error('SBOM component references must be unique strings');
    }
    if (component.name === 'typescript') {
      throw new Error(
        `development component leaked into SBOM: ${component.name}`,
      );
    }
    const licenseIds = (component.licenses || []).map(
      (entry) => entry?.license?.id,
    );
    if (
      licenseIds.length !== 1 ||
      !ALLOWED_LICENSE_IDS.includes(licenseIds[0])
    ) {
      throw new Error(
        `SBOM component has an unreviewed license: ${component.name}`,
      );
    }
    result.set(ref, component);
  }
  return result;
}

function compareStringArrays(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differs from the reviewed runtime closure`);
  }
}

function collectRuntimeInventory(nodeModulesRoot) {
  const root = path.resolve(nodeModulesRoot);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`runtime inventory root is not a directory: ${root}`);
  }
  const inventory = [];

  function visitNodeModules(directory) {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        if (!fs.statSync(entryPath).isDirectory()) {
          throw new Error(`invalid npm scope entry: ${entryPath}`);
        }
        for (const scopedEntry of fs
          .readdirSync(entryPath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
          visitPackage(path.join(entryPath, scopedEntry.name));
        }
      } else {
        visitPackage(entryPath);
      }
    }
  }

  function visitPackage(packageDirectory) {
    if (!fs.statSync(packageDirectory).isDirectory()) {
      throw new Error(`invalid runtime package directory: ${packageDirectory}`);
    }
    const manifest = readJson(path.join(packageDirectory, 'package.json'));
    inventory.push({
      name: manifest.name,
      version: manifest.version,
      ref: componentRef(manifest.name, manifest.version),
    });
    if (inventory.length > MAX_INVENTORY_PACKAGES) {
      throw new Error('runtime package inventory exceeds bounded maximum');
    }
    const nested = path.join(packageDirectory, 'node_modules');
    if (fs.existsSync(nested)) {
      visitNodeModules(nested);
    }
  }

  visitNodeModules(root);
  const refs = inventory.map((entry) => entry.ref).sort();
  if (new Set(refs).size !== refs.length) {
    throw new Error(
      'runtime inventory contains duplicate name/version packages',
    );
  }
  return inventory.sort((left, right) =>
    left.ref.localeCompare(right.ref, 'en'),
  );
}

function auditClusterImageSbom(document, options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const profile = resolveImageProfile(options.image);
  const expected = createClusterImageSbom({
    root,
    image: profile.id,
  });
  if (
    document?.bomFormat !== 'CycloneDX' ||
    document?.specVersion !== '1.5' ||
    document?.version !== 1 ||
    JSON.stringify(Object.keys(document).sort()) !==
      JSON.stringify([
        'bomFormat',
        'components',
        'dependencies',
        'metadata',
        'specVersion',
        'version',
      ])
  ) {
    throw new Error('SBOM must use the exact CycloneDX 1.5 document shape');
  }

  const actualRoot = document.metadata?.component;
  const expectedRoot = expected.metadata.component;
  if (
    JSON.stringify(Object.keys(document.metadata || {}).sort()) !==
      JSON.stringify(['component', 'properties']) ||
    JSON.stringify(actualRoot) !== JSON.stringify(expectedRoot)
  ) {
    throw new Error('SBOM root component differs from the image manifest');
  }
  if (
    JSON.stringify(document.metadata?.properties) !==
    JSON.stringify(expected.metadata.properties)
  ) {
    throw new Error('SBOM metadata differs from the selected image profile');
  }

  const actualComponents = componentMap(document);
  const expectedComponents = componentMap(expected);
  compareStringArrays(
    [...actualComponents.keys()].sort(),
    [...expectedComponents.keys()].sort(),
    'SBOM component set',
  );
  for (const [ref, expectedComponent] of expectedComponents) {
    if (
      JSON.stringify(actualComponents.get(ref)) !==
      JSON.stringify(expectedComponent)
    ) {
      throw new Error(`SBOM component metadata differs for ${ref}`);
    }
  }

  const actualDependencies = dependencyMap(document);
  const expectedDependencies = dependencyMap(expected);
  compareStringArrays(
    [...actualDependencies.keys()].sort(),
    [...expectedDependencies.keys()].sort(),
    'SBOM dependency node set',
  );
  for (const [ref, expectedDependsOn] of expectedDependencies) {
    compareStringArrays(
      actualDependencies.get(ref),
      expectedDependsOn,
      `SBOM dependency edges for ${ref}`,
    );
  }

  const allRefs = new Set([
    expectedRoot['bom-ref'],
    ...actualComponents.keys(),
  ]);
  for (const [ref, dependsOn] of actualDependencies) {
    if (!allRefs.has(ref)) {
      throw new Error(`SBOM dependency node is dangling: ${ref}`);
    }
    for (const dependencyRef of dependsOn) {
      if (!actualComponents.has(dependencyRef)) {
        throw new Error(`SBOM dependency edge is dangling: ${dependencyRef}`);
      }
    }
  }

  if (options.inventoryRoot) {
    const inventory = collectRuntimeInventory(options.inventoryRoot);
    compareStringArrays(
      inventory.map((entry) => entry.ref),
      [...actualComponents.keys()].sort(),
      'runtime image package inventory',
    );
  }

  return {
    image: profile.id,
    root: expectedRoot['bom-ref'],
    components: actualComponents.size,
    externalComponents:
      actualComponents.size - profile.internalManifestPaths.length,
    internalComponents: profile.internalManifestPaths.length,
    dependencyNodes: actualDependencies.size,
    inventoryVerified: Boolean(options.inventoryRoot),
  };
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument.startsWith('--output=')) {
      options.output = path.resolve(argument.slice('--output='.length));
    } else if (argument.startsWith('--inventory-root=')) {
      options.inventoryRoot = path.resolve(
        argument.slice('--inventory-root='.length),
      );
    } else if (argument.startsWith('--root=')) {
      options.root = path.resolve(argument.slice('--root='.length));
    } else if (argument.startsWith('--image=')) {
      options.image = argument.slice('--image='.length);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const document = createClusterImageSbom(options);
  const report = auditClusterImageSbom(document, options);
  if (options.output) {
    fs.writeFileSync(options.output, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_LICENSE_IDS,
  IMAGE_PROFILES,
  INTERNAL_MANIFEST_PATHS,
  auditClusterImageSbom,
  collectRuntimeInventory,
  componentRef,
  createClusterImageSbom,
  resolveImageProfile,
  resolveLockClosure,
};
