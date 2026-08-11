'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ALLOWED_CRITERIA = new Set([
  'authority',
  'dependency_isolation',
  'deployable',
  'replaceable_adapter',
  'shared_leaf',
]);
const THIN_PACKAGE_CRITERIA = new Set([
  'authority',
  'deployable',
  'shared_leaf',
]);
const ALLOWED_ROOT_SOURCE_ROLES = new Set([
  'binary_entry',
  'public_export',
  'shared_infrastructure',
]);
const ALLOWED_SHALLOW_LAYOUT_KINDS = new Set(['public_entrypoints']);
const ALLOWED_DENSE_DIRECTORY_KINDS = new Set([
  'ordered_ledger',
  'ownership_review',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sortedUniqueStrings(value) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    return undefined;
  }
  const sorted = [...new Set(value)].sort();
  return sorted.length === value.length ? sorted : undefined;
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sourceMetrics(directory) {
  const files = [];
  const directDirectories = [];
  const sourceRoot = path.join(directory, 'src');
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const directFiles = entries.filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.d.ts'),
    );
    if (current !== sourceRoot && directFiles.length > 0) {
      directDirectories.push(
        Object.freeze({
          relativePath: path
            .relative(sourceRoot, current)
            .split(path.sep)
            .join('/'),
          files: directFiles.length,
        }),
      );
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(target);
      }
    }
  };
  walk(sourceRoot);
  files.sort();
  directDirectories.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const rootFileNames = files
    .filter((file) => path.dirname(file) === sourceRoot)
    .map((file) => path.basename(file));
  const linesByFile = new Map(
    files.map((file) => [
      file,
      fs.readFileSync(file, 'utf8').split(/\r?\n/u).length,
    ]),
  );
  return Object.freeze({
    files: files.length,
    rootFiles: rootFileNames.length,
    rootFileNames: Object.freeze(rootFileNames),
    rootLines: files
      .filter((file) => path.dirname(file) === sourceRoot)
      .reduce((total, file) => total + (linesByFile.get(file) ?? 0), 0),
    nestedFiles: files.filter((file) => path.dirname(file) !== sourceRoot)
      .length,
    directDirectories: Object.freeze(directDirectories),
    lines: files.reduce(
      (total, file) => total + (linesByFile.get(file) ?? 0),
      0,
    ),
  });
}

function internalSourceLayoutPolicy(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !sameStrings(Object.keys(value), [
      'directSourceFileReviewThreshold',
      'reviewedDenseDirectories',
    ]) ||
    !Number.isSafeInteger(value.directSourceFileReviewThreshold) ||
    value.directSourceFileReviewThreshold < 2 ||
    !Array.isArray(value.reviewedDenseDirectories)
  ) {
    return undefined;
  }
  const reviewed = [];
  for (const entry of value.reviewedDenseDirectories) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !sameStrings(Object.keys(entry), [
        'kind',
        'maxDirectSourceFiles',
        'path',
        'rationale',
      ]) ||
      !ALLOWED_DENSE_DIRECTORY_KINDS.has(entry.kind) ||
      !Number.isSafeInteger(entry.maxDirectSourceFiles) ||
      entry.maxDirectSourceFiles < value.directSourceFileReviewThreshold ||
      typeof entry.path !== 'string' ||
      !/^packages\/ql3-[a-z0-9-]+\/src\/[A-Za-z0-9][A-Za-z0-9/-]*$/u.test(
        entry.path,
      ) ||
      entry.path.includes('//') ||
      entry.path.split('/').includes('..') ||
      typeof entry.rationale !== 'string' ||
      entry.rationale.length < 16
    ) {
      return undefined;
    }
    reviewed.push(
      Object.freeze({
        kind: entry.kind,
        maxDirectSourceFiles: entry.maxDirectSourceFiles,
        path: entry.path,
        rationale: entry.rationale,
      }),
    );
  }
  const paths = reviewed.map((entry) => entry.path);
  if (
    new Set(paths).size !== paths.length ||
    !sameStrings(paths, [...paths].sort())
  ) {
    return undefined;
  }
  return Object.freeze({
    directSourceFileReviewThreshold: value.directSourceFileReviewThreshold,
    reviewedDenseDirectories: Object.freeze(reviewed),
  });
}

