const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const {
  ProjectPolicyEngine,
} = require('@qinglong/runtime-core/project-policy');
const {
  InvalidToolDefinitionError,
  InvalidToolJsonValueError,
  TOOL_INVOCATION_SCHEMA,
  ToolDefinitionRegistry,
  ToolPolicySnapshotConflictError,
  ToolPolicyUnavailableError,
  UnsupportedToolError,
  normalizeToolDefinition,
  prepareToolInvocation,
} = require('../dist/tool-execution/tool-registry/toolRegistry');

function definition(overrides = {}) {
  const value = {
    name: 'run.compare',
    version: '1.0.0',
    description: 'Compare one bounded Run projection',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, maxLength: 64 },
        tags: {
          type: 'array',
          items: { type: 'string', maxLength: 16 },
          maxItems: 4,
          uniqueItems: true,
        },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', maxLength: 1024 },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    effect: 'read',
    risk: 'low',
    requiredPermissions: ['run.read'],
    timeoutSeconds: 15,
  };
  return {
    ...value,
    ...overrides,
    inputSchema: overrides.inputSchema ?? value.inputSchema,
    outputSchema: Object.hasOwn(overrides, 'outputSchema')
      ? overrides.outputSchema
      : value.outputSchema,
  };
}

function principal(overrides = {}) {
  return {
    subject: { type: 'user', id: 'usr-1' },
    authenticationId: 'auth-1',
    authenticatedAtMs: 900,
    expiresAtMs: 2_000,
    assurance: 'multi_factor',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    projectId: 'default',
    principal: principal(),
    nowMs: 1_000,
    tool: { name: 'run.compare', version: '1.0.0' },
    input: { tags: ['failed', 'recent'], runId: 'run-1' },
    ...overrides,
  };
}

function policyDecision(effect = 'allow', fence = {}) {
  return {
    effect,
    reasons:
      effect === 'allow'
        ? ['role_grant']
        : effect === 'deny'
        ? ['permission_missing']
        : ['agent_action_requires_approval'],
    fence:
      fence === null
        ? null
        : {
            projectVersion: 3,
            bindingVersion: 7,
            ...fence,
          },
  };
}

function authorizer(resolve = () => policyDecision()) {
  const calls = [];
  return {
    calls,
    async authorize(currentPrincipal, projectId, permission) {
      calls.push({ currentPrincipal, projectId, permission });
      return resolve(permission);
    },
  };
}

test('publishes one immutable registry without runtime registration', () => {
  const registry = new ToolDefinitionRegistry([
    definition({ version: '2.0.0' }),
    definition(),
  ]);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal('register' in registry, false);
  assert.deepEqual(
    registry.list().map(({ name, version }) => ({ name, version })),
    [
      { name: 'run.compare', version: '1.0.0' },
      { name: 'run.compare', version: '2.0.0' },
    ],
  );
  assert.equal(Object.isFrozen(registry.list()[0].inputSchema), true);
  assert.throws(
    () => registry.resolve('run.compare', '3.0.0'),
    UnsupportedToolError,
  );
});

test('publishes the same contract through root and tool-registry subpath', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/tool-registry');
  assert.equal(root.ToolDefinitionRegistry, ToolDefinitionRegistry);
  assert.equal(subpath.prepareToolInvocation, prepareToolInvocation);
});

test('normalizes a bounded exact JSON Schema subset', () => {
  const normalized = normalizeToolDefinition(definition());
  assert.deepEqual(normalized.requiredPermissions, ['run.read']);
  assert.deepEqual(
    normalizeToolDefinition(
      definition({ requiredPermissions: ['package.manage'] }),
    ).requiredPermissions,
    ['package.manage'],
  );
  assert.deepEqual(Object.keys(normalized.inputSchema.properties), [
    'runId',
    'tags',
  ]);
  assert.deepEqual(normalized.inputSchema.required, ['runId']);

  const invalid = [
    definition({ extra: true }),
    definition({ name: 'RunCompare' }),
    definition({ version: 'v1.0.0' }),
    definition({ requiredPermissions: ['tool.call:run.get'] }),
    definition({ requiredPermissions: ['run.read', 'run.read'] }),
    definition({
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
    }),
    definition({
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: [],
        additionalProperties: false,
      },
    }),
    definition({
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
        oneOf: [],
      },
    }),
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizeToolDefinition(value),
      InvalidToolDefinitionError,
    );
  }
});

