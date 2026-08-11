const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  BUILTIN_RUN_READ_ADAPTER,
  BUILTIN_RUN_READ_TOOL,
  BUILTIN_RUN_READ_TOOL_DEFINITION,
  BuiltInRunReadToolAdapter,
  InvalidBuiltInRunReadToolError,
  createBuiltInRunReadToolHandlerBinding,
} = require('../dist/tool-execution/builtin-run-read/builtInRunReadTool');
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
} = require('../dist/run/stepRun');
const {
  createToolExecutionStartCommand,
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
  createTrustedToolInvocationPlan,
  trustedToolContractIdentityDigest,
} = require('../dist/tool-execution/trustedToolInvocation');
const {
  prepareToolInvocation,
} = require('../dist/tool-execution/tool-registry/toolRegistry');
const {
  TRUSTED_TOOL_EXECUTION_RECOVERY_EVIDENCE_SCHEMA,
  TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
  TrustedToolExecutionAdapterRegistry,
  TrustedToolExecutionDeadlineExceededError,
  TrustedToolExecutionFailedError,
  TrustedToolExecutionUnavailableError,
  executeTrustedToolAfterStart,
  inspectTrustedToolExecutionRecovery,
} = require('../dist/tool-execution/trustedToolExecution');
const {
  TOOL_EXECUTION_COMPLETION_SCHEMA,
  TOOL_EXECUTION_RESULT_ARTIFACT_SCHEMA,
  ToolExecutionCompletionUnavailableError,
  createToolExecutionCompletionCommand,
  createToolExecutionResultArtifact,
  openToolExecutionResultArtifact,
  toolExecutionCompletionRecord,
  toolExecutionResultKeyBinding,
} = require('../dist/tool-execution/toolExecutionCompletion');
const {
  executeAndCompleteTrustedToolSuccess,
} = require('../dist/tool-execution/trustedToolSuccessCompletion');
const {
  executeAndCompleteTrustedTool,
} = require('../dist/tool-execution/trustedToolCompletion');
const {
  TOOL_EXECUTION_FAILURE_COMPLETION_SCHEMA,
  TOOL_EXECUTION_FAILURE_FACTS,
  createToolExecutionFailureCompletionCommand,
  createToolExecutionFailureResult,
  toolExecutionFailureCompletionRecord,
} = require('../dist/tool-execution/toolExecutionFailureCompletion');
const {
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRotationCommand,
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('../dist/tool-execution/toolResultKeyCatalog');
const {
  createToolExecutionResultRekeyCommand,
} = require('../dist/tool-execution/toolResultRekey');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const KEY = Buffer.alloc(32, 7);
const REQUESTER = Object.freeze({ type: 'user', id: 'usr-tool-owner' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 7 });
const NOW_MS = 1_400;

function resultKeyCatalog(key = KEY) {
  const command = createToolResultKeyCatalogBootstrapCommand({
    keyId: 'tool-result-key-test',
    materialProof: toolResultKeyMaterialProof('tool-result-key-test', key),
    mutationId: 'tool-result-key-bootstrap-test',
  });
  return normalizeToolResultKeyCatalogRecord({
    ...command.next,
    committedAtMs: 1_200,
  });
}

const DIRECT_RESULT_KEY_CATALOG = resultKeyCatalog();
const DIRECT_RESULT_KEY_CATALOG_FENCE = toolResultKeyCatalogFence(
  DIRECT_RESULT_KEY_CATALOG,
  requireActiveToolResultKey(DIRECT_RESULT_KEY_CATALOG),
);

function principal() {
  return {
    subject: REQUESTER,
    authenticationId: 'auth-tool-1',
    authenticatedAtMs: 800,
    expiresAtMs: 10_000,
    assurance: 'local_console',
  };
}

function authorizer() {
  return {
    async authorize() {
      return {
        effect: 'allow',
        reasons: ['role_grant'],
        fence: FENCE,
      };
    },
  };
}

function run(overrides = {}) {
  return {
    id: 'target-run-001',
    projectId: 'project-001',
    taskId: 'task-001',
    taskRevision: 'task-001@7',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 4,
    eventSequence: 6,
    priority: 10,
    createdAtMs: 900,
    queuedAtMs: 950,
    startedAtMs: 1_000,
    requestId: 'must-not-cross-tool-output',
    inputRef: 'artifact:must-not-cross-tool-output',
    ...overrides,
  };
}

async function fixture(options = {}) {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-qinglong',
    projectId: 'project-001',
    packageName: 'qinglong',
    lockDigest: DIGEST_A,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: DIGEST_B,
    resources: [],
  });
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [
      {
        generation,
        revisionDigest: DIGEST_C,
        definitions: [options.definition ?? BUILTIN_RUN_READ_TOOL_DEFINITION],
      },
    ],
  });
  const binding = createBuiltInRunReadToolHandlerBinding(snapshot, [
    'edge',
    'standalone',
    'cluster-control',
  ]);
  const bindings = new TrustedToolHandlerBindingRegistry(snapshot, [binding]);
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(snapshot),
    {
      projectId: 'project-001',
      principal: principal(),
      nowMs: 900,
      tool: BUILTIN_RUN_READ_TOOL,
      input: { runId: 'target-run-001' },
    },
    authorizer(),
  );
  const planBundle = createTrustedToolInvocationPlan(bindings, invocation, {
    actionRef: 'tool-plan:run-read-001',
    inputArtifactId: 'artifact-input-run-read-001',
    previewArtifactId: 'artifact-preview-run-read-001',
    artifactKeyId: 'tool-key-test',
    artifactKey: KEY,
    artifactNonce: Buffer.alloc(12, 9),
    profile: 'edge',
    preview: {
      title: 'Read Run',
      summary: 'Reads one low-sensitive Run projection',
      fields: [
        {
          kind: 'identifier',
          label: 'Run',
          value: 'target-run-001',
        },
      ],
      warnings: [],
    },
    sealedAtMs: 1_000,
  });
  const ready = createStepRunRecord({
    id: 'step-run-read-001',
    runId: 'tool-host-run-001',
    stepKey: 'workflow.read-run',
    kind: 'tool',
    definitionRef: 'tool:qinglong.run.get@1.0.0',
    definitionDigest: binding.definitionDigest,
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:step-input-read-001',
    mutationId: 'step-create-read-001',
    createdAtMs: 1_000,
  });
  const evidence = createToolExecutionEvidenceBundle({
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    projectId: 'project-001',
    runId: 'tool-host-run-001',
    stepRunId: ready.id,
    invocationPlanDigest: planBundle.plan.planDigest,
    bindingDigest: binding.bindingDigest,
    adapterDigest: trustedToolContractIdentityDigest(binding.adapter),
    redactionContractDigest: trustedToolContractIdentityDigest(
      binding.redactionContract,
    ),
    auditContractDigest: trustedToolContractIdentityDigest(
      binding.auditContract,
    ),
    audit: {
      eventId: '40000000-0000-4000-8000-000000000001',
      requestId: 'tool-request-read-001',
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
  const admission = await admitTrustedToolExecution(bindings, planBundle.plan, {
    principal: principal(),
    profile: 'edge',
    nowMs: NOW_MS,
    authorizer: authorizer(),
    evidence: {
      stepRun: {
        id: ready.id,
        version: ready.version,
        digest: ready.stepRunDigest,
      },
      ...toolExecutionAdmissionEvidence(evidence),
    },
  });
  const mutation = transitionStepRunMutation(
    ready,
    {
      expectedVersion: ready.version,
      expectedDigest: ready.stepRunDigest,
      mutationId: 'step-running-read-002',
      to: 'running',
      atMs: NOW_MS,
    },
    {
      expectedRunVersion: 5,
      expectedRunEventSequence: 8,
      eventId: 'event-step-running-read-001',
      dedupeKey: 'step-running:step-run-read-001',
      actor: REQUESTER,
    },
  );
  const barrier = toolExecutionStartBarrierRecord(
    createToolExecutionStartCommand({
      startId: 'tool-start-read-001',
      admission,
      evidence,
      stepRunMutation: mutation,
    }),
  );
  const calls = [];
  const runs = {
    async findRunById(runId) {
      calls.push(runId);
      return options.run === undefined ? run() : options.run;
    },
  };
  const adapter = new BuiltInRunReadToolAdapter(
    binding,
    'edge',
    bindings.definitionRegistry(),
    runs,
  );
  const adapters = new TrustedToolExecutionAdapterRegistry(bindings, [adapter]);
  return {
    adapter,
    adapters,
    barrier,
    binding,
    bindings,
    calls,
    inputArtifact: planBundle.inputArtifact,
    running: mutation.stepRun,
  };
}

function dependencies(current, options = {}) {
  const issuedKey = options.key ?? Buffer.from(KEY);
  return {
    issuedKey,
    value: {
      barriers: {
        async findByStartId(startId) {
          return startId === current.barrier.startId ? current.barrier : null;
        },
      },
      artifacts: {
        async findInput(artifactId) {
          return artifactId === current.inputArtifact.artifactId
            ? current.inputArtifact
            : null;
        },
      },
      keys: {
        async resolve(keyId) {
          return { keyId, key: issuedKey };
        },
      },
      adapters: current.adapters,
      now: () => 1_500,
    },
  };
}

function successCompletionDependencies(current, options = {}) {
  const input = dependencies(current);
  const state = {
    catalogCalls: 0,
    commitCalls: 0,
    completion: null,
    failureCommitCalls: 0,
    failureCompletion: null,
    failureIdentityCalls: 0,
    identityCalls: 0,
    issuedResultKeys: [],
    rekeyCalls: 0,
    rekeyHead: null,
    resultArtifact: null,
    resultBinding: null,
    resolveCalls: 0,
  };
  const resultKey = Buffer.alloc(32, 11);
  const catalog = options.resultKeyCatalog ?? resultKeyCatalog(resultKey);
  const value = {
    ...input.value,
    completions: {
      async findByStartId(startId) {
        return startId === current.barrier.startId ? state.completion : null;
      },
      async findResultArtifact(artifactId) {
        return artifactId === state.resultArtifact?.artifactId
          ? state.resultArtifact
          : null;
      },
      async commit(command) {
        state.commitCalls += 1;
        state.resultArtifact = command.resultArtifact;
        state.resultBinding = toolExecutionResultKeyBinding(command);
        state.completion = toolExecutionCompletionRecord(command);
        if (options.loseCommitResponse) {
          throw new Error('simulated commit response loss');
        }
        return {
          status: 'created',
          completion: state.completion,
        };
      },
    },
    failureCompletions: {
      async findByStartId(startId) {
        return startId === current.barrier.startId
          ? state.failureCompletion
          : null;
      },
      async commit(command) {
        state.failureCommitCalls += 1;
        state.failureCompletion = toolExecutionFailureCompletionRecord(command);
        if (options.loseFailureCommitResponse) {
          throw new Error('simulated failure commit response loss');
        }
        return {
          status: 'created',
          completion: state.failureCompletion,
        };
      },
    },
    stepRuns: {
      async findById(stepRunId) {
        return stepRunId === current.running.id ? current.running : null;
      },
    },
    runs: {
      async findRunById(runId) {
        return runId === current.barrier.runId
          ? run({
              id: 'tool-host-run-001',
              version: 6,
              eventSequence: 9,
            })
          : null;
      },
    },
    resultKeys: {
      async resolve(keyId) {
        state.resolveCalls += 1;
        if (options.missingResultKey) return null;
        const configured = options.resultKeysById?.[keyId] ?? resultKey;
        const key = Buffer.from(configured);
        state.issuedResultKeys.push(key);
        return { keyId, key };
      },
    },
    resultRekeys: {
      async findHeadByArtifactId(artifactId) {
        state.rekeyCalls += 1;
        return artifactId === state.resultArtifact?.artifactId
          ? state.rekeyHead
          : null;
      },
    },
    resultKeyCatalog: {
      async findCurrent() {
        state.catalogCalls += 1;
        return options.missingResultKeyCatalog ? null : catalog;
      },
    },
    identities: {
      create() {
        state.identityCalls += 1;
        return {
          artifactId: 'artifact-result-run-read-coordinator-001',
          mutationId: 'step-completed-read-coordinator-001',
          eventId: 'event-step-completed-read-coordinator-001',
        };
      },
    },
    failureIdentities: {
      create() {
        state.failureIdentityCalls += 1;
        return {
          mutationId: 'step-failed-read-coordinator-001',
          eventId: 'event-step-failed-read-coordinator-001',
        };
      },
    },
    nonceFactory: () => Buffer.alloc(12, 5),
  };
  return { input, state, value };
}

test('executes the reviewed Run read adapter only after a durable start', async () => {
  const current = await fixture();
  const deps = dependencies(current);
  const result = await executeTrustedToolAfterStart(
    current.barrier.startId,
    deps.value,
  );

  assert.equal(result.schema, TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA);
  assert.equal(result.startId, current.barrier.startId);
  assert.equal(result.adapterDigest, current.barrier.adapterDigest);
  assert.deepEqual(result.output, {
    found: true,
    id: 'target-run-001',
    taskId: 'task-001',
    taskRevision: 'task-001@7',
    status: 'running',
    version: 4,
    eventSequence: 6,
    priority: 10,
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    createdAtMs: 900,
    queuedAtMs: 950,
    startedAtMs: 1_000,
  });
  assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
  assert.deepEqual(current.calls, ['target-run-001']);
  assert.equal(
    deps.issuedKey.every((byte) => byte === 0),
    true,
  );
  assert.match(result.outputDigest, /^[0-9a-f]{64}$/);
  assert.match(result.resultDigest, /^[0-9a-f]{64}$/);
});

test('fails closed before adapter execution for missing starts and bad keys', async () => {
  const current = await fixture();
  const missing = dependencies(current);
  missing.value.barriers.findByStartId = async () => null;
  await assert.rejects(
    executeTrustedToolAfterStart('tool-start-read-001', missing.value),
    TrustedToolExecutionUnavailableError,
  );
  assert.deepEqual(current.calls, []);

  const badKey = dependencies(current, { key: Buffer.alloc(32, 8) });
  await assert.rejects(
    executeTrustedToolAfterStart(current.barrier.startId, badKey.value),
    TrustedToolExecutionFailedError,
  );
  assert.deepEqual(current.calls, []);
  assert.equal(
    badKey.issuedKey.every((byte) => byte === 0),
    true,
  );
});

test('bounds a stalled read adapter without claiming underlying cancellation', async () => {
  const current = await fixture();
  const stalled = new BuiltInRunReadToolAdapter(
    current.binding,
    'edge',
    current.bindings.definitionRegistry(),
    {
      async findRunById() {
        return new Promise(() => undefined);
      },
    },
  );
  const adapters = new TrustedToolExecutionAdapterRegistry(current.bindings, [
    stalled,
  ]);
  const deps = dependencies({ ...current, adapters });
  const deadlineAtMs =
    current.barrier.startedAtMs + current.barrier.timeoutSeconds * 1_000;
  deps.value.now = () => deadlineAtMs - 1;
  await assert.rejects(
    executeTrustedToolAfterStart(current.barrier.startId, deps.value),
    TrustedToolExecutionDeadlineExceededError,
  );
  assert.equal(
    deps.issuedKey.every((byte) => byte === 0),
    true,
  );
});

test('returns indistinguishable not-found output across Project boundaries', async () => {
  const missing = await fixture({ run: null });
  const foreign = await fixture({
    run: run({ projectId: 'project-other' }),
  });
  const missingResult = await executeTrustedToolAfterStart(
    missing.barrier.startId,
    dependencies(missing).value,
  );
  const foreignResult = await executeTrustedToolAfterStart(
    foreign.barrier.startId,
    dependencies(foreign).value,
  );
  assert.deepEqual(missingResult.output, { found: false });
  assert.deepEqual(foreignResult.output, { found: false });
});

test('inspects read-only recovery without loading Artifact, key or adapter output', async () => {
  const current = await fixture();
  let artifactReads = 0;
  let keyReads = 0;
  const evidence = await inspectTrustedToolExecutionRecovery(
    current.barrier.startId,
    {
      barriers: {
        async findByStartId() {
          return current.barrier;
        },
      },
      adapters: current.adapters,
      now: () => 1_600,
      artifacts: {
        async findInput() {
          artifactReads += 1;
          return null;
        },
      },
      keys: {
        async resolve() {
          keyReads += 1;
          return null;
        },
      },
    },
  );
  assert.equal(
    evidence.schema,
    TRUSTED_TOOL_EXECUTION_RECOVERY_EVIDENCE_SCHEMA,
  );
  assert.equal(evidence.disposition, 'retry_safe');
  assert.equal(evidence.reason, 'read_only_no_side_effects');
  assert.equal(artifactReads, 0);
  assert.equal(keyReads, 0);
  assert.deepEqual(current.calls, []);
  assert.match(evidence.evidenceDigest, /^[0-9a-f]{64}$/);
});

test('rejects Definition or executable binding drift and exposes authority only by subpath', async () => {
  const changed = {
    ...BUILTIN_RUN_READ_TOOL_DEFINITION,
    description: 'Changed after review',
  };
  await assert.rejects(
    async () => fixture({ definition: changed }),
    InvalidBuiltInRunReadToolError,
  );

  const current = await fixture();
  assert.throws(
    () =>
      new BuiltInRunReadToolAdapter(
        current.binding,
        'worker',
        current.bindings.definitionRegistry(),
        {
          async findRunById() {
            return null;
          },
        },
      ),
    InvalidBuiltInRunReadToolError,
  );

  const root = require('../dist');
  const execution = require('@qinglong/runtime-core/trusted-tool-execution');
  const builtIn = require('@qinglong/runtime-core/builtin-run-read-tool');
  assert.equal(root.executeTrustedToolAfterStart, undefined);
  assert.equal(
    execution.executeTrustedToolAfterStart,
    executeTrustedToolAfterStart,
  );
  assert.equal(builtIn.BUILTIN_RUN_READ_TOOL.name, 'qinglong.run.get');

  const source = readFileSync(
    join(__dirname, '..', 'src', 'tool-execution', 'trustedToolExecution.ts'),
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

test('loads the Run read projection without the Trusted Tool or Plugin Package chain', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const value = require('@qinglong/runtime-core/builtin-run-read-projection');
       process.stdout.write(JSON.stringify({
         tool: value.BUILTIN_RUN_READ_TOOL,
         loaded: Object.keys(require.cache),
       }));`,
    ],
    { cwd: join(__dirname, '..'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.tool, {
    name: 'qinglong.run.get',
    version: '1.0.0',
  });
  assert.equal(
    report.loaded.some((file) =>
      /(?:trustedToolInvocation|trustedToolExecution|plugin-package)/.test(
        file,
      ),
    ),
    false,
  );
});

test('seals one canonical result and binds it to a succeeded StepRun mutation', async () => {
  const current = await fixture();
  const result = await executeTrustedToolAfterStart(
    current.barrier.startId,
    dependencies(current).value,
  );
  const resultArtifact = createToolExecutionResultArtifact(
    {
      artifactId: 'artifact-result-run-read-001',
      projectId: current.barrier.projectId,
      runId: current.barrier.runId,
      stepRunId: current.barrier.stepRunId,
      tool: BUILTIN_RUN_READ_TOOL,
      executionResult: result,
      keyId: 'tool-result-key-test',
      key: KEY,
    },
    current.bindings.definitionRegistry(),
    () => Buffer.alloc(12, 4),
  );
  assert.equal(resultArtifact.schema, TOOL_EXECUTION_RESULT_ARTIFACT_SCHEMA);
  assert.equal(
    JSON.stringify(resultArtifact).includes('target-run-001'),
    false,
  );
  assert.deepEqual(
    openToolExecutionResultArtifact(
      resultArtifact,
      KEY,
      current.bindings.definitionRegistry(),
    ),
    result.output,
  );

  const completionMutation = transitionStepRunMutation(
    current.running,
    {
      expectedVersion: current.running.version,
      expectedDigest: current.running.stepRunDigest,
      mutationId: 'step-completed-read-003',
      to: 'succeeded',
      atMs: result.completedAtMs,
      outputRef: resultArtifact.artifactId,
    },
    {
      expectedRunVersion: 6,
      expectedRunEventSequence: 9,
      eventId: 'event-step-completed-read-001',
      dedupeKey: 'step-completed:step-run-read-001',
      actor: REQUESTER,
    },
  );
  const command = createToolExecutionCompletionCommand({
    barrier: current.barrier,
    executionResult: result,
    resultArtifact,
    resultKeyCatalogFence: DIRECT_RESULT_KEY_CATALOG_FENCE,
    stepRunMutation: completionMutation,
  });
  const completion = toolExecutionCompletionRecord(command);
  assert.equal(completion.schema, TOOL_EXECUTION_COMPLETION_SCHEMA);
  assert.equal(completion.startId, current.barrier.startId);
  assert.equal(completion.completedStepRunVersion, current.running.version + 1);
  assert.equal(completion.resultArtifact.artifactId, resultArtifact.artifactId);
  assert.match(completion.completionDigest, /^[0-9a-f]{64}$/);

  assert.throws(
    () =>
      createToolExecutionCompletionCommand({
        barrier: current.barrier,
        executionResult: result,
        resultArtifact,
        resultKeyCatalogFence: DIRECT_RESULT_KEY_CATALOG_FENCE,
        stepRunMutation: {
          ...completionMutation,
          expectedRunVersion: 7,
        },
      }),
    TypeError,
  );
  const root = require('../dist');
  const completionAuthority = require('@qinglong/runtime-core/tool-execution-completion');
  assert.equal(root.createToolExecutionResultArtifact, undefined);
  assert.equal(
    completionAuthority.createToolExecutionResultArtifact,
    createToolExecutionResultArtifact,
  );
});

test('executes, seals and atomically completes one durable Tool start', async () => {
  const current = await fixture();
  const dependencies = successCompletionDependencies(current);
  const result = await executeAndCompleteTrustedToolSuccess(
    current.barrier.startId,
    dependencies.value,
  );

  assert.equal(result.status, 'created');
  assert.equal(result.completion.schema, TOOL_EXECUTION_COMPLETION_SCHEMA);
  assert.equal(result.completion.startId, current.barrier.startId);
  assert.equal(result.completion.completedStepRunVersion, 3);
  assert.deepEqual(result.output, {
    found: true,
    id: 'target-run-001',
    taskId: 'task-001',
    taskRevision: 'task-001@7',
    status: 'running',
    version: 4,
    eventSequence: 6,
    priority: 10,
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    createdAtMs: 900,
    queuedAtMs: 950,
    startedAtMs: 1_000,
  });
  assert.deepEqual(current.calls, ['target-run-001']);
  assert.equal(dependencies.state.catalogCalls, 1);
  assert.equal(dependencies.state.commitCalls, 1);
  assert.equal(dependencies.state.identityCalls, 1);
  assert.equal(
    JSON.stringify(dependencies.state.resultArtifact).includes(
      'target-run-001',
    ),
    false,
  );
  assert.equal(
    dependencies.state.issuedResultKeys.every((key) =>
      key.every((byte) => byte === 0),
    ),
    true,
  );
});

test('returns the encrypted durable completion without re-executing the adapter', async () => {
  const current = await fixture();
  const dependencies = successCompletionDependencies(current);
  const first = await executeAndCompleteTrustedToolSuccess(
    current.barrier.startId,
    dependencies.value,
  );
  const second = await executeAndCompleteTrustedToolSuccess(
    current.barrier.startId,
    dependencies.value,
  );

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'existing');
  assert.deepEqual(second.output, first.output);
  assert.deepEqual(second.completion, first.completion);
  assert.deepEqual(current.calls, ['target-run-001']);
  assert.equal(dependencies.state.catalogCalls, 2);
  assert.equal(dependencies.state.resolveCalls, 2);
  assert.equal(dependencies.state.commitCalls, 1);
  assert.equal(dependencies.state.identityCalls, 1);
});

test('prefers the current durable rekey overlay when reopening a completion', async () => {
  const current = await fixture();
  const dependencies = successCompletionDependencies(current);
  const first = await executeAndCompleteTrustedToolSuccess(
    current.barrier.startId,
    dependencies.value,
  );
  const targetKey = Buffer.alloc(32, 12);
  const rotatedCommand = createToolResultKeyRotationCommand(
    resultKeyCatalog(Buffer.alloc(32, 11)),
    {
      keyId: 'tool-result-key-next',
      materialProof: toolResultKeyMaterialProof(
        'tool-result-key-next',
        targetKey,
      ),
      mutationId: 'tool-result-key-rotate-next',
    },
  );
  const rotatedCatalog = normalizeToolResultKeyCatalogRecord({
    ...rotatedCommand.next,
    committedAtMs: 1_300,
  });
  const rekeyCommand = createToolExecutionResultRekeyCommand({
    artifact: dependencies.state.resultArtifact,
    binding: dependencies.state.resultBinding,
    previousOverlay: null,
    overlayId: 'tool-result-rekey-overlay-test-001',
    mutationId: 'tool-result-rekey-mutation-test-001',
    targetCatalogFence: toolResultKeyCatalogFence(
      rotatedCatalog,
      requireActiveToolResultKey(rotatedCatalog),
    ),
    targetKey,
    output: first.output,
    rekeyedAtMs: 1_400,
    registry: current.bindings.definitionRegistry(),
    nonceFactory: () => Buffer.alloc(12, 6),
  });
  dependencies.state.rekeyHead = rekeyCommand.overlay;
  dependencies.value.resultKeyCatalog.findCurrent = async () => rotatedCatalog;
  dependencies.value.resultKeys.resolve = async (keyId) => ({
    keyId,
    key: Buffer.from(targetKey),
  });

  const reopened = await executeAndCompleteTrustedToolSuccess(
    current.barrier.startId,
    dependencies.value,
  );
  assert.equal(reopened.status, 'existing');
  assert.deepEqual(reopened.output, first.output);
  assert.deepEqual(current.calls, ['target-run-001']);
  assert.equal(dependencies.state.rekeyCalls, 1);
});

test('recovers a committed Tool result after the commit response is lost', async () => {
  const current = await fixture();
  const dependencies = successCompletionDependencies(current, {
    loseCommitResponse: true,
  });
  const result = await executeAndCompleteTrustedToolSuccess(
    current.barrier.startId,
    dependencies.value,
  );

  assert.equal(result.status, 'existing');
  assert.equal(result.completion.startId, current.barrier.startId);
  assert.equal(result.output.found, true);
  assert.deepEqual(current.calls, ['target-run-001']);
  assert.equal(dependencies.state.commitCalls, 1);
  assert.equal(dependencies.state.resolveCalls, 2);
});

test('fails closed before adapter replay when a durable result key is lost', async () => {
  const current = await fixture();
  const dependencies = successCompletionDependencies(current);
  await executeAndCompleteTrustedToolSuccess(
    current.barrier.startId,
    dependencies.value,
  );
  dependencies.value.resultKeys.resolve = async () => null;

  await assert.rejects(
    executeAndCompleteTrustedToolSuccess(
      current.barrier.startId,
      dependencies.value,
    ),
    ToolExecutionCompletionUnavailableError,
  );
  assert.deepEqual(current.calls, ['target-run-001']);
  assert.equal(dependencies.state.commitCalls, 1);
});

test('exposes Tool success completion only through its explicit subpath', () => {
  const root = require('../dist');
  const authority = require('@qinglong/runtime-core/trusted-tool-success-completion');
  assert.equal(root.executeAndCompleteTrustedToolSuccess, undefined);
  assert.equal(
    authority.executeAndCompleteTrustedToolSuccess,
    executeAndCompleteTrustedToolSuccess,
  );
});

test('durably completes adapter failure once and replays without re-execution', async () => {
  const current = await fixture();
  const completion = successCompletionDependencies(current);
  let executions = 0;
  completion.value.adapters = new TrustedToolExecutionAdapterRegistry(
    current.bindings,
    [
      {
        binding: current.binding,
        profile: 'edge',
        recoveryMode: 'retry_safe_read',
        async execute() {
          executions += 1;
          throw new Error('caller-sensitive adapter failure');
        },
      },
    ],
  );

  const first = await executeAndCompleteTrustedTool(
    current.barrier.startId,
    completion.value,
  );
  const replay = await executeAndCompleteTrustedTool(
    current.barrier.startId,
    completion.value,
  );

  assert.equal(first.outcome, 'failed');
  assert.equal(first.status, 'created');
  assert.equal(first.completion.resultCode, 'tool_adapter_failed');
  assert.equal(first.completion.errorSummary, 'Trusted Tool execution failed');
  assert.equal(replay.outcome, 'failed');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.completion, first.completion);
  assert.equal(executions, 1);
  assert.equal(completion.state.failureCommitCalls, 1);
  assert.equal(completion.state.failureIdentityCalls, 1);
  assert.equal(completion.state.catalogCalls, 0);
  assert.equal(
    JSON.stringify(first.completion).includes('caller-sensitive'),
    false,
  );
});

test('recovers timed_out after failure commit response loss without adapter replay', async () => {
  const current = await fixture();
  const completion = successCompletionDependencies(current, {
    loseFailureCommitResponse: true,
  });
  const afterDeadline =
    current.barrier.startedAtMs + current.barrier.timeoutSeconds * 1_000 + 1;
  completion.value.now = () => afterDeadline;

  const result = await executeAndCompleteTrustedTool(
    current.barrier.startId,
    completion.value,
  );

  assert.equal(result.outcome, 'timed_out');
  assert.equal(result.status, 'existing');
  assert.equal(result.completion.resultCode, 'tool_deadline_exceeded');
  assert.equal(
    result.completion.errorSummary,
    'Trusted Tool execution deadline exceeded',
  );
  assert.equal(completion.state.failureCommitCalls, 1);
  assert.equal(completion.state.failureIdentityCalls, 1);
  assert.deepEqual(current.calls, []);
});

test('keeps missing execution prerequisites non-terminal', async () => {
  const current = await fixture();
  const completion = successCompletionDependencies(current);
  completion.value.artifacts.findInput = async () => null;

  await assert.rejects(
    executeAndCompleteTrustedTool(current.barrier.startId, completion.value),
    TrustedToolExecutionUnavailableError,
  );
  assert.equal(completion.state.failureCommitCalls, 0);
  assert.equal(completion.state.failureCompletion, null);
});

test('exposes unified Tool completion only through its explicit subpath', () => {
  const root = require('../dist');
  const authority = require('@qinglong/runtime-core/trusted-tool-completion');
  assert.equal(root.executeAndCompleteTrustedTool, undefined);
  assert.equal(
    authority.executeAndCompleteTrustedTool,
    executeAndCompleteTrustedTool,
  );
});

test('binds fixed low-sensitive failed and timed-out facts to terminal StepRun mutations', async () => {
  const current = await fixture();
  for (const outcome of ['failed', 'timed_out']) {
    const facts = TOOL_EXECUTION_FAILURE_FACTS[outcome];
    const failure = createToolExecutionFailureResult(
      current.barrier,
      outcome,
      1_500,
    );
    const mutation = transitionStepRunMutation(
      current.running,
      {
        expectedVersion: current.running.version,
        expectedDigest: current.running.stepRunDigest,
        mutationId: `step-${outcome}-read-003`,
        to: outcome,
        atMs: failure.completedAtMs,
        resultCode: facts.resultCode,
        errorSummary: facts.errorSummary,
      },
      {
        expectedRunVersion: 6,
        expectedRunEventSequence: 9,
        eventId: `event-step-${outcome}-read-001`,
        dedupeKey: `step-${outcome}:step-run-read-001`,
        actor: { type: 'system', id: 'trusted-tool-runtime' },
      },
    );
    const command = createToolExecutionFailureCompletionCommand({
      barrier: current.barrier,
      failure,
      stepRunMutation: mutation,
    });
    const completion = toolExecutionFailureCompletionRecord(command);

    assert.equal(completion.schema, TOOL_EXECUTION_FAILURE_COMPLETION_SCHEMA);
    assert.equal(completion.outcome, outcome);
    assert.equal(completion.resultCode, facts.resultCode);
    assert.equal(completion.errorSummary, facts.errorSummary);
    assert.equal(completion.completedStepRunVersion, 3);
    assert.equal(mutation.stepRun.outputRef, null);
    assert.equal(
      JSON.stringify(completion).includes('adapter stack trace'),
      false,
    );
  }
});

test('rejects caller-selected Tool failure diagnostics and root authority', async () => {
  const current = await fixture();
  const failure = createToolExecutionFailureResult(
    current.barrier,
    'failed',
    1_500,
  );
  assert.throws(
    () =>
      createToolExecutionFailureResult(
        current.barrier,
        'adapter stack trace',
        1_500,
      ),
    TypeError,
  );

  const mutation = transitionStepRunMutation(
    current.running,
    {
      expectedVersion: current.running.version,
      expectedDigest: current.running.stepRunDigest,
      mutationId: 'step-failed-read-drift-003',
      to: 'failed',
      atMs: failure.completedAtMs,
      resultCode: TOOL_EXECUTION_FAILURE_FACTS.failed.resultCode,
      errorSummary: TOOL_EXECUTION_FAILURE_FACTS.failed.errorSummary,
    },
    {
      expectedRunVersion: 6,
      expectedRunEventSequence: 9,
      eventId: 'event-step-failed-read-drift-001',
      dedupeKey: 'step-failed:step-run-read-drift-001',
      actor: { type: 'system', id: 'trusted-tool-runtime' },
    },
  );
  assert.throws(
    () =>
      createToolExecutionFailureCompletionCommand({
        barrier: current.barrier,
        failure,
        stepRunMutation: {
          ...mutation,
          stepRun: {
            ...mutation.stepRun,
            errorSummary: 'adapter stack trace',
          },
        },
      }),
    TypeError,
  );

  const root = require('../dist');
  const authority = require('@qinglong/runtime-core/tool-execution-failure-completion');
  assert.equal(root.createToolExecutionFailureResult, undefined);
  assert.equal(
    authority.createToolExecutionFailureResult,
    createToolExecutionFailureResult,
  );
});
