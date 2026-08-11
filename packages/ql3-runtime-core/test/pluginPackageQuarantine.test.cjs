const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  InvalidPluginPackageQuarantineError,
  MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS,
  assertPluginPackageWithdrawalMatchesEvent,
  createPluginPackageQuarantineEvent,
  createPluginPackageWithdrawalReceipt,
  normalizePluginPackageQuarantineEvent,
  normalizePluginPackageWithdrawalReceipt,
  pluginPackageQuarantineMutationId,
  pluginPackageQuarantineTaskMutationId,
} = require('../dist/plugin-package/lifecycle/pluginPackageQuarantine');

const digest = (value) => value.repeat(64);

function target(state = 'active') {
  return {
    projectId: 'default',
    packageName: 'example-monitor',
    installationId: 'install-example-v1',
    lockDigest: digest('a'),
    installState: state,
    installVersion: 4,
    installRecordDigest: digest('b'),
    activeLockDigest: state === 'active' ? digest('a') : digest('c'),
  };
}

function eventInput(overrides = {}) {
  return {
    mutationId: 'quarantine-example-v1',
    revocationReceiptDigest: digest('d'),
    impactDigest: digest('e'),
    target: target(),
    proposer: { type: 'user', id: 'owner-a' },
    confirmer: { type: 'user', id: 'owner-b' },
    authorizationMode: 'dual_control',
    reasonCode: 'confirmed_key_compromise',
    occurredAtMs: 100,
    ...overrides,
  };
}

function activeCapability(overrides = {}) {
  return {
    status: 'withdrawn',
    taskWithdrawals: [
      {
        taskId: 'collect',
        previousRevision: 2,
        disabledRevision: 3,
        previousContentDigest: digest('f'),
        disabledContentDigest: digest('1'),
      },
      {
        taskId: 'report',
        previousRevision: 7,
        disabledRevision: 8,
        previousContentDigest: digest('2'),
        disabledContentDigest: digest('3'),
      },
    ],
    previousActiveVectorDigest: digest('4'),
    currentActiveVectorDigest: digest('5'),
    currentToolSnapshotDigest: digest('6'),
    retainedSourceCount: 2,
    ...overrides,
  };
}

test('binds dual-control quarantine to one exact active capability withdrawal', () => {
  const event = createPluginPackageQuarantineEvent(eventInput());
  const reordered = createPluginPackageQuarantineEvent({
    ...eventInput(),
    target: {
      activeLockDigest: digest('a'),
      installRecordDigest: digest('b'),
      installVersion: 4,
      installState: 'active',
      lockDigest: digest('a'),
      installationId: 'install-example-v1',
      packageName: 'example-monitor',
      projectId: 'default',
    },
  });
  assert.equal(reordered.eventDigest, event.eventDigest);
  const receipt = createPluginPackageWithdrawalReceipt({
    eventDigest: event.eventDigest,
    target: event.target,
    capability: activeCapability(),
    committedAtMs: 101,
  });
  assert.deepEqual(normalizePluginPackageQuarantineEvent(event), event);
  assert.deepEqual(normalizePluginPackageWithdrawalReceipt(receipt), receipt);
  assert.doesNotThrow(() =>
    assertPluginPackageWithdrawalMatchesEvent(event, receipt),
  );
  assert.equal(receipt.capability.taskWithdrawals.length, 2);
  assert.notEqual(
    receipt.capability.previousActiveVectorDigest,
    receipt.capability.currentActiveVectorDigest,
  );
});

test('publishes quarantine only through its explicit subpath', () => {
  const root = require('../dist');
  assert.equal(root.createPluginPackageQuarantineEvent, undefined);
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../package.json'), 'utf8'),
  );
  assert.deepEqual(manifest.exports['./plugin-package-quarantine'], {
    types: './dist/plugin-package/lifecycle/pluginPackageQuarantine.d.ts',
    require: './dist/plugin-package/lifecycle/pluginPackageQuarantine.js',
    default: './dist/plugin-package/lifecycle/pluginPackageQuarantine.js',
  });
});

test('requires distinct subjects for dual-control and permits explicit break-glass', () => {
  assert.throws(
    () =>
      createPluginPackageQuarantineEvent(
        eventInput({
          confirmer: { type: 'user', id: 'owner-a' },
        }),
      ),
    /distinct subjects/,
  );
  const event = createPluginPackageQuarantineEvent(
    eventInput({
      confirmer: { type: 'user', id: 'owner-a' },
      authorizationMode: 'break_glass',
      reasonCode: 'suspected_key_compromise',
    }),
  );
  assert.equal(event.authorizationMode, 'break_glass');
});