test('enforces schema depth, node and property budgets', () => {
  let schema = { type: 'string', maxLength: 8 };
  for (let index = 0; index < 9; index += 1) {
    schema = { type: 'array', items: schema, maxItems: 1 };
  }
  assert.throws(
    () =>
      normalizeToolDefinition(
        definition({
          inputSchema: {
            type: 'object',
            properties: { value: schema },
            required: ['value'],
            additionalProperties: false,
          },
        }),
      ),
    /depth exceeded/,
  );

  const properties = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [
      `field${index}`,
      { type: 'boolean' },
    ]),
  );
  assert.throws(
    () =>
      normalizeToolDefinition(
        definition({
          inputSchema: {
            type: 'object',
            properties,
            required: [],
            additionalProperties: false,
          },
        }),
      ),
    /property budget exceeded/,
  );
});

test('canonicalizes input and output while rejecting drift and bounds', () => {
  const registry = new ToolDefinitionRegistry([definition()]);
  const input = registry.normalizeInput('run.compare', '1.0.0', {
    tags: ['failed', 'recent'],
    runId: 'run-1',
  });
  assert.deepEqual(input, {
    runId: 'run-1',
    tags: ['failed', 'recent'],
  });
  assert.equal(Object.isFrozen(input), true);
  assert.deepEqual(
    registry.normalizeOutput('run.compare', '1.0.0', {
      summary: 'changed\nwith context',
    }),
    { summary: 'changed\nwith context' },
  );

  for (const invalid of [
    {},
    { runId: 'run-1', extra: true },
    { runId: 'run-1', tags: ['same', 'same'] },
    { runId: 'x'.repeat(65) },
  ]) {
    assert.throws(
      () => registry.normalizeInput('run.compare', '1.0.0', invalid),
      InvalidToolJsonValueError,
    );
  }
  assert.throws(
    () =>
      registry.normalizeOutput('run.compare', '1.0.0', {
        summary: 1,
      }),
    InvalidToolJsonValueError,
  );

  const getterInput = { runId: 'run-1' };
  Object.defineProperty(getterInput, 'tags', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  assert.throws(
    () => registry.normalizeInput('run.compare', '1.0.0', getterInput),
    /JSON data properties/,
  );
  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () =>
      registry.normalizeInput('run.compare', '1.0.0', {
        runId: 'run-1',
        tags: sparse,
      }),
    /dense JSON array/,
  );
});

test('requires null output when a Tool has no output schema', () => {
  const registry = new ToolDefinitionRegistry([
    definition({ outputSchema: undefined }),
  ]);
  assert.equal(registry.normalizeOutput('run.compare', '1.0.0', null), null);
  assert.throws(
    () => registry.normalizeOutput('run.compare', '1.0.0', {}),
    /output must be null/,
  );
});

test('prepares one digest-bound invocation from a single policy fence', async () => {
  const registry = new ToolDefinitionRegistry([definition()]);
  const policy = authorizer();
  const plan = await prepareToolInvocation(registry, request(), policy);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.schema, TOOL_INVOCATION_SCHEMA);
  assert.equal(plan.permission, 'tool.call:run.compare');
  assert.deepEqual(plan.requiredPermissions, ['run.read']);
  assert.deepEqual(plan.fence, {
    projectVersion: 3,
    bindingVersion: 7,
  });
  assert.match(plan.inputDigest, /^[0-9a-f]{64}$/);
  assert.match(plan.actionDigest, /^[0-9a-f]{64}$/);
  assert.equal('execute' in plan, false);
  assert.deepEqual(
    policy.calls.map(({ permission }) => permission),
    ['tool.call:run.compare', 'run.read'],
  );

  const replay = await prepareToolInvocation(
    registry,
    request({ input: { runId: 'run-1', tags: ['failed', 'recent'] } }),
    authorizer(),
  );
  assert.equal(replay.actionDigest, plan.actionDigest);
});

