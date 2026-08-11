const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('../dist/approved-action/approvedAction');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../dist/plugin-package/pluginPackageResourceGeneration');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionRegistry,
} = require('../dist/tool-execution/tool-registry/projectToolDefinitionSnapshot');
const {
  prepareToolInvocation,
} = require('../dist/tool-execution/tool-registry/toolRegistry');
const {
  InvalidTrustedToolInvocationError,
  TOOL_INVOKE_ACTION_TYPE,
  TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA,
  TRUSTED_TOOL_HANDLER_BINDING_SCHEMA,
  TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA,
  TrustedToolExecutionApprovalRequiredError,
  TrustedToolExecutionPolicyDeniedError,
  TrustedToolExecutionPolicyUnavailableError,
  TrustedToolHandlerBindingRegistry,
  TrustedToolHandlerUnavailableError,
  TrustedToolInvocationBindingConflictError,
  admitTrustedToolExecution,
  assertTrustedToolApprovedDispatch,
  createTrustedToolHandlerBinding,
  createTrustedToolInvocationPlan,
  normalizeTrustedToolHandlerBinding,
  normalizeTrustedToolInvocationPlan,
  trustedToolInvocationApprovalBinding,
} = require('../dist/tool-execution/trustedToolInvocation');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const REQUESTER = Object.freeze({ type: 'user', id: 'usr-tool-owner' });
const SYSTEM = Object.freeze({ type: 'system', id: 'tool-dispatcher' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 7 });

function definition(overrides = {}) {
  return {
    name: 'demo.compare',
    version: '1.0.0',
    description: 'Compare one bounded Run projection',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, maxLength: 64 },
        token: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['runId', 'token'],
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
    timeoutSeconds: 30,
    ...overrides,
  };
}

function snapshot(options = {}) {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-demo',
    projectId: 'project-001',
    packageName: 'demo',
    lockDigest: options.lockDigest ?? DIGEST_A,
    generation: options.generation ?? 1,
    previousActiveLockDigest:
      options.generation && options.generation > 1 ? DIGEST_A : null,
    contentDigest: options.contentDigest ?? DIGEST_B,
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [
      {
        generation,
        revisionDigest: options.revisionDigest ?? DIGEST_C,
        definitions: [definition(options.definition)],
      },
    ],
  });
}

function bindingInput(overrides = {}) {
  return {
    tool: { name: 'demo.compare', version: '1.0.0' },
    adapter: { id: 'builtin.demo-compare', version: '1.0.0' },
    executionClass: 'builtin_in_process',
    profiles: ['edge', 'standalone'],
    authorities: ['database.read'],
    timeoutSeconds: 20,
    redactionContract: {
      id: 'redaction.demo-compare',
      version: '1.0.0',
    },
    auditContract: { id: 'audit.tool-call', version: '1.0.0' },
    ...overrides,
  };
}

function harness(options = {}) {
  const currentSnapshot = options.snapshot ?? snapshot();
  const binding = createTrustedToolHandlerBinding(
    currentSnapshot,
    bindingInput(options.binding),
  );
  return {
    snapshot: currentSnapshot,
    binding,
    bindings: new TrustedToolHandlerBindingRegistry(currentSnapshot, [binding]),
  };
}

function principal(overrides = {}) {
  return {
    subject: REQUESTER,
    authenticationId: 'auth-tool-1',
    authenticatedAtMs: 800,
    expiresAtMs: 10_000,
    assurance: 'local_console',
    ...overrides,
  };
}

function decision(effect = 'allow', fence = FENCE) {
  return {
    effect,
    reasons:
      effect === 'allow'
        ? ['role_grant']
        : effect === 'deny'
        ? ['permission_missing']
        : ['agent_action_requires_approval'],
    fence,
  };
}

function authorizer(resolve = () => decision()) {
  const calls = [];
  return {
    calls,
    async authorize(currentPrincipal, projectId, permission) {
      calls.push({ currentPrincipal, projectId, permission });
      return resolve(permission);
    },
  };
}

async function invocation(currentSnapshot, status = 'ready') {
  return prepareToolInvocation(
    projectToolDefinitionRegistry(currentSnapshot),
    {
      projectId: 'project-001',
      principal: principal(),
      nowMs: 900,
      tool: { name: 'demo.compare', version: '1.0.0' },
      input: { token: 'secret-value', runId: 'run-001' },
    },
    authorizer(() =>
      decision(status === 'ready' ? 'allow' : 'require_approval'),
    ),
  );
}

