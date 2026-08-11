const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  InvalidPluginPackageInstallError,
  InvalidPluginPackageLockError,
  MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE,
  MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  PluginPackageInstallMutationConflictError,
  PluginPackageInstallTransitionConflictError,
  assertPluginPackageInstallInventoryPageSize,
  assertPluginPackageInstallRecoveryPageSize,
  createPluginPackageInstall,
  createPluginPackageLock,
  normalizePluginPackageInstallRecord,
  normalizePluginPackageInstallInventoryCursor,
  normalizePluginPackageInstallRecoveryCursor,
  normalizePluginPackageInstallCreate,
  normalizePluginPackageLock,
  planPluginPackageInstall,
  pluginPackageInstallActionDigest,
  pluginPackageActivationIntentDigest,
  pluginPackageInstallCommit,
  pluginPackageInstallCreate,
  pluginPackageInstallPlanDigest,
  pluginPackageInstallRecoveryAction,
  transitionPluginPackageInstall,
} = require('../dist');

test('bounds and canonicalizes current installation inventory pages', () => {
  assert.doesNotThrow(() =>
    assertPluginPackageInstallInventoryPageSize(
      MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE,
    ),
  );
  assert.throws(
    () =>
      assertPluginPackageInstallInventoryPageSize(
        MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE + 1,
      ),
    InvalidPluginPackageInstallError,
  );
  const cursor = normalizePluginPackageInstallInventoryCursor({
    packageName: 'example-monitor',
  });
  assert.deepEqual(cursor, { packageName: 'example-monitor' });
  assert.equal(Object.isFrozen(cursor), true);
  assert.throws(
    () =>
      normalizePluginPackageInstallInventoryCursor({
        packageName: '../escape',
      }),
    InvalidPluginPackageInstallError,
  );
  assert.throws(
    () =>
      normalizePluginPackageInstallInventoryCursor({
        packageName: 'example-monitor',
        installationId: 'unexpected',
      }),
    InvalidPluginPackageInstallError,
  );
});

const ARTIFACT_DIGEST = 'a'.repeat(64);
const OCI_MANIFEST_DIGEST = 'f'.repeat(64);
const CONTENT_DIGEST = 'b'.repeat(64);
const PREVIOUS_LOCK_DIGEST = 'c'.repeat(64);

function manifest(overrides = {}) {
  const value = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'Collects one bounded report',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64', 'amd64'],
        deploymentProfiles: ['standalone', 'edge'],
      },
      runtimes: [{ name: 'python', version: '>=3.10.0 <4.0.0' }],
      resources: {
        memory: { recommended: '128Mi' },
        disk: { install: '20Mi', working: '100Mi' },
      },
      permissions: {
        network: { allowedHosts: ['api.example.com'] },
        secrets: [{ name: 'EXAMPLE_TOKEN', required: true }],
        tools: ['notification.send'],
      },
      contents: {
        tasks: ['tasks/collect.yaml'],
        workflows: ['workflows/daily-report.yaml'],
        prompts: ['prompts/analyze-error.md'],
        tools: ['tools/query-data.yaml'],
      },
    },
  };
  return {
    ...value,
    ...overrides,
    metadata: { ...value.metadata, ...overrides.metadata },
    spec: {
      ...value.spec,
      ...overrides.spec,
      compatibility: {
        ...value.spec.compatibility,
        ...overrides.spec?.compatibility,
      },
      resources: {
        ...value.spec.resources,
        ...overrides.spec?.resources,
        memory: {
          ...value.spec.resources.memory,
          ...overrides.spec?.resources?.memory,
        },
        disk: {
          ...value.spec.resources.disk,
          ...overrides.spec?.resources?.disk,
        },
      },
      permissions: {
        ...value.spec.permissions,
        ...overrides.spec?.permissions,
        network: {
          ...value.spec.permissions.network,
          ...overrides.spec?.permissions?.network,
        },
      },
      contents: {
        ...value.spec.contents,
        ...overrides.spec?.contents,
      },
    },
  };
}

function environment(overrides = {}) {
  return {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [{ name: 'python', version: '3.12.4' }],
    availableMemoryBytes: 256 * 1024 * 1024,
    availableDiskBytes: 512 * 1024 * 1024,
    ...overrides,
  };
}