test('records non-active locks without inventing Task or Tool withdrawal', () => {
  for (const state of ['queued', 'staged', 'activating']) {
    const event = createPluginPackageQuarantineEvent(
      eventInput({ target: target(state) }),
    );
    const receipt = createPluginPackageWithdrawalReceipt({
      eventDigest: event.eventDigest,
      target: event.target,
      capability: {
        status: 'not_active',
        taskWithdrawals: [],
        previousActiveVectorDigest: null,
        currentActiveVectorDigest: null,
        currentToolSnapshotDigest: null,
        retainedSourceCount: 0,
      },
      committedAtMs: 101,
    });
    assert.doesNotThrow(() =>
      assertPluginPackageWithdrawalMatchesEvent(event, receipt),
    );
  }
  const activeEvent = createPluginPackageQuarantineEvent(eventInput());
  assert.throws(
    () =>
      createPluginPackageWithdrawalReceipt({
        eventDigest: activeEvent.eventDigest,
        target: activeEvent.target,
        capability: {
          status: 'not_active',
          taskWithdrawals: [],
          previousActiveVectorDigest: null,
          currentActiveVectorDigest: null,
          currentToolSnapshotDigest: null,
          retainedSourceCount: 0,
        },
        committedAtMs: 101,
      }),
    /inconsistent/,
  );
});

test('fails closed on tampering, unsorted tasks and reviewed bounds', () => {
  const event = createPluginPackageQuarantineEvent(eventInput());
  assert.throws(
    () =>
      normalizePluginPackageQuarantineEvent({
        ...event,
        impactDigest: digest('9'),
      }),
    /eventDigest/,
  );
  assert.throws(
    () =>
      createPluginPackageWithdrawalReceipt({
        eventDigest: event.eventDigest,
        target: event.target,
        capability: activeCapability({
          taskWithdrawals: [...activeCapability().taskWithdrawals].reverse(),
        }),
        committedAtMs: 101,
      }),
    /unique and sorted/,
  );
  assert.throws(
    () =>
      createPluginPackageWithdrawalReceipt({
        eventDigest: event.eventDigest,
        target: event.target,
        capability: activeCapability({
          taskWithdrawals: Array.from(
            {
              length: MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS + 1,
            },
            (_, index) => ({
              taskId: `task-${index.toString().padStart(3, '0')}`,
              previousRevision: 1,
              disabledRevision: 2,
              previousContentDigest: digest('7'),
              disabledContentDigest: digest('8'),
            }),
          ),
        }),
        committedAtMs: 101,
      }),
    /disposition is invalid/,
  );
  const receipt = createPluginPackageWithdrawalReceipt({
    eventDigest: event.eventDigest,
    target: event.target,
    capability: activeCapability(),
    committedAtMs: 101,
  });
  assert.throws(
    () =>
      normalizePluginPackageWithdrawalReceipt({
        ...receipt,
        committedAtMs: 102,
      }),
    /receiptDigest/,
  );
  assert.throws(
    () =>
      assertPluginPackageWithdrawalMatchesEvent(
        event,
        createPluginPackageWithdrawalReceipt({
          eventDigest: event.eventDigest,
          target: { ...event.target, installVersion: 5 },
          capability: activeCapability(),
          committedAtMs: 101,
        }),
      ),
    InvalidPluginPackageQuarantineError,
  );
});

test('derives stable distinct UUID task mutation identities from quarantine evidence', () => {
  const event = createPluginPackageQuarantineEvent(eventInput());
  const collect = pluginPackageQuarantineTaskMutationId(
    event.eventDigest,
    'collect',
  );
  assert.match(
    collect,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    collect,
    pluginPackageQuarantineTaskMutationId(event.eventDigest, 'collect'),
  );
  assert.notEqual(
    collect,
    pluginPackageQuarantineTaskMutationId(event.eventDigest, 'report'),
  );
  assert.match(
    pluginPackageQuarantineMutationId(
      event.revocationReceiptDigest,
      event.target,
    ),
    /^quarantine:[0-9a-f]{64}$/,
  );
  assert.equal(
    pluginPackageQuarantineMutationId(
      event.revocationReceiptDigest,
      event.target,
    ),
    pluginPackageQuarantineMutationId(
      event.revocationReceiptDigest,
      event.target,
    ),
  );
});
