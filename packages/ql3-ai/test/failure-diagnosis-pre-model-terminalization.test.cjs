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
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  createCopilotFailureDiagnosisAdmissionBundle,
  prepareCopilotFailureDiagnosisExecution,
} = require('@qinglong/ai/failure-diagnosis-execution-admission');
const {
  CopilotFailureDiagnosisPreModelTerminalizationNotReadyError,
  normalizeCopilotFailureDiagnosisPreModelTerminalizationCommand,
  terminalizeCopilotFailureDiagnosisBeforeModel,
} = require('@qinglong/ai/failure-diagnosis-pre-model-terminalization');

const NOW = 4_000;

async function plan() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-terminalization-test',
    projectId: 'project-terminalization',
    packageName: 'qinglong',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    resources: [],
  });
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-terminalization',
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
    subject: { type: 'user', id: 'owner-terminalization' },
    authenticationId: 'auth-terminalization',
    authenticatedAtMs: 1_000,
    expiresAtMs: 10_000,
    assurance: 'multi_factor',
  };
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(snapshot),
    {
      projectId: 'project-terminalization',
      principal,
      nowMs: 1_200,
      tool: BUILTIN_RUN_LOG_EXCERPT_TOOL,
      input: { runId: 'source-run-failed', attemptId: 'source-attempt-failed' },
    },
    {
      async authorize() {
        return {
          effect: 'allow',
          reasons: ['role_grant'],
          fence: { projectVersion: 1, bindingVersion: 1 },
        };
      },
    },
  );
  const tool = createTrustedToolInvocationPlan(bindings, invocation, {
    actionRef: 'terminalization-log-tool',
    inputArtifactId: 'terminalization-input',
    previewArtifactId: 'terminalization-preview',
    artifactKeyId: 'terminalization-key',
    artifactKey: Buffer.alloc(32, 0x11),
    artifactNonce: Buffer.alloc(12, 0x22),
    profile: 'cluster-control',
    preview: {
      title: 'Read failed Run log',
      summary: 'Read bounded evidence',
      fields: [
        { kind: 'identifier', label: 'Run', value: 'source-run-failed' },
        {
          kind: 'identifier',
          label: 'Attempt',
          value: 'source-attempt-failed',
        },
      ],
      warnings: ['potentially_sensitive_output'],
    },
    sealedAtMs: 2_000,
  });
  return prepareCopilotFailureDiagnosisExecution({
    requestId: 'terminalization-request-1',
    traceId: 'terminalization-trace-1',
    source: {
      runId: 'source-run-failed',
      runVersion: 4,
      runStatus: 'failed',
      attemptId: 'source-attempt-failed',
      attemptStatus: 'failed',
      attemptFinishedAtMs: 1_900,
      logArtifactId: 'source-log-artifact',
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
        revision: 'terminalization-policy-v1',
        potentiallySensitiveDataBoundaries: ['external'],
        maxInputBytes: 64 * 1024,
        maxOutputTokens: 512,
      },
    },
    plannedAtMs: 2_100,
    deadlineAtMs: 8_000,
  });
}

function transition(step, runVersion, to, atMs, suffix, outputRef) {
  return transitionStepRunMutation(
    step,
    {
      expectedVersion: step.version,
      expectedDigest: step.stepRunDigest,
      mutationId: `fixture-mutation-${suffix}`,
      to,
      atMs,
      ...(outputRef ? { outputRef } : {}),
      ...(['failed', 'timed_out', 'cancelled'].includes(to)
        ? { resultCode: `fixture_${to}` }
        : {}),
      ...(['failed', 'timed_out'].includes(to)
        ? { errorSummary: `Fixture ${to}` }
        : {}),
    },
    {
      expectedRunVersion: runVersion,
      expectedRunEventSequence: runVersion,
      eventId: `fixture-event-${suffix}`,
      dedupeKey: `fixture-event-${suffix}`,
      actor: { type: 'system' },
    },
  );
}