function lockInput(overrides = {}) {
  const candidate = overrides.manifest ?? manifest();
  const previous = overrides.previousManifest;
  const installEnvironment = {
    ...environment(),
    ...overrides.environment,
  };
  const plan =
    overrides.plan ??
    planPluginPackageInstall(candidate, installEnvironment, previous);
  const operation = plan.operation;
  const targetGeneration =
    overrides.targetGeneration ?? (operation === 'install' ? 1 : 2);
  const previousLockDigest =
    overrides.previousLockDigest ??
    (operation === 'install' ? undefined : PREVIOUS_LOCK_DIGEST);
  const source = {
    kind: 'oci',
    locator: `oci://registry.example.com/qinglong/example-monitor@sha256:${OCI_MANIFEST_DIGEST}`,
    artifactDigest: ARTIFACT_DIGEST,
    artifactBytes: 1024,
    contentDigest: CONTENT_DIGEST,
    ...overrides.source,
  };
  const actionInput = {
    lockId: overrides.lockId ?? 'lock-001',
    projectId: overrides.projectId ?? 'project-001',
    manifest: candidate,
    plan,
    environment: installEnvironment,
    ...(previous === undefined ? {} : { previousManifest: previous }),
    source,
    architecture: overrides.architecture ?? 'arm64',
    deploymentProfile: overrides.deploymentProfile ?? 'edge',
    targetGeneration,
    ...(previousLockDigest === undefined ? {} : { previousLockDigest }),
  };
  const actionDigest = pluginPackageInstallActionDigest(actionInput);
  const previewDigest = pluginPackageInstallPlanDigest(plan);
  return {
    ...actionInput,
    approval: {
      requestId: 'approval-001',
      requestVersion: 2,
      dispatchId: 'dispatch-001',
      actionDigest,
      previewDigest,
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 1_000,
      fence: { projectVersion: 3, bindingVersion: 4 },
      ...overrides.approval,
    },
    createdAtMs: overrides.createdAtMs ?? 200,
  };
}

function installFixture(lockOverrides = {}) {
  const lock = createPluginPackageLock(lockInput(lockOverrides));
  const install = createPluginPackageInstall(lock, {
    installationId: 'install-001',
    mutationId: 'mutation-create',
    occurredAtMs: 201,
  });
  return { lock, install };
}

function stageEvent(lock, overrides = {}) {
  return {
    type: 'stage_completed',
    mutationId: 'mutation-stage',
    occurredAtMs: 202,
    stageRef: 'stage-001',
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'e'.repeat(64),
    ...overrides,
  };
}

test('creates one immutable OCI PackageLock bound to plan and approval', () => {
  const input = lockInput();
  const lock = createPluginPackageLock(input);
  assert.equal(lock.schema, 'qinglong/plugin-package-lock@v2');
  assert.equal(lock.operation, 'install');
  assert.equal(lock.targetGeneration, 1);
  assert.equal(lock.approval.actionDigest, lock.actionDigest);
  assert.equal(lock.approval.previewDigest, lock.planDigest);
  assert.match(lock.environmentDigest, /^[0-9a-f]{64}$/);
  assert.match(lock.lockDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(lock), true);
  assert.equal(Object.isFrozen(lock.source), true);
  assert.deepEqual(lock.resources, [
    { kind: 'prompt', path: 'prompts/analyze-error.md' },
    { kind: 'task', path: 'tasks/collect.yaml' },
    { kind: 'tool', path: 'tools/query-data.yaml' },
    { kind: 'workflow', path: 'workflows/daily-report.yaml' },
  ]);
  assert.equal(
    lock.source.locator,
    `oci://registry.example.com/qinglong/example-monitor@sha256:${OCI_MANIFEST_DIGEST}`,
  );
  assert.notEqual(OCI_MANIFEST_DIGEST, lock.source.artifactDigest);
  assert.deepEqual(normalizePluginPackageLock(lock), lock);
  assert.throws(
    () =>
      normalizePluginPackageLock({
        ...lock,
        schema: 'qinglong/plugin-package-lock@v1',
      }),
    /lock vocabulary is invalid/,
  );
});

test('accepts content-addressed offline bundles without persisting a host path', () => {
  const input = lockInput({
    source: {
      kind: 'offline',
      locator: `offline:sha256:${ARTIFACT_DIGEST}`,
    },
  });
  const lock = createPluginPackageLock(input);
  assert.equal(lock.source.kind, 'offline');
  assert.equal(lock.source.locator, `offline:sha256:${ARTIFACT_DIGEST}`);
  assert.equal(lock.source.locator.includes('/'), false);
});