function preview(overrides = {}) {
  return {
    title: 'Compare Run',
    summary: 'Reads one Run projection without exposing credentials',
    fields: [
      { kind: 'identifier', label: 'Run', value: 'run-001' },
      { kind: 'redacted', label: 'Credential', value: null },
    ],
    warnings: [],
    ...overrides,
  };
}

async function plan(currentHarness, status = 'ready', overrides = {}) {
  return createTrustedToolInvocationPlan(
    currentHarness.bindings,
    await invocation(currentHarness.snapshot, status),
    {
      actionRef: 'tool-plan:run-001',
      inputArtifactId: 'artifact-input-001',
      previewArtifactId: 'artifact-preview-001',
      artifactKeyId: 'tool-key-test',
      artifactKey: Buffer.alloc(32, 7),
      artifactNonce: Buffer.alloc(12, 9),
      profile: 'edge',
      preview: preview(),
      sealedAtMs: 1_000,
      ...overrides,
    },
  ).plan;
}

function evidence(overrides = {}) {
  return {
    stepRun: {
      id: 'step-run-001',
      version: 1,
      digest: DIGEST_A,
      ...overrides.stepRun,
    },
    trace: {
      traceId: 'trace-001',
      spanId: 'span-001',
      digest: DIGEST_B,
      ...overrides.trace,
    },
    audit: {
      eventId: 'audit-event-001',
      digest: DIGEST_C,
      ...overrides.audit,
    },
  };
}

async function approvedDispatch(currentHarness, currentPlan) {
  const action = trustedToolInvocationApprovalBinding(
    currentPlan,
    currentHarness.bindings,
  );
  const request = createApprovalRequest({
    id: 'approval-tool-001',
    projectId: currentPlan.projectId,
    action,
    risk: currentPlan.risk,
    decisionMode: 'human_confirmation',
    requestedBy: currentPlan.requestedBy,
    requestedAtMs: 1_100,
    expiresAtMs: 9_000,
    requestFence: currentPlan.policyFence,
  });
  const approved = decideApprovalRequest(request, {
    expectedVersion: 1,
    decisionId: 'decision-tool-001',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: principal(),
    decidedAtMs: 1_200,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-tool-001',
    dispatchId: 'dispatch-tool-001',
    action,
    requestedBy: currentPlan.requestedBy,
    consumedBy: SYSTEM,
    consumedAtMs: 1_300,
    authorizationFence: FENCE,
  }).dispatch;
}

