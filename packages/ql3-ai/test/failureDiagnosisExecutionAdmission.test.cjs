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
  COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA,
  COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA,
  InvalidCopilotFailureDiagnosisExecutionPlanError,
  createCopilotFailureDiagnosisAdmissionBundle,
  failureDiagnosisToolInputDigest,
  normalizeCopilotFailureDiagnosisAdmissionReceipt,
  normalizeCopilotFailureDiagnosisExecutionPlan,
  prepareCopilotFailureDiagnosisExecution,
} = require('../dist/copilot/failure-diagnosis/executionAdmission.js');
const {
  storedJsonEquals,
} = require('../dist/copilot/failure-diagnosis/admission/postgresRepository.js');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const SUBJECT = Object.freeze({ type: 'user', id: 'usr-diagnosis-owner' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 7 });
const SOURCE = Object.freeze({
  runId: 'run-source-failed',
  runVersion: 8,
  runStatus: 'failed',
  attemptId: 'attempt-source-final',
  attemptStatus: 'failed',
  attemptFinishedAtMs: 1_900,
  logArtifactId: 'artifact-source-log',
});

test('compares PostgreSQL jsonb evidence independent of object key order', () => {
  assert.equal(
    storedJsonEquals(
      { outer: { beta: 2, alpha: 1 }, items: [{ right: 2, left: 1 }] },
      { items: [{ left: 1, right: 2 }], outer: { alpha: 1, beta: 2 } },
    ),
    true,
  );
  assert.equal(
    storedJsonEquals({ outer: { alpha: 1 } }, { outer: { alpha: 2 } }),
    false,
  );
});

function snapshot() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-qinglong-run-log-excerpt',
    projectId: 'project-diagnosis',
    packageName: 'qinglong',
    lockDigest: DIGEST_A,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: DIGEST_B,
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: 'project-diagnosis',
    contributions: [
      {
        generation,
        revisionDigest: DIGEST_C,
        definitions: [BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION],
      },
    ],
  });
}