test('rejects mutable sources and offline source digest mismatches', () => {
  assert.throws(
    () =>
      lockInput({
        source: {
          locator: 'oci://registry.example.com/qinglong/example-monitor:latest',
        },
      }),
    InvalidPluginPackageLockError,
  );
  assert.throws(
    () =>
      lockInput({
        source: {
          kind: 'offline',
          locator: `oci://registry.example.com/qinglong/example-monitor@sha256:${'d'.repeat(
            64,
          )}`,
        },
      }),
    /source locator is not immutable/,
  );
  assert.throws(
    () =>
      lockInput({
        source: {
          kind: 'offline',
          locator: `offline:sha256:${'d'.repeat(64)}`,
        },
      }),
    /offline source locator does not match its artifact digest/,
  );
  for (const locator of [
    `oci://registry..example.com/qinglong/example-monitor@sha256:${ARTIFACT_DIGEST}`,
    `oci://registry.example.com:99999/qinglong/example-monitor@sha256:${ARTIFACT_DIGEST}`,
  ]) {
    assert.throws(
      () => lockInput({ source: { locator } }),
      InvalidPluginPackageLockError,
    );
  }
});

test('rejects expired or digest-detached approval bindings', () => {
  const detached = lockInput();
  detached.approval.actionDigest = 'd'.repeat(64);
  assert.throws(
    () => createPluginPackageLock(detached),
    /approval is not bound/,
  );

  const expired = lockInput();
  expired.approval.expiresAtMs = expired.createdAtMs;
  assert.throws(() => createPluginPackageLock(expired), /is not active/);

  const automated = lockInput();
  automated.approval.approvedBy = { type: 'agent', id: 'agent-001' };
  assert.throws(
    () => createPluginPackageLock(automated),
    /requires a human approval/,
  );
});

test('recomputes the approved plan from the exact environment and previous manifest', () => {
  const candidate = manifest();
  const reviewed = planPluginPackageInstall(candidate, environment());
  assert.throws(
    () => lockInput({ plan: { ...reviewed, risk: 'low' } }),
    /manifest, environment or previous manifest does not match/,
  );
  assert.throws(
    () => lockInput({ architecture: 'amd64' }),
    /does not match the install environment/,
  );
});

test('requires a previous immutable lock for upgrade and rollback generations', () => {
  const previous = manifest({ metadata: { version: '1.1.0' } });
  const upgrade = createPluginPackageLock(
    lockInput({ previousManifest: previous }),
  );
  assert.equal(upgrade.operation, 'upgrade');
  assert.equal(upgrade.targetGeneration, 2);
  assert.equal(upgrade.previousLockDigest, PREVIOUS_LOCK_DIGEST);

  const rollbackManifest = manifest({ metadata: { version: '1.1.0' } });
  const rollback = createPluginPackageLock(
    lockInput({
      manifest: rollbackManifest,
      previousManifest: manifest(),
    }),
  );
  assert.equal(rollback.operation, 'rollback');
  assert.equal(rollback.previousLockDigest, PREVIOUS_LOCK_DIGEST);

  assert.throws(
    () =>
      createPluginPackageLock(
        lockInput({
          previousManifest: previous,
          previousLockDigest: undefined,
          targetGeneration: 1,
        }),
      ),
    /operation does not match/,
  );
});

test('creates a queued durable record while preserving the previous active lock', () => {
  const previous = manifest({ metadata: { version: '1.1.0' } });
  const { install } = installFixture({ previousManifest: previous });
  assert.equal(install.state, 'queued');
  assert.equal(install.version, 1);
  assert.equal(install.previousActiveLockDigest, PREVIOUS_LOCK_DIGEST);
  assert.equal(install.activeLockDigest, PREVIOUS_LOCK_DIGEST);
  assert.equal(pluginPackageInstallRecoveryAction(install), 'resume_stage');
  assert.match(install.recordDigest, /^[0-9a-f]{64}$/);
});