test('uses the real Project Policy port and requires approval for an Agent Tool call', async () => {
  const registry = new ToolDefinitionRegistry([definition()]);
  const policy = new ProjectPolicyEngine({
    async resolve(projectId, subject) {
      return {
        project: {
          id: projectId,
          name: 'Default',
          slug: 'default',
          status: 'active',
          version: 3,
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        binding: {
          projectId,
          subject,
          version: 7,
          state: 'active',
          role: 'operator',
          mutationId: 'bind-1',
          changedBy: { type: 'user', id: 'owner-1' },
          createdAtMs: 2,
        },
      };
    },
    async append() {
      throw new Error('not used');
    },
  });
  const plan = await prepareToolInvocation(
    registry,
    request({
      principal: principal({
        subject: { type: 'agent', id: 'agent-1' },
        assurance: 'service',
      }),
    }),
    policy,
  );
  assert.equal(plan.status, 'approval_required');
  assert.equal(plan.permission, 'tool.call:run.compare');
  assert.equal('execute' in plan, false);
});

test('short-circuits denial before parsing untrusted Tool input', async () => {
  const registry = new ToolDefinitionRegistry([definition()]);
  const policy = authorizer(() => policyDecision('deny', null));
  const plan = await prepareToolInvocation(
    registry,
    request({ input: { invalid: true } }),
    policy,
  );
  assert.deepEqual(plan, {
    status: 'denied',
    tool: { name: 'run.compare', version: '1.0.0' },
    permission: 'tool.call:run.compare',
  });
  assert.equal(policy.calls.length, 1);
});

test('fails closed on unavailable, malformed or mixed policy snapshots', async () => {
  const registry = new ToolDefinitionRegistry([definition()]);
  await assert.rejects(
    prepareToolInvocation(
      registry,
      request(),
      authorizer(() => {
        throw new Error('storage internals');
      }),
    ),
    ToolPolicyUnavailableError,
  );
  await assert.rejects(
    prepareToolInvocation(
      registry,
      request(),
      authorizer((permission) =>
        policyDecision('allow', {
          projectVersion: permission === 'run.read' ? 4 : 3,
        }),
      ),
    ),
    ToolPolicySnapshotConflictError,
  );
  await assert.rejects(
    prepareToolInvocation(
      registry,
      request(),
      authorizer(() => ({
        effect: 'allow',
        reasons: ['driver stack'],
        fence: null,
      })),
    ),
    ToolPolicyUnavailableError,
  );
});

test('rejects expired principals and extensible invocation envelopes', async () => {
  const registry = new ToolDefinitionRegistry([definition()]);
  await assert.rejects(
    prepareToolInvocation(
      registry,
      request({
        principal: principal({ expiresAtMs: 1_000 }),
      }),
      authorizer(),
    ),
    /principal lifetime is inactive/,
  );
  await assert.rejects(
    prepareToolInvocation(
      registry,
      { ...request(), extra: true },
      authorizer(),
    ),
    /request shape is invalid/,
  );
});

test('enforces whole-envelope byte budgets after schema validation', () => {
  const registry = new ToolDefinitionRegistry([
    definition({
      inputSchema: {
        type: 'object',
        properties: {
          payload: { type: 'string', maxLength: 70_000 },
        },
        required: ['payload'],
        additionalProperties: false,
      },
    }),
  ]);
  assert.throws(
    () =>
      registry.normalizeInput('run.compare', '1.0.0', {
        payload: 'x'.repeat(66_000),
      }),
    /byte budget exceeded/,
  );
});

test('keeps registry and invocation planning free of execution and ambient authority', () => {
  const source = readFileSync(
    join(__dirname, '../src/tool-execution/tool-registry/toolRegistry.ts'),
    'utf8',
  );
  for (const authority of [
    "from 'node:child_process'",
    "from 'node:fs'",
    "from 'node:http'",
    "from 'node:https'",
    'setInterval(',
    'setTimeout(',
    'dynamic import',
  ]) {
    assert.equal(source.includes(authority), false, authority);
  }
});
