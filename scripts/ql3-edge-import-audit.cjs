#!/usr/bin/env node

require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');

const ROOT_FORBIDDEN_PACKAGES = Object.freeze([
  '@qinglong/cluster-control',
  '@qinglong/cluster-postgres',
  '@qinglong/worker-runtime',
  '@types/pg',
  'drizzle-kit',
  'drizzle-orm',
  'pg',
  'pg-native',
]);
const ROOT_DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const IMPORT_TARGETS = Object.freeze([
  '../back/runtime/domain/deploymentProfile',
  '../back/runtime/adapters/legacy/bootstrapDefaultManualPrimaryRuntime',
  '../back/runtime/application/headlessWorkerRuntime',
]);
const FORBIDDEN_IMPORT_PATTERNS = Object.freeze([
  {
    name: 'postgresql migration implementation',
    pattern: /\/back\/migrations\/postgresql\//,
  },
  { name: 'pg', pattern: /\/node_modules\/pg\// },
  { name: 'pg-native', pattern: /\/node_modules\/pg-native\// },
  { name: 'drizzle-orm', pattern: /\/node_modules\/drizzle-orm\// },
  { name: 'drizzle-kit', pattern: /\/node_modules\/drizzle-kit\// },
  {
    name: 'cluster package',
    pattern:
      /\/(?:packages\/ql3-cluster-(?:control|postgres)|node_modules\/@qinglong\/cluster-(?:control|postgres))(?:\/|$)/,
  },
  {
    name: 'worker runtime package',
    pattern:
      /\/(?:packages\/ql3-worker-runtime|node_modules\/@qinglong\/worker-runtime)(?:\/|$)/,
  },
]);

function normalizeModulePath(value) {
  return value.split(path.sep).join('/');
}

function findForbiddenRootDependencies(manifest) {
  const findings = [];
  for (const section of ROOT_DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section] || {};
    for (const packageName of ROOT_FORBIDDEN_PACKAGES) {
      if (Object.prototype.hasOwnProperty.call(dependencies, packageName)) {
        findings.push({ packageName, section });
      }
    }
  }
  return findings;
}

function findForbiddenImports(modulePaths) {
  const findings = [];
  for (const modulePath of modulePaths) {
    for (const forbidden of FORBIDDEN_IMPORT_PATTERNS) {
      if (forbidden.pattern.test(modulePath)) {
        findings.push({ category: forbidden.name, modulePath });
      }
    }
  }
  return findings;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const forbiddenRootDependencies = findForbiddenRootDependencies(manifest);

  process.env.QL_DEPLOYMENT_PROFILE = 'edge';
  const baselineModules = new Set(Object.keys(require.cache));
  for (const target of IMPORT_TARGETS) require(target);
  const importedModules = Object.keys(require.cache)
    .filter((modulePath) => !baselineModules.has(modulePath))
    .map(normalizeModulePath)
    .sort();
  const forbiddenImports = findForbiddenImports(importedModules);
  const report = {
    schemaVersion: 1,
    profile: process.env.QL_DEPLOYMENT_PROFILE,
    importTargets: IMPORT_TARGETS,
    importedModuleCount: importedModules.length,
    forbiddenRootDependencies,
    forbiddenImports,
    compatible:
      forbiddenRootDependencies.length === 0 && forbiddenImports.length === 0,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { findForbiddenImports, findForbiddenRootDependencies };