function repository(authority) {
  let command = null;
  return {
    value: {
      async findByRequestId() {
        return null;
      },
      async readAuthority() {
        return authority;
      },
      async commit(value) {
        command =
          normalizeCopilotFailureDiagnosisPreModelTerminalizationCommand(value);
        return { status: 'created', receipt: command.receipt };
      },
    },
    command: () => command,
  };
}

test('terminalizes a durable Tool failure and cancels the pending Model Step', async () => {
  const current = await plan();
  const admitted = createCopilotFailureDiagnosisAdmissionBundle(current);
  const started = transition(
    admitted.toolStepMutation.stepRun,
    3,
    'running',
    2_500,
    'tool-start',
  );
  const failed = transition(started.stepRun, 4, 'failed', 3_000, 'tool-failed');
  const storage = repository({
    plan: current,
    run: {
      id: current.runId,
      projectId: current.projectId,
      status: 'running',
      version: 5,
      eventSequence: 5,
    },
    toolStep: failed.stepRun,
    modelStep: admitted.modelStepMutation.stepRun,
    modelStartExists: false,
    observedAtMs: NOW,
  });
  const result = await terminalizeCopilotFailureDiagnosisBeforeModel(
    current.requestId,
    {
      kind: 'tool_failure',
      completion: {
        startId: 'tool-start-1',
        runId: current.runId,
        stepRunId: current.toolStepRunId,
        outcome: 'failed',
        completedStepRunDigest: failed.stepRun.stepRunDigest,
        completionDigest: 'd'.repeat(64),
      },
    },
    { repository: storage.value },
  );
  assert.equal(result.receipt.reason, 'tool_failed');
  assert.equal(result.receipt.outcome, 'failed');
  assert.equal(result.receipt.terminalSteps.length, 1);
  assert.equal(
    result.receipt.terminalSteps[0].stepRunId,
    current.modelStepRunId,
  );
  assert.equal(result.receipt.terminalSteps[0].status, 'cancelled');
  assert.equal(storage.command().expectedRunVersion, 5);
  assert.equal(result.receipt.finalRunVersion, 7);
});

test('terminalizes every non-available log status without exposing content', async () => {
  for (const status of ['not_found', 'pending', 'missing', 'retired']) {
    const current = await plan();
    const admitted = createCopilotFailureDiagnosisAdmissionBundle(current);
    const toolStarted = transition(
      admitted.toolStepMutation.stepRun,
      3,
      'running',
      2_500,
      `start-${status}`,
    );
    const toolSucceeded = transition(
      toolStarted.stepRun,
      4,
      'succeeded',
      3_000,
      `success-${status}`,
      'tool-result-artifact',
    );
    const modelReady = transition(
      admitted.modelStepMutation.stepRun,
      5,
      'ready',
      3_100,
      `ready-${status}`,
    );
    const storage = repository({
      plan: current,
      run: {
        id: current.runId,
        projectId: current.projectId,
        status: 'running',
        version: 6,
        eventSequence: 6,
      },
      toolStep: toolSucceeded.stepRun,
      modelStep: modelReady.stepRun,
      modelStartExists: false,
      observedAtMs: NOW,
    });
    const result = await terminalizeCopilotFailureDiagnosisBeforeModel(
      current.requestId,
      {
        kind: 'tool_projection',
        completion: {
          startId: 'tool-start-1',
          runId: current.runId,
          stepRunId: current.toolStepRunId,
          completedStepRunDigest: toolSucceeded.stepRun.stepRunDigest,
          completionDigest: 'e'.repeat(64),
        },
        output: {
          status,
          runId: current.source.runId,
          attemptId: current.source.attemptId,
          profile: 'cluster-control',
        },
      },
      { repository: storage.value },
    );
    assert.equal(result.receipt.reason, `log_${status}`);
    assert.equal(result.receipt.outcome, 'failed');
    assert.equal(result.receipt.terminalSteps[0].status, 'failed');
    assert.equal(JSON.stringify(result.receipt).includes('log content'), false);
  }
});

