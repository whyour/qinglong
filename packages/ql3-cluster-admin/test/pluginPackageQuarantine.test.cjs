const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackageQuarantineError,
  createPluginPackageQuarantineEvent,
  createPluginPackageWithdrawalReceipt,
} = require('@qinglong/runtime-core/plugin-package-quarantine');
const {
  CLUSTER_PLUGIN_PACKAGE_QUARANTINE_BATCH_LIMIT,
  createClusterPluginPackageQuarantineService,
} = require('@qinglong/cluster-admin/plugin-package-quarantine');

function event(index, overrides = {}) {
  return createPluginPackageQuarantineEvent({
    mutationId: `quarantine-cluster-${index}`,
    revocationReceiptDigest: 'a'.repeat(64),
    impactDigest: 'b'.repeat(64),
    target: {
      projectId: 'project-cluster',
      packageName: `package-${index}`,
      installationId: `install-${index}`,
      lockDigest: String(index % 10).repeat(64),
      installState: 'queued',
      installVersion: 1,
      installRecordDigest: 'c'.repeat(64),
      activeLockDigest: null,
      ...overrides.target,
    },
    proposer: { type: 'user', id: 'owner-a' },
    confirmer: { type: 'user', id: 'owner-b' },
    authorizationMode: 'dual_control',
    reasonCode: 'confirmed_key_compromise',
    occurredAtMs: 1_000 + index,
    ...overrides,
  });
}

function receipt(value) {
  return createPluginPackageWithdrawalReceipt({
    eventDigest: value.eventDigest,
    target: value.target,
    capability: {
      status: 'not_active',
      taskWithdrawals: [],
      previousActiveVectorDigest: null,
      currentActiveVectorDigest: null,
      currentToolSnapshotDigest: null,
      retainedSourceCount: 0,
    },
    committedAtMs: value.occurredAtMs,
  });
}

test('runs one bounded batch with authorization rechecked inside each repository transaction', async () => {
  const events = [event(1), event(2)];
  const calls = [];
  const service = createClusterPluginPackageQuarantineService({
    async findTargetsByLockDigest() {
      return [];
    },
    async findByEventDigest() {
      return null;
    },
    async quarantine(value, confirmAuthorization) {
      calls.push(`begin:${value.eventDigest}`);
      await confirmAuthorization();
      calls.push(`write:${value.eventDigest}`);
      await confirmAuthorization();
      return {
        status: 'created',
        receipt: receipt(value),
      };
    },
  });
  const authorization = [];
  const results = await service.quarantine(events, (value) => {
    authorization.push(value.eventDigest);
  });
  assert.deepEqual(
    results.map(({ status, eventDigest }) => ({ status, eventDigest })),
    events.map(({ eventDigest }) => ({ status: 'created', eventDigest })),
  );
  assert.deepEqual(authorization, [
    events[0].eventDigest,
    events[0].eventDigest,
    events[1].eventDigest,
    events[1].eventDigest,
  ]);
  assert.deepEqual(calls, [
    `begin:${events[0].eventDigest}`,
    `write:${events[0].eventDigest}`,
    `begin:${events[1].eventDigest}`,
    `write:${events[1].eventDigest}`,
  ]);
});

test('rejects duplicate targets, sparse input and batches above the hard limit before storage', async () => {
  let calls = 0;
  const service = createClusterPluginPackageQuarantineService({
    async findTargetsByLockDigest() {
      return [];
    },
    async findByEventDigest() {
      return null;
    },
    async quarantine() {
      calls += 1;
      throw new Error('must not write');
    },
  });
  const first = event(3);
  const duplicateTarget = event(4, { target: first.target });
  await assert.rejects(
    service.quarantine([first, duplicateTarget], () => {}),
    InvalidPluginPackageQuarantineError,
  );
  const sparse = [first, event(5)];
  delete sparse[0];
  await assert.rejects(
    service.quarantine(sparse, () => {}),
    InvalidPluginPackageQuarantineError,
  );
  await assert.rejects(
    service.quarantine(
      Array.from(
        { length: CLUSTER_PLUGIN_PACKAGE_QUARANTINE_BATCH_LIMIT + 1 },
        (_, index) => event(index + 10),
      ),
      () => {},
    ),
    InvalidPluginPackageQuarantineError,
  );
  assert.equal(calls, 0);
});

test('publishes quarantine authority only through its explicit subpath', () => {
  assert.equal(
    require('@qinglong/cluster-admin').createClusterPluginPackageQuarantineService,
    undefined,
  );
  assert.equal(
    typeof require('@qinglong/cluster-admin/plugin-package-quarantine')
      .createClusterPluginPackageQuarantineService,
    'function',
  );
});
