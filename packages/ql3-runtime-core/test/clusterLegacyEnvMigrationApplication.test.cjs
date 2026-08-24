const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_RECEIPT_SCHEMA,
  InvalidClusterLegacyEnvMigrationApplicationError,
  clusterLegacyEnvMigrationApplicationReceiptMatchesIntent,
  createClusterLegacyEnvMigrationApplicationReceipt,
  createClusterLegacyEnvMigrationTaskMutationSetDigester,
  createClusterLegacyEnvMigrationTriggerMutationSetDigester,
  normalizeClusterLegacyEnvMigrationApplicationReceipt,
} = require('@qinglong/runtime-core/cluster-legacy-env-migration-application');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const IDS = Object.freeze({
  application: '11111111-1111-4111-8111-111111111111',
  applicationMutation: '22222222-2222-4222-8222-222222222222',
  taskOneMutation: '33333333-3333-4333-8333-333333333333',
  taskTwoMutation: '44444444-4444-4444-8444-444444444444',
  triggerMutation: '55555555-5555-4555-8555-555555555555',
});

function taskMutations() {
  return [
    {
      ordinal: 0,
      taskId: 'task-a',
      previousRevision: 3,
      previousContentDigest: '1'.repeat(64),
      mutationId: IDS.taskOneMutation,
    },
    {
      ordinal: 1,
      taskId: 'task-b',
      previousRevision: 8,
      previousContentDigest: '2'.repeat(64),
      mutationId: IDS.taskTwoMutation,
    },
  ];
}

function triggerMutations() {
  return [
    {
      ordinal: 0,
      triggerId: 'trigger-a',
      taskId: 'task-a',
      previousRevision: 4,
      previousContentDigest: '3'.repeat(64),
      previousTaskRevision: 3,
      previousTaskContentDigest: '1'.repeat(64),
      mutationId: IDS.triggerMutation,
    },
  ];
}

function digestTaskMutations(values = taskMutations()) {
  const digester = createClusterLegacyEnvMigrationTaskMutationSetDigester();
  for (const value of values) digester.update(value);
  return digester.finish();
}

function digestTriggerMutations(values = triggerMutations()) {
  const digester = createClusterLegacyEnvMigrationTriggerMutationSetDigester();
  for (const value of values) digester.update(value);
  return digester.finish();
}

function receiptInput(overrides = {}) {
  const task = digestTaskMutations();
  const trigger = digestTriggerMutations();
  return {
    applicationId: 'legacy-env-application-a',
    mutationId: IDS.applicationMutation,
    projectId: 'project-a',
    planId: 'legacy-env-plan-a',
    planDigest: '6'.repeat(64),
    environmentBundleRef: createSecretRef({
      projectId: 'project-a',
      name: 'legacy-env-bundle',
      version: 7,
    }),
    taskRevisionSetDigest: task.revisionSetDigest,
    triggerRevisionSetDigest: trigger.revisionSetDigest,
    taskMutationSetDigest: task.mutationSetDigest,
    triggerMutationSetDigest: trigger.mutationSetDigest,
    taskCount: task.count,
    triggerCount: trigger.count,
    committedAtMs: 12_345,
    ...overrides,
  };
}

test('streams canonical Task and Trigger revision and mutation sets', () => {
  const firstTask = digestTaskMutations();
  const secondTask = digestTaskMutations();
  const firstTrigger = digestTriggerMutations();
  const secondTrigger = digestTriggerMutations();

  assert.deepEqual(firstTask, secondTask);
  assert.deepEqual(firstTrigger, secondTrigger);
  assert.equal(firstTask.count, 2);
  assert.equal(firstTrigger.count, 1);
  assert.notEqual(firstTask.revisionSetDigest, firstTask.mutationSetDigest);
  assert.notEqual(
    firstTrigger.revisionSetDigest,
    firstTrigger.mutationSetDigest,
  );
});

test('rejects gaps, duplicate ordering, malformed UUIDs and unknown fields', () => {
  const gap = taskMutations();
  gap[1] = { ...gap[1], ordinal: 2 };
  assert.throws(() => digestTaskMutations(gap), {
    name: 'InvalidClusterLegacyEnvMigrationApplicationError',
  });

  const unordered = taskMutations();
  unordered[1] = { ...unordered[1], taskId: 'task-a' };
  assert.throws(
    () => digestTaskMutations(unordered),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );

  const malformedMutation = taskMutations();
  malformedMutation[0] = { ...malformedMutation[0], mutationId: 'not-a-uuid' };
  assert.throws(
    () => digestTaskMutations(malformedMutation),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );

  const extra = taskMutations();
  extra[0] = { ...extra[0], command: 'must-not-enter-ledger' };
  assert.throws(
    () => digestTaskMutations(extra),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );
});

test('creates a frozen content-free receipt and detects tampering', () => {
  const receipt = createClusterLegacyEnvMigrationApplicationReceipt(
    receiptInput(),
  );
  assert.equal(
    receipt.schema,
    CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_RECEIPT_SCHEMA,
  );
  assert.equal(Object.isFrozen(receipt), true);
  assert.match(receipt.receiptDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    normalizeClusterLegacyEnvMigrationApplicationReceipt(receipt),
    receipt,
  );
  assert.equal(
    clusterLegacyEnvMigrationApplicationReceiptMatchesIntent(receipt, {
      applicationId: receipt.applicationId,
      mutationId: receipt.mutationId,
      projectId: receipt.projectId,
      planId: receipt.planId,
      planDigest: receipt.planDigest,
      taskMutationSetDigest: receipt.taskMutationSetDigest,
      triggerMutationSetDigest: receipt.triggerMutationSetDigest,
    }),
    true,
  );
  assert.throws(
    () =>
      normalizeClusterLegacyEnvMigrationApplicationReceipt({
        ...receipt,
        taskCount: receipt.taskCount + 1,
      }),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );
});

test('requires one Task and a canonical version-pinned bundle in the same Project', () => {
  assert.throws(
    () =>
      createClusterLegacyEnvMigrationApplicationReceipt(
        receiptInput({ taskCount: 0 }),
      ),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );
  assert.throws(
    () =>
      createClusterLegacyEnvMigrationApplicationReceipt(
        receiptInput({
          environmentBundleRef: createSecretRef({
            projectId: 'project-a',
            name: 'legacy-env-bundle',
          }),
        }),
      ),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );
  assert.throws(
    () =>
      createClusterLegacyEnvMigrationApplicationReceipt(
        receiptInput({
          environmentBundleRef: createSecretRef({
            projectId: 'project-b',
            name: 'legacy-env-bundle',
            version: 7,
          }),
        }),
      ),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );
});

test('supports an empty Trigger mutation set without weakening Task authority', () => {
  const trigger = digestTriggerMutations([]);
  const receipt = createClusterLegacyEnvMigrationApplicationReceipt(
    receiptInput({
      triggerRevisionSetDigest: trigger.revisionSetDigest,
      triggerMutationSetDigest: trigger.mutationSetDigest,
      triggerCount: 0,
    }),
  );
  assert.equal(receipt.taskCount, 2);
  assert.equal(receipt.triggerCount, 0);
});
