const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLocalSecretRef } = require('../dist/secret/localSecret');
const {
  createTaskDefinitionRecord,
  normalizeAppendTaskDefinitionRevisionCommand,
} = require('../dist/task-definition/taskDefinition');
const {
  InvalidTaskDefinitionCompilationError,
  UnsupportedTaskDefinitionCompilationError,
  compileLocalCommandTaskDefinition,
  createTaskDefinitionRevisionRef,
  parseTaskDefinitionRevisionRef,
} = require('../dist/task-definition/taskDefinitionExecutionCompiler');
const {
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} = require('../dist/task-definition/taskSpecSemantic');

function command(overrides = {}) {
  return {
    projectId: 'default',
    taskId: 'task-1',
    expectedRevision: null,
    mutationId: '019f7400-0000-7000-8000-000000000001',
    name: 'Compiled command',
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: [''] },
      },
    },
    labels: { source: 'compiler-test' },
    enabled: true,
    occurredAtMs: 100,
    ...overrides,
  };
}

function semanticRecord(registry, overrides = {}) {
  const normalized = normalizeAppendTaskDefinitionRevisionCommand(
    command(overrides),
  );
  const spec = registry.normalize({
    projectId: normalized.projectId,
    taskId: normalized.taskId,
    kind: normalized.kind,
    spec: normalized.spec,
  });
  return createTaskDefinitionRecord({ ...normalized, spec }, 90);
}

test('compiles one canonical command revision into a profile-neutral and local plan', () => {
  const registry = createBuiltInTaskSpecSemanticRegistry();
  const secretRef = createLocalSecretRef({
    projectId: 'default',
    name: 'TOKEN',
  });
  const definition = semanticRecord(registry, {
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: ['', 'ready'] },
        environment: [
          { kind: 'secret', name: 'TOKEN', secretRef },
          { kind: 'public', name: 'MODE', value: 'test' },
        ],
        workingDirectory: '/work',
        timeoutMs: 5_000,
      },
    },
  });
  const compiled = compileLocalCommandTaskDefinition(definition, registry);

  assert.deepEqual(parseTaskDefinitionRevisionRef(compiled.source.taskRevision), {
    revision: definition.revision,
    contentDigest: definition.contentDigest,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(compiled.source.environment)), [
    { name: 'MODE', kind: 'public', value: 'test' },
    { name: 'TOKEN', kind: 'secret', secretRef },
  ]);
  assert.deepEqual(compiled.executionRevision.command, {
    kind: 'argv',
    file: '/bin/echo',
    args: ['', 'ready'],
  });
  assert.equal(
    compiled.executionRevision.contextRef,
    compiled.contextRecipe.contextRef,
  );
  assert.equal(compiled.executionRevision.createdAtMs, definition.updatedAtMs);
  assert.equal(Object.isFrozen(compiled.source), true);
  assert.deepEqual(
    compileLocalCommandTaskDefinition(definition, registry),
    compiled,
  );
});

test('rejects disabled, unsupported, structurally-only and drifted sources', () => {
  const registry = createBuiltInTaskSpecSemanticRegistry();
  assert.throws(
    () =>
      compileLocalCommandTaskDefinition(
        semanticRecord(registry, { enabled: false }),
        registry,
      ),
    /source is disabled/,
  );

  const script = createTaskDefinitionRecord(
    command({
      kind: 'script',
      spec: { schema: 'qinglong/script@v1', config: {} },
    }),
    90,
  );
  assert.throws(
    () => compileLocalCommandTaskDefinition(script, registry),
    UnsupportedTaskDefinitionCompilationError,
  );

  const structurallyOnly = createTaskDefinitionRecord(command(), 90);
  assert.throws(
    () => compileLocalCommandTaskDefinition(structurallyOnly, registry),
    /not semantically canonical/,
  );
  assert.throws(
    () =>
      compileLocalCommandTaskDefinition(
        { ...semanticRecord(registry), contentDigest: '0'.repeat(64) },
        registry,
      ),
    /source record is invalid/,
  );

  const withoutBuiltIn = new TaskSpecSemanticRegistry([
    {
      schema: 'example/tool@v1',
      kind: 'tool',
      normalizeConfig: (config) => config,
    },
  ]);
  assert.throws(
    () =>
      compileLocalCommandTaskDefinition(
        semanticRecord(registry),
        withoutBuiltIn,
      ),
    UnsupportedTaskDefinitionCompilationError,
  );
});

test('uses one canonical digest-bound TaskDefinition revision reference', () => {
  const digest = 'a'.repeat(64);
  const reference = createTaskDefinitionRevisionRef({
    revision: 2_147_483_647,
    contentDigest: digest,
  });
  assert.equal(reference, `qltd:v1:2147483647:${digest}`);
  assert.deepEqual(parseTaskDefinitionRevisionRef(reference), {
    revision: 2_147_483_647,
    contentDigest: digest,
  });
  for (const invalid of [
    `qltd:v1:01:${digest}`,
    `qltd:v1:2147483648:${digest}`,
    `qltd:v1:1:${'A'.repeat(64)}`,
    'revision-1',
  ]) {
    assert.throws(
      () => parseTaskDefinitionRevisionRef(invalid),
      InvalidTaskDefinitionCompilationError,
    );
  }
});
