#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const IMAGE_DIRECTORY = 'deploy/containers/ql3-local-application';
const QL3_VERSION = readReleaseIdentity(path.resolve(__dirname, '..')).version;
const BUILD_NODE_IMAGE =
  'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
const RUNTIME_NODE_IMAGE =
  'node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436';
const RUNTIME_OS_PATCH =
  'RUN apk add --no-cache --upgrade \\\n' +
  '    libcrypto3=3.5.8-r0 \\\n' +
  '    libssl3=3.5.8-r0';
const BUILD_DEPENDENCIES = Object.freeze({
  croner: '7.0.8',
  'drizzle-orm': '1.0.0-rc.4',
  semver: '7.7.4',
});
const BUILD_DEV_DEPENDENCIES = Object.freeze({
  '@types/node': '24.13.3',
  typescript: '5.9.3',
});
const RUNTIME_DEPENDENCIES = Object.freeze({
  croner: '7.0.8',
  semver: '7.7.4',
});
const BUILD_PACKAGES = Object.freeze([
  'ql3-ai',
  'ql3-local-admin',
  'ql3-local-api',
  'ql3-local-application',
  'ql3-local-command-file',
  'ql3-local-execution',
  'ql3-local-owner-console',
  'ql3-local-process',
  'ql3-local-secret',
  'ql3-local-sqlite',
  'ql3-runtime-core',
]);
const RUNTIME_PACKAGES = Object.freeze([
  'ql3-local-admin',
  'ql3-local-application',
  'ql3-local-command-file',
  'ql3-local-execution',
  'ql3-local-process',
  'ql3-local-secret',
  'ql3-local-sqlite',
  'ql3-runtime-core',
]);
const CONSOLE_RUNTIME_PACKAGES = Object.freeze(
  [...RUNTIME_PACKAGES, 'ql3-local-api', 'ql3-local-owner-console'].sort(),
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedObject(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function addFinding(findings, code, detail) {
  findings.push(Object.freeze({ code, ...(detail ? { detail } : {}) }));
}

function auditManifest(manifest, runtime, findings) {
  const expectedName = '@qinglong/local-application-image';
  if (
    manifest.name !== expectedName ||
    manifest.version !== QL3_VERSION ||
    manifest.private !== true ||
    manifest.license !== 'Apache-2.0' ||
    manifest.engines?.node !== '>=24.18.0 <25'
  ) {
    addFinding(
      findings,
      runtime ? 'RUNTIME_MANIFEST_IDENTITY' : 'BUILD_MANIFEST_IDENTITY',
    );
  }
  const expectedDependencies = runtime
    ? RUNTIME_DEPENDENCIES
    : BUILD_DEPENDENCIES;
  if (
    !sameJson(
      sortedObject(manifest.dependencies),
      sortedObject(expectedDependencies),
    )
  ) {
    addFinding(
      findings,
      runtime ? 'RUNTIME_DEPENDENCY_DRIFT' : 'BUILD_DEPENDENCY_DRIFT',
    );
  }
  const expectedDevDependencies = runtime ? {} : BUILD_DEV_DEPENDENCIES;
  if (
    !sameJson(
      sortedObject(manifest.devDependencies),
      sortedObject(expectedDevDependencies),
    )
  ) {
    addFinding(
      findings,
      runtime ? 'RUNTIME_DEV_DEPENDENCY_PRESENT' : 'BUILD_DEV_DEPENDENCY_DRIFT',
    );
  }
  for (const section of [
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
  ]) {
    if (manifest[section] !== undefined) {
      addFinding(findings, 'UNREVIEWED_MANIFEST_SECTION', section);
    }
  }
}

function auditLock(manifest, lock, runtime, findings) {
  if (
    lock.lockfileVersion !== 3 ||
    lock.requires !== true ||
    !lock.packages ||
    typeof lock.packages !== 'object'
  ) {
    addFinding(findings, runtime ? 'RUNTIME_LOCK_SHAPE' : 'BUILD_LOCK_SHAPE');
    return;
  }
  const root = lock.packages[''];
  if (
    !root ||
    root.name !== manifest.name ||
    root.version !== manifest.version ||
    root.license !== manifest.license ||
    root.engines?.node !== manifest.engines.node ||
    !sameJson(
      sortedObject(root.dependencies),
      sortedObject(manifest.dependencies),
    ) ||
    !sameJson(
      sortedObject(root.devDependencies),
      sortedObject(manifest.devDependencies),
    )
  ) {
    addFinding(
      findings,
      runtime ? 'RUNTIME_LOCK_ROOT_DRIFT' : 'BUILD_LOCK_ROOT_DRIFT',
    );
  }
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
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
      addFinding(findings, 'LOCKED_PACKAGE_UNSAFE', packagePath);
    }
  }
  if (runtime) {
    const expectedPaths = ['', 'node_modules/croner', 'node_modules/semver'];
    if (!sameJson(Object.keys(lock.packages).sort(), expectedPaths.sort())) {
      addFinding(findings, 'RUNTIME_LOCK_CLOSURE_DRIFT');
    }
  }
}