test('database-observed deadline terminalizes both unstarted Steps', async () => {
  const current = await plan();
  const admitted = createCopilotFailureDiagnosisAdmissionBundle(current);
  const storage = repository({
    plan: current,
    run: {
      id: current.runId,
      projectId: current.projectId,
      status: 'running',
      version: 3,
      eventSequence: 3,
    },
    toolStep: admitted.toolStepMutation.stepRun,
    modelStep: admitted.modelStepMutation.stepRun,
    modelStartExists: false,
    observedAtMs: current.deadlineAtMs,
  });
  const result = await terminalizeCopilotFailureDiagnosisBeforeModel(
    current.requestId,
    { kind: 'boundary' },
    { repository: storage.value },
  );
  assert.equal(result.receipt.reason, 'deadline_exceeded');
  assert.equal(result.receipt.outcome, 'timed_out');
  assert.deepEqual(
    result.receipt.terminalSteps.map(({ status }) => status),
    ['timed_out', 'cancelled'],
  );
  assert.equal(result.receipt.finalRunVersion, 6);
});

test('insufficient durable Tool budget terminalizes before starting the Tool', async () => {
  const current = await plan();
  const admitted = createCopilotFailureDiagnosisAdmissionBundle(current);
  const storage = repository({
    plan: current,
    run: {
      id: current.runId,
      projectId: current.projectId,
      status: 'running',
      version: 3,
      eventSequence: 3,
    },
    toolStep: admitted.toolStepMutation.stepRun,
    modelStep: admitted.modelStepMutation.stepRun,
    modelStartExists: false,
    observedAtMs: current.deadlineAtMs - 4_999,
  });
  const result = await terminalizeCopilotFailureDiagnosisBeforeModel(
    current.requestId,
    { kind: 'boundary' },
    { repository: storage.value },
  );
  assert.equal(result.receipt.reason, 'tool_budget_exhausted');
  assert.equal(result.receipt.outcome, 'timed_out');
  assert.deepEqual(
    result.receipt.terminalSteps.map(({ status }) => status),
    ['timed_out', 'cancelled'],
  );
});

test('durable cancellation terminalizes both unstarted Steps', async () => {
  const current = await plan();
  const admitted = createCopilotFailureDiagnosisAdmissionBundle(current);
  const storage = repository({
    plan: current,
    run: {
      id: current.runId,
      projectId: current.projectId,
      status: 'running',
      version: 3,
      eventSequence: 3,
      cancelRequestedAtMs: NOW - 1,
      cancelReason: 'user',
    },
    toolStep: admitted.toolStepMutation.stepRun,
    modelStep: admitted.modelStepMutation.stepRun,
    modelStartExists: false,
    observedAtMs: NOW,
  });
  const result = await terminalizeCopilotFailureDiagnosisBeforeModel(
    current.requestId,
    { kind: 'boundary' },
    { repository: storage.value },
  );
  assert.equal(result.receipt.reason, 'cancellation_requested');
  assert.equal(result.receipt.outcome, 'cancelled');
  assert.deepEqual(
    result.receipt.terminalSteps.map(({ status }) => status),
    ['cancelled', 'cancelled'],
  );
});

test('refuses early boundary settlement and any pre-Model lie after Model start', async () => {
  const current = await plan();
  const admitted = createCopilotFailureDiagnosisAdmissionBundle(current);
  const base = {
    plan: current,
    run: {
      id: current.runId,
      projectId: current.projectId,
      status: 'running',
      version: 3,
      eventSequence: 3,
    },
    toolStep: admitted.toolStepMutation.stepRun,
    modelStep: admitted.modelStepMutation.stepRun,
    observedAtMs: current.deadlineAtMs - 5_001,
  };
  await assert.rejects(
    terminalizeCopilotFailureDiagnosisBeforeModel(
      current.requestId,
      { kind: 'boundary' },
      { repository: repository({ ...base, modelStartExists: false }).value },
    ),
    CopilotFailureDiagnosisPreModelTerminalizationNotReadyError,
  );
  await assert.rejects(
    terminalizeCopilotFailureDiagnosisBeforeModel(
      current.requestId,
      { kind: 'boundary' },
      {
        repository: repository({
          ...base,
          modelStartExists: true,
          observedAtMs: current.deadlineAtMs,
        }).value,
      },
    ),
    /pre-Model authority is invalid/,
  );
});
