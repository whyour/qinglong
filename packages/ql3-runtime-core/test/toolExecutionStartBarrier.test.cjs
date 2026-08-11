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
  createStepRunRecord,
  transitionStepRunMutation,
  transitionStepRunRecord,
} = require('../dist/run/stepRun');
const {
  InvalidToolExecutionStartBarrierError,
  TOOL_EXECUTION_START_BARRIER_SCHEMA,
  TOOL_EXECUTION_START_COMMAND_SCHEMA,
  createToolExecutionStartCommand,
  normalizeToolExecutionStartBarrierRecord,
  normalizeToolExecutionStartCommand,
  toolExecutionStartBarrierRecord,
} = require('../dist/tool-execution/toolExecutionStartBarrier');
const {
  TOOL_EXECUTION_START_AUDIT_OPERATION,
  createToolExecutionEvidenceBundle,
  toolExecutionAdmissionEvidence,
} = require('../dist/tool-execution/toolExecutionEvidence');
const {
  TrustedToolHandlerBindingRegistry,
  admitTrustedToolExecution,
  createTrustedToolHandlerBinding,
  createTrustedToolInvocationPlan,
  trustedToolContractIdentityDigest,
  trustedToolInvocationApprovalBinding,
} = require('../dist/tool-execution/trustedToolInvocation');
const {
  prepareToolInvocation,
} = require('../dist/tool-execution/tool-registry/toolRegistry');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const REQUESTER = Object.freeze({ type: 'user', id: 'usr-tool-owner' });
const SYSTEM = Object.freeze({ type: 'system', id: 'tool-dispatcher' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 7 });
const NOW_MS = 1_400;

function definition() {
  return {
    name: 'demo.compare',
    version: '1.0.0',
    description: 'Compare one bounded Run projection',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, maxLength: 64 },
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
    timeoutSeconds: 30,
  };
}

function snapshot() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-demo',
    projectId: 'project-001',
    packageName: 'demo',
    lockDigest: DIGEST_A,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: DIGEST_B,
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [
      {
        generation,
        revisionDigest: DIGEST_C,
        definitions: [definition()],
      },
    ],
  });
}

function principal() {
  return {
    subject: REQUESTER,
    authenticationId: 'auth-tool-1',
    authenticatedAtMs: 800,
    expiresAtMs: 10_000,
    assurance: 'local_console',
  };
}

function authorizer(effect = 'allow') {
  return {
    async authorize() {
      return {
        effect,
        reasons:
          effect === 'allow'
            ? ['role_grant']
            : ['agent_action_requires_approval'],
        fence: FENCE,
      };
    },
  };
}