function principal() {
  return {
    subject: SUBJECT,
    authenticationId: 'auth-diagnosis-owner',
    authenticatedAtMs: 1_000,
    expiresAtMs: 10_000,
    assurance: 'multi_factor',
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

async function toolHarness(options = {}) {
  const currentSnapshot = snapshot();
  const binding = createBuiltInRunLogExcerptToolHandlerBinding(
    currentSnapshot,
    [options.profile ?? 'cluster-control'],
  );
  const bindings = new TrustedToolHandlerBindingRegistry(currentSnapshot, [
    binding,
  ]);
  const source = options.source ?? SOURCE;
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(currentSnapshot),
    {
      projectId: 'project-diagnosis',
      principal: principal(),
      nowMs: 1_200,
      tool: BUILTIN_RUN_LOG_EXCERPT_TOOL,
      input: {
        runId: options.inputRunId ?? source.runId,
        attemptId: options.inputAttemptId ?? source.attemptId,
      },
    },
    authorizer(options.effect),
  );
  const bundle = createTrustedToolInvocationPlan(bindings, invocation, {
    actionRef: 'diagnosis-log-tool-plan',
    inputArtifactId: 'diagnosis-tool-input',
    previewArtifactId: 'diagnosis-tool-preview',
    artifactKeyId: 'diagnosis-input-key',
    artifactKey: Buffer.alloc(32, 0x21),
    artifactNonce: Buffer.alloc(12, 0x31),
    profile: options.profile ?? 'cluster-control',
    preview: {
      title: 'Read failed Run log',
      summary: 'Reads one bounded redacted log excerpt',
      fields: [
        { kind: 'identifier', label: 'Run', value: source.runId },
        { kind: 'identifier', label: 'Attempt', value: source.attemptId },
      ],
      warnings: ['potentially_sensitive_output'],
    },
    sealedAtMs: 2_000,
  });
  return { bindings, toolPlan: bundle.plan, source };
}

function model(overrides = {}) {
  return {
    provider: 'provider-primary',
    model: 'model-diagnosis',
    modelBoundary: 'external',
    responseLanguage: 'zh-CN',
    maxOutputTokens: 512,
    egressPolicy: {
      schema: 'qinglong/copilot-model-egress-policy@v1',
      revision: 'policy-diagnosis-v1',
      potentiallySensitiveDataBoundaries: ['on_device', 'external'],
      maxInputBytes: 64 * 1024,
      maxOutputTokens: 1_024,
    },
    ...overrides,
  };
}

async function plan(options = {}) {
  const harness = await toolHarness(options);
  return prepareCopilotFailureDiagnosisExecution({
    requestId: 'request-diagnosis-001',
    traceId: 'trace-diagnosis-001',
    source: harness.source,
    toolPlan: harness.toolPlan,
    bindings: harness.bindings,
    model: model(options.model),
    deadlineAtMs: 8_000,
    plannedAtMs: 2_100,
  });
}

test('creates one independent diagnosis Run with ready Tool and pending Model Steps', async () => {
  const current = await plan();
  assert.equal(current.schema, COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA);
  assert.equal(current.runId.startsWith('cdr:'), true);
  assert.equal(current.toolStepRunId.startsWith('cdt:'), true);
  assert.equal(current.modelStepRunId.startsWith('cdm:'), true);
  assert.equal(current.modelInvocationId.startsWith('cdi:'), true);
  assert.equal(
    current.tool.invocationArtifact.inputDigest,
    failureDiagnosisToolInputDigest(SOURCE),
  );
  assert.equal(current.model.egressPolicyDigest.length, 64);
  assert.equal(current.model.intentDigest.length, 64);

  const bundle = createCopilotFailureDiagnosisAdmissionBundle(current);
  assert.equal(bundle.run.parentRunId, SOURCE.runId);
  assert.equal(bundle.run.status, 'running');
  assert.equal(bundle.run.version, 3);
  assert.equal(bundle.run.eventSequence, 3);
  assert.equal(bundle.admissionEvent.sequence, 1);
  for (const event of [
    bundle.admissionEvent,
    bundle.toolStepMutation.event,
    bundle.modelStepMutation.event,
  ]) {
    assert.equal(Buffer.byteLength(event.id, 'utf8') <= 36, true);
  }
  assert.deepEqual(
    {
      kind: bundle.toolStepMutation.stepRun.kind,
      status: bundle.toolStepMutation.stepRun.status,
      sequence: bundle.toolStepMutation.event.sequence,
    },
    { kind: 'tool', status: 'ready', sequence: 2 },
  );
  assert.deepEqual(
    {
      kind: bundle.modelStepMutation.stepRun.kind,
      status: bundle.modelStepMutation.stepRun.status,
      parentStepRunId: bundle.modelStepMutation.stepRun.parentStepRunId,
      sequence: bundle.modelStepMutation.event.sequence,
    },
    {
      kind: 'model',
      status: 'pending',
      parentStepRunId: current.toolStepRunId,
      sequence: 3,
    },
  );
  assert.equal(
    bundle.receipt.schema,
    COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA,
  );
  assert.equal(bundle.receipt.finalRunVersion, 3);
  assert.deepEqual(
    normalizeCopilotFailureDiagnosisExecutionPlan(
      JSON.parse(JSON.stringify(current)),
    ),
    current,
  );
  assert.deepEqual(
    normalizeCopilotFailureDiagnosisAdmissionReceipt(
      JSON.parse(JSON.stringify(bundle.receipt)),
    ),
    bundle.receipt,
  );
});

test('rejects a Tool input detached from the source failure fence', async () => {
  await assert.rejects(
    () => plan({ inputAttemptId: 'attempt-unrelated' }),
    InvalidCopilotFailureDiagnosisExecutionPlanError,
  );
});

test('rejects approval-pending or non-Cluster Tool authority before Run creation', async () => {
  await assert.rejects(
    () => plan({ effect: 'require_approval' }),
    InvalidCopilotFailureDiagnosisExecutionPlanError,
  );
  await assert.rejects(
    () => plan({ profile: 'edge' }),
    InvalidCopilotFailureDiagnosisExecutionPlanError,
  );
});

test('rejects inconsistent source terminal evidence and denied model egress', async () => {
  await assert.rejects(
    () =>
      plan({
        source: {
          ...SOURCE,
          runStatus: 'timed_out',
          attemptStatus: 'failed',
        },
      }),
    InvalidCopilotFailureDiagnosisExecutionPlanError,
  );
  await assert.rejects(
    () =>
      plan({
        model: {
          egressPolicy: {
            ...model().egressPolicy,
            potentiallySensitiveDataBoundaries: ['on_device'],
          },
        },
      }),
    InvalidCopilotFailureDiagnosisExecutionPlanError,
  );
});

test('fails closed on widened or digest-drifted durable plans', async () => {
  const current = await plan();
  assert.throws(
    () =>
      normalizeCopilotFailureDiagnosisExecutionPlan({
        ...current,
        callerAuthority: 'execute',
      }),
    InvalidCopilotFailureDiagnosisExecutionPlanError,
  );
  assert.throws(
    () =>
      normalizeCopilotFailureDiagnosisExecutionPlan({
        ...current,
        source: {
          ...current.source,
          runVersion: current.source.runVersion + 1,
        },
      }),
    InvalidCopilotFailureDiagnosisExecutionPlanError,
  );
});
