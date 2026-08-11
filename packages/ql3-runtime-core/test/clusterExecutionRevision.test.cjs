const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidClusterExecutionRevisionError,
  compileClusterCommandTaskDefinition,
  normalizeClusterTaskExecutionRevision,
} = require('../dist/task-definition/clusterExecutionRevision');
const {
  createTaskDefinitionRecord,
  normalizeAppendTaskDefinitionRevisionCommand,
} = require('../dist/task-definition/taskDefinition');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('../dist/task-definition/taskSpecSemantic');
const { createSecretRef } = require('../dist/secret/secretReference');

function definition() {
  const registry = createBuiltInTaskSpecSemanticRegistry();
  const command = normalizeAppendTaskDefinitionRevisionCommand({
    projectId: 'default',
    taskId: 'task-1',
    expectedRevision: null,
    mutationId: '019f7600-0000-7000-8000-000000000001',
    name: 'Cluster command',
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: ['ready'] },
        environment: [
          { kind: 'public', name: 'MODE', value: 'cluster' },
          {
            kind: 'secret',
            name: 'TOKEN',
            secretRef: createSecretRef({ projectId: 'default', name: 'TOKEN' }),
          },
        ],
        timeoutMs: 5000,
      },
    },
    labels: {},
    enabled: true,
    occurredAtMs: 100,
  });
  return {
    registry,
    record: createTaskDefinitionRecord({
      ...command,
      spec: registry.normalize({
        projectId: command.projectId,
        taskId: command.taskId,
        kind: command.kind,
        spec: command.spec,
      }),
    }, 90),
  };
}

test('compiles one digest-bound remote Worker execution revision', () => {
  const input = definition();
  const revision = compileClusterCommandTaskDefinition(
    input.record,
    input.registry,
  );
  assert.equal(revision.executorType, 'remote_worker');
  assert.equal(revision.planSchema, 'qinglong/command-execution@v1');
  assert.equal(revision.sourceRevision, input.record.revision);
  assert.equal(revision.sourceContentDigest, input.record.contentDigest);
  assert.match(revision.contentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(normalizeClusterTaskExecutionRevision(revision), revision);
});

test('rejects digest drift and cross-Project Secret references', () => {
  const input = definition();
  const revision = compileClusterCommandTaskDefinition(
    input.record,
    input.registry,
  );
  assert.throws(
    () => normalizeClusterTaskExecutionRevision({
      ...revision,
      contentDigest: '0'.repeat(64),
    }),
    InvalidClusterExecutionRevisionError,
  );
  assert.throws(
    () => normalizeClusterTaskExecutionRevision({
      ...revision,
      environment: [{
        kind: 'secret',
        name: 'TOKEN',
        secretRef: createSecretRef({ projectId: 'another', name: 'TOKEN' }),
      }],
    }),
    InvalidClusterExecutionRevisionError,
  );
});
