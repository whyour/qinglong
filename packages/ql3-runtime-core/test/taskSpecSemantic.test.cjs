const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLocalSecretRef } = require('../dist/secret/localSecret');
const {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  InvalidTaskSpecSemanticError,
  TaskSpecSemanticRegistry,
  UnsupportedTaskSpecError,
  createBuiltInTaskSpecSemanticRegistry,
  createTaskSpecSemanticRegistry,
} = require('../dist/task-definition/taskSpecSemantic');

function context(overrides = {}) {
  return {
    projectId: 'default',
    taskId: 'task-1',
    kind: 'command',
    spec: {
      schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: ['hello'] },
      },
    },
    ...overrides,
  };
}

test('publishes one immutable built-in schema and canonicalizes command specs', () => {
  const registry = createBuiltInTaskSpecSemanticRegistry();
  assert.equal(Object.isFrozen(registry), true);
  assert.equal('register' in registry, false);
  assert.deepEqual(registry.list(), [
    { schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA, kind: 'command' },
  ]);
  assert.equal(
    registry.supports('command', BUILT_IN_COMMAND_TASK_SPEC_SCHEMA),
    true,
  );

  const secretRef = createLocalSecretRef({
    projectId: 'default',
    name: 'TOKEN',
  });
  const normalized = registry.normalize(
    context({
      spec: {
        schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
        config: {
          timeoutMs: 5_000,
          workingDirectory: '/work',
          environment: [
            { kind: 'secret', name: 'TOKEN', secretRef },
            { kind: 'public', name: 'EMPTY', value: '' },
          ],
          command: { kind: 'shell', command: 'echo "$EMPTY"' },
        },
      },
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
    schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
    config: {
      command: {
        kind: 'shell',
        command: 'echo "$EMPTY"',
        shell: '/bin/sh',
      },
      environment: [
        { name: 'EMPTY', kind: 'public', value: '' },
        { name: 'TOKEN', kind: 'secret', secretRef },
      ],
      timeoutMs: 5_000,
      workingDirectory: '/work',
    },
  });
  assert.equal(Object.isFrozen(normalized.config.environment), true);
});

test('fails closed for unknown schemas, kind drift and unsafe command shapes', () => {
  const registry = createBuiltInTaskSpecSemanticRegistry();
  assert.throws(
    () =>
      registry.normalize(
        context({
          kind: 'script',
          spec: { schema: 'qinglong/script@v1', config: {} },
        }),
      ),
    UnsupportedTaskSpecError,
  );
  assert.throws(
    () => registry.normalize(context({ kind: 'script' })),
    /schema does not match TaskDefinition kind/,
  );

  const invalidConfigs = [
    { command: { kind: 'argv', file: 'bin/echo', args: [] } },
    { command: { kind: 'shell', command: 'true', shell: '/usr/bin/zsh' } },
    {
      command: { kind: 'argv', file: '/bin/echo', args: [] },
      workingDirectory: 'work',
    },
    {
      command: { kind: 'argv', file: '/bin/echo', args: [] },
      environment: [{ kind: 'public', name: 'QL3_TOKEN', value: 'x' }],
    },
    {
      command: { kind: 'argv', file: '/bin/echo', args: [] },
      environment: [
        { kind: 'public', name: 'TOKEN', value: 'a' },
        { kind: 'public', name: 'TOKEN', value: 'b' },
      ],
    },
    {
      command: { kind: 'argv', file: '/bin/echo', args: [] },
      environment: [
        {
          kind: 'secret',
          name: 'TOKEN',
          secretRef: createLocalSecretRef({
            projectId: 'other',
            name: 'TOKEN',
          }),
        },
      ],
    },
    { command: { kind: 'argv', file: '/bin/echo', args: [] }, extra: true },
  ];
  for (const config of invalidConfigs) {
    assert.throws(
      () =>
        registry.normalize(
          context({
            spec: { schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA, config },
          }),
        ),
      InvalidTaskSpecSemanticError,
    );
  }
  assert.doesNotThrow(() =>
    registry.normalize(
      context({
        spec: {
          schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
          config: {
            command: { kind: 'argv', file: '/bin/echo', args: [''] },
          },
        },
      }),
    ),
  );
});

test('accepts only an explicit bounded descriptor set and hides validator errors', () => {
  const descriptor = {
    schema: 'example/tool@v1',
    kind: 'tool',
    normalizeConfig() {
      throw new Error('provider internals');
    },
  };
  assert.throws(
    () => new TaskSpecSemanticRegistry([descriptor, descriptor]),
    /invalid or duplicated/,
  );
  const registry = new TaskSpecSemanticRegistry([descriptor]);
  assert.throws(
    () =>
      registry.normalize(
        context({
          kind: 'tool',
          spec: { schema: 'example/tool@v1', config: {} },
        }),
      ),
    (error) => {
      assert.equal(error.message.includes('provider internals'), false);
      return error instanceof InvalidTaskSpecSemanticError;
    },
  );

  const extended = createTaskSpecSemanticRegistry([
    {
      schema: 'example/command@v1',
      kind: 'command',
      normalizeConfig: (config) => config,
    },
  ]);
  assert.deepEqual(
    extended.list().map(({ schema }) => schema),
    ['example/command@v1', BUILT_IN_COMMAND_TASK_SPEC_SCHEMA],
  );
  assert.throws(
    () =>
      createTaskSpecSemanticRegistry([
        {
          schema: 'qinglong/tool@v1',
          kind: 'tool',
          normalizeConfig: (config) => config,
        },
      ]),
    /reserved qinglong namespace/,
  );
});

test('canonicalizes an optional bounded Remote Worker PlacementSpec in command semantics', () => {
  const registry = createBuiltInTaskSpecSemanticRegistry();
  const normalized = registry.normalize(
    context({
      spec: {
        schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
        config: {
          command: { kind: 'argv', file: '/bin/echo', args: ['placed'] },
          placement: {
            required: {
              architectures: ['arm64'],
              runtimes: [{ name: 'node', versionRange: '^24.0.0' }],
              labels: { region: 'cn-east' },
            },
            preferred: [{ labels: { tier: 'edge' }, weight: 5 }],
          },
        },
      },
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.config.placement)), {
    required: {
      architectures: ['arm64'],
      runtimes: [{ name: 'node', versionRange: '^24.0.0' }],
      labels: { region: 'cn-east' },
    },
    preferred: [{ labels: { tier: 'edge' }, weight: 5 }],
  });
  assert.throws(
    () => registry.normalize(context({
      spec: {
        schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
        config: {
          command: { kind: 'argv', file: '/bin/echo', args: [] },
          placement: {
            required: { runtimes: [{ name: 'node', versionRange: 'not-semver' }] },
          },
        },
      },
    })),
    InvalidTaskSpecSemanticError,
  );
});
