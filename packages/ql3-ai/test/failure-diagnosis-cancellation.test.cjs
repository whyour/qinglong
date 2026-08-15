const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_RUN_LOG_EXCERPT_TOOL,
  BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION,
  createBuiltInRunLogExcerptToolHandlerBinding,
} = require('@qinglong/runtime-core/builtin-run-log-excerpt-tool');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionRegistry,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  prepareToolInvocation,
} = require('@qinglong/runtime-core/tool-registry');
const {
  TrustedToolHandlerBindingRegistry,
  createTrustedToolInvocationPlan,
} = require('@qinglong/runtime-core/trusted-tool-invocation');
const {
  CopilotFailureDiagnosisCancellationNotFoundError,
  CopilotFailureDiagnosisCancellationService,
  CopilotFailureDiagnosisCancellationUnavailableError,
} = require('@qinglong/ai/failure-diagnosis-cancellation');
const {
  createCopilotFailureDiagnosisAdmissionBundle,
  prepareCopilotFailureDiagnosisExecution,
} = require('@qinglong/ai/failure-diagnosis-execution-admission');
const {
  CopilotFailureDiagnosisPreModelTerminalizationConflictError,
} = require('@qinglong/ai/failure-diagnosis-pre-model-terminalization');

async function durablePlan() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-cancel-test',
    projectId: 'project-cancel',
    packageName: 'qinglong',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    resources: [],
  });
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-cancel',
    contributions: [
      {
        generation,
        revisionDigest: 'c'.repeat(64),
        definitions: [BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION],
      },
    ],
  });
  const binding = createBuiltInRunLogExcerptToolHandlerBinding(snapshot, [
    'cluster-control',
  ]);
  const bindings = new TrustedToolHandlerBindingRegistry(snapshot, [binding]);
  const principal = {
    subject: { type: 'user', id: 'owner-cancel' },
    authenticationId: 'auth-cancel',
    authenticatedAtMs: 100,
    expiresAtMs: 10_000,
    assurance: 'multi_factor',
  };
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(snapshot),
    {
      projectId: 'project-cancel',
      principal,
      nowMs: 200,
      tool: BUILTIN_RUN_LOG_EXCERPT_TOOL,
      input: { runId: 'source-run-cancel', attemptId: 'source-attempt-cancel' },
    },
    {
      async authorize() {
        return {
          effect: 'allow',
          reasons: ['role_grant'],
          fence: { projectVersion: 2, bindingVersion: 3 },
        };
      },
    },
  );
  const tool = createTrustedToolInvocationPlan(bindings, invocation, {
    actionRef: 'cancel-log-tool',
    inputArtifactId: 'cancel-input',
    previewArtifactId: 'cancel-preview',
    artifactKeyId: 'cancel-key',
    artifactKey: Buffer.alloc(32, 0x11),
    artifactNonce: Buffer.alloc(12, 0x22),
    profile: 'cluster-control',
    preview: {
      title: 'Read failed Run log',
      summary: 'Read bounded evidence',
      fields: [
        { kind: 'identifier', label: 'Run', value: 'source-run-cancel' },
        {
          kind: 'identifier',
          label: 'Attempt',
          value: 'source-attempt-cancel',
        },
      ],
      warnings: ['potentially_sensitive_output'],
    },
    sealedAtMs: 300,
  });
  return prepareCopilotFailureDiagnosisExecution({
    requestId: 'diagnosis-request-cancel',
    traceId: 'diagnosis-trace-cancel',
    source: {
      runId: 'source-run-cancel',
      runVersion: 4,
      runStatus: 'failed',
      attemptId: 'source-attempt-cancel',
      attemptStatus: 'failed',
      attemptFinishedAtMs: 250,
      logArtifactId: 'source-log-cancel',
    },
    toolPlan: tool.plan,
    bindings,
    model: {
      provider: 'provider-primary',
      model: 'model-diagnosis',
      modelBoundary: 'external',
      responseLanguage: 'zh-CN',
      maxOutputTokens: 256,
      egressPolicy: {
        schema: 'qinglong/copilot-model-egress-policy@v1',
        revision: 'cancel-policy-v1',
        potentiallySensitiveDataBoundaries: ['external'],
        maxInputBytes: 64 * 1024,
        maxOutputTokens: 512,
      },
    },
    plannedAtMs: 400,
    deadlineAtMs: 8_000,
  });
}

function command(overrides = {}) {
  return {
    projectId: 'project-cancel',
    sourceRunId: 'source-run-cancel',
    requestId: 'diagnosis-request-cancel',
    mutationId: '11111111-1111-4111-8111-111111111111',
    eventId: '22222222-2222-4222-8222-222222222222',
    subject: { type: 'user', id: 'owner-cancel' },
    policyFence: { projectVersion: 2, bindingVersion: 3 },
    ...overrides,
  };
}