function captures(contents, pattern) {
  return [...contents.matchAll(pattern)].map((match) => match[1]);
}

function counts(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function dockerStage(contents, name) {
  const marker = new RegExp(`^FROM [^\\n]+ AS ${name}$`, 'm');
  const match = marker.exec(contents);
  if (!match) return '';
  const remaining = contents.slice(match.index + match[0].length);
  const next = /^FROM [^\n]+ AS [a-z0-9-]+$/m.exec(remaining);
  return next ? remaining.slice(0, next.index) : remaining;
}

function auditDockerfile(contents, findings) {
  const escapedBuildNodeImage = BUILD_NODE_IMAGE.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const escapedRuntimeNodeImage = RUNTIME_NODE_IMAGE.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const exactBuildBasePattern = new RegExp(
    `^FROM ${escapedBuildNodeImage} AS dependency-manifest$`,
    'gm',
  );
  const exactRuntimeBasePattern = new RegExp(
    `^FROM ${escapedRuntimeNodeImage} AS runtime-platform$`,
    'gm',
  );
  if (
    [...contents.matchAll(exactBuildBasePattern)].length !== 1 ||
    [...contents.matchAll(exactRuntimeBasePattern)].length !== 1
  ) {
    addFinding(findings, 'BASE_IMAGE_NOT_EXACTLY_PINNED');
  }
  if (/(?:^|\n)\s*ARG\s+NODE_IMAGE\b/.test(contents)) {
    addFinding(findings, 'BASE_IMAGE_OVERRIDE_AUTHORITY');
  }
  if (
    !contents.includes('RUN npm ci --ignore-scripts --no-audit --no-fund') ||
    !contents.includes(
      'RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
    )
  ) {
    addFinding(findings, 'NPM_CI_CONTRACT_DRIFT');
  }
  if (
    !contents.includes(RUNTIME_OS_PATCH) ||
    (contents.match(/\bapk\b/gu) || []).length !== 1
  ) {
    addFinding(findings, 'RUNTIME_OS_PATCH_DRIFT');
  }
  if (/\b(?:apt-get|apt|curl|wget)\b|ADD\s+https?:/i.test(contents)) {
    addFinding(findings, 'UNREVIEWED_BUILD_NETWORK_OR_OS_PACKAGE');
  }
  if (/^(?:EXPOSE|HEALTHCHECK)\b/gm.test(contents)) {
    addFinding(findings, 'UNREVIEWED_RUNTIME_SURFACE');
  }

  const workspaceStage = dockerStage(contents, 'workspace');
  const assembledStage = dockerStage(contents, 'assembled');
  const consoleAssembledStage = dockerStage(contents, 'console-assembled');
  const runtimeStage = dockerStage(contents, 'runtime');
  const consoleRuntimeStage = dockerStage(contents, 'runtime-console');
  const buildCopies = captures(
    workspaceStage,
    /^COPY packages\/(ql3-[a-z-]+) packages\/\1$/gm,
  ).sort();
  if (!sameJson(buildCopies, [...BUILD_PACKAGES].sort())) {
    addFinding(findings, 'BUILD_PACKAGE_CLOSURE_DRIFT');
  }
  const runtimeCopyCounts = counts(
    captures(
      assembledStage,
      /^COPY --from=workspace \/workspace\/packages\/(ql3-[a-z-]+)\/(?:package\.json|dist) /gm,
    ),
  );
  if (
    !sameJson(
      sortedObject(runtimeCopyCounts),
      sortedObject(
        Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, 2])),
      ),
    ) ||
    !assembledStage.includes(
      'COPY --from=workspace /workspace/packages/ql3-local-process/assets \\\n' +
        '  node_modules/@qinglong/local-process/assets',
    ) ||
    !assembledStage.includes(
      'RUN chmod 0555 node_modules/@qinglong/local-process/assets/ql3-launcher.sh',
    )
  ) {
    addFinding(findings, 'RUNTIME_INTERNAL_PACKAGE_CLOSURE_DRIFT');
  }
  const consoleRuntimeCopyCounts = counts(
    captures(
      consoleAssembledStage,
      /^COPY --from=workspace \/workspace\/packages\/(ql3-[a-z-]+)\/(?:package\.json|dist) /gm,
    ),
  );
  if (
    !sameJson(
      sortedObject(consoleRuntimeCopyCounts),
      sortedObject(
        Object.fromEntries(CONSOLE_RUNTIME_PACKAGES.map((name) => [name, 2])),
      ),
    ) ||
    !consoleAssembledStage.includes(
      'COPY --from=workspace /workspace/packages/ql3-local-api/assets \\\n' +
        '  node_modules/@qinglong/local-api/assets',
    ) ||
    !consoleAssembledStage.includes(
      'COPY --from=workspace /workspace/packages/ql3-local-process/assets \\\n' +
        '  node_modules/@qinglong/local-process/assets',
    ) ||
    !consoleAssembledStage.includes(
      'COPY .ql3-panel-dist node_modules/@qinglong/local-api/assets/panel',
    ) ||
    !consoleAssembledStage.includes(
      'RUN chmod 0555 node_modules/@qinglong/local-process/assets/ql3-launcher.sh',
    )
  ) {
    addFinding(findings, 'CONSOLE_RUNTIME_INTERNAL_PACKAGE_CLOSURE_DRIFT');
  }
  if (contents.includes('COPY --from=workspace /workspace/packages/ql3-ai/')) {
    addFinding(findings, 'AI_PRESENT_IN_RUNTIME_STAGE');
  }
  if (
    !contents.includes(
      'RUN rm -rf node_modules/.bin \\\n' +
        '  && node /tmp/ql3-prune-runtime-artifact.cjs node_modules/@qinglong \\\n' +
        '    @qinglong/local-application \\\n' +
        '    @qinglong/local-application/process \\\n' +
        '    @qinglong/local-application/plugin-package-recovery-catalog \\\n' +
        '    --exclude=@qinglong/ai \\\n' +
        '  && rm /tmp/ql3-prune-runtime-artifact.cjs',
    ) ||
    !contents.includes(
      'COPY scripts/ql3-prune-runtime-artifact.cjs /tmp/ql3-prune-runtime-artifact.cjs',
    )
  ) {
    addFinding(findings, 'RUNTIME_NONESSENTIAL_FILES_NOT_REMOVED');
  }
  if (
    !consoleAssembledStage.includes(
      'RUN rm -rf node_modules/.bin \\\n' +
        '  && node /tmp/ql3-prune-runtime-artifact.cjs node_modules/@qinglong \\\n' +
        '    @qinglong/local-api/config \\\n' +
        '    @qinglong/local-api/process \\\n' +
        '    --exclude=@qinglong/ai \\\n' +
        '    --retain-js=local-api/assets/console/console.js \\\n' +
        '  && rm /tmp/ql3-prune-runtime-artifact.cjs',
    )
  ) {
    addFinding(findings, 'CONSOLE_RUNTIME_NONESSENTIAL_FILES_NOT_REMOVED');
  }
  if (
    !runtimeStage.includes('USER 65532:65532') ||
    !runtimeStage.includes(
      'ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js"]',
    ) ||
    !runtimeStage.includes('io.qinglong.ai="excluded"') ||
    !runtimeStage.includes('io.qinglong.profile="edge,standalone"') ||
    !runtimeStage.includes('io.qinglong.local.application-config="2,3,4"') ||
    !runtimeStage.includes('io.qinglong.local.sqlite-contract-min="51"') ||
    !runtimeStage.includes('io.qinglong.local.sqlite-contract-max="52"') ||
    !runtimeStage.includes('io.qinglong.local.sqlite-write-contract="52"') ||
    !runtimeStage.includes('io.qinglong.local.compose-selection="1"')
  ) {
    addFinding(findings, 'RUNTIME_IDENTITY_OR_LABEL_DRIFT');
  }
  if (
    !consoleRuntimeStage.includes('USER 65532:65532') ||
    !consoleRuntimeStage.includes(
      'ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/local-api/dist/cli.js"]',
    ) ||
    !consoleRuntimeStage.includes(
      'org.opencontainers.image.title="QingLong 3.0 Local Console Application"',
    ) ||
    !consoleRuntimeStage.includes(
      'io.qinglong.profile="edge-application-api,standalone-application-api"',
    ) ||
    !consoleRuntimeStage.includes(
      'io.qinglong.local.console="offline-loopback"',
    ) ||
    !consoleRuntimeStage.includes(
      'io.qinglong.local.panel="legacy-capability-gated@v1"',
    ) ||
    !consoleRuntimeStage.includes('io.qinglong.local.panel-max-files="256"') ||
    !consoleRuntimeStage.includes(
      'io.qinglong.local.panel-max-bytes="13631488"',
    ) ||
    !consoleRuntimeStage.includes('io.qinglong.ai="excluded"')
  ) {
    addFinding(findings, 'CONSOLE_RUNTIME_IDENTITY_OR_LABEL_DRIFT');
  }
}