async function approvedDispatch(currentPlan) {
  const action = trustedToolInvocationApprovalBinding(
    currentPlan.plan,
    currentPlan.bindings,
  );
  const request = createApprovalRequest({
    id: 'approval-tool-001',
    projectId: currentPlan.plan.projectId,
    action,
    risk: currentPlan.plan.risk,
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 1_050,
    expiresAtMs: 9_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(request, {
    expectedVersion: 1,
    decisionId: 'decision-tool-001',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: principal(),
    decidedAtMs: 1_100,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-tool-001',
    dispatchId: 'dispatch-tool-001',
    action,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 1_200,
    authorizationFence: FENCE,
  }).dispatch;
}

async function fixture(options = {}) {
  const currentSnapshot = snapshot();
  const binding = createTrustedToolHandlerBinding(currentSnapshot, {
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
  });
  const bindings = new TrustedToolHandlerBindingRegistry(currentSnapshot, [
    binding,
  ]);
  const approvalRequired = options.approvalRequired === true;
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(currentSnapshot),
    {
      projectId: 'project-001',
      principal: principal(),
      nowMs: 900,
      tool: { name: 'demo.compare', version: '1.0.0' },
      input: { runId: 'run-001' },
    },
    authorizer(approvalRequired ? 'require_approval' : 'allow'),
  );
  const plan = (
    await createTrustedToolInvocationPlan(bindings, invocation, {
      actionRef: 'tool-plan:run-001',
      inputArtifactId: 'artifact-input-001',
      previewArtifactId: 'artifact-preview-001',
      artifactKeyId: 'tool-key-test',
      artifactKey: Buffer.alloc(32, 7),
      artifactNonce: Buffer.alloc(12, 9),
      profile: 'edge',
      preview: {
        title: 'Compare Run',
        summary: 'Reads one Run projection',
        fields: [{ kind: 'identifier', label: 'Run', value: 'run-001' }],
        warnings: [],
      },
      sealedAtMs: 1_000,
    })
  ).plan;
  const ready = createStepRunRecord({
    id: 'step-run-001',
    runId: 'run-001',
    stepKey: 'workflow.compare',
    kind: 'tool',
    definitionRef: 'tool:demo.compare@1.0.0',
    definitionDigest: binding.definitionDigest,
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:step-input-001',
    mutationId: 'step-create-001',
    createdAtMs: 1_000,
  });
  const planWithBindings = { plan, bindings };
  const dispatch = approvalRequired
    ? await approvedDispatch(planWithBindings)
    : undefined;
  const previous = approvalRequired
    ? transitionStepRunRecord(ready, {
        expectedVersion: ready.version,
        expectedDigest: ready.stepRunDigest,
        mutationId: 'step-waiting-002',
        to: 'waiting_approval',
        atMs: 1_200,
        approvalRequestId: dispatch.approvalRequestId,
      })
    : ready;
  const evidence = createToolExecutionEvidenceBundle({
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    projectId: 'project-001',
    runId: 'run-001',
    stepRunId: previous.id,
    invocationPlanDigest: plan.planDigest,
    bindingDigest: binding.bindingDigest,
    adapterDigest:
      options.adapterDigest ??
      trustedToolContractIdentityDigest(binding.adapter),
    redactionContractDigest: trustedToolContractIdentityDigest(
      binding.redactionContract,
    ),
    auditContractDigest: trustedToolContractIdentityDigest(
      binding.auditContract,
    ),
    audit: {
      eventId: '40000000-0000-4000-8000-000000000001',
      requestId: 'tool-request-001',
      operationId: TOOL_EXECUTION_START_AUDIT_OPERATION,
      projectId: 'project-001',
      subject: REQUESTER,
      authenticationId: 'auth-tool-1',
      outcome: 'allowed',
      reasons: ['tool_execution_start'],
      fence: FENCE,
      occurredAtMs: NOW_MS,
    },
    createdAtMs: NOW_MS,
  });
  const admission = await admitTrustedToolExecution(bindings, plan, {
    principal: principal(),
    profile: 'edge',
    nowMs: NOW_MS,
    authorizer: authorizer(),
    evidence: {
      stepRun: {
        id: previous.id,
        version: previous.version,
        digest: previous.stepRunDigest,
      },
      ...toolExecutionAdmissionEvidence(evidence),
    },
    ...(dispatch ? { dispatch } : {}),
  });
  const stepRunMutation = transitionStepRunMutation(
    previous,
    {
      expectedVersion: previous.version,
      expectedDigest: previous.stepRunDigest,
      mutationId: 'step-running-003',
      to: 'running',
      atMs: NOW_MS,
      ...(dispatch ? { approvalRequestId: dispatch.approvalRequestId } : {}),
    },
    {
      expectedRunVersion: 5,
      expectedRunEventSequence: 8,
      eventId: 'event-step-running-001',
      dedupeKey: 'step-running:step-run-001',
      actor: REQUESTER,
    },
  );
  return { admission, binding, evidence, stepRunMutation };
}

function copy(value) {
  return structuredClone(value);
}

test('creates one immutable same-transaction Tool start command and barrier', async () => {
  const current = await fixture();
  const command = createToolExecutionStartCommand({
    startId: 'tool-start-001',
    admission: current.admission,
    evidence: current.evidence,
    stepRunMutation: current.stepRunMutation,
  });
  const barrier = toolExecutionStartBarrierRecord(command);

  assert.equal(command.schema, TOOL_EXECUTION_START_COMMAND_SCHEMA);
  assert.equal(barrier.schema, TOOL_EXECUTION_START_BARRIER_SCHEMA);
  assert.equal(barrier.projectId, 'project-001');
  assert.equal(barrier.stepRunId, 'step-run-001');
  assert.equal(barrier.previousStepRunVersion, 1);
  assert.equal(barrier.startedStepRunVersion, 2);
  assert.equal(barrier.approvalRequestId, null);
  assert.equal(barrier.adapterDigest, current.evidence.trace.adapterDigest);
  assert.match(command.commandDigest, /^[0-9a-f]{64}$/);
  assert.match(barrier.barrierDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(command), true);
  assert.deepEqual(normalizeToolExecutionStartCommand(command), command);
  assert.deepEqual(normalizeToolExecutionStartBarrierRecord(barrier), barrier);
  for (const sensitive of ['input', 'handler', 'execute', 'token', 'secret']) {
    assert.equal(sensitive in barrier, false);
  }
});

test('binds an approved start to the exact waiting Approval request', async () => {
  const current = await fixture({ approvalRequired: true });
  const command = createToolExecutionStartCommand({
    startId: 'tool-start-approved-001',
    admission: current.admission,
    evidence: current.evidence,
    stepRunMutation: current.stepRunMutation,
  });
  const barrier = toolExecutionStartBarrierRecord(command);
  assert.equal(barrier.approvalRequestId, 'approval-tool-001');
  assert.equal(barrier.approvalDispatchId, 'dispatch-tool-001');
  assert.equal(command.stepRunMutation.previousStatus, 'waiting_approval');
  assert.equal(
    command.stepRunMutation.stepRun.approvalRequestId,
    barrier.approvalRequestId,
  );
});

test('rejects detached contract, StepRun, audit and approval bindings', async () => {
  const current = await fixture();
  const wrongContract = await fixture({ adapterDigest: DIGEST_A });
  assert.notEqual(
    DIGEST_A,
    trustedToolContractIdentityDigest(wrongContract.binding.adapter),
  );
  assert.throws(
    () =>
      createToolExecutionStartCommand({
        startId: 'tool-start-wrong-contract',
        admission: wrongContract.admission,
        evidence: wrongContract.evidence,
        stepRunMutation: wrongContract.stepRunMutation,
      }),
    InvalidToolExecutionStartBarrierError,
  );
  assert.throws(
    () =>
      createToolExecutionStartCommand({
        startId: 'tool-start-wrong-step',
        admission: current.admission,
        evidence: current.evidence,
        stepRunMutation: {
          ...copy(current.stepRunMutation),
          runId: 'run-other',
        },
      }),
    InvalidToolExecutionStartBarrierError,
  );

  const approved = await fixture({ approvalRequired: true });
  assert.throws(
    () =>
      createToolExecutionStartCommand({
        startId: 'tool-start-wrong-approval',
        admission: approved.admission,
        evidence: approved.evidence,
        stepRunMutation: current.stepRunMutation,
      }),
    InvalidToolExecutionStartBarrierError,
  );
});

test('rejects unknown fields, accessors and digest tampering', async () => {
  const current = await fixture();
  const command = createToolExecutionStartCommand({
    startId: 'tool-start-001',
    admission: current.admission,
    evidence: current.evidence,
    stepRunMutation: current.stepRunMutation,
  });
  const barrier = toolExecutionStartBarrierRecord(command);

  assert.throws(
    () =>
      normalizeToolExecutionStartCommand({
        ...copy(command),
        commandDigest: DIGEST_A,
      }),
    InvalidToolExecutionStartBarrierError,
  );
  assert.throws(
    () =>
      normalizeToolExecutionStartBarrierRecord({
        ...copy(barrier),
        adapterDigest: DIGEST_A,
      }),
    InvalidToolExecutionStartBarrierError,
  );
  assert.throws(
    () => normalizeToolExecutionStartCommand({ ...copy(command), extra: 1 }),
    InvalidToolExecutionStartBarrierError,
  );
  const accessor = copy(command);
  Object.defineProperty(accessor, 'startId', {
    enumerable: true,
    get() {
      return 'tool-start-accessor';
    },
  });
  assert.throws(
    () => normalizeToolExecutionStartCommand(accessor),
    InvalidToolExecutionStartBarrierError,
  );
});

test('publishes the contract through root and explicit subpath without authority', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/tool-execution-start-barrier');
  assert.equal(
    root.createToolExecutionStartCommand,
    createToolExecutionStartCommand,
  );
  assert.equal(
    subpath.toolExecutionStartBarrierRecord,
    toolExecutionStartBarrierRecord,
  );
  const source = readFileSync(
    join(
      __dirname,
      '..',
      'src',
      'tool-execution',
      'toolExecutionStartBarrier.ts',
    ),
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
