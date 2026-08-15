const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA,
  COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESULT_SCHEMA,
  CopilotFailureDiagnosisReadService,
  CopilotFailureDiagnosisReadUnavailableError,
} = require('@qinglong/ai/failure-diagnosis-read-model');
const {
  createCopilotFailureDiagnosisOutputArtifact,
} = require('@qinglong/ai/failure-diagnosis-model-execution');

const DIGEST = 'a'.repeat(64);
const COMPLETION_DIGEST = 'b'.repeat(64);

function principal() {
  return {
    subject: { type: 'api_app', id: 'app-1' },
    authenticationId: 'credential-1',
    authenticatedAtMs: 10,
    expiresAtMs: 10_000,
    assurance: 'service',
  };
}

function target(overrides = {}) {
  return {
    principal: principal(),
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'diagnosis-request-1',
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    requestId: 'diagnosis-request-1',
    projectId: 'project-1',
    source: { runId: 'source-run-1' },
    runId: 'diagnosis-run-1',
    modelStepRunId: 'model-step-1',
    modelInvocationId: 'model-invocation-1',
    traceId: 'trace-1',
    planDigest: DIGEST,
    plannedAtMs: 100,
    ...overrides,
  };
}

function admission(overrides = {}) {
  return {
    requestId: 'diagnosis-request-1',
    planDigest: DIGEST,
    runId: 'diagnosis-run-1',
    sourceRunId: 'source-run-1',
    admittedAtMs: 110,
    ...overrides,
  };
}

function finalization(overrides = {}) {
  return {
    requestId: 'diagnosis-request-1',
    planDigest: DIGEST,
    runId: 'diagnosis-run-1',
    modelStepRunId: 'model-step-1',
    invocationId: 'model-invocation-1',
    completionDigest: COMPLETION_DIGEST,
    outcome: 'succeeded',
    outputArtifactId: 'cdo:artifact-1',
    finalizedAtMs: 300,
    ...overrides,
  };
}

function terminalization(overrides = {}) {
  return {
    requestId: 'diagnosis-request-1',
    planDigest: DIGEST,
    runId: 'diagnosis-run-1',
    stage: 'cancellation',
    reason: 'cancellation_requested',
    outcome: 'cancelled',
    finalizedAtMs: 250,
    ...overrides,
  };
}

function usage(overrides = {}) {
  return {
    invocationId: 'model-invocation-1',
    projectId: 'project-1',
    runId: 'diagnosis-run-1',
    stepRunId: 'model-step-1',
    traceId: 'trace-1',
    completionDigest: COMPLETION_DIGEST,
    outcome: 'succeeded',
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    costMicros: 42,
    ...overrides,
  };
}

function settlement(overrides = {}) {
  return {
    invocationId: 'model-invocation-1',
    projectId: 'project-1',
    completionDigest: COMPLETION_DIGEST,
    currency: 'USD',
    inputTokens: 12,
    outputTokens: 8,
    costMicros: 42,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const state = {
    plan: plan(),
    admission: admission(),
    terminalization: null,
    finalization: null,
    usage: null,
    settlement: null,
    artifact: null,
    decision: {
      effect: 'allow',
      reasons: ['role_grant'],
      fence: {
        projectVersion: 1,
        bindingVersion: 1,
      },
    },
    keyMaterial: null,
    keyResolves: 0,
    permissions: [],
    ...overrides,
  };
  const service = new CopilotFailureDiagnosisReadService({
    admissions: {
      async findPlanByRequestId() {
        return state.plan;
      },
      async findByRequestId() {
        return state.admission;
      },
    },
    terminalizations: {
      async findByRequestId() {
        return state.terminalization;
      },
    },
    finalizations: {
      async findFinalization() {
        return state.finalization;
      },
    },
    models: {
      async findCopilotFailureDiagnosisOutput() {
        return state.artifact;
      },
      async findUsage() {
        return state.usage;
      },
      async findPriceSettlement() {
        return state.settlement;
      },
    },
    authorizer: {
      async authorize(_principal, _projectId, permission) {
        state.permissions.push(permission);
        return state.decision;
      },
    },
    keys: {
      async active() {
        throw new Error('read must not request the active key');
      },
      async resolve() {
        state.keyResolves += 1;
        return state.keyMaterial;
      },
    },
    now: () => 500,
  });
  return { service, state };
}

test('inspects running and pre-Model cancellation without content or model metadata', async () => {
  const running = fixture();
  assert.deepEqual(await running.service.inspect(target()), {
    schema: COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA,
    status: 'running',
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'diagnosis-request-1',
    diagnosisRunId: 'diagnosis-run-1',
    outcome: null,
    stage: null,
    reason: null,
    outputAvailable: false,
    admittedAtMs: 110,
    finalizedAtMs: null,
    usage: null,
  });
  assert.deepEqual(running.state.permissions, ['run.read']);

  const cancelled = fixture({ terminalization: terminalization() });
  const result = await cancelled.service.inspect(target());
  assert.equal(result.status, 'terminal');
  assert.equal(result.stage, 'cancellation');
  assert.equal(result.reason, 'cancellation_requested');
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    currency: 'USD',
    costMicros: 0,
  });
  assert.equal(JSON.stringify(result).includes('provider'), false);
});