function auditWorkflow(contents, findings) {
  const panelMatch =
    /\n  legacy-panel-compatibility:\n([\s\S]*?)(?=\n  [a-z0-9-]+:\n)/.exec(
      contents,
    );
  if (!panelMatch) {
    addFinding(findings, 'LEGACY_PANEL_ARTIFACT_CI_JOB_MISSING');
  } else {
    const panelJob = panelMatch[1];
    for (const value of [
      "node-version: '20.20.2'",
      'pnpm build:front',
      'scripts/ql3-legacy-panel-bundle.cjs',
      '--source="${GITHUB_WORKSPACE}/static/dist"',
      '--output="${RUNNER_TEMP}/ql3-legacy-panel"',
      'name: ql3-legacy-panel-${{ github.run_id }}-${{ github.run_attempt }}',
      'compression-level: 0',
    ]) {
      if (!panelJob.includes(value)) {
        addFinding(findings, 'LEGACY_PANEL_ARTIFACT_CI_CONTRACT_DRIFT', value);
      }
    }
  }
  const match = /\n  local-image:\n([\s\S]*?)(?=\n  [a-z0-9-]+:\n)/.exec(
    contents,
  );
  if (!match) {
    addFinding(findings, 'LOCAL_IMAGE_CI_JOB_MISSING');
    return;
  }
  const job = match[1];
  const required = [
    'runner: ubuntu-24.04\n            node_arch: x64\n            image_arch: amd64',
    'runner: ubuntu-24.04-arm\n            node_arch: arm64\n            image_arch: arm64',
    'needs: legacy-panel-compatibility',
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    'name: ql3-legacy-panel-${{ github.run_id }}-${{ github.run_attempt }}',
    'path: .ql3-panel-dist',
    'scripts/ql3-legacy-panel-bundle.cjs --audit="${GITHUB_WORKSPACE}/.ql3-panel-dist"',
    'pnpm audit:local-image:ql3',
    'docker build',
    '--file deploy/containers/ql3-local-application/Dockerfile',
    '--target runtime',
    '--target runtime-console',
    'io.qinglong.local.panel',
    'io.qinglong.local.panel-max-files',
    'io.qinglong.local.panel-max-bytes',
    'qinglong3-local-console:ci-${{ matrix.image_arch }}',
    'EXPECTED: ${{ matrix.image_arch }} 65532:65532 2,3,4 51 52 52 1',
    'actual="$(docker image inspect --format \'{{.Architecture}} {{.Config.User}} {{index .Config.Labels "io.qinglong.local.application-config"}} {{index .Config.Labels "io.qinglong.local.sqlite-contract-min"}} {{index .Config.Labels "io.qinglong.local.sqlite-contract-max"}} {{index .Config.Labels "io.qinglong.local.sqlite-write-contract"}} {{index .Config.Labels "io.qinglong.local.compose-selection"}}\' "${IMAGE}")"',
    'io.qinglong.local.application-config',
    'io.qinglong.local.sqlite-contract-min',
    'io.qinglong.local.sqlite-contract-max',
    'io.qinglong.local.sqlite-write-contract',
    'io.qinglong.local.compose-selection',
    '--read-only',
    '--network none',
    '--cap-drop ALL',
    '--security-opt no-new-privileges',
    '--memory=128m',
    '--pids-limit=64',
    'Verify live sparse output and byte quotas in the installed runtime',
    'for capture_image in "${IMAGE}" "${CONSOLE_IMAGE}"; do',
    '--test --test-name-pattern=\'publishes sparse|keeps byte-exact|rejects unsupported\'',
    '/opt/qinglong/node_modules/@qinglong/local-process/test/launcher.test.cjs',
    'scripts/ql3-local-image-inventory.cjs',
    'scripts/ql3-local-console-image-inventory.cjs',
    '--inventory-root=/opt/qinglong/node_modules',
    'node ../../scripts/ql3-build-package-closure.cjs',
    'node scripts/ql3-local-image-live-contract.cjs --image="${IMAGE}" --profile=edge',
    'node scripts/ql3-local-image-live-contract.cjs --image="${IMAGE}" --profile=standalone',
    'node scripts/ql3-local-alpha-trial-kit-live-contract.cjs',
    '--variant=headless',
    '--variant=console',
    '--image=local-console',
    'io.qinglong.local.console',
    '--variant="${TRIAL_VARIANT}"',
    'inputs.local_alpha_variant',
  ];
  for (const value of required) {
    if (!job.includes(value)) {
      addFinding(findings, 'LOCAL_IMAGE_CI_CONTRACT_DRIFT', value);
    }
  }
}

