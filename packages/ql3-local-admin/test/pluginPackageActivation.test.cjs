const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
  PluginPackageActivationConflictError,
  PluginPackageActivationUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-activation');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCreate,
  pluginPackageInstallPlanDigest,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createPluginPackageInstallProposal,
} = require('@qinglong/runtime-core/plugin-package-proposal');
const {
  PluginPackageRecoveryCoordinator,
} = require('@qinglong/runtime-core/plugin-package-recovery');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  LocalSqliteApprovalRequestRepository,
} = require('@qinglong/local-sqlite/approved-action');
const {
  LocalSqliteApprovedActionExecutionRepository,
} = require('@qinglong/local-sqlite/approved-action-execution');
const {
  LocalSqlitePluginPackageInstallProposalRepository,
} = require('@qinglong/local-sqlite/plugin-package-proposal');
const {
  migrateLocalSqliteDatabase,
} = require('@qinglong/local-sqlite/migration');
const {
  LocalPluginPackageActivationPublisher,
  isLocalPluginPackageActivePointerName,
} = require('../dist/plugin-package/pluginPackageActivation');
const {
  createLocalPluginPackageInstallationCoordinator,
} = require('../dist/plugin-package/pluginPackageInstallation');

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-package-active-'));
  const stagingRoot = path.join(root, 'staging');
  const activationRoot = path.join(root, 'activation');
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  fs.mkdirSync(activationRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stagingRoot, activationRoot };
}

function createStage(stagingRoot, overrides = {}) {
  const lockDigest = overrides.lockDigest ?? 'a'.repeat(64);
  const contentDigest = overrides.contentDigest ?? 'b'.repeat(64);
  const material = Buffer.from(overrides.material ?? 'bounded package content');
  const entryPath = 'package.json';
  const blob = `0000-${sha(entryPath)}.blob`;
  const stageDirectory = path.join(stagingRoot, lockDigest);
  const blobDirectory = path.join(stageDirectory, 'blobs');
  fs.mkdirSync(stageDirectory, { mode: 0o700 });
  fs.mkdirSync(blobDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(blobDirectory, blob), material, { mode: 0o600 });
  const receipt = {
    schema: 'qinglong/plugin-package-stage-receipt@v1',
    lockDigest,
    inspection: { lockDigest, contentDigest },
    entries: [
      {
        path: entryPath,
        bytes: material.byteLength,
        digest: sha(material),
        blob,
      },
    ],
  };
  const serialized = `${JSON.stringify(receipt)}\n`;
  fs.writeFileSync(path.join(stageDirectory, 'receipt.json'), serialized, {
    mode: 0o600,
  });
  return {
    lockDigest,
    contentDigest,
    stageDirectory,
    blobPath: path.join(blobDirectory, blob),
    evidenceDigest: sha(serialized),
  };
}

function intent(stage, overrides = {}) {
  const installationId = overrides.installationId ?? 'install-001';
  const targetGeneration = overrides.targetGeneration ?? 1;
  const previousActiveLockDigest = overrides.previousActiveLockDigest ?? null;
  const resourceGeneration = createPluginPackageResourceGeneration({
    installationId,
    projectId: 'default',
    packageName: 'example-monitor',
    lockDigest: stage.lockDigest,
    generation: targetGeneration,
    previousActiveLockDigest,
    contentDigest: stage.contentDigest,
    contents: {
      tasks: ['tasks/example.yaml'],
      workflows: [],
      prompts: [],
      tools: [],
    },
  });
  return Object.freeze({
    schema: PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
    installationId,
    projectId: 'default',
    packageName: 'example-monitor',
    lockDigest: stage.lockDigest,
    targetGeneration,
    previousActiveLockDigest,
    stageRef: `local-stage:${stage.lockDigest}`,
    stageReceiptDigest: overrides.stageReceiptDigest ?? 'c'.repeat(64),
    stageEvidenceDigest: stage.evidenceDigest,
    contentDigest: stage.contentDigest,
    resourceGeneration: overrides.resourceGeneration ?? resourceGeneration,
    intentDigest: overrides.intentDigest ?? 'd'.repeat(64),
  });
}

