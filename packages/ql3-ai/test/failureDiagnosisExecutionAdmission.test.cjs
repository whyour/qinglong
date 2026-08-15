const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
const {
  COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA,
  createCopilotFailureDiagnosisToolUnlockCommand,
  normalizeCopilotFailureDiagnosisToolUnlockCommand,
  restoreCopilotFailureDiagnosisTrustedToolAuthority,
} = require('../dist/copilot/failure-diagnosis/toolExecution.js');
const {
  CopilotFailureDiagnosisOutputArtifactUnavailableError,
  copilotFailureDiagnosisOutputReference,
  createCopilotFailureDiagnosisFinalizationReceipt,
  createCopilotFailureDiagnosisOutputArtifact,
  openCopilotFailureDiagnosisOutputArtifact,
} = require('../dist/copilot/failure-diagnosis/modelExecution.js');

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

function successfulToolCompletion(current) {
  const unsigned = Object.freeze({
    schema: 'qinglong/tool-execution-completion@v1',
    startId: 'cds:diagnosis-tool-start',
    projectId: current.projectId,
    runId: current.runId,
    stepRunId: current.toolStepRunId,
    startedStepRunVersion: 2,
    completedStepRunVersion: 3,
    barrierDigest: DIGEST_A,
    adapterDigest: DIGEST_B,
    resultArtifact: Object.freeze({
      artifactId: 'cdra:diagnosis-result',
      artifactDigest: DIGEST_C,
      outputDigest: DIGEST_A,
      executionResultDigest: DIGEST_B,
    }),
    stepRunMutationId: 'cdscm:diagnosis-tool',
    stepRunMutationDigest: DIGEST_C,
    completedStepRunDigest: DIGEST_A,
    runEventId: 'cdsce:diagnosis-tool',
    completedAtMs: 3_000,
  });
  return Object.freeze({
    ...unsigned,
    completionDigest: createHash('sha256')
      .update(
        Buffer.from('qinglong/tool-execution-completion-digest@v1\0', 'utf8'),
      )
      .update(JSON.stringify(unsigned))
      .digest('hex'),
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
  assert.equal(
    bundle.toolStepMutation.stepRun.definitionRef,
    'tool:qinglong.run.log.excerpt@1.0.0',
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

test('restores the exact admitted Tool and binds success to one Model unlock mutation', async () => {
  const current = await plan();
  const admission = createCopilotFailureDiagnosisAdmissionBundle(current);
  const authority = restoreCopilotFailureDiagnosisTrustedToolAuthority(
    current,
    snapshot(),
  );
  assert.equal(authority.plan.planDigest, current.tool.planDigest);
  assert.equal(authority.binding.bindingDigest, current.tool.bindingDigest);

  const command = createCopilotFailureDiagnosisToolUnlockCommand({
    plan: current,
    completion: successfulToolCompletion(current),
    modelStepRun: admission.modelStepMutation.stepRun,
    run: {
      id: current.runId,
      projectId: current.projectId,
      status: 'running',
      version: 5,
      eventSequence: 5,
    },
  });
  assert.equal(
    command.receipt.schema,
    COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA,
  );
  assert.equal(command.modelStepRunMutation.previousStatus, 'pending');
  assert.equal(command.modelStepRunMutation.stepRun.status, 'ready');
  assert.equal(command.receipt.finalRunVersion, 6);
  assert.deepEqual(
    normalizeCopilotFailureDiagnosisToolUnlockCommand(
      JSON.parse(JSON.stringify(command)),
    ),
    command,
  );
  assert.throws(
    () =>
      normalizeCopilotFailureDiagnosisToolUnlockCommand({
        ...command,
        receipt: { ...command.receipt, finalRunVersion: 7 },
      }),
    TypeError,
  );
});

test('publishes Tool execution only through explicit AI subpaths', () => {
  const root = require('../dist');
  const execution = require('@qinglong/ai/failure-diagnosis-tool-execution');
  const storage = require('@qinglong/ai/postgres-failure-diagnosis-tool-execution-storage');
  assert.equal(root.executeCopilotFailureDiagnosisTool, undefined);
  assert.equal(typeof execution.executeCopilotFailureDiagnosisTool, 'function');
  assert.equal(
    typeof storage.PostgresCopilotFailureDiagnosisToolUnlockRepository,
    'function',
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

test('encrypts one Copilot diagnosis output and exposes only a content-free reference', async () => {
  const current = await plan();
  const prompt = require('../dist/copilot/failure-diagnosis/prompt.js')
    .buildFailureDiagnosisPromptPlan({
      provider: current.model.provider,
      model: current.model.model,
      modelBoundary: current.model.modelBoundary,
      profile: 'cluster-control',
      responseLanguage: current.model.responseLanguage,
      projection: {
        content: 'failure: connection refused',
        sourceBytes: 27,
        modelTextBytes: 27,
        redaction: {
          contract: 'recognized_credentials_v1',
          residualSensitivity: 'potentially_sensitive',
          replacements: 0,
          categories: [],
        },
        normalization: {
          invalidUtf8: false,
          unsafeCodePointsReplaced: 0,
        },
        trust: {
          classification: 'untrusted_execution_output',
          instructionPolicy: 'data_only_never_execute',
          actionAuthority: 'none',
          suspectedPromptInjection: false,
          signals: [],
        },
      },
      maxOutputTokens: current.model.maxOutputTokens,
      egressPolicy: current.model.egressPolicy,
    });
  const result = {
    provider: current.model.provider,
    model: current.model.model,
    text: 'Likely a refused upstream connection.',
    finishReason: 'stop',
    usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
  };
  const artifact = createCopilotFailureDiagnosisOutputArtifact(
    {
      requestId: current.requestId,
      planDigest: current.planDigest,
      toolCompletionDigest: DIGEST_A,
      projectId: current.projectId,
      runId: current.runId,
      stepRunId: current.modelStepRunId,
      invocationId: current.modelInvocationId,
      result,
      egressEvidence: prompt.egressEvidence,
      keyId: 'copilot-output-key-1',
      key: Buffer.alloc(32, 0x61),
      sealedAtMs: 4_000,
    },
    () => Buffer.alloc(12, 0x62),
  );
  assert.equal(JSON.stringify(artifact).includes(result.text), false);
  assert.deepEqual(
    openCopilotFailureDiagnosisOutputArtifact(
      artifact,
      Buffer.alloc(32, 0x61),
    ),
    result,
  );
  const reference = copilotFailureDiagnosisOutputReference(artifact);
  assert.equal(reference.artifactId, artifact.artifactId);
  assert.equal(JSON.stringify(reference).includes('ciphertext'), false);
  assert.equal(JSON.stringify(reference).includes(result.text), false);
  assert.throws(
    () =>
      openCopilotFailureDiagnosisOutputArtifact(
        { ...artifact, ciphertext: `${artifact.ciphertext.slice(0, -1)}A` },
        Buffer.alloc(32, 0x61),
      ),
    TypeError,
  );
  assert.throws(
    () =>
      openCopilotFailureDiagnosisOutputArtifact(
        artifact,
        Buffer.alloc(32, 0x63),
      ),
    CopilotFailureDiagnosisOutputArtifactUnavailableError,
  );
});

test('binds a content-free diagnosis Run finalization receipt', async () => {
  const current = await plan();
  const receipt = createCopilotFailureDiagnosisFinalizationReceipt({
    requestId: current.requestId,
    planDigest: current.planDigest,
    runId: current.runId,
    modelStepRunId: current.modelStepRunId,
    invocationId: current.modelInvocationId,
    completionDigest: DIGEST_B,
    outcome: 'succeeded',
    outputArtifactId: 'cdo:diagnosis-output',
    finalRunVersion: 9,
    finalRunEventSequence: 9,
    finalizedAtMs: 4_100,
  });
  assert.equal(receipt.runEventId.length, 36);
  assert.equal(receipt.receiptDigest.length, 64);
  assert.equal(JSON.stringify(receipt).includes('model output'), false);
  assert.throws(
    () =>
      createCopilotFailureDiagnosisFinalizationReceipt({
        ...receipt,
        outcome: 'failed',
      }),
    /finalization conflicts/,
  );
});

test('publishes Model execution through explicit AI subpaths only', () => {
  const root = require('../dist');
  const execution = require('@qinglong/ai/failure-diagnosis-model-execution');
  const storage = require('@qinglong/ai/postgres-failure-diagnosis-model-execution-storage');
  assert.equal(root.executeCopilotFailureDiagnosisModel, undefined);
  assert.equal(
    typeof execution.executeCopilotFailureDiagnosisModel,
    'function',
  );
  assert.equal(
    typeof storage.PostgresCopilotFailureDiagnosisModelRepository,
    'function',
  );
});

test('executes the unlocked Model once, commits ciphertext, and terminalizes replay', async () => {
  const current = await plan();
  const admission = createCopilotFailureDiagnosisAdmissionBundle(current);
  const unlockCommand = createCopilotFailureDiagnosisToolUnlockCommand({
    plan: current,
    completion: successfulToolCompletion(current),
    modelStepRun: admission.modelStepMutation.stepRun,
    run: {
      id: current.runId,
      projectId: current.projectId,
      status: 'running',
      version: 5,
      eventSequence: 5,
    },
  });
  const {
    DurableModelInvocationCoordinator,
  } = require('../dist/model-invocation/durableModelInvocationCoordinator.js');
  const { BoundedModelGateway } = require('../dist/model-gateway/gateway.js');
  const {
    CopilotFailureDiagnosisModelCompletionCoordinator,
    assertCopilotFailureDiagnosisOutputCompletionBinding,
    copilotFailureDiagnosisOutputReference,
    executeCopilotFailureDiagnosisModel,
  } = require('../dist/copilot/failure-diagnosis/modelExecution.js');

  let stepRun = unlockCommand.modelStepRunMutation.stepRun;
  let runVersion = unlockCommand.receipt.finalRunVersion;
  let runEventSequence = unlockCommand.receipt.finalRunEventSequence;
  let start = null;
  let completion = null;
  let outputArtifact = null;
  let finalization = null;
  const repository = {
    async findStart() {
      return start;
    },
    async findCompletion() {
      return completion;
    },
    async readAuthority() {
      return {
        projectId: current.projectId,
        runId: current.runId,
        runVersion,
        runEventSequence,
        stepRun,
      };
    },
    async listIncomplete() {
      return { observedAtMs: 3_000, candidates: [], hasMore: false };
    },
    async admit(command) {
      start = command.start;
      stepRun = command.stepRunMutation.stepRun;
      runVersion += 1;
      runEventSequence += 1;
      return { status: 'created', record: start };
    },
    async complete(command) {
      completion = command.completion;
      stepRun = command.stepRunMutation.stepRun;
      runVersion += 1;
      runEventSequence += 1;
      return { status: 'created', record: completion };
    },
    async findCopilotFailureDiagnosisOutput() {
      return outputArtifact;
    },
    async completeWithCopilotFailureDiagnosisOutput(command, artifact) {
      const binding = assertCopilotFailureDiagnosisOutputCompletionBinding(
        command,
        artifact,
      );
      completion = command.completion;
      outputArtifact = binding.artifact;
      stepRun = command.stepRunMutation.stepRun;
      runVersion += 1;
      runEventSequence += 1;
      return { status: 'created', reference: binding.reference };
    },
  };
  const durable = new DurableModelInvocationCoordinator(repository);
  const successfulCompletion =
    new CopilotFailureDiagnosisModelCompletionCoordinator({
      coordinator: durable,
      keys: {
        async active() {
          return { keyId: 'copilot-output-key-1', key: Buffer.alloc(32, 7) };
        },
        async resolve(keyId) {
          return keyId === 'copilot-output-key-1'
            ? { keyId, key: Buffer.alloc(32, 7) }
            : null;
        },
      },
      now: () => 3_500,
      nonceFactory: () => Buffer.alloc(12, 8),
    });
  let providerCalls = 0;
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: current.model.provider,
        async listModels() {
          return [{ id: current.model.model }];
        },
        async generate() {
          providerCalls += 1;
          return {
            provider: current.model.provider,
            model: current.model.model,
            text: 'The upstream service refused the connection.',
            finishReason: 'stop',
            usage: { inputTokens: 100, outputTokens: 9, totalTokens: 109 },
          };
        },
        async *stream() {},
      },
    ],
    policies: {
      async resolve() {
        return {
          revision: 'model-policy-1',
          allowedProviders: [current.model.provider],
          allowedModels: [current.model.model],
          maxInputBytes: 64 * 1024,
          maxOutputBytes: 64 * 1024,
          maxOutputTokens: 1_024,
          maxTotalTokens: 2_048,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    pricing: { async resolve() { return null; } },
    audit: durable,
    successfulCompletion,
    maxConcurrent: 1,
    now: () => 3_100,
  });
  const finalizations = {
    async findFinalization() {
      return finalization;
    },
    async finalize() {
      if (!finalization) {
        finalization = createCopilotFailureDiagnosisFinalizationReceipt({
          requestId: current.requestId,
          planDigest: current.planDigest,
          runId: current.runId,
          modelStepRunId: current.modelStepRunId,
          invocationId: current.modelInvocationId,
          completionDigest: completion.completionDigest,
          outcome: completion.outcome,
          outputArtifactId: outputArtifact.artifactId,
          finalRunVersion: runVersion + 1,
          finalRunEventSequence: runEventSequence + 1,
          finalizedAtMs: completion.completedAtMs,
        });
        return { status: 'created', receipt: finalization };
      }
      return { status: 'existing', receipt: finalization };
    },
  };
  const dependencies = {
    admissions: {
      async findPlanByRequestId() {
        return current;
      },
      async findByRequestId() {
        return admission.receipt;
      },
    },
    unlocks: {
      async findByRequestId() {
        return unlockCommand.receipt;
      },
    },
    toolResults: {
      async open() {
        return {
          status: 'existing',
          completion: successfulToolCompletion(current),
          output: {
            status: 'available',
            runId: current.source.runId,
            attemptId: current.source.attemptId,
            profile: 'cluster-control',
            sourceWindowBytes: 16 * 1024,
            content: 'connect ECONNREFUSED 127.0.0.1:5432',
            sourceBytes: 35,
            modelTextBytes: 35,
            redaction: {
              contract: 'recognized_credentials_v1',
              residualSensitivity: 'potentially_sensitive',
              replacements: 0,
              categories: [],
            },
            normalization: {
              invalidUtf8: false,
              unsafeCodePointsReplaced: 0,
            },
            trust: {
              classification: 'untrusted_execution_output',
              instructionPolicy: 'data_only_never_execute',
              actionAuthority: 'none',
              suspectedPromptInjection: false,
              signals: [],
            },
          },
        };
      },
    },
    modelInvocations: repository,
    outputs: repository,
    gateway,
    successfulCompletion,
    finalizations,
  };
  const created = await executeCopilotFailureDiagnosisModel(
    current.requestId,
    dependencies,
  );
  assert.equal(created.outcome, 'succeeded');
  assert.equal(providerCalls, 1);
  assert.equal(JSON.stringify(outputArtifact).includes('refused'), false);
  assert.deepEqual(
    created.output,
    copilotFailureDiagnosisOutputReference(outputArtifact),
  );
  const replay = await executeCopilotFailureDiagnosisModel(
    current.requestId,
    dependencies,
  );
  assert.equal(replay.finalization.receiptDigest, created.finalization.receiptDigest);
  assert.equal(providerCalls, 1);
});