function auditLocalImageContract(root) {
  const imageRoot = path.join(root, IMAGE_DIRECTORY);
  const buildManifest = readJson(path.join(imageRoot, 'package.json'));
  const buildLock = readJson(path.join(imageRoot, 'package-lock.json'));
  const runtimeRoot = path.join(imageRoot, 'runtime-dependencies');
  const runtimeManifest = readJson(path.join(runtimeRoot, 'package.json'));
  const runtimeLock = readJson(path.join(runtimeRoot, 'package-lock.json'));
  const dockerfile = fs.readFileSync(
    path.join(imageRoot, 'Dockerfile'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(root, '.github/workflows/ql3-ci.yml'),
    'utf8',
  );
  const findings = [];

  auditManifest(buildManifest, false, findings);
  auditManifest(runtimeManifest, true, findings);
  auditLock(buildManifest, buildLock, false, findings);
  auditLock(runtimeManifest, runtimeLock, true, findings);
  auditDockerfile(dockerfile, findings);
  auditWorkflow(workflow, findings);

  return Object.freeze({
    schemaVersion: 1,
    image: 'local-application',
    nodeImage: RUNTIME_NODE_IMAGE,
    buildNodeImage: BUILD_NODE_IMAGE,
    runtimePackages: Object.freeze(
      [
        ...RUNTIME_PACKAGES.map((name) => `@qinglong/${name.slice(4)}`),
        ...Object.keys(RUNTIME_DEPENDENCIES),
      ].sort(),
    ),
    consoleRuntimePackages: Object.freeze(
      [
        ...CONSOLE_RUNTIME_PACKAGES.map((name) => `@qinglong/${name.slice(4)}`),
        ...Object.keys(RUNTIME_DEPENDENCIES),
      ].sort(),
    ),
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

module.exports = {
  auditLocalImageContract,
};

if (require.main === module) {
  try {
    const report = auditLocalImageContract(path.resolve(__dirname, '..'));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.compatible) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `QingLong local image audit failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