function activationLockPath(activationRoot, value) {
  const key = createHash('sha256')
    .update('qinglong/plugin-package-active-pointer-key@v1\0', 'utf8')
    .update(value.projectId, 'utf8')
    .update('\0', 'utf8')
    .update(value.packageName, 'utf8')
    .digest('hex');
  return path.join(activationRoot, `.${key}.lock`);
}

function installAction() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'One bounded package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '16Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(manifest, environment);
  return {
    lockId: 'lock-install-001',
    projectId: 'default',
    manifest,
    plan,
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${'a'.repeat(64)}`,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 2048,
      contentDigest: 'b'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
}

function installLock() {
  const action = installAction();
  return createPluginPackageLock({
    ...action,
    approval: {
      requestId: 'approval-install-001',
      requestVersion: 3,
      dispatchId: 'dispatch-install-001',
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(action.plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
}

test('publishes one durable exact pointer and replays without advancing time', async (t) => {
  const directories = harness(t);
  const stage = createStage(directories.stagingRoot);
  let nowCalls = 0;
  const publisher = new LocalPluginPackageActivationPublisher({
    stagingRoot: directories.stagingRoot,
    activationRoot: directories.activationRoot,
    now() {
      nowCalls += 1;
      return 500;
    },
  });
  const value = intent(stage);
  assert.equal(
    await publisher.findActiveResourceGeneration('default', 'example-monitor'),
    null,
  );
  assert.deepEqual(await publisher.inspect(value), {
    status: 'not_published',
  });
  const published = await publisher.publish(value);
  assert.equal(published.intentDigest, value.intentDigest);
  assert.equal(published.generation, 1);
  assert.equal(published.activatedAtMs, 500);
  assert.deepEqual(await publisher.inspect(value), {
    status: 'published',
    receipt: published,
  });
  assert.deepEqual(await publisher.publish(value), published);
  assert.deepEqual(
    await publisher.findActiveResourceGeneration('default', 'example-monitor'),
    value.resourceGeneration,
  );
  await assert.rejects(
    publisher.findActiveResourceGeneration('default', 'Example_Monitor'),
    TypeError,
  );
  assert.equal(nowCalls, 1);
  const files = fs.readdirSync(directories.activationRoot);
  assert.equal(files.length, 1);
  assert.equal(isLocalPluginPackageActivePointerName(files[0]), true);
  assert.equal(
    fs.statSync(path.join(directories.activationRoot, files[0])).mode & 0o777,
    0o600,
  );
});

test('replaces only the exact previous active lock generation', async (t) => {
  const directories = harness(t);
  const firstStage = createStage(directories.stagingRoot);
  const publisher = new LocalPluginPackageActivationPublisher({
    stagingRoot: directories.stagingRoot,
    activationRoot: directories.activationRoot,
    now: () => 500,
  });
  const first = intent(firstStage);
  await publisher.publish(first);

  const secondStage = createStage(directories.stagingRoot, {
    lockDigest: 'e'.repeat(64),
    contentDigest: 'f'.repeat(64),
    material: 'replacement package content',
  });
  const second = intent(secondStage, {
    installationId: 'install-002',
    targetGeneration: 2,
    previousActiveLockDigest: first.lockDigest,
    intentDigest: '1'.repeat(64),
  });
  const secondReceipt = await publisher.publish(second);
  assert.equal(secondReceipt.generation, 2);
  assert.equal((await publisher.inspect(second)).status, 'published');
  assert.deepEqual(
    await publisher.findActiveResourceGeneration('default', 'example-monitor'),
    second.resourceGeneration,
  );

  const stale = intent(
    createStage(directories.stagingRoot, {
      lockDigest: '2'.repeat(64),
      contentDigest: '3'.repeat(64),
      material: 'stale package content',
    }),
    {
      installationId: 'install-003',
      targetGeneration: 3,
      previousActiveLockDigest: first.lockDigest,
      intentDigest: '4'.repeat(64),
    },
  );
  await assert.rejects(
    publisher.publish(stale),
    PluginPackageActivationConflictError,
  );
});

test('never removes a publication lock owned by another publisher', async (t) => {
  const directories = harness(t);
  const stage = createStage(directories.stagingRoot);
  let nowCalls = 0;
  const publisher = new LocalPluginPackageActivationPublisher({
    stagingRoot: directories.stagingRoot,
    activationRoot: directories.activationRoot,
    now() {
      nowCalls += 1;
      return 500;
    },
  });
  const value = intent(stage);
  const lockPath = activationLockPath(directories.activationRoot, value);
  fs.writeFileSync(lockPath, 'another-publisher\n', { mode: 0o600 });

  await assert.rejects(
    publisher.publish(value),
    PluginPackageActivationUnavailableError,
  );
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'another-publisher\n');
  assert.equal(nowCalls, 0);
});

test('fails closed when staged evidence or an active pointer is tampered', async (t) => {
  const directories = harness(t);
  const stage = createStage(directories.stagingRoot);
  const publisher = new LocalPluginPackageActivationPublisher({
    stagingRoot: directories.stagingRoot,
    activationRoot: directories.activationRoot,
    now: () => 500,
  });
  const value = intent(stage);
  fs.writeFileSync(stage.blobPath, 'tampered', { mode: 0o600 });
  await assert.rejects(
    publisher.publish(value),
    PluginPackageActivationConflictError,
  );

  fs.rmSync(stage.stageDirectory, { recursive: true });
  const restored = createStage(directories.stagingRoot);
  const restoredIntent = intent(restored);
  await publisher.publish(restoredIntent);
  const pointer = fs
    .readdirSync(directories.activationRoot)
    .find(isLocalPluginPackageActivePointerName);
  const pointerPath = path.join(directories.activationRoot, pointer);
  const oldPointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  oldPointer.schema = 'qinglong/plugin-package-active-pointer@v1';
  fs.writeFileSync(pointerPath, `${JSON.stringify(oldPointer)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    publisher.inspect(restoredIntent),
    PluginPackageActivationConflictError,
  );
});

