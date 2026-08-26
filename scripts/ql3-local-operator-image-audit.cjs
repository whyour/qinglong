#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const IMAGE_DIRECTORY = 'deploy/containers/ql3-local-operator';
const BUILD_NODE_IMAGE =
  'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
const RUNTIME_NODE_IMAGE =
  'node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436';
const BUILD_DEPENDENCIES = Object.freeze({
  'drizzle-orm': '1.0.0-rc.4',
  semver: '7.7.4',
});
const BUILD_DEV_DEPENDENCIES = Object.freeze({
  '@types/node': '24.13.3',
  typescript: '5.9.3',
});
const RUNTIME_DEPENDENCIES = Object.freeze({ semver: '7.7.4' });
const INTERNAL_PACKAGES = Object.freeze([
  'ql3-ai',
  'ql3-local-admin',
  'ql3-local-command-file',
  'ql3-local-owner-cli',
  'ql3-local-owner-console',
  'ql3-local-secret',
  'ql3-local-sqlite',
  'ql3-runtime-core',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sorted(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function finding(findings, code, detail) {
  findings.push(Object.freeze({ code, ...(detail ? { detail } : {}) }));
}

function auditManifest(manifest, release, runtime, findings) {
  if (
    manifest.name !== '@qinglong/local-operator-image' ||
    manifest.version !== release.version ||
    manifest.private !== true ||
    manifest.license !== 'Apache-2.0' ||
    manifest.engines?.node !== release.node.engine
  ) {
    finding(
      findings,
      runtime ? 'RUNTIME_MANIFEST_IDENTITY' : 'BUILD_MANIFEST_IDENTITY',
    );
  }
  if (
    !same(
      sorted(manifest.dependencies),
      sorted(runtime ? RUNTIME_DEPENDENCIES : BUILD_DEPENDENCIES),
    )
  ) {
    finding(
      findings,
      runtime ? 'RUNTIME_DEPENDENCY_DRIFT' : 'BUILD_DEPENDENCY_DRIFT',
    );
  }
  if (
    !same(
      sorted(manifest.devDependencies),
      sorted(runtime ? {} : BUILD_DEV_DEPENDENCIES),
    )
  ) {
    finding(
      findings,
      runtime ? 'RUNTIME_DEV_DEPENDENCY_PRESENT' : 'BUILD_DEV_DEPENDENCY_DRIFT',
    );
  }
}

function auditLock(manifest, lock, runtime, findings) {
  const root = lock.packages?.[''];
  if (
    lock.lockfileVersion !== 3 ||
    lock.requires !== true ||
    root?.name !== manifest.name ||
    root?.version !== manifest.version ||
    !same(sorted(root?.dependencies), sorted(manifest.dependencies)) ||
    !same(sorted(root?.devDependencies), sorted(manifest.devDependencies))
  ) {
    finding(
      findings,
      runtime ? 'RUNTIME_LOCK_ROOT_DRIFT' : 'BUILD_LOCK_ROOT_DRIFT',
    );
  }
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (packagePath === '') continue;
    if (
      typeof entry.version !== 'string' ||
      typeof entry.integrity !== 'string' ||
      !entry.integrity.startsWith('sha512-') ||
      typeof entry.resolved !== 'string' ||
      !entry.resolved.startsWith('https://registry.npmjs.org/') ||
      entry.hasInstallScript === true ||
      entry.link === true
    ) {
      finding(findings, 'LOCKED_PACKAGE_UNSAFE', packagePath);
    }
  }
  if (
    runtime &&
    !same(Object.keys(lock.packages ?? {}).sort(), ['', 'node_modules/semver'])
  ) {
    finding(findings, 'RUNTIME_LOCK_CLOSURE_DRIFT');
  }
}

function auditDockerfile(contents, release, findings) {
  const copies = [
    ...contents.matchAll(/^COPY packages\/(ql3-[a-z-]+) packages\/\1$/gmu),
  ]
    .map((match) => match[1])
    .sort();
  const copiedRuntimePackages = [
    ...contents.matchAll(
      /^COPY --from=workspace \/workspace\/packages\/(ql3-[a-z-]+)\/(?:package\.json|dist) /gmu,
    ),
  ].map((match) => match[1]);
  const counts = Object.fromEntries(INTERNAL_PACKAGES.map((name) => [name, 0]));
  for (const name of copiedRuntimePackages)
    counts[name] = (counts[name] ?? 0) + 1;
  if (!same(copies, [...INTERNAL_PACKAGES].sort())) {
    finding(findings, 'BUILD_PACKAGE_CLOSURE_DRIFT');
  }
  if (
    !same(
      sorted(counts),
      sorted(Object.fromEntries(INTERNAL_PACKAGES.map((name) => [name, 2]))),
    )
  ) {
    finding(findings, 'RUNTIME_INTERNAL_PACKAGE_CLOSURE_DRIFT');
  }
  const required = [
    `FROM ${BUILD_NODE_IMAGE} AS dependency-manifest`,
    `FROM ${RUNTIME_NODE_IMAGE} AS runtime`,
    'RUN npm ci --ignore-scripts --no-audit --no-fund',
    'RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
    `org.opencontainers.image.version="${release.version}"`,
    'io.qinglong.lifecycle="short-lived"',
    'io.qinglong.authority="local-owner-management"',
    'io.qinglong.network="none-by-default"',
    'USER 65532:65532',
    'ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/local-owner-cli/dist/product-cli/cli.js"]',
    'RUN rm -rf node_modules/.bin',
    'find node_modules/@qinglong -type f',
    "-name '*.d.ts' -o -name '*.map'",
  ];
  for (const value of required) {
    if (!contents.includes(value))
      finding(findings, 'DOCKERFILE_CONTRACT_DRIFT', value);
  }
  if (
    /(?:^|\n)\s*ARG\s+NODE_IMAGE\b/u.test(contents) ||
    /\b(?:apt-get|apt|curl|wget)\b|ADD\s+https?:/iu.test(contents) ||
    /^(?:EXPOSE|HEALTHCHECK)\b/gmu.test(contents)
  ) {
    finding(findings, 'UNREVIEWED_RUNTIME_OR_BUILD_SURFACE');
  }
}

function auditWorkflow(contents, findings) {
  const required = [
    'qinglong3-local-operator:ci-${{ matrix.image_arch }}',
    '--file deploy/containers/ql3-local-operator/Dockerfile',
    'pnpm audit:local-operator-image:ql3',
    'scripts/ql3-local-operator-image-inventory.cjs',
    '--image=local-operator',
    'ql3-local-operator.cdx.json',
    'image-ref: qinglong3-local-operator:ci-${{ matrix.image_arch }}',
    '"${OPERATOR_IMAGE}" --version',
    'scripts/ql3-local-alpha-trial-kit-live-contract.cjs',
    'qinglong3-local-trial-kit-${IMAGE_ARCH}.docker.tar',
    "schema: 'qinglong/alpha-local-trial-kit@v1'",
    'operatorImageId',
    "freshOwnerJourney: 'passed'",
  ];
  for (const value of required) {
    if (!contents.includes(value))
      finding(findings, 'LOCAL_OPERATOR_CI_CONTRACT_DRIFT', value);
  }
}

function auditLocalOperatorImageContract(root) {
  const resolvedRoot = path.resolve(root);
  const release = readReleaseIdentity(resolvedRoot);
  const imageRoot = path.join(resolvedRoot, IMAGE_DIRECTORY);
  const buildManifest = readJson(path.join(imageRoot, 'package.json'));
  const runtimeManifest = readJson(
    path.join(imageRoot, 'runtime-dependencies/package.json'),
  );
  const findings = [];
  auditManifest(buildManifest, release, false, findings);
  auditManifest(runtimeManifest, release, true, findings);
  auditLock(
    buildManifest,
    readJson(path.join(imageRoot, 'package-lock.json')),
    false,
    findings,
  );
  auditLock(
    runtimeManifest,
    readJson(path.join(imageRoot, 'runtime-dependencies/package-lock.json')),
    true,
    findings,
  );
  auditDockerfile(
    fs.readFileSync(path.join(imageRoot, 'Dockerfile'), 'utf8'),
    release,
    findings,
  );
  auditWorkflow(
    fs.readFileSync(
      path.join(resolvedRoot, '.github/workflows/ql3-ci.yml'),
      'utf8',
    ),
    findings,
  );
  return Object.freeze({
    schemaVersion: 1,
    image: 'local-operator',
    lifecycle: 'short-lived',
    authority: 'local-owner-management',
    runtimePackages: Object.freeze(
      [
        ...INTERNAL_PACKAGES.map((name) => `@qinglong/${name.slice(4)}`),
        'semver',
      ].sort(),
    ),
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

module.exports = { auditLocalOperatorImageContract };

if (require.main === module) {
  try {
    const report = auditLocalOperatorImageContract(
      path.resolve(__dirname, '..'),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.compatible) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
