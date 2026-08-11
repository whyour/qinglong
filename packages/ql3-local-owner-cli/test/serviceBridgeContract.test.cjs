const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const {
  localServiceManagerIntentDigest,
  normalizeLocalServiceBridgeCommand,
  normalizeLocalServiceManagerIntent,
} = require('../dist/deployment/service-manager/serviceBridgeContract.js');
const {
  LocalDeploymentConfigurationError,
} = require('../dist/deployment/foundation/contract.js');

function intent(overrides = {}) {
  const root = '/opt/qinglong3';
  const actionId = '123e4567-e89b-42d3-a456-426614174001';
  const payload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-service-manager-intent',
    actionId,
    action: 'install-enable-start',
    profile: 'edge',
    instanceId: 'router-edge-1',
    service: {
      kind: 'systemd',
      name: 'qinglong3',
      uid: 1000,
      gid: 1000,
      allowRootService: false,
    },
    deployment: {
      root,
      applicationConfigPath: path.join(root, 'local-application.json'),
      applicationConfigSha256: 'e'.repeat(64),
    },
    descriptor: {
      sourcePath: path.join(root, 'service/qinglong3.service'),
      destinationPath: '/etc/systemd/system/qinglong3.service',
      sha256: 'a'.repeat(64),
      sourceMode: 0o600,
      destinationMode: 0o644,
    },
    lineage: { mode: 'fresh' },
    outcomePath: path.join(
      root,
      'service/service-manager-outcomes',
      `${actionId}.json`,
    ),
    requestedAtMs: 1786416000000,
    ...overrides,
  };
  return { ...payload, intentDigest: localServiceManagerIntentDigest(payload) };
}

test('normalizes exact systemd fresh and OpenRC adopted intents', () => {
  assert.deepEqual(normalizeLocalServiceManagerIntent(intent()), intent());
  const root = '/opt/qinglong3-openrc';
  const actionId = '123e4567-e89b-42d3-a456-426614174002';
  const openrc = intent({
    actionId,
    action: 'restart',
    service: {
      kind: 'openrc',
      name: 'qinglong3',
      uid: 0,
      gid: 0,
      allowRootService: true,
    },
    deployment: {
      root,
      applicationConfigPath: path.join(root, 'local-application.json'),
      applicationConfigSha256: 'f'.repeat(64),
    },
    descriptor: {
      sourcePath: path.join(root, 'service/qinglong3.openrc'),
      destinationPath: '/etc/init.d/qinglong3',
      sha256: 'b'.repeat(64),
      sourceMode: 0o700,
      destinationMode: 0o755,
    },
    lineage: {
      mode: 'adopted',
      cutoverId: 'router-edge-1-cutover',
      generation: 2,
      expectedActivationDigest: 'c'.repeat(64),
      previousRecordDigest: 'd'.repeat(64),
    },
    outcomePath: path.join(
      root,
      'service/service-manager-outcomes',
      `${actionId}.json`,
    ),
  });
  assert.deepEqual(normalizeLocalServiceManagerIntent(openrc), openrc);
});

test('rejects arbitrary destinations, root drift, digest drift and unknown fields', () => {
  for (const candidate of [
    intent({
      descriptor: {
        ...intent().descriptor,
        destinationPath: '/etc/systemd/system/other.service',
      },
    }),
    intent({
      service: { ...intent().service, uid: 0 },
    }),
    { ...intent(), intentDigest: 'f'.repeat(64) },
    { ...intent(), shell: 'systemctl start qinglong3' },
    intent({
      action: 'restart',
      lineage: {
        mode: 'adopted',
        cutoverId: 'router-edge-1-cutover',
        generation: 1,
        expectedActivationDigest: 'c'.repeat(64),
        previousRecordDigest: 'd'.repeat(64),
      },
    }),
    intent({
      action: 'start',
      lineage: {
        mode: 'adopted',
        cutoverId: 'router-edge-1-cutover',
        generation: 2,
        expectedActivationDigest: 'c'.repeat(64),
        previousRecordDigest: 'd'.repeat(64),
      },
    }),
  ]) {
    assert.throws(
      () => normalizeLocalServiceManagerIntent(candidate),
      LocalDeploymentConfigurationError,
    );
  }
});

test('normalizes manager-specific root bridge commands without shell surface', () => {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.execute',
    options: {
      controllerRoot: '/var/lib/qinglong3-service-bridge',
      allowRootController: true,
      manager: { kind: 'systemd', executable: '/usr/bin/systemctl' },
    },
    request: {
      intentPath: '/opt/qinglong3/service/service-manager-intent.json',
      expectedIntentDigest: 'a'.repeat(64),
    },
  };
  assert.deepEqual(normalizeLocalServiceBridgeCommand(command), command);
  assert.deepEqual(
    normalizeLocalServiceBridgeCommand({
      ...command,
      options: {
        ...command.options,
        manager: {
          kind: 'openrc',
          serviceExecutable: '/sbin/rc-service',
          updateExecutable: '/sbin/rc-update',
        },
      },
    }).options.manager,
    {
      kind: 'openrc',
      serviceExecutable: '/sbin/rc-service',
      updateExecutable: '/sbin/rc-update',
    },
  );
  assert.throws(
    () =>
      normalizeLocalServiceBridgeCommand({
        ...command,
        options: {
          ...command.options,
          manager: {
            kind: 'systemd',
            executable: '/usr/bin/systemctl',
            arguments: ['start', 'anything.service'],
          },
        },
      }),
    LocalDeploymentConfigurationError,
  );
});
