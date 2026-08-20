const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  localServiceManagerLegacyStartOutcomeDigest,
  localServiceManagerRollbackObservationDigest,
  normalizeLocalServiceManagerLegacyRollbackBridgeCommand,
  normalizeLocalServiceManagerLegacyStartOutcome,
} = require('../dist/deployment/service-manager/legacy-rollback/contract.js');

function command(kind = 'systemd') {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.execute',
    options: {
      deploymentRoot: '/var/lib/qinglong3',
      controllerRoot: '/var/lib/qinglong3-service-bridge',
      allowRootController: true,
      manager:
        kind === 'systemd'
          ? { kind, executable: '/usr/bin/systemctl' }
          : {
              kind,
              serviceExecutable: '/sbin/rc-service',
              updateExecutable: '/sbin/rc-update',
            },
    },
    request: {
      cutoverId: 'edge-router-cutover',
      generation: 1,
      expectedAuthorizationDigest: '1'.repeat(64),
    },
  };
}

function observation(serviceName, active, observedAtMs) {
  const payload = {
    managerKind: 'systemd',
    serviceName,
    fragmentPath: `/etc/systemd/system/${serviceName}.service`,
    loadState: 'loaded',
    activeState: active ? 'active' : 'inactive',
    subState: active ? 'running' : 'dead',
    enabledState: 'enabled',
    mainPid: active ? 3101 : 0,
    observedAtMs,
  };
  return {
    ...payload,
    observationDigest: localServiceManagerRollbackObservationDigest(payload),
  };
}

function outcome() {
  const payload = {
    schema: 'qinglong3-local-service-manager-legacy-start-outcome',
    schemaVersion: 1,
    state: 'legacy_running',
    cutoverId: 'edge-router-cutover',
    profile: 'edge',
    instanceId: 'edge-router-1',
    generation: 1,
    activationDigest: '2'.repeat(64),
    managerKind: 'systemd',
    preparationDigest: '3'.repeat(64),
    authorizationDigest: '4'.repeat(64),
    barrierDigest: '5'.repeat(64),
    legacyDescriptorDigest: '6'.repeat(64),
    targetDescriptorDigest: '7'.repeat(64),
    mutationDisposition: 'response-loss-inspected',
    manualReason: null,
    legacyObservation: observation('qinglong', true, 100),
    targetObservation: observation('qinglong3', false, 101),
    completedAtMs: 102,
  };
  return {
    ...payload,
    outcomeDigest: localServiceManagerLegacyStartOutcomeDigest(payload),
  };
}

test('normalizes exact systemd and OpenRC legacy rollback bridge commands', () => {
  assert.equal(
    normalizeLocalServiceManagerLegacyRollbackBridgeCommand(command()).options
      .manager.kind,
    'systemd',
  );
  assert.equal(
    normalizeLocalServiceManagerLegacyRollbackBridgeCommand(command('openrc'))
      .options.manager.kind,
    'openrc',
  );
});

test('rejects shell surface, path drift and unbound root acknowledgement', () => {
  assert.throws(
    () =>
      normalizeLocalServiceManagerLegacyRollbackBridgeCommand({
        ...command(),
        shell: 'systemctl start qinglong',
      }),
    /shape is invalid/,
  );
  assert.throws(
    () =>
      normalizeLocalServiceManagerLegacyRollbackBridgeCommand({
        ...command(),
        options: { ...command().options, deploymentRoot: '/var/lib/../tmp' },
      }),
    /supervisor-safe absolute path/,
  );
  assert.throws(
    () =>
      normalizeLocalServiceManagerLegacyRollbackBridgeCommand({
        ...command(),
        options: { ...command().options, allowRootController: false },
      }),
    /command is invalid/,
  );
});

test('binds both service observations and all rollback outcome digests', () => {
  const value = outcome();
  const normalized = normalizeLocalServiceManagerLegacyStartOutcome(value);
  assert.equal(normalized.state, 'legacy_running');
  assert.equal(normalized.legacyObservation.serviceName, 'qinglong');
  assert.equal(normalized.targetObservation.serviceName, 'qinglong3');
  assert.throws(
    () =>
      normalizeLocalServiceManagerLegacyStartOutcome({
        ...value,
        targetDescriptorDigest: '8'.repeat(64),
      }),
    /outcome drifted/,
  );
  assert.throws(
    () =>
      normalizeLocalServiceManagerLegacyStartOutcome({
        ...value,
        legacyObservation: value.targetObservation,
      }),
    /outcome drifted/,
  );
});
