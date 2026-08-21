const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  consumeLocalServiceManagerOutcome,
  prepareLocalServiceManagerIntent,
} = require('../dist/deployment/service-manager/serviceManagerIntent.js');
const {
  localServiceManagerObservationDigest,
  localServiceManagerOutcomeDigest,
} = require('../dist/deployment/service-manager/serviceOutcomeContract.js');
const {
  LocalDeploymentConfigurationError,
} = require('../dist/deployment/foundation/contract.js');
const {
  advanceLocalCutoverInstanceHead,
  claimLocalCutoverInstance,
} = require('../dist/deployment/cutover/instanceLineage.js');
const {
  createLocalDataDirectoryApplicationCommit,
} = require('@qinglong/local-sqlite/data-directory-application-commit');

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-service-intent-')),
  );
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const service = path.join(root, 'service');
  fs.mkdirSync(service, { mode: 0o700 });
  const application = `${JSON.stringify(
    {
      schema: 'qinglong/local-application-process@v2',
      instanceId: 'edge-router-1',
      profile: 'edge',
      storage: { mode: 'fresh' },
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(path.join(root, 'local-application.json'), application, {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(service, 'qinglong3.service'),
    '[Service]\nExecStart=/usr/bin/node /opt/qinglong3/app.js\n',
    { mode: 0o600 },
  );
  return { root, service };
}

function prepareCommand(root) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.intent.prepare',
    options: {
      deploymentRoot: root,
      allowRootService: process.getuid() === 0,
    },
    request: {
      actionId: '123e4567-e89b-42d3-a456-426614174011',
      action: 'install-enable-start',
      serviceKind: 'systemd',
      lineage: { mode: 'fresh' },
      requestedAtMs: 1786416000100,
    },
  };
}

function adoptedHead(root) {
  const previousRecordDigest = 'b'.repeat(64);
  const identity = {
    options: { deploymentRoot: root },
    request: {
      cutoverId: 'cutover-edge-router-1',
      profile: 'edge',
      instanceId: 'edge-router-1',
      expectedActivationDigest: 'a'.repeat(64),
      requestedAtMs: 1786416000000,
    },
  };
  claimLocalCutoverInstance(identity, process.getuid(), 'c'.repeat(64));
  advanceLocalCutoverInstanceHead(
    identity,
    process.getuid(),
    'legacy_stopped',
    0,
    previousRecordDigest,
  );
  return { identity, previousRecordDigest };
}

function adoptedApplication(root, identity, previousRecordDigest) {
  const material = {
    schema: 'qinglong/local-application-process@v3',
    instanceId: identity.request.instanceId,
    profile: identity.request.profile,
    storage: {
      mode: 'adopted',
      sourcePath: path.join(root, 'legacy.sqlite'),
      targetPath: path.join(root, 'target.sqlite'),
      recoveryPath: path.join(root, 'recovery.sqlite'),
      manifestPath: path.join(root, 'manifest.json'),
      activationPath: path.join(root, 'activation.json'),
      expectedActivationDigest: identity.request.expectedActivationDigest,
    },
    runtime: {},
    pluginPackages: {},
    ai: { deployment: 'excluded' },
    cutover: {
      cutoverId: identity.request.cutoverId,
      commitmentPath: path.join(root, 'legacy-stopped.json'),
      expectedCommitmentDigest: previousRecordDigest,
    },
  };
  fs.writeFileSync(
    path.join(root, 'local-application.json'),
    `${JSON.stringify(material)}\n`,
    { mode: 0o600 },
  );
}

test('publishes an exact Owner intent and verifies a bound bridge outcome', () => {
  const { root } = fixture();
  const command = prepareCommand(root);
  const prepared = prepareLocalServiceManagerIntent(command);
  assert.equal(prepared.status, 'prepared');
  assert.equal(fs.statSync(prepared.intentPath).mode & 0o777, 0o600);
  assert.equal(prepareLocalServiceManagerIntent(command).status, 'existing');

  const intent = JSON.parse(fs.readFileSync(prepared.intentPath, 'utf8'));
  assert.equal(intent.profile, 'edge');
  assert.equal(intent.instanceId, 'edge-router-1');
  assert.equal(intent.service.uid, process.getuid());
  assert.equal(intent.service.gid, process.getgid());
  assert.match(intent.deployment.applicationConfigSha256, /^[0-9a-f]{64}$/);
  assert.match(intent.descriptor.sha256, /^[0-9a-f]{64}$/);

  const observationPayload = {
    managerKind: 'systemd',
    serviceName: 'qinglong3',
    fragmentPath: '/etc/systemd/system/qinglong3.service',
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    enabledState: 'enabled',
    mainPid: 4123,
    observedAtMs: 1786416000200,
  };
  const observation = {
    ...observationPayload,
    observationDigest: localServiceManagerObservationDigest(observationPayload),
  };
  const outcomePayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-service-manager-outcome',
    actionId: intent.actionId,
    action: intent.action,
    intentDigest: intent.intentDigest,
    descriptorDigest: intent.descriptor.sha256,
    state: 'active',
    mutationDisposition: 'executed',
    manualReason: null,
    observation,
    completedAtMs: 1786416000300,
  };
  const outcome = {
    ...outcomePayload,
    outcomeDigest: localServiceManagerOutcomeDigest(outcomePayload),
  };
  fs.writeFileSync(prepared.outcomePath, `${JSON.stringify(outcome)}\n`, {
    mode: 0o600,
  });

  assert.deepEqual(
    consumeLocalServiceManagerOutcome({
      schemaVersion: 1,
      operation: 'local.deployment.service-manager.outcome.consume',
      options: command.options,
      request: {
        actionId: prepared.actionId,
        expectedIntentDigest: prepared.intentDigest,
      },
    }),
    {
      schemaVersion: 1,
      operation: 'local.deployment.service-manager.outcome.consume',
      status: 'verified',
      actionId: prepared.actionId,
      state: 'active',
      outcomeDigest: outcome.outcomeDigest,
      observationDigest: observation.observationDigest,
    },
  );
});

test('fails closed when current descriptor material drifts after intent publication', () => {
  const { root, service } = fixture();
  const command = prepareCommand(root);
  const prepared = prepareLocalServiceManagerIntent(command);
  fs.writeFileSync(
    path.join(service, 'qinglong3.service'),
    '[Service]\nExecStart=/usr/bin/false\n',
    { mode: 0o600 },
  );
  assert.throws(
    () => prepareLocalServiceManagerIntent(command),
    LocalDeploymentConfigurationError,
  );
  assert.equal(fs.existsSync(prepared.intentPath), true);
});

test('binds an adopted first start to the current legacy-stopped instance head', () => {
  const { root } = fixture();
  const { identity, previousRecordDigest } = adoptedHead(root);
  adoptedApplication(root, identity, previousRecordDigest);
  const command = prepareCommand(root);
  command.request.lineage = {
    mode: 'adopted',
    cutoverId: identity.request.cutoverId,
    generation: 1,
    expectedActivationDigest: identity.request.expectedActivationDigest,
    previousRecordDigest,
  };
  assert.equal(prepareLocalServiceManagerIntent(command).status, 'prepared');

  advanceLocalCutoverInstanceHead(
    identity,
    process.getuid(),
    'target_active',
    1,
    'e'.repeat(64),
  );
  const stale = structuredClone(command);
  stale.request.actionId = '123e4567-e89b-42d3-a456-426614174012';
  assert.throws(
    () => prepareLocalServiceManagerIntent(stale),
    /lost the instance lineage compare-and-swap/,
  );
});

test('rejects v4 legacy data receipt drift before publishing a service intent', () => {
  const { root } = fixture();
  const { identity, previousRecordDigest } = adoptedHead(root);
  adoptedApplication(root, identity, previousRecordDigest);
  const applicationPath = path.join(root, 'local-application.json');
  const application = JSON.parse(fs.readFileSync(applicationPath, 'utf8'));
  const commit = createLocalDataDirectoryApplicationCommit({
    mutationId: '00000000-0000-4000-8000-000000000001',
    projectId: 'project-edge-router-1',
    profile: 'edge',
    sourceStageManifestDigest: '1'.repeat(64),
    transformationDigest: '2'.repeat(64),
    modelDigest: '3'.repeat(64),
    publicationDigest: '4'.repeat(64),
    receiptDigest: '5'.repeat(64),
    committedAtMs: 1786416000001,
    receipt: {
      secretCount: 2,
      environmentSecretCount: 1,
      sshSecretCount: 1,
    },
  });
  const commitPath = path.join(root, 'legacy-data-commit.json');
  fs.writeFileSync(commitPath, `${JSON.stringify(commit)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    applicationPath,
    `${JSON.stringify({
      ...application,
      schema: 'qinglong/local-application-process@v4',
      legacyDataApplication: {
        commitPath,
        expectedCommitDigest: commit.commitDigest,
        expectedReceiptDigest: '0'.repeat(64),
      },
    })}\n`,
    { mode: 0o600 },
  );
  const command = prepareCommand(root);
  command.request.lineage = {
    mode: 'adopted',
    cutoverId: identity.request.cutoverId,
    generation: 1,
    expectedActivationDigest: identity.request.expectedActivationDigest,
    previousRecordDigest,
  };
  assert.throws(
    () => prepareLocalServiceManagerIntent(command),
    /legacy data application commit does not match the application binding/,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        root,
        'service',
        'service-manager-intents',
        `${command.request.actionId}.json`,
      ),
    ),
    false,
  );
});

test('does not allow fresh service intent to bypass an existing cutover head', () => {
  const { root } = fixture();
  adoptedHead(root);
  assert.throws(
    () => prepareLocalServiceManagerIntent(prepareCommand(root)),
    /fresh service intent cannot bypass an instance lineage head/,
  );
});

test('rejects adopted lineage when the application remains a fresh v2 deployment', () => {
  const { root } = fixture();
  const { identity, previousRecordDigest } = adoptedHead(root);
  const command = prepareCommand(root);
  command.request.lineage = {
    mode: 'adopted',
    cutoverId: identity.request.cutoverId,
    generation: 1,
    expectedActivationDigest: identity.request.expectedActivationDigest,
    previousRecordDigest,
  };
  assert.throws(
    () => prepareLocalServiceManagerIntent(command),
    /service intent does not match adopted application binding/,
  );
});