test('creates an immutable snapshot-specific handler binding without executable code', () => {
  const current = harness();
  assert.equal(current.binding.schema, TRUSTED_TOOL_HANDLER_BINDING_SCHEMA);
  assert.equal(current.binding.snapshotDigest, current.snapshot.snapshotDigest);
  assert.equal(
    current.binding.definitionDigest,
    current.snapshot.definitions[0].definitionDigest,
  );
  assert.match(current.binding.bindingDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(current.binding.profiles, ['edge', 'standalone']);
  assert.deepEqual(current.binding.authorities, ['database.read']);
  assert.equal(Object.isFrozen(current.binding), true);
  assert.equal('execute' in current.binding, false);
  assert.equal('handler' in current.binding, false);
  assert.deepEqual(
    normalizeTrustedToolHandlerBinding(current.binding),
    current.binding,
  );
  assert.deepEqual(current.bindings.list()[0], current.binding);
  assert.equal('register' in current.bindings, false);
});

test('rejects unknown Tools, widened timeouts, duplicate bindings and stale snapshots', () => {
  const currentSnapshot = snapshot();
  assert.throws(
    () =>
      createTrustedToolHandlerBinding(
        currentSnapshot,
        bindingInput({
          tool: { name: 'demo.missing', version: '1.0.0' },
        }),
      ),
    TrustedToolHandlerUnavailableError,
  );
  assert.throws(
    () =>
      createTrustedToolHandlerBinding(
        currentSnapshot,
        bindingInput({ timeoutSeconds: 31 }),
      ),
    /widens/,
  );
  const binding = createTrustedToolHandlerBinding(
    currentSnapshot,
    bindingInput(),
  );
  assert.throws(
    () =>
      new TrustedToolHandlerBindingRegistry(currentSnapshot, [
        binding,
        binding,
      ]),
    /duplicated/,
  );
  const nextSnapshot = snapshot({
    generation: 2,
    lockDigest: 'd'.repeat(64),
    contentDigest: 'e'.repeat(64),
    revisionDigest: 'f'.repeat(64),
  });
  assert.throws(
    () => new TrustedToolHandlerBindingRegistry(nextSnapshot, [binding]),
    TrustedToolInvocationBindingConflictError,
  );
});

test('enforces Profile availability independently from Tool definitions', () => {
  const current = harness();
  assert.equal(
    current.bindings.resolve('demo.compare', '1.0.0', 'edge').bindingDigest,
    current.binding.bindingDigest,
  );
  assert.throws(
    () => current.bindings.resolve('demo.compare', '1.0.0', 'worker'),
    TrustedToolHandlerUnavailableError,
  );
});

test('seals invocation, binding and safe preview into separate canonical digests', async () => {
  const current = harness();
  const sealed = await plan(current);
  assert.equal(sealed.schema, TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA);
  assert.equal(sealed.actionType, TOOL_INVOKE_ACTION_TYPE);
  assert.equal(sealed.snapshotDigest, current.snapshot.snapshotDigest);
  assert.equal(sealed.binding.bindingDigest, current.binding.bindingDigest);
  assert.equal(sealed.timeoutSeconds, 20);
  assert.match(sealed.actionDigest, /^[0-9a-f]{64}$/);
  assert.match(sealed.previewArtifact.previewDigest, /^[0-9a-f]{64}$/);
  assert.match(sealed.planDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(sealed.actionDigest, sealed.invocationActionDigest);
  assert.equal(JSON.stringify(sealed).includes('secret-value'), false);
  assert.equal('input' in sealed, false);
  assert.equal('preview' in sealed, false);
  assert.equal('execute' in sealed, false);
  assert.deepEqual(
    normalizeTrustedToolInvocationPlan(sealed, current.bindings),
    sealed,
  );

  const replay = await plan(current);
  assert.equal(replay.planDigest, sealed.planDigest);
  const changedAdapter = harness({
    snapshot: current.snapshot,
    binding: {
      adapter: { id: 'builtin.demo-compare', version: '1.0.1' },
    },
  });
  const changed = await plan(changedAdapter);
  assert.notEqual(changed.actionDigest, sealed.actionDigest);
});

test('rejects unsafe preview shapes and digest drift', async () => {
  const current = harness();
  await assert.rejects(
    async () =>
      plan(current, 'ready', {
        preview: preview({
          fields: [
            { kind: 'redacted', label: 'Credential', value: 'secret-value' },
          ],
        }),
      }),
    /redaction is invalid/,
  );
  const sealed = await plan(current);
  assert.throws(
    () =>
      normalizeTrustedToolInvocationPlan(
        {
          ...sealed,
          previewArtifact: {
            ...sealed.previewArtifact,
            previewDigest: DIGEST_A,
          },
        },
        current.bindings,
      ),
    InvalidTrustedToolInvocationError,
  );
});

test('publishes Approval binding only for approval-required plans', async () => {
  const current = harness();
  const required = await plan(current, 'approval_required');
  assert.deepEqual(
    trustedToolInvocationApprovalBinding(required, current.bindings),
    {
      permission: 'tool.call:demo.compare',
      actionType: TOOL_INVOKE_ACTION_TYPE,
      actionRef: 'tool-plan:run-001',
      actionDigest: required.actionDigest,
      previewDigest: required.previewArtifact.previewDigest,
    },
  );
  await assert.rejects(
    async () =>
      trustedToolInvocationApprovalBinding(
        await plan(current),
        current.bindings,
      ),
    TrustedToolExecutionApprovalRequiredError,
  );
});

test('accepts only an exact consumed Approved Action dispatch', async () => {
  const current = harness();
  const required = await plan(current, 'approval_required');
  const dispatch = await approvedDispatch(current, required);
  assert.equal(
    assertTrustedToolApprovedDispatch(required, current.bindings, dispatch).id,
    dispatch.id,
  );
  assert.throws(
    () =>
      assertTrustedToolApprovedDispatch(required, current.bindings, {
        ...dispatch,
        action: { ...dispatch.action, actionRef: 'tool-plan:replaced' },
      }),
    TrustedToolInvocationBindingConflictError,
  );
});

test('admits a ready Tool only after fresh Policy and durable start evidence', async () => {
  const current = harness();
  const ready = await plan(current);
  const policy = authorizer();
  const admitted = await admitTrustedToolExecution(current.bindings, ready, {
    principal: principal(),
    profile: 'edge',
    nowMs: 1_400,
    authorizer: policy,
    evidence: evidence(),
  });
  assert.equal(admitted.schema, TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA);
  assert.equal(admitted.planDigest, ready.planDigest);
  assert.equal(admitted.approvalDispatchId, null);
  assert.deepEqual(admitted.policyFence, FENCE);
  assert.equal(admitted.evidence.stepRun.id, 'step-run-001');
  assert.match(admitted.admissionDigest, /^[0-9a-f]{64}$/);
  assert.equal('input' in admitted, false);
  assert.equal('execute' in admitted, false);
  assert.deepEqual(
    policy.calls.map(({ permission }) => permission),
    ['tool.call:demo.compare', 'run.read'],
  );
});

test('requires exact approval dispatch before admitting an approval plan', async () => {
  const current = harness();
  const required = await plan(current, 'approval_required');
  await assert.rejects(
    admitTrustedToolExecution(current.bindings, required, {
      principal: principal(),
      profile: 'edge',
      nowMs: 1_400,
      authorizer: authorizer(),
      evidence: evidence(),
    }),
    TrustedToolExecutionApprovalRequiredError,
  );
  const dispatch = await approvedDispatch(current, required);
  const admitted = await admitTrustedToolExecution(current.bindings, required, {
    principal: principal(),
    profile: 'edge',
    nowMs: 1_400,
    authorizer: authorizer(),
    evidence: evidence(),
    dispatch,
  });
  assert.equal(admitted.approvalDispatchId, dispatch.id);
  assert.match(admitted.approvalDispatchDigest, /^[0-9a-f]{64}$/);
});

test('fails closed on current deny, approval escalation, mixed fence and unavailable Policy', async () => {
  const current = harness();
  const ready = await plan(current);
  await assert.rejects(
    admitTrustedToolExecution(current.bindings, ready, {
      principal: principal(),
      profile: 'edge',
      nowMs: 1_400,
      authorizer: authorizer(() => decision('deny', null)),
      evidence: evidence(),
    }),
    TrustedToolExecutionPolicyDeniedError,
  );
  await assert.rejects(
    admitTrustedToolExecution(current.bindings, ready, {
      principal: principal(),
      profile: 'edge',
      nowMs: 1_400,
      authorizer: authorizer(() => decision('require_approval')),
      evidence: evidence(),
    }),
    TrustedToolExecutionApprovalRequiredError,
  );
  await assert.rejects(
    admitTrustedToolExecution(current.bindings, ready, {
      principal: principal(),
      profile: 'edge',
      nowMs: 1_400,
      authorizer: authorizer((permission) =>
        decision('allow', {
          projectVersion: permission === 'run.read' ? 4 : 3,
          bindingVersion: 7,
        }),
      ),
      evidence: evidence(),
    }),
    TrustedToolExecutionPolicyUnavailableError,
  );
  await assert.rejects(
    admitTrustedToolExecution(current.bindings, ready, {
      principal: principal(),
      profile: 'edge',
      nowMs: 1_400,
      authorizer: {
        async authorize() {
          throw new Error('database unavailable');
        },
      },
      evidence: evidence(),
    }),
    TrustedToolExecutionPolicyUnavailableError,
  );
});

test('rejects missing StepRun, Trace or Audit evidence and Profile drift', async () => {
  const current = harness();
  const ready = await plan(current);
  await assert.rejects(
    admitTrustedToolExecution(current.bindings, ready, {
      principal: principal(),
      profile: 'edge',
      nowMs: 1_400,
      authorizer: authorizer(),
      evidence: evidence({ stepRun: { version: 0 } }),
    }),
    InvalidTrustedToolInvocationError,
  );
  await assert.rejects(
    admitTrustedToolExecution(current.bindings, ready, {
      principal: principal(),
      profile: 'standalone',
      nowMs: 1_400,
      authorizer: authorizer(),
      evidence: evidence(),
    }),
    TrustedToolInvocationBindingConflictError,
  );
});

test('exports the same contract through root and explicit subpath without authority imports', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/trusted-tool-invocation');
  assert.equal(
    root.TrustedToolHandlerBindingRegistry,
    TrustedToolHandlerBindingRegistry,
  );
  assert.equal(subpath.admitTrustedToolExecution, admitTrustedToolExecution);
  const source = readFileSync(
    join(__dirname, '..', 'src', 'tool-execution', 'trustedToolInvocation.ts'),
    'utf8',
  );
  for (const authority of [
    'node:child_process',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:worker_threads',
  ]) {
    assert.equal(source.includes(`from '${authority}'`), false);
  }
});