test('rejects symlinked roots and keeps authority behind an explicit subpath', (t) => {
  const directories = harness(t);
  const linked = path.join(directories.root, 'linked');
  fs.symlinkSync(directories.stagingRoot, linked);
  assert.throws(
    () =>
      new LocalPluginPackageActivationPublisher({
        stagingRoot: linked,
        activationRoot: directories.activationRoot,
        now: () => 500,
      }),
    TypeError,
  );
  assert.equal(require('..').LocalPluginPackageActivationPublisher, undefined);
  assert.equal(
    require('@qinglong/local-admin/package-activation')
      .LocalPluginPackageActivationPublisher,
    LocalPluginPackageActivationPublisher,
  );
});

test('composes approval, SQLite lock persistence, stage and POSIX activation end to end', async (t) => {
  const admittedAtMs = Date.now();
  const actionInput = installAction();
  const directories = harness(t);
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: 'approval-install-001',
      requestVersion: 3,
      dispatchId: 'dispatch-install-001',
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(actionInput.plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: admittedAtMs - 200,
      expiresAtMs: admittedAtMs + 60_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: admittedAtMs,
  });
  const stage = createStage(directories.stagingRoot, {
    lockDigest: lock.lockDigest,
    contentDigest: lock.source.contentDigest,
  });
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  t.after(() => client.close());
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings"
       ("project_id","subject_type","subject_id","version","state","role",
        "mutation_id","changed_by_type","changed_by_id","created_at_ms")
       VALUES ('default','user','owner-001',1,'active','owner',
               'grant-owner-1','user','owner-001',0)`,
    )
    .run();
  const requester = { type: 'user', id: 'owner-001' };
  const consumer = { type: 'system', id: 'package-dispatcher' };
  const fence = { projectVersion: 1, bindingVersion: 1 };
  const action = {
    permission: 'package.manage',
    actionType: 'plugin_package.install',
    actionRef: 'proposal:example-monitor-v1',
    actionDigest: lock.actionDigest,
    previewDigest: lock.planDigest,
  };
  const proposal = createPluginPackageInstallProposal({
    actionRef: action.actionRef,
    actionInput,
    proposedBy: requester,
    proposalFence: fence,
    createdAtMs: admittedAtMs - 400,
  });
  const audit = (
    eventId,
    requestId,
    operationId,
    subject,
    authenticationId,
    outcome,
    reasons,
    occurredAtMs,
  ) => ({
    eventId,
    requestId,
    operationId,
    projectId: 'default',
    subject,
    authenticationId,
    outcome,
    reasons,
    fence,
    occurredAtMs,
  });
  const approvals = new LocalSqliteApprovalRequestRepository(client);
  await new LocalSqlitePluginPackageInstallProposalRepository(
    client,
  ).createProposal({
    proposal,
    audit: audit(
      '10000000-0000-4000-8000-000000000200',
      action.actionRef,
      'plugin_package.propose',
      requester,
      'auth-owner',
      'allowed',
      ['package_proposal'],
      proposal.createdAtMs,
    ),
  });
  await approvals.create({
    request: createApprovalRequest({
      id: lock.approval.requestId,
      projectId: 'default',
      action,
      risk: 'high',
      decisionMode: 'human_confirmation',
      requestedBy: requester,
      requestedAtMs: admittedAtMs - 300,
      expiresAtMs: lock.approval.expiresAtMs,
      requestFence: fence,
    }),
    audit: audit(
      '10000000-0000-4000-8000-000000000201',
      'http-package-1',
      'approval.request',
      requester,
      'auth-owner',
      'approval_required',
      ['package_review'],
      admittedAtMs - 300,
    ),
  });
  await approvals.decide({
    requestId: lock.approval.requestId,
    expectedVersion: 1,
    decisionId: 'decision-install-001',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: requester,
      authenticationId: 'auth-owner-step-up',
      authenticatedAtMs: admittedAtMs - 250,
      expiresAtMs: lock.approval.expiresAtMs,
      assurance: 'local_console',
    },
    decidedAtMs: lock.approval.approvedAtMs,
    authorizationFence: fence,
    audit: audit(
      '10000000-0000-4000-8000-000000000202',
      'http-package-1',
      'approval.decide',
      requester,
      'auth-owner-step-up',
      'allowed',
      ['role_grant'],
      lock.approval.approvedAtMs,
    ),
  });
  const consumed = await approvals.consume({
    requestId: lock.approval.requestId,
    expectedVersion: 2,
    consumptionId: 'consume-install-001',
    dispatchId: lock.approval.dispatchId,
    action,
    requestedBy: requester,
    consumedBy: consumer,
    consumedAtMs: admittedAtMs - 100,
    authorizationFence: fence,
    audit: audit(
      '10000000-0000-4000-8000-000000000203',
      'dispatch-cycle-1',
      'approval.consume',
      consumer,
      'auth-package-dispatcher',
      'allowed',
      ['role_grant'],
      admittedAtMs - 100,
    ),
  });
  const executions = new LocalSqliteApprovedActionExecutionRepository(client);
  const claimed = await executions.claimExecution({
    dispatchId: consumed.dispatch.id,
    owner: 'package_dispatcher',
    leaseToken: 'lease-install-001',
    nowMs: admittedAtMs - 50,
    leaseDurationMs: 60_000,
  });
  assert.equal(claimed.status, 'claimed');
  const started = await executions.startExecution({
    dispatchId: consumed.dispatch.id,
    approvalRequestId: consumed.dispatch.approvalRequestId,
    actionDigest: consumed.dispatch.action.actionDigest,
    owner: 'package_dispatcher',
    leaseToken: 'lease-install-001',
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: admittedAtMs,
  });
  const repository = new LocalSqlitePluginPackageInstallRepository(client);
  const staged = [];
  const coordinator = createLocalPluginPackageInstallationCoordinator({
    repository,
    publisher: new LocalPluginPackageActivationPublisher({
      stagingRoot: directories.stagingRoot,
      activationRoot: directories.activationRoot,
      now: () => admittedAtMs + 300,
    }),
  });
  const options = {
    lock,
    proposalDigest: proposal.proposalDigest,
    execution: started.execution,
    installationId: 'install-001',
    createMutationId: 'mutation-create',
    createdAtMs: admittedAtMs,
    stageMutationId: 'mutation-stage',
    stagedAtMs: admittedAtMs + 100,
    activationStartedMutationId: 'mutation-activate',
    activationCommittedMutationId: 'mutation-commit',
    activationFailedMutationId: 'mutation-fail',
    activationStartedAtMs: admittedAtMs + 200,
    activationObservedAtMs: admittedAtMs + 301,
    admissionAudit: audit(
      '10000000-0000-4000-8000-000000000204',
      lock.approval.dispatchId,
      'plugin_package.admit',
      consumer,
      'auth-package-dispatcher',
      'allowed',
      ['approved_action'],
      admittedAtMs,
    ),
  };
  const stageProvider = {
    async stage(value) {
      staged.push(value.lockDigest);
      return {
        stageRef: `local-stage:${value.lockDigest}`,
        artifactDigest: value.source.artifactDigest,
        manifestDigest: value.manifestDigest,
        contentDigest: value.source.contentDigest,
        evidenceDigest: stage.evidenceDigest,
      };
    },
  };
  const active = await coordinator.install(options, stageProvider);
  assert.equal(active.state, 'active');
  assert.equal(active.activeLockDigest, lock.lockDigest);
  assert.deepEqual(await repository.findLock(lock.lockDigest), lock);
  assert.equal(
    (await repository.findAdmissionReceipt(lock.approval.dispatchId))
      .lockDigest,
    lock.lockDigest,
  );
  assert.deepEqual(staged, [lock.lockDigest]);

  const replay = await coordinator.install(options, {
    async stage() {
      throw new Error('an active exact replay must not stage again');
    },
  });
  assert.deepEqual(replay, active);
  assert.deepEqual(staged, [lock.lockDigest]);
});

test('recovers a durable queued SQLite install through the POSIX publisher without approval replay', async (t) => {
  const directories = harness(t);
  const lock = installLock();
  const stage = createStage(directories.stagingRoot, {
    lockDigest: lock.lockDigest,
    contentDigest: lock.source.contentDigest,
  });
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  t.after(() => client.close());
  const repository = new LocalSqlitePluginPackageInstallRepository(client);
  const queued = createPluginPackageInstall(lock, {
    installationId: 'recovery-install-001',
    mutationId: 'recovery-create',
    occurredAtMs: 201,
  });
  await repository.create(pluginPackageInstallCreate(lock, queued, null));
  let stageCalls = 0;
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage(value) {
        stageCalls += 1;
        return {
          stageRef: `local-stage:${value.lockDigest}`,
          artifactDigest: value.source.artifactDigest,
          manifestDigest: value.manifestDigest,
          contentDigest: value.source.contentDigest,
          evidenceDigest: stage.evidenceDigest,
        };
      },
    },
    publisher: new LocalPluginPackageActivationPublisher({
      stagingRoot: directories.stagingRoot,
      activationRoot: directories.activationRoot,
      now: () => 500,
    }),
    now: () => 250,
  });

  const cycle = await coordinator.recover({ pageSize: 1, maxPages: 2 });

  assert.equal(cycle.settled, 1);
  assert.equal(cycle.safeToAdmit, true);
  assert.equal(stageCalls, 1);
  const active = await repository.find(lock.projectId, lock.packageName);
  assert.equal(active.state, 'active');
  assert.equal(active.activeLockDigest, lock.lockDigest);
  assert.deepEqual(await repository.listRecoveryPage({ limit: 1 }), {
    records: [],
    truncated: false,
  });
});