test('builds an exact first-create envelope and fences replacement heads', () => {
  const { lock, install } = installFixture();
  const initial = pluginPackageInstallCreate(lock, install, null);
  assert.deepEqual(initial, {
    installationId: install.installationId,
    mutationId: install.lastMutationId,
    mutationDigest: initial.mutationDigest,
    expectedHead: null,
    lock,
    record: install,
  });
  assert.match(initial.mutationDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(initial.mutationDigest, install.lastMutationDigest);
  assert.equal(Object.isFrozen(initial), true);

  const failed = transitionPluginPackageInstall(lock, install, {
    type: 'failed',
    mutationId: 'mutation-fail',
    occurredAtMs: 202,
    reason: 'stage_failed',
  });
  const replacementLock = createPluginPackageLock(
    lockInput({ lockId: 'lock-002' }),
  );
  const replacement = createPluginPackageInstall(replacementLock, {
    installationId: 'install-002',
    mutationId: 'mutation-retry',
    occurredAtMs: 203,
  });
  const retry = pluginPackageInstallCreate(
    replacementLock,
    replacement,
    failed,
  );
  assert.deepEqual(retry.expectedHead, {
    installationId: failed.installationId,
    version: failed.version,
    recordDigest: failed.recordDigest,
  });
  assert.throws(
    () => pluginPackageInstallCreate(replacementLock, replacement, install),
    PluginPackageInstallTransitionConflictError,
  );
  assert.throws(
    () =>
      pluginPackageInstallCreate(
        replacementLock,
        { ...replacement, lastMutationDigest: 'f'.repeat(64) },
        failed,
      ),
    InvalidPluginPackageInstallError,
  );
  assert.throws(
    () =>
      normalizePluginPackageInstallCreate({
        ...initial,
        expectedHead: retry.expectedHead,
      }),
    InvalidPluginPackageInstallError,
  );
});

test('records exact staging evidence before activation can begin', () => {
  const { lock, install } = installFixture();
  const staged = transitionPluginPackageInstall(
    lock,
    install,
    stageEvent(lock),
  );
  assert.equal(staged.state, 'staged');
  assert.equal(staged.version, 2);
  assert.equal(staged.activeLockDigest, null);
  assert.equal(staged.stageReceipt.contentDigest, CONTENT_DIGEST);
  assert.match(staged.stageReceipt.receiptDigest, /^[0-9a-f]{64}$/);
  assert.equal(pluginPackageInstallRecoveryAction(staged), 'resume_activation');
});

test('rejects staging evidence detached from the immutable lock', () => {
  const { lock, install } = installFixture();
  assert.throws(
    () =>
      transitionPluginPackageInstall(
        lock,
        install,
        stageEvent(lock, { contentDigest: 'd'.repeat(64) }),
      ),
    PluginPackageInstallTransitionConflictError,
  );
});

test('keeps the previous active lock through activating and swaps only on commit', () => {
  const previous = manifest({ metadata: { version: '1.1.0' } });
  const { lock, install } = installFixture({ previousManifest: previous });
  const staged = transitionPluginPackageInstall(
    lock,
    install,
    stageEvent(lock),
  );
  const activating = transitionPluginPackageInstall(lock, staged, {
    type: 'activation_started',
    mutationId: 'mutation-activate',
    occurredAtMs: 203,
  });
  assert.equal(activating.state, 'activating');
  assert.equal(activating.activeLockDigest, PREVIOUS_LOCK_DIGEST);
  assert.equal(
    pluginPackageInstallRecoveryAction(activating),
    'inspect_activation',
  );

  const active = transitionPluginPackageInstall(lock, activating, {
    type: 'activation_committed',
    mutationId: 'mutation-commit',
    occurredAtMs: 204,
    activationRef: 'activation-generation-2',
    intentDigest: pluginPackageActivationIntentDigest(lock, activating),
    generation: 2,
    contentDigest: CONTENT_DIGEST,
  });
  assert.equal(active.state, 'active');
  assert.equal(active.activeLockDigest, lock.lockDigest);
  assert.equal(active.activationReceipt.generation, 2);
  assert.equal(pluginPackageInstallRecoveryAction(active), 'none');
});

test('fails closed without replacing the prior active generation', () => {
  const previous = manifest({ metadata: { version: '1.1.0' } });
  const { lock, install } = installFixture({ previousManifest: previous });
  const staged = transitionPluginPackageInstall(
    lock,
    install,
    stageEvent(lock),
  );
  const failed = transitionPluginPackageInstall(lock, staged, {
    type: 'failed',
    mutationId: 'mutation-fail',
    occurredAtMs: 203,
    reason: 'activation_failed',
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.activeLockDigest, PREVIOUS_LOCK_DIGEST);
  assert.equal(failed.failure.failedFrom, 'staged');
  assert.equal(pluginPackageInstallRecoveryAction(failed), 'none');
});

test('makes the last mutation replay idempotent and rejects mutation reuse', () => {
  const { lock, install } = installFixture();
  const event = stageEvent(lock);
  const staged = transitionPluginPackageInstall(lock, install, event);
  assert.deepEqual(transitionPluginPackageInstall(lock, staged, event), staged);
  assert.throws(
    () =>
      transitionPluginPackageInstall(lock, staged, {
        ...event,
        stageRef: 'different-stage',
      }),
    PluginPackageInstallMutationConflictError,
  );
});

test('rejects illegal transitions, time reversal and tampered durable records', () => {
  const { lock, install } = installFixture();
  assert.throws(
    () =>
      transitionPluginPackageInstall(lock, install, {
        type: 'activation_started',
        mutationId: 'mutation-skip-stage',
        occurredAtMs: 202,
      }),
    PluginPackageInstallTransitionConflictError,
  );
  assert.throws(
    () =>
      transitionPluginPackageInstall(
        lock,
        install,
        stageEvent(lock, { occurredAtMs: 199 }),
      ),
    PluginPackageInstallTransitionConflictError,
  );
  assert.throws(
    () =>
      normalizePluginPackageInstallRecord({
        ...install,
        activeLockDigest: lock.lockDigest,
      }),
    InvalidPluginPackageInstallError,
  );
});

test('builds an exact CAS commit envelope for durable adapters', () => {
  const { lock, install } = installFixture();
  const staged = transitionPluginPackageInstall(
    lock,
    install,
    stageEvent(lock),
  );
  const commit = pluginPackageInstallCommit(install, staged);
  assert.deepEqual(commit, {
    installationId: 'install-001',
    expectedVersion: 1,
    expectedRecordDigest: install.recordDigest,
    mutationId: 'mutation-stage',
    mutationDigest: staged.lastMutationDigest,
    record: staged,
  });
  assert.equal(Object.isFrozen(commit), true);

  const otherLock = createPluginPackageLock(
    lockInput({ projectId: 'different-project' }),
  );
  const otherInstall = createPluginPackageInstall(otherLock, {
    installationId: 'install-001',
    mutationId: 'mutation-create',
    occurredAtMs: 201,
  });
  const otherStaged = transitionPluginPackageInstall(
    otherLock,
    otherInstall,
    stageEvent(otherLock),
  );
  assert.throws(
    () => pluginPackageInstallCommit(install, otherStaged),
    PluginPackageInstallTransitionConflictError,
  );
});

test('bounds recovery scans and publishes root plus dedicated subpath', () => {
  assert.doesNotThrow(() =>
    assertPluginPackageInstallRecoveryPageSize(
      MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
    ),
  );
  assert.throws(
    () =>
      assertPluginPackageInstallRecoveryPageSize(
        MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE + 1,
      ),
    InvalidPluginPackageInstallError,
  );
  assert.deepEqual(
    normalizePluginPackageInstallRecoveryCursor({
      packageName: 'example-monitor',
      installationId: 'install-001',
    }),
    {
      packageName: 'example-monitor',
      installationId: 'install-001',
    },
  );
  assert.throws(
    () =>
      normalizePluginPackageInstallRecoveryCursor({
        packageName: 'example-monitor',
        installationId: '../escape',
      }),
    InvalidPluginPackageInstallError,
  );
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/plugin-package-install');
  assert.equal(
    subpath.transitionPluginPackageInstall,
    root.transitionPluginPackageInstall,
  );
  assert.equal(subpath.createPluginPackageLock, createPluginPackageLock);

  const source = readFileSync(
    join(
      __dirname,
      '../src/plugin-package/installation/pluginPackageInstall.ts',
    ),
    'utf8',
  );
  for (const forbidden of [
    "from 'node:child_process'",
    "from 'node:fs'",
    "from 'node:http'",
    "from 'node:https'",
    "from 'node:net'",
    "from 'node:timers'",
    'setInterval(',
    'setTimeout(',
    'fetch(',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