test('projects only exact durable usage and price settlement', async () => {
  const settled = fixture({
    finalization: finalization(),
    usage: usage(),
    settlement: settlement(),
  });
  const result = await settled.service.inspect(target());
  assert.equal(result.status, 'terminal');
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.outputAvailable, true);
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    currency: 'USD',
    costMicros: 42,
  });

  const unpriced = fixture({
    finalization: finalization(),
    usage: usage({ costMicros: null }),
  });
  assert.deepEqual((await unpriced.service.inspect(target())).usage, {
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    currency: null,
    costMicros: null,
  });

  const inconsistent = fixture({
    finalization: finalization(),
    usage: usage(),
    settlement: settlement({ costMicros: 43 }),
  });
  await assert.rejects(
    inconsistent.service.inspect(target()),
    CopilotFailureDiagnosisReadUnavailableError,
  );
});

test('masks absence, cross-target and current Policy denial and rejects dual terminal facts', async () => {
  const absent = fixture({ plan: null, admission: null });
  assert.equal((await absent.service.inspect(target())).status, 'not_found');

  const incompleteAdmission = fixture({ plan: null });
  await assert.rejects(
    incompleteAdmission.service.inspect(target()),
    CopilotFailureDiagnosisReadUnavailableError,
  );

  const crossProject = fixture({ plan: plan({ projectId: 'project-2' }) });
  assert.equal(
    (await crossProject.service.inspect(target())).status,
    'not_found',
  );
  assert.deepEqual(crossProject.state.permissions, []);

  const denied = fixture({
    decision: { effect: 'deny', reasons: ['permission_missing'], fence: null },
  });
  assert.equal((await denied.service.inspect(target())).status, 'not_found');

  const conflict = fixture({
    terminalization: terminalization(),
    finalization: finalization(),
  });
  await assert.rejects(
    conflict.service.inspect(target()),
    CopilotFailureDiagnosisReadUnavailableError,
  );
});

test('decrypts an exact success Artifact, omits provider/model and wipes resolved key', async () => {
  const encryptionKey = Buffer.alloc(32, 0x44);
  const artifact = createCopilotFailureDiagnosisOutputArtifact(
    {
      requestId: 'diagnosis-request-1',
      planDigest: DIGEST,
      toolCompletionDigest: 'c'.repeat(64),
      projectId: 'project-1',
      runId: 'diagnosis-run-1',
      stepRunId: 'model-step-1',
      invocationId: 'model-invocation-1',
      result: {
        provider: 'private-provider',
        model: 'private-model',
        text: 'bounded diagnosis',
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      },
      egressEvidence: { policyRevision: 'private-policy' },
      keyId: 'output-key-1',
      key: encryptionKey,
      sealedAtMs: 200,
    },
    () => Buffer.alloc(12, 0x22),
  );
  const resolvedKey = Buffer.from(encryptionKey);
  const exactFinalization = finalization({
    outputArtifactId: artifact.artifactId,
  });
  const output = fixture({
    finalization: exactFinalization,
    artifact,
    keyMaterial: { keyId: 'output-key-1', key: resolvedKey },
  });
  const result = await output.service.readOutput(target());
  assert.equal(
    result.schema,
    COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESULT_SCHEMA,
  );
  assert.equal(result.status, 'available');
  assert.equal(result.result.text, 'bounded diagnosis');
  assert.equal(result.reference.artifactId, artifact.artifactId);
  assert.equal(JSON.stringify(result).includes('private-provider'), false);
  assert.equal(JSON.stringify(result).includes('private-model'), false);
  assert.equal(
    resolvedKey.every((byte) => byte === 0),
    true,
  );
  assert.deepEqual(output.state.permissions, ['artifact.read']);
});

test('never resolves keys for denial/non-success and wipes keys after tamper failure', async () => {
  const denied = fixture({
    finalization: finalization(),
    decision: { effect: 'deny', reasons: ['permission_missing'], fence: null },
  });
  assert.equal((await denied.service.readOutput(target())).status, 'not_found');
  assert.equal(denied.state.keyResolves, 0);

  const failed = fixture({
    finalization: finalization({
      outcome: 'failed',
      outputArtifactId: null,
    }),
  });
  assert.equal((await failed.service.readOutput(target())).status, 'not_found');
  assert.equal(failed.state.keyResolves, 0);

  const encryptionKey = Buffer.alloc(32, 0x55);
  const artifact = createCopilotFailureDiagnosisOutputArtifact({
    requestId: 'diagnosis-request-1',
    planDigest: DIGEST,
    toolCompletionDigest: 'c'.repeat(64),
    projectId: 'project-1',
    runId: 'diagnosis-run-1',
    stepRunId: 'model-step-1',
    invocationId: 'model-invocation-1',
    result: {
      provider: 'provider',
      model: 'model',
      text: 'diagnosis',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
    egressEvidence: { policyRevision: 'private-policy' },
    keyId: 'output-key-1',
    key: encryptionKey,
    sealedAtMs: 200,
  });
  const resolvedKey = Buffer.from(encryptionKey);
  const tampered = { ...artifact, ciphertext: `${artifact.ciphertext}A` };
  const corrupted = fixture({
    finalization: finalization({ outputArtifactId: artifact.artifactId }),
    artifact: tampered,
    keyMaterial: { keyId: 'output-key-1', key: resolvedKey },
  });
  await assert.rejects(
    corrupted.service.readOutput(target()),
    CopilotFailureDiagnosisReadUnavailableError,
  );
  assert.equal(
    resolvedKey.every((byte) => byte === 0),
    true,
  );
});
