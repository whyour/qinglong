#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_MAP_DIRECTIVE =
  /\r?\n\/\/# sourceMappingURL=[A-Za-z0-9_.-]+\.map\r?\n?$/;
const DEVELOPMENT_MANIFEST_FIELDS = new Set([
  'devDependencies',
  'files',
  'scripts',
  'types',
  'typesVersions',
]);
const INTERNAL_SPECIFIER_PATTERN =
  /^(@qinglong\/[a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*))?$/;
const STATIC_MODULE_SPECIFIER_PATTERN =
  /(?:require(?:\.resolve)?|import)\(\s*(["'])([^"'\\\r\n]+)\1\s*\)/g;
const MODULE_LOAD_START_PATTERN = /(?:require(?:\.resolve)?|import)\s*\(/g;

function fail(message) {
  throw new Error(`QingLong runtime artifact pruning failed: ${message}`);
}

function writeFileAtomically(filePath, contents, mode) {
  const temporaryPath = `${filePath}.ql3-prune-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: mode & 0o777,
    });
    fs.chmodSync(temporaryPath, mode & 0o777);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function inventoryRuntimeArtifact(directory) {
  const resolved = path.resolve(directory);
  if (
    path.basename(resolved) !== '@qinglong' ||
    path.basename(path.dirname(resolved)) !== 'node_modules'
  ) {
    fail('root must be a node_modules/@qinglong directory');
  }
  const rootStat = fs.lstatSync(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('root must be a real directory');
  }

  const files = [];
  const pending = [resolved];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        fail('runtime package contains a symbolic link');
      }
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile()) {
        files.push(Object.freeze({ path: entryPath, stat }));
      } else {
        fail('runtime package contains an unsupported filesystem entry');
      }
    }
  }
  return Object.freeze({ resolved, files: Object.freeze(files) });
}

function projectRuntimeConditions(value) {
  if (Array.isArray(value)) return value.map(projectRuntimeConditions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'types')
      .map(([key, entry]) => [key, projectRuntimeConditions(entry)]),
  );
}

function projectRuntimeExports(value, requiredKeys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('runtime package exports must be an exact subpath map');
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        if (
          key !== '.' &&
          !/^\.\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(key)
        ) {
          fail(`runtime package export key ${key} is invalid`);
        }
        return requiredKeys === null || requiredKeys.has(key);
      })
      .map(([key, entry]) => [key, projectRuntimeConditions(entry)]),
  );
}

function projectRuntimeManifest(
  manifest,
  requiredExportKeys = null,
  retainMain = true,
) {
  return Object.fromEntries(
    Object.entries(manifest)
      .filter(
        ([key]) =>
          !DEVELOPMENT_MANIFEST_FIELDS.has(key) &&
          (key !== 'main' || retainMain),
      )
      .map(([key, value]) => [
        key,
        key === 'exports'
          ? projectRuntimeExports(value, requiredExportKeys)
          : value,
      ]),
  );
}

function normalizeEntrySpecifiers(options) {
  if (options === undefined) return Object.freeze([]);
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Reflect.ownKeys(options).some(
      (key) =>
        key !== 'entrySpecifiers' &&
        key !== 'excludedInternalPackages' &&
        key !== 'retainedJavaScriptFiles',
    ) ||
    !Array.isArray(options.entrySpecifiers) ||
    options.entrySpecifiers.length > 64
  ) {
    fail('runtime entry specifier options are invalid');
  }
  const entries = [];
  const seen = new Set();
  for (const value of options.entrySpecifiers) {
    if (typeof value !== 'string' || !INTERNAL_SPECIFIER_PATTERN.test(value)) {
      fail('runtime entry specifier is invalid');
    }
    if (seen.has(value)) fail('runtime entry specifier is duplicated');
    seen.add(value);
    entries.push(value);
  }
  return Object.freeze(entries);
}

function normalizeRetainedJavaScriptFiles(options, inventory) {
  if (options === undefined || options.retainedJavaScriptFiles === undefined) {
    return Object.freeze([]);
  }
  if (
    !Array.isArray(options.retainedJavaScriptFiles) ||
    options.retainedJavaScriptFiles.length > 64
  ) {
    fail('retained JavaScript file options are invalid');
  }
  const inventoryPaths = new Set(inventory.files.map(({ path: file }) => file));
  const retained = [];
  const seen = new Set();
  for (const value of options.retainedJavaScriptFiles) {
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') > 256 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[A-Za-z0-9._-]+)+\.js$/u.test(value) ||
      seen.has(value)
    ) {
      fail('retained JavaScript file is invalid');
    }
    seen.add(value);
    const resolved = path.resolve(inventory.resolved, ...value.split('/'));
    if (
      !resolved.startsWith(`${inventory.resolved}${path.sep}`) ||
      !inventoryPaths.has(resolved)
    ) {
      fail('retained JavaScript file is not installed');
    }
    retained.push(resolved);
  }
  return Object.freeze(retained);
}

function normalizeExcludedInternalPackages(options) {
  if (options === undefined || options.excludedInternalPackages === undefined) {
    return Object.freeze([]);
  }
  if (
    !Array.isArray(options.excludedInternalPackages) ||
    options.excludedInternalPackages.length > 16
  ) {
    fail('excluded internal package options are invalid');
  }
  const packages = [];
  const seen = new Set();
  for (const value of options.excludedInternalPackages) {
    const identity =
      typeof value === 'string' ? specifierIdentity(value) : null;
    if (!identity || identity.exportKey !== '.') {
      fail('excluded internal package is invalid');
    }
    if (seen.has(identity.packageName)) {
      fail('excluded internal package is duplicated');
    }
    seen.add(identity.packageName);
    packages.push(identity.packageName);
  }
  return Object.freeze(packages);
}

function specifierIdentity(specifier) {
  const match = INTERNAL_SPECIFIER_PATTERN.exec(specifier);
  if (!match) fail(`runtime internal specifier ${specifier} is invalid`);
  return Object.freeze({
    packageName: match[1],
    exportKey: match[2] === undefined ? '.' : `./${match[2]}`,
  });
}

function collectStaticModuleSpecifiers(files) {
  const byFile = new Map();
  for (const file of files) {
    if (!file.path.endsWith('.js')) continue;
    const contents = fs.readFileSync(file.path, 'utf8');
    const literalRanges = [];
    const literalCalls = new Set();
    const specifiers = [];
    STATIC_MODULE_SPECIFIER_PATTERN.lastIndex = 0;
    for (const match of contents.matchAll(STATIC_MODULE_SPECIFIER_PATTERN)) {
      const specifier = match[2];
      const start = match.index + match[0].indexOf(specifier);
      literalRanges.push(
        Object.freeze({ start, end: start + specifier.length }),
      );
      literalCalls.add(match.index);
      specifiers.push(specifier);
    }
    MODULE_LOAD_START_PATTERN.lastIndex = 0;
    for (const match of contents.matchAll(MODULE_LOAD_START_PATTERN)) {
      if (!literalCalls.has(match.index)) {
        fail(
          `runtime JavaScript contains a non-literal module load at ${file.path}`,
        );
      }
    }
    let occurrence = contents.indexOf('@qinglong/');
    while (occurrence !== -1) {
      if (
        !literalRanges.some(
          ({ start, end }) => occurrence >= start && occurrence < end,
        )
      ) {
        fail(
          `runtime JavaScript contains an unproved internal specifier at ${file.path}`,
        );
      }
      occurrence = contents.indexOf('@qinglong/', occurrence + 1);
    }
    byFile.set(file.path, Object.freeze(specifiers));
  }
  return byFile;
}

function runtimeExportTargetFiles(packageRoot, value) {
  validateRuntimeExportTarget(packageRoot, value);
  if (typeof value === 'string') {
    return Object.freeze([path.resolve(packageRoot, value)]);
  }
  return Object.freeze(
    Object.entries(value)
      .filter(([condition]) => condition !== 'types')
      .flatMap(([, target]) => runtimeExportTargetFiles(packageRoot, target)),
  );
}

function manifestRuntimeTarget(packageRoot, value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    fail(`${label} target is invalid`);
  }
  const resolved = path.resolve(packageRoot, value);
  if (
    resolved === packageRoot ||
    !resolved.startsWith(`${packageRoot}${path.sep}`)
  ) {
    fail(`${label} target escapes its package`);
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`${label} target is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} target is not a regular file`);
  }
  return resolved;
}

function manifestBinTargets(record) {
  const { bin } = record.manifest;
  if (bin === undefined) return Object.freeze([]);
  const values =
    typeof bin === 'string'
      ? [bin]
      : bin && typeof bin === 'object' && !Array.isArray(bin)
      ? Object.values(bin)
      : null;
  if (!values || values.some((value) => typeof value !== 'string')) {
    fail(`runtime package bin is invalid for ${record.manifest.name}`);
  }
  return Object.freeze(
    values.map((value) =>
      manifestRuntimeTarget(record.packageRoot, value, 'runtime bin'),
    ),
  );
}

function canonicalRelativeSpecifier(specifier) {
  if (
    typeof specifier !== 'string' ||
    (!specifier.startsWith('./') && !specifier.startsWith('../')) ||
    specifier.includes('\\') ||
    specifier.includes('?') ||
    specifier.includes('#') ||
    specifier.includes('\0')
  ) {
    return false;
  }
  let remainder = specifier;
  if (remainder.startsWith('./')) remainder = remainder.slice(2);
  else while (remainder.startsWith('../')) remainder = remainder.slice(3);
  return (
    remainder.length > 0 &&
    remainder
      .split('/')
      .every(
        (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
      )
  );
}

function resolveRelativeRuntimeTarget(fromFile, specifier, packageRoot) {
  if (!canonicalRelativeSpecifier(specifier)) {
    fail(`runtime relative specifier ${specifier} is invalid`);
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (!base.startsWith(`${packageRoot}${path.sep}`)) {
    fail(`runtime relative specifier ${specifier} escapes its package`);
  }
  const candidates = path.extname(base)
    ? [base]
    : [
        base,
        `${base}.js`,
        `${base}.json`,
        `${base}.node`,
        path.join(base, 'index.js'),
        path.join(base, 'index.json'),
        path.join(base, 'index.node'),
      ];
  for (const candidate of candidates) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  fail(`runtime relative specifier ${specifier} target is missing`);
}

function validateRuntimeExportTarget(packageRoot, value) {
  if (typeof value === 'string') {
    if (!value.startsWith('./') || value.includes('\\')) {
      fail('runtime export target is not package-relative');
    }
    const resolved = path.resolve(packageRoot, value);
    if (
      resolved === packageRoot ||
      !resolved.startsWith(`${packageRoot}${path.sep}`)
    ) {
      fail('runtime export target escapes its package');
    }
    let stat;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      fail('runtime export target is missing');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('runtime export target is not a regular file');
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('runtime export condition shape is invalid');
  }
  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'types') continue;
    validateRuntimeExportTarget(packageRoot, target);
  }
}

function pruneRuntimeArtifact(directory, options) {
  const entrySpecifiers = normalizeEntrySpecifiers(options);
  const excludedInternalPackages = new Set(
    normalizeExcludedInternalPackages(options),
  );
  const inventory = inventoryRuntimeArtifact(directory);
  const retainedJavaScriptFiles = normalizeRetainedJavaScriptFiles(
    options,
    inventory,
  );
  const manifests = inventory.files.filter(
    (file) =>
      path.basename(file.path) === 'package.json' &&
      path.dirname(path.dirname(file.path)) === inventory.resolved,
  );
  if (manifests.length === 0) {
    fail('root does not contain any direct QingLong package manifests');
  }
  const packageRecords = [];
  const packageByName = new Map();
  for (const file of manifests) {
    const before = fs.readFileSync(file.path, 'utf8');
    const manifest = JSON.parse(before);
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      typeof manifest.name !== 'string' ||
      !manifest.name.startsWith('@qinglong/')
    ) {
      fail(`invalid QingLong package manifest at ${file.path}`);
    }
    if (packageByName.has(manifest.name)) {
      fail(`duplicate QingLong package manifest ${manifest.name}`);
    }
    const record = Object.freeze({
      file,
      before,
      manifest,
      packageRoot: path.dirname(file.path),
    });
    packageRecords.push(record);
    packageByName.set(manifest.name, record);
  }

  const javascriptFiles = inventory.files.filter((file) =>
    file.path.endsWith('.js'),
  );
  const javascriptByPath = new Map(
    javascriptFiles.map((file) => [file.path, file]),
  );
  const staticSpecifiers = collectStaticModuleSpecifiers(javascriptFiles);
  const requiredExports = new Map(
    packageRecords.map(({ manifest }) => [manifest.name, new Set()]),
  );
  const excludedSpecifiers = new Set();
  const reachableJavascript = new Set();
  const pendingJavascript = [];
  const enqueueJavascript = (filePath, label) => {
    if (!filePath.endsWith('.js')) return;
    const file = javascriptByPath.get(filePath);
    if (!file) fail(`${label} JavaScript target is not installed`);
    if (reachableJavascript.has(filePath)) return;
    reachableJavascript.add(filePath);
    pendingJavascript.push(filePath);
  };
  const requireExport = (specifier, sourceFilePath = null) => {
    const { packageName, exportKey } = specifierIdentity(specifier);
    const record = packageByName.get(packageName);
    if (!record) {
      const owner = sourceFilePath
        ? packageRecords.find(({ packageRoot }) =>
            sourceFilePath.startsWith(`${packageRoot}${path.sep}`),
          )
        : null;
      const declaredVersion = owner?.manifest.devDependencies?.[packageName];
      if (
        excludedInternalPackages.has(packageName) &&
        (declaredVersion === 'workspace:*' ||
          declaredVersion === owner?.manifest.version)
      ) {
        excludedSpecifiers.add(`${owner.manifest.name}:${specifier}`);
        return;
      }
      fail(
        `runtime internal package ${packageName} is not installed for ${
          owner?.manifest.name ?? 'Profile entry'
        }`,
      );
    }
    if (excludedInternalPackages.has(packageName)) {
      fail(`excluded runtime internal package ${packageName} is installed`);
    }
    if (!record.manifest.exports) {
      if (exportKey !== '.' || record.manifest.main === undefined) {
        fail(`runtime internal specifier ${specifier} is not exported`);
      }
      enqueueJavascript(
        manifestRuntimeTarget(
          record.packageRoot,
          record.manifest.main,
          'runtime main',
        ),
        `runtime main for ${packageName}`,
      );
      return;
    }
    if (
      typeof record.manifest.exports !== 'object' ||
      Array.isArray(record.manifest.exports) ||
      !Object.hasOwn(record.manifest.exports, exportKey)
    ) {
      fail(`runtime internal specifier ${specifier} is not exported`);
    }
    const keys = requiredExports.get(packageName);
    keys.add(exportKey);
    for (const target of runtimeExportTargetFiles(
      record.packageRoot,
      record.manifest.exports[exportKey],
    )) {
      enqueueJavascript(target, `runtime export ${specifier}`);
    }
    if (exportKey === '.' && record.manifest.main !== undefined) {
      enqueueJavascript(
        manifestRuntimeTarget(
          record.packageRoot,
          record.manifest.main,
          'runtime main',
        ),
        `runtime main for ${packageName}`,
      );
    }
  };

  for (const record of packageRecords) {
    for (const target of manifestBinTargets(record)) {
      enqueueJavascript(target, `runtime bin for ${record.manifest.name}`);
    }
    if (!record.manifest.exports && record.manifest.main !== undefined) {
      enqueueJavascript(
        manifestRuntimeTarget(
          record.packageRoot,
          record.manifest.main,
          'runtime main',
        ),
        `runtime main for ${record.manifest.name}`,
      );
    }
    for (const file of javascriptFiles) {
      if (!file.path.startsWith(`${record.packageRoot}${path.sep}`)) continue;
      const relative = path.relative(record.packageRoot, file.path);
      const [dist, domain] = relative.split(path.sep);
      if (
        dist === 'dist' &&
        (domain === 'migration' || domain === 'migrations')
      ) {
        enqueueJavascript(file.path, `migration for ${record.manifest.name}`);
      }
    }
  }
  for (const file of retainedJavaScriptFiles) {
    enqueueJavascript(file, 'explicit runtime asset');
  }
  for (const specifier of entrySpecifiers) requireExport(specifier);

  while (pendingJavascript.length > 0) {
    const filePath = pendingJavascript.pop();
    const owner = packageRecords.find(({ packageRoot }) =>
      filePath.startsWith(`${packageRoot}${path.sep}`),
    );
    if (!owner) fail('reachable JavaScript has no package owner');
    for (const specifier of staticSpecifiers.get(filePath) ?? []) {
      if (specifier.startsWith('@qinglong/')) {
        requireExport(specifier, filePath);
      } else if (specifier.startsWith('.')) {
        enqueueJavascript(
          resolveRelativeRuntimeTarget(filePath, specifier, owner.packageRoot),
          `relative import from ${filePath}`,
        );
      }
    }
  }

  const developmentPlan = inventory.files.filter(
    (file) => file.path.endsWith('.d.ts') || file.path.endsWith('.map'),
  );
  const javascriptPrunePlan = javascriptFiles.filter(
    (file) => !reachableJavascript.has(file.path),
  );
  const sourceMapDirectivePlan = [];
  for (const file of javascriptFiles) {
    if (!reachableJavascript.has(file.path)) continue;
    const before = fs.readFileSync(file.path, 'utf8');
    const after = before.replace(SOURCE_MAP_DIRECTIVE, '\n');
    if (after !== before) {
      sourceMapDirectivePlan.push(Object.freeze({ file, after }));
    }
  }

  const packageManifestPlan = [];
  for (const record of packageRecords) {
    const { file, before, manifest, packageRoot } = record;
    const required = requiredExports.get(manifest.name);
    const retainMain = !manifest.exports || required.has('.');
    const projected = projectRuntimeManifest(manifest, required, retainMain);
    if (projected.exports) {
      for (const target of Object.values(projected.exports)) {
        validateRuntimeExportTarget(packageRoot, target);
      }
    }
    const compacted = `${JSON.stringify(manifest)}\n`;
    const developmentProjected = `${JSON.stringify(
      projectRuntimeManifest(manifest, null, retainMain),
    )}\n`;
    const after = `${JSON.stringify(projected)}\n`;
    const exportKeysBefore = Object.keys(manifest.exports ?? {}).length;
    const exportKeysAfter = Object.keys(projected.exports ?? {}).length;
    if (Buffer.byteLength(after) < Buffer.byteLength(before)) {
      packageManifestPlan.push(
        Object.freeze({
          file,
          after,
          compactedBytes: Math.max(
            0,
            Buffer.byteLength(before) - Buffer.byteLength(compacted),
          ),
          projectedBytes: Math.max(
            0,
            Buffer.byteLength(compacted) - Buffer.byteLength(after),
          ),
          runtimeExportKeysBefore: exportKeysBefore,
          runtimeExportKeysAfter: exportKeysAfter,
          runtimeExportBytes: Math.max(
            0,
            Buffer.byteLength(developmentProjected) - Buffer.byteLength(after),
          ),
        }),
      );
    }
  }

  let developmentFiles = 0;
  let developmentBytes = 0;
  let runtimeJavaScriptFiles = 0;
  let runtimeJavaScriptBytes = 0;
  let sourceMapDirectiveFiles = 0;
  let sourceMapDirectiveBytes = 0;
  let packageManifestFiles = 0;
  let packageManifestBytes = 0;
  let compactedPackageManifestFiles = 0;
  let compactedPackageManifestBytes = 0;
  let projectedPackageManifestFiles = 0;
  let projectedPackageManifestBytes = 0;
  let runtimeExportKeysBefore = 0;
  let runtimeExportKeysAfter = 0;
  let runtimeExportBytes = 0;

  for (const file of developmentPlan) {
    fs.unlinkSync(file.path);
    developmentFiles += 1;
    developmentBytes += file.stat.size;
  }

  for (const file of javascriptPrunePlan) {
    fs.unlinkSync(file.path);
    runtimeJavaScriptFiles += 1;
    runtimeJavaScriptBytes += file.stat.size;
  }

  for (const { file, after } of sourceMapDirectivePlan) {
    writeFileAtomically(file.path, after, file.stat.mode);
    sourceMapDirectiveFiles += 1;
    sourceMapDirectiveBytes += file.stat.size - Buffer.byteLength(after);
  }

  for (const {
    file,
    after,
    compactedBytes,
    projectedBytes,
    runtimeExportKeysBefore: manifestExportKeysBefore,
    runtimeExportKeysAfter: manifestExportKeysAfter,
    runtimeExportBytes: manifestRuntimeExportBytes,
  } of packageManifestPlan) {
    writeFileAtomically(file.path, after, file.stat.mode);
    packageManifestFiles += 1;
    packageManifestBytes += file.stat.size - Buffer.byteLength(after);
    if (compactedBytes > 0) {
      compactedPackageManifestFiles += 1;
      compactedPackageManifestBytes += compactedBytes;
    }
    if (projectedBytes > 0) {
      projectedPackageManifestFiles += 1;
      projectedPackageManifestBytes += projectedBytes;
    }
    runtimeExportKeysBefore += manifestExportKeysBefore;
    runtimeExportKeysAfter += manifestExportKeysAfter;
    runtimeExportBytes += manifestRuntimeExportBytes;
  }

  return Object.freeze({
    development: Object.freeze({
      files: developmentFiles,
      bytes: developmentBytes,
    }),
    runtimeJavaScript: Object.freeze({
      filesBefore: javascriptFiles.length,
      filesAfter: javascriptFiles.length - runtimeJavaScriptFiles,
      filesRemoved: runtimeJavaScriptFiles,
      bytesRemoved: runtimeJavaScriptBytes,
    }),
    sourceMapDirectives: Object.freeze({
      files: sourceMapDirectiveFiles,
      bytes: sourceMapDirectiveBytes,
    }),
    packageManifests: Object.freeze({
      files: packageManifestFiles,
      bytes: packageManifestBytes,
      compactedFiles: compactedPackageManifestFiles,
      compactedBytes: compactedPackageManifestBytes,
      projectedFiles: projectedPackageManifestFiles,
      projectedBytes: projectedPackageManifestBytes,
      runtimeExports: Object.freeze({
        keysBefore: runtimeExportKeysBefore,
        keysAfter: runtimeExportKeysAfter,
        keysRemoved: runtimeExportKeysBefore - runtimeExportKeysAfter,
        bytes: runtimeExportBytes,
        excludedSpecifiers: excludedSpecifiers.size,
      }),
    }),
    savedBytes:
      developmentBytes +
      runtimeJavaScriptBytes +
      sourceMapDirectiveBytes +
      packageManifestBytes,
  });
}

module.exports = {
  pruneRuntimeArtifact,
};

if (require.main === module) {
  try {
    if (process.argv.length < 4) {
      fail(
        'usage: ql3-prune-runtime-artifact.cjs node_modules/@qinglong @qinglong/profile-entry [...]',
      );
    }
    const arguments = process.argv.slice(3);
    const report = pruneRuntimeArtifact(process.argv[2], {
      entrySpecifiers: arguments.filter(
        (argument) => !argument.startsWith('--exclude='),
      ),
      excludedInternalPackages: arguments
        .filter((argument) => argument.startsWith('--exclude='))
        .map((argument) => argument.slice('--exclude='.length)),
    });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...report })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