function packageDirectories(root) {
  const packagesRoot = path.join(root, 'packages');
  return fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith('ql3-') &&
        fs.existsSync(path.join(packagesRoot, entry.name, 'package.json')),
    )
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

function productionDependencies(manifest) {
  return Object.freeze({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  });
}

function finding(code, packagePath, message) {
  return Object.freeze({ code, packagePath, message });
}

function stringTargets(value, targets = []) {
  if (typeof value === 'string') {
    targets.push(value.replace(/^\.\//u, ''));
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) stringTargets(nested, targets);
  }
  return targets;
}

function sourceOutputTarget(fileName) {
  return `dist/${fileName.replace(/\.tsx?$/u, '.js')}`;
}

function publicExportIsReexportOnly(filePath) {
  try {
    const sourceFile = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    return (
      sourceFile.parseDiagnostics.length === 0 &&
      sourceFile.statements.length > 0 &&
      sourceFile.statements.every((statement) =>
        ts.isExportDeclaration(statement),
      )
    );
  } catch {
    return false;
  }
}

function rootSourceRoles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const fileNames = Object.keys(value);
  if (
    fileNames.some(
      (fileName) =>
        !/^[A-Za-z][A-Za-z0-9]*\.(?:ts|tsx)$/u.test(fileName) ||
        !ALLOWED_ROOT_SOURCE_ROLES.has(value[fileName]),
    ) ||
    !sameStrings(fileNames, [...fileNames].sort())
  ) {
    return undefined;
  }
  return Object.freeze(
    Object.fromEntries(
      fileNames.map((fileName) => [fileName, value[fileName]]),
    ),
  );
}

function shallowSourceLayout(value) {
  const keys =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
      : [];
  const baseShape = sameStrings(keys, ['kind', 'rationale']);
  const artifactShape = sameStrings(keys, [
    'artifactEntrypoints',
    'closureDelta',
    'kind',
    'rationale',
  ]);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (!baseShape && !artifactShape) ||
    !ALLOWED_SHALLOW_LAYOUT_KINDS.has(value.kind) ||
    typeof value.rationale !== 'string' ||
    value.rationale.length < 16
  ) {
    return undefined;
  }
  if (baseShape) {
    return Object.freeze({ kind: value.kind, rationale: value.rationale });
  }
  const artifactEntrypoints = value.artifactEntrypoints;
  const artifactNames =
    artifactEntrypoints &&
    typeof artifactEntrypoints === 'object' &&
    !Array.isArray(artifactEntrypoints)
      ? Object.keys(artifactEntrypoints)
      : [];
  const entrypointSpecifiers = artifactNames.map(
    (artifactName) => artifactEntrypoints[artifactName],
  );
  const closureDelta = value.closureDelta;
  const excludedDependencies = sortedUniqueStrings(
    closureDelta?.excludedDependencies,
  );
  if (
    artifactNames.length === 0 ||
    !sameStrings(artifactNames, [...artifactNames].sort()) ||
    artifactNames.some(
      (artifactName) => !/^[a-z][a-z0-9-]*$/u.test(artifactName),
    ) ||
    entrypointSpecifiers.some(
      (specifier) =>
        typeof specifier !== 'string' ||
        !/^\.\/[a-z][a-z0-9-]*$/u.test(specifier),
    ) ||
    new Set(entrypointSpecifiers).size !== entrypointSpecifiers.length ||
    !closureDelta ||
    typeof closureDelta !== 'object' ||
    Array.isArray(closureDelta) ||
    !sameStrings(Object.keys(closureDelta), [
      'comparedWith',
      'excludedDependencies',
    ]) ||
    typeof closureDelta.comparedWith !== 'string' ||
    !closureDelta.comparedWith.startsWith('@qinglong/') ||
    !excludedDependencies ||
    excludedDependencies.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    artifactEntrypoints: Object.freeze({ ...artifactEntrypoints }),
    closureDelta: Object.freeze({
      comparedWith: closureDelta.comparedWith,
      excludedDependencies,
    }),
    kind: value.kind,
    rationale: value.rationale,
  });
}