function fixture(plan, overrides = {}) {
  const receipt = createCopilotFailureDiagnosisAdmissionBundle(plan).receipt;
  const state = {
    cancellationCalls: [],
    terminalizeCalls: 0,
    cancellation: {
      status: 'accepted',
      projectId: plan.projectId,
      runId: plan.runId,
      runStatus: 'running',
      runVersion: 4,
      eventSequence: 4,
      cancelRequestedAtMs: 500,
      cancelReason: 'user',
    },
    authority: {
      plan,
      run: {
        id: plan.runId,
        projectId: plan.projectId,
        status: 'running',
        version: 4,
        eventSequence: 4,
        cancelRequestedAtMs: 500,
        cancelReason: 'user',
      },
      toolStep: {},
      modelStep: {},
      modelStartExists: false,
      observedAtMs: 501,
    },
    ...overrides,
  };
  const terminalizations = {
    repository: {
      async findByRequestId() {
        return null;
      },
      async readAuthority() {
        return state.authority;
      },
      async commit() {
        throw new Error('not called by injected terminalizer');
      },
    },
  };
  const service = new CopilotFailureDiagnosisCancellationService({
    admissions: {
      async findPlanByRequestId() {
        return state.plan === undefined ? plan : state.plan;
      },
      async findByRequestId() {
        return state.receipt === undefined ? receipt : state.receipt;
      },
    },
    cancellations: {
      async requestUserCancellation(value) {
        state.cancellationCalls.push(value);
        return state.cancellation;
      },
    },
    terminalizations,
    async terminalizeBeforeModel(requestId, trigger) {
      state.terminalizeCalls += 1;
      if (state.terminalizeError) throw state.terminalizeError;
      assert.equal(requestId, plan.requestId);
      assert.deepEqual(trigger, { kind: 'boundary' });
      return {
        status: 'created',
        receipt: {
          outcome: 'cancelled',
          finalRunVersion: 7,
          finalRunEventSequence: 7,
        },
      };
    },
  });
  return { service, state, receipt };
}

test('resolves the request key to a server-owned Run and terminalizes pre-Model', async () => {
  const plan = await durablePlan();
  const { service, state } = fixture(plan);
  const result = await service.cancel(command());
  assert.deepEqual(state.cancellationCalls, [
    {
      projectId: 'project-cancel',
      runId: plan.runId,
      mutationId: '11111111-1111-4111-8111-111111111111',
      eventId: '22222222-2222-4222-8222-222222222222',
      subject: { type: 'user', id: 'owner-cancel' },
      policyFence: { projectVersion: 2, bindingVersion: 3 },
    },
  ]);
  assert.equal(state.terminalizeCalls, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(result.convergence, 'terminal');
  assert.equal(result.runStatus, 'cancelled');
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.diagnosisRunId, plan.runId);
  assert.equal(result.cancelRequestedAtMs, 500);
});

test('masks cross-target requests before writing a cancellation intent', async () => {
  const plan = await durablePlan();
  const { service, state } = fixture(plan);
  await assert.rejects(
    service.cancel(command({ sourceRunId: 'other-source-run' })),
    CopilotFailureDiagnosisCancellationNotFoundError,
  );
  assert.equal(state.cancellationCalls.length, 0);
});

test('keeps a durable intent pending when Model start wins the race', async () => {
  const plan = await durablePlan();
  const conflict =
    new CopilotFailureDiagnosisPreModelTerminalizationConflictError(
      'Model started',
    );
  const { service, state } = fixture(plan, {
    terminalizeError: conflict,
    authority: {
      plan,
      run: {
        id: plan.runId,
        projectId: plan.projectId,
        status: 'running',
        version: 5,
        eventSequence: 5,
        cancelRequestedAtMs: 500,
        cancelReason: 'user',
      },
      toolStep: {},
      modelStep: {},
      modelStartExists: true,
      observedAtMs: 501,
    },
  });
  const result = await service.cancel(command());
  assert.equal(state.terminalizeCalls, 1);
  assert.equal(result.convergence, 'model_in_flight');
  assert.equal(result.runStatus, 'running');
  assert.equal(result.outcome, null);
  assert.equal(result.runVersion, 5);
});

test('reports the real terminal winner instead of forging cancellation', async () => {
  const plan = await durablePlan();
  const { service } = fixture(plan, {
    terminalizeError:
      new CopilotFailureDiagnosisPreModelTerminalizationConflictError(),
    authority: {
      plan,
      run: {
        id: plan.runId,
        projectId: plan.projectId,
        status: 'succeeded',
        version: 7,
        eventSequence: 7,
        cancelRequestedAtMs: 500,
        cancelReason: 'user',
      },
      toolStep: {},
      modelStep: {},
      modelStartExists: true,
      observedAtMs: 600,
    },
  });
  const result = await service.cancel(command());
  assert.equal(result.convergence, 'terminal');
  assert.equal(result.runStatus, 'succeeded');
  assert.equal(result.outcome, 'succeeded');
});

test('fails closed when plan and admission receipt drift', async () => {
  const plan = await durablePlan();
  const base = fixture(plan);
  const { service, state } = fixture(plan, {
    receipt: { ...base.receipt, runId: 'diagnosis-run-drift' },
  });
  await assert.rejects(
    service.cancel(command()),
    CopilotFailureDiagnosisCancellationUnavailableError,
  );
  assert.equal(state.cancellationCalls.length, 0);
});