function runtimeExportTarget(value) {
  const targets = [
    ...new Set(stringTargets(value).filter((target) => target.endsWith('.js'))),
  ];
  return targets.length === 1 ? targets[0] : undefined;
}

function productionDependencyClosure(manifest, manifestsByName) {
  const closure = new Set();
  const pending = Object.keys(productionDependencies(manifest));
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (!dependency || closure.has(dependency)) continue;
    closure.add(dependency);
    const dependencyManifest = manifestsByName.get(dependency);
    if (dependencyManifest) {
      pending.push(...Object.keys(productionDependencies(dependencyManifest)));
    }
  }
  return closure;
}

function auditPackageBoundaries(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const ledgerPath = path.resolve(
    options.ledgerPath ?? path.join(root, 'docs/ql3-package-boundaries.json'),
  );
  const findings = [];
  let ledger;
  try {
    ledger = readJson(ledgerPath);
  } catch (error) {
    return Object.freeze({
      schemaVersion: 6,
      compatible: false,
      workspacePackageCount: 0,
      workspacePackageHardCap: 0,
      singleSourcePackages: Object.freeze([]),
      shallowSourcePackages: Object.freeze([]),
      denseSourceDirectories: Object.freeze([]),
      packages: Object.freeze([]),
      findings: Object.freeze([
        finding(
          'PACKAGE_BOUNDARY_LEDGER_INVALID',
          'docs/ql3-package-boundaries.json',
          error instanceof Error ? error.name : 'Error',
        ),
      ]),
    });
  }

  const directories = packageDirectories(root);
  const declared = Array.isArray(ledger.packages) ? ledger.packages : [];
  if (ledger.schemaVersion !== 6) {
    findings.push(
      finding(
        'PACKAGE_BOUNDARY_SCHEMA_INVALID',
        'docs/ql3-package-boundaries.json',
        'schemaVersion must be 6',
      ),
    );
  }
  const sourceLayoutPolicy = internalSourceLayoutPolicy(
    ledger.internalSourceLayout,
  );
  if (!sourceLayoutPolicy) {
    findings.push(
      finding(
        'PACKAGE_SOURCE_INTERNAL_LAYOUT_POLICY_INVALID',
        'docs/ql3-package-boundaries.json',
        'internalSourceLayout must declare one threshold and a sorted exact dense-directory review list',
      ),
    );
  }
  if (
    !Number.isSafeInteger(ledger.workspacePackageHardCap) ||
    ledger.workspacePackageHardCap < 1
  ) {
    findings.push(
      finding(
        'PACKAGE_BOUNDARY_HARD_CAP_INVALID',
        'docs/ql3-package-boundaries.json',
        'workspacePackageHardCap must be a positive integer',
      ),
    );
  } else if (directories.length > ledger.workspacePackageHardCap) {
    findings.push(
      finding(
        'PACKAGE_BOUNDARY_HARD_CAP_EXCEEDED',
        'packages',
        `${directories.length} packages exceed cap ${ledger.workspacePackageHardCap}`,
      ),
    );
  }

  const entriesByPath = new Map();
  for (const entry of declared) {
    const packagePath =
      entry && typeof entry.path === 'string' ? entry.path : '<invalid>';
    if (entriesByPath.has(packagePath)) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_DUPLICATE_PATH',
          packagePath,
          'package path is declared more than once',
        ),
      );
    } else {
      entriesByPath.set(packagePath, entry);
    }
  }
  for (const directory of directories) {
    if (!entriesByPath.has(directory)) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_UNDECLARED_PACKAGE',
          directory,
          'workspace package has no reviewed boundary decision',
        ),
      );
    }
  }
  for (const packagePath of entriesByPath.keys()) {
    if (!directories.includes(packagePath)) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_STALE_PACKAGE',
          packagePath,
          'boundary decision has no workspace package',
        ),
      );
    }
  }

  const manifests = new Map();
  for (const directory of directories) {
    manifests.set(
      directory,
      readJson(path.join(root, directory, 'package.json')),
    );
  }
  const actualNames = new Set(
    [...manifests.values()].map((manifest) => manifest.name),
  );
  const manifestsByName = new Map(
    [...manifests.values()].map((manifest) => [manifest.name, manifest]),
  );
  const reports = [];
  const directSourceDirectories = new Map();
  const denseSourceDirectories = [];
  const reviewedDenseDirectories = new Map(
    (sourceLayoutPolicy?.reviewedDenseDirectories ?? []).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  for (const directory of directories) {
    const entry = entriesByPath.get(directory);
    const manifest = manifests.get(directory);
    const metrics = sourceMetrics(path.join(root, directory));
    for (const directDirectory of metrics.directDirectories) {
      const directoryPath = `${directory}/src/${directDirectory.relativePath}`;
      directSourceDirectories.set(directoryPath, directDirectory.files);
      if (
        sourceLayoutPolicy &&
        directDirectory.files >=
          sourceLayoutPolicy.directSourceFileReviewThreshold
      ) {
        const review = reviewedDenseDirectories.get(directoryPath);
        denseSourceDirectories.push(
          Object.freeze({
            path: directoryPath,
            directSourceFiles: directDirectory.files,
            reviewKind: review?.kind ?? null,
            maxDirectSourceFiles: review?.maxDirectSourceFiles ?? null,
          }),
        );
        if (!review) {
          findings.push(
            finding(
              'PACKAGE_SOURCE_DENSE_DIRECTORY_UNREVIEWED',
              directory,
              `${directoryPath} has ${directDirectory.files} direct source files at review threshold ${sourceLayoutPolicy.directSourceFileReviewThreshold}`,
            ),
          );
        } else if (directDirectory.files > review.maxDirectSourceFiles) {
          findings.push(
            finding(
              'PACKAGE_SOURCE_DENSE_DIRECTORY_HARD_CAP_EXCEEDED',
              directory,
              `${directoryPath} has ${directDirectory.files} direct source files above reviewed cap ${review.maxDirectSourceFiles}`,
            ),
          );
        }
      }
    }
    const dependencies = productionDependencies(manifest);
    const consumers = [...manifests.entries()]
      .filter(([, candidate]) =>
        Object.prototype.hasOwnProperty.call(
          productionDependencies(candidate),
          manifest.name,
        ),
      )
      .map(([, candidate]) => candidate.name)
      .sort();
    reports.push(
      Object.freeze({
        path: directory,
        name: manifest.name,
        sourceFiles: metrics.files,
        rootSourceFiles: metrics.rootFiles,
        rootSourceLines: metrics.rootLines,
        nestedSourceFiles: metrics.nestedFiles,
        rootSourceFileHardCap: entry?.rootSourceFileHardCap ?? null,
        rootSourceLineHardCap: entry?.rootSourceLineHardCap ?? null,
        rootSourceFileRoles: Object.freeze({
          ...(entry?.rootSourceFileRoles ?? {}),
        }),
        shallowSourceLayoutKind: entry?.shallowSourceLayout?.kind ?? null,
        sourceLines: metrics.lines,
        consumers: Object.freeze(consumers),
      }),
    );
    for (const dependency of Object.keys(dependencies)) {
      if (dependency.startsWith('@qinglong/') && !actualNames.has(dependency)) {
        findings.push(
          finding(
            'PACKAGE_BOUNDARY_UNKNOWN_WORKSPACE_DEPENDENCY',
            directory,
            dependency,
          ),
        );
      }
    }
    if (!entry) continue;
    if (
      !Number.isSafeInteger(entry.rootSourceFileHardCap) ||
      entry.rootSourceFileHardCap < 0
    ) {
      findings.push(
        finding(
          'PACKAGE_SOURCE_ROOT_HARD_CAP_INVALID',
          directory,
          'rootSourceFileHardCap must be a non-negative integer',
        ),
      );
    } else if (metrics.rootFiles > entry.rootSourceFileHardCap) {
      findings.push(
        finding(
          'PACKAGE_SOURCE_ROOT_HARD_CAP_EXCEEDED',
          directory,
          `${metrics.rootFiles} root source files exceed cap ${entry.rootSourceFileHardCap}`,
        ),
      );
    }
    if (
      !Number.isSafeInteger(entry.rootSourceLineHardCap) ||
      entry.rootSourceLineHardCap < 0
    ) {
      findings.push(
        finding(
          'PACKAGE_SOURCE_ROOT_LINE_HARD_CAP_INVALID',
          directory,
          'rootSourceLineHardCap must be a non-negative integer',
        ),
      );
    } else if (metrics.rootLines > entry.rootSourceLineHardCap) {
      findings.push(
        finding(
          'PACKAGE_SOURCE_ROOT_LINE_HARD_CAP_EXCEEDED',
          directory,
          `${metrics.rootLines} root source lines exceed cap ${entry.rootSourceLineHardCap}`,
        ),
      );
    }
    const roles = rootSourceRoles(entry.rootSourceFileRoles);
    if (!roles) {
      findings.push(
        finding(
          'PACKAGE_SOURCE_ROOT_ROLES_INVALID',
          directory,
          'rootSourceFileRoles must be a sorted exact file-to-role object',
        ),
      );
    } else {
      const declaredRootFiles = Object.keys(roles);
      if (!sameStrings(declaredRootFiles, metrics.rootFileNames)) {
        findings.push(
          finding(
            'PACKAGE_SOURCE_ROOT_ROLE_DRIFT',
            directory,
            `expected ${JSON.stringify(
              declaredRootFiles,
            )}, found ${JSON.stringify(metrics.rootFileNames)}`,
          ),
        );
      } else {
        const publicTargets = new Set([
          ...stringTargets(manifest.main),
          ...stringTargets(manifest.exports),
        ]);
        const binaryTargets = new Set(stringTargets(manifest.bin));
        for (const [fileName, role] of Object.entries(roles)) {
          const outputTarget = sourceOutputTarget(fileName);
          const roleProven =
            (role === 'public_export' && publicTargets.has(outputTarget)) ||
            (role === 'binary_entry' && binaryTargets.has(outputTarget)) ||
            (role === 'shared_infrastructure' &&
              !publicTargets.has(outputTarget) &&
              !binaryTargets.has(outputTarget) &&
              metrics.nestedFiles > 0);
          if (!roleProven) {
            findings.push(
              finding(
                'PACKAGE_SOURCE_ROOT_ROLE_UNPROVEN',
                directory,
                `${fileName} is not proven as ${role}`,
              ),
            );
          }
          if (
            role === 'public_export' &&
            entry.shallowSourceLayout === undefined &&
            !publicExportIsReexportOnly(
              path.join(root, directory, 'src', fileName),
            )
          ) {
            findings.push(
              finding(
                'PACKAGE_SOURCE_ROOT_PUBLIC_EXPORT_IMPLEMENTATION',
                directory,
                `${fileName} must contain only re-export declarations`,
              ),
            );
          }
        }
        if (
          Object.values(roles).includes('shared_infrastructure') &&
          (typeof entry.rootSourceLayoutRationale !== 'string' ||
            entry.rootSourceLayoutRationale.length < 16)
        ) {
          findings.push(
            finding(
              'PACKAGE_SOURCE_ROOT_INFRASTRUCTURE_UNPROVEN',
              directory,
              'shared infrastructure roots need a concrete layout rationale',
            ),
          );
        }
      }
    }
    if (entry.name !== manifest.name) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_NAME_DRIFT',
          directory,
          `expected ${entry.name}, found ${manifest.name}`,
        ),
      );
    }
    const criteria = sortedUniqueStrings(entry.criteria);
    if (
      !criteria ||
      criteria.length === 0 ||
      criteria.some((criterion) => !ALLOWED_CRITERIA.has(criterion))
    ) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_CRITERIA_INVALID',
          directory,
          'criteria must be sorted, unique and reviewed',
        ),
      );
      continue;
    }
    const declaredConsumers = sortedUniqueStrings(entry.consumers);
    if (!declaredConsumers || !sameStrings(declaredConsumers, consumers)) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_CONSUMER_DRIFT',
          directory,
          `expected ${JSON.stringify(
            declaredConsumers ?? entry.consumers,
          )}, found ${JSON.stringify(consumers)}`,
        ),
      );
    }
    if (
      !Array.isArray(entry.profiles) ||
      entry.profiles.length === 0 ||
      typeof entry.rationale !== 'string' ||
      entry.rationale.length < 16
    ) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_EVIDENCE_INCOMPLETE',
          directory,
          'profiles and a concrete rationale are required',
        ),
      );
    }
    if (metrics.nestedFiles === 0) {
      const shallowLayout = shallowSourceLayout(entry.shallowSourceLayout);
      if (!shallowLayout) {
        findings.push(
          finding(
            'PACKAGE_SOURCE_SHALLOW_LAYOUT_MISSING',
            directory,
            'an all-root package needs one reviewed shallow layout exception',
          ),
        );
      } else if (roles) {
        const roleValues = Object.values(roles);
        const publicEntrypointsProven =
          shallowLayout.kind === 'public_entrypoints' &&
          criteria.includes('deployable') &&
          roleValues.every((role) =>
            ['binary_entry', 'public_export'].includes(role),
          ) &&
          (Boolean(manifest.bin) ||
            (Array.isArray(entry.artifacts) && entry.artifacts.length > 0));
        if (!publicEntrypointsProven) {
          findings.push(
            finding(
              'PACKAGE_SOURCE_SHALLOW_LAYOUT_UNPROVEN',
              directory,
              `${shallowLayout.kind} lacks matching package boundary evidence`,
            ),
          );
        }
        if (!manifest.bin) {
          const artifactNames = sortedUniqueStrings(entry.artifacts);
          const artifactEntrypoints = shallowLayout.artifactEntrypoints;
          const exportSpecifiers =
            manifest.exports &&
            typeof manifest.exports === 'object' &&
            !Array.isArray(manifest.exports)
              ? Object.keys(manifest.exports).sort()
              : [];
          const expectedSpecifiers = artifactEntrypoints
            ? ['.', ...Object.values(artifactEntrypoints)].sort()
            : [];
          const runtimeTargets = exportSpecifiers.map((specifier) =>
            runtimeExportTarget(manifest.exports[specifier]),
          );
          const expectedRuntimeTargets = metrics.rootFileNames
            .map(sourceOutputTarget)
            .sort();
          const artifactEntrypointsProven =
            artifactNames !== undefined &&
            artifactNames.length >= 2 &&
            artifactEntrypoints !== undefined &&
            sameStrings(artifactNames, Object.keys(artifactEntrypoints)) &&
            sameStrings(exportSpecifiers, expectedSpecifiers) &&
            runtimeTargets.every(Boolean) &&
            sameStrings([...runtimeTargets].sort(), expectedRuntimeTargets);
          if (!artifactEntrypointsProven) {
            findings.push(
              finding(
                'PACKAGE_SOURCE_SHALLOW_ARTIFACT_ENTRYPOINTS_UNPROVEN',
                directory,
                'artifact names, export specifiers and root source outputs must map one-to-one',
              ),
            );
          }

          const closureDelta = shallowLayout.closureDelta;
          const comparedManifest = closureDelta
            ? manifestsByName.get(closureDelta.comparedWith)
            : undefined;
          const ownClosure = productionDependencyClosure(
            manifest,
            manifestsByName,
          );
          const comparedClosure = comparedManifest
            ? productionDependencyClosure(comparedManifest, manifestsByName)
            : new Set();
          const dependencyFirewallProven =
            closureDelta !== undefined &&
            consumers.includes(closureDelta.comparedWith) &&
            comparedManifest !== undefined &&
            closureDelta.excludedDependencies.every(
              (dependency) =>
                !ownClosure.has(dependency) && comparedClosure.has(dependency),
            );
          if (!dependencyFirewallProven) {
            findings.push(
              finding(
                'PACKAGE_SOURCE_SHALLOW_DEPENDENCY_FIREWALL_UNPROVEN',
                directory,
                'a direct consumer must prove a non-empty production dependency closure delta',
              ),
            );
          }
        }
      }
    } else if (entry.shallowSourceLayout !== undefined) {
      findings.push(
        finding(
          'PACKAGE_SOURCE_SHALLOW_LAYOUT_STALE',
          directory,
          'a package with nested sources must remove its shallow exception',
        ),
      );
    }
    if (criteria.includes('shared_leaf') && consumers.length < 2) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_SHARED_LEAF_UNPROVEN',
          directory,
          'shared_leaf requires at least two production consumers',
        ),
      );
    }
    if (
      criteria.includes('deployable') &&
      !manifest.bin &&
      (!Array.isArray(entry.artifacts) || entry.artifacts.length === 0)
    ) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_DEPLOYABLE_UNPROVEN',
          directory,
          'deployable requires a bin or reviewed artifact names',
        ),
      );
    }
    if (
      criteria.includes('authority') &&
      (!Array.isArray(entry.authorities) || entry.authorities.length === 0)
    ) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_AUTHORITY_UNPROVEN',
          directory,
          'authority requires at least one explicit authority',
        ),
      );
    }
    if (criteria.includes('dependency_isolation')) {
      const isolated = sortedUniqueStrings(entry.isolatedDependencies);
      if (
        !isolated ||
        isolated.length === 0 ||
        isolated.some(
          (dependency) =>
            dependency.startsWith('@qinglong/') ||
            !Object.prototype.hasOwnProperty.call(dependencies, dependency),
        )
      ) {
        findings.push(
          finding(
            'PACKAGE_BOUNDARY_DEPENDENCY_ISOLATION_UNPROVEN',
            directory,
            'isolatedDependencies must name installed external production dependencies',
          ),
        );
      }
    }
    if (
      criteria.includes('replaceable_adapter') &&
      (typeof entry.adapterContract !== 'string' ||
        entry.adapterContract.length < 16)
    ) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_ADAPTER_UNPROVEN',
          directory,
          'replaceable_adapter requires a concrete adapterContract',
        ),
      );
    }
    if (
      metrics.files <= 2 &&
      !criteria.some((criterion) => THIN_PACKAGE_CRITERIA.has(criterion))
    ) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_THIN_PACKAGE_UNJUSTIFIED',
          directory,
          'one-or-two-source-file package needs deployable, authority or shared_leaf evidence',
        ),
      );
    }
    if (metrics.files === 0) {
      findings.push(
        finding(
          'PACKAGE_BOUNDARY_SOURCE_MISSING',
          directory,
          'workspace package has no TypeScript source',
        ),
      );
    }
  }

  if (sourceLayoutPolicy) {
    for (const review of sourceLayoutPolicy.reviewedDenseDirectories) {
      const actualFiles = directSourceDirectories.get(review.path);
      if (
        actualFiles === undefined ||
        actualFiles < sourceLayoutPolicy.directSourceFileReviewThreshold
      ) {
        findings.push(
          finding(
            'PACKAGE_SOURCE_DENSE_DIRECTORY_REVIEW_STALE',
            review.path.split('/src/')[0],
            `${review.path} no longer reaches review threshold ${sourceLayoutPolicy.directSourceFileReviewThreshold}`,
          ),
        );
      }
    }
  }
  denseSourceDirectories.sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  return Object.freeze({
    schemaVersion: 6,
    compatible: findings.length === 0,
    workspacePackageCount: directories.length,
    workspacePackageHardCap: ledger.workspacePackageHardCap,
    singleSourcePackages: Object.freeze(
      reports
        .filter((report) => report.sourceFiles === 1)
        .map((report) => report.name),
    ),
    shallowSourcePackages: Object.freeze(
      reports
        .filter((report) => report.nestedSourceFiles === 0)
        .map((report) => report.name),
    ),
    denseSourceDirectories: Object.freeze(denseSourceDirectories),
    packages: Object.freeze(reports),
    findings: Object.freeze(findings),
  });
}

if (require.main === module) {
  const report = auditPackageBoundaries();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = Object.freeze({ auditPackageBoundaries });
