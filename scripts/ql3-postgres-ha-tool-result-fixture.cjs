const assert = require('node:assert/strict');

const {
  PostgresRunRepository,
  PostgresStepRunRepository,
  PostgresToolExecutionCompletionRepository,
  PostgresToolExecutionStartBarrierRepository,
  PostgresToolInvocationArtifactRepository,
  PostgresToolResultKeyCatalogReader,
  PostgresToolResultRekeyReader,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  PostgresToolResultKeyCatalogRepository,
  PostgresToolResultRekeyRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/admin.js');
const {
  createStepRunMutation,
  transitionStepRunMutation,
} = require('../packages/ql3-runtime-core/dist/run/stepRun.js');
const {
  TOOL_EXECUTION_START_AUDIT_OPERATION,
  createToolExecutionEvidenceBundle,
  toolExecutionAdmissionEvidence,
} = require('../packages/ql3-runtime-core/dist/tool-execution/toolExecutionEvidence.js');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackageResourceGeneration.js');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionRegistry,
} = require('../packages/ql3-runtime-core/dist/tool-execution/tool-registry/projectToolDefinitionSnapshot.js');
const {
  TrustedToolHandlerBindingRegistry,
  admitTrustedToolExecution,
  createTrustedToolHandlerBinding,
  createTrustedToolInvocationPlan,
  trustedToolContractIdentityDigest,
} = require('../packages/ql3-runtime-core/dist/tool-execution/trustedToolInvocation.js');
const {
  prepareToolInvocation,
} = require('../packages/ql3-runtime-core/dist/tool-execution/tool-registry/toolRegistry.js');
const {
  createToolExecutionStartCommand,
} = require('../packages/ql3-runtime-core/dist/tool-execution/toolExecutionStartBarrier.js');
const {
  TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
  normalizeToolExecutionResultKeyBinding,
} = require('../packages/ql3-runtime-core/dist/tool-execution/toolExecutionCompletion.js');
const {
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRetirementCommand,
  createToolResultKeyRotationCommand,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('../packages/ql3-runtime-core/dist/tool-execution/toolResultKeyCatalog.js');
const {
  createToolExecutionResultRekeyCommand,
  createToolResultKeyRetirementReceiptCommand,
} = require('../packages/ql3-runtime-core/dist/tool-execution/toolResultRekey.js');
const {
  TrustedToolExecutionAdapterRegistry,
} = require('../packages/ql3-runtime-core/dist/tool-execution/trustedToolExecution.js');
const {
  executeAndCompleteTrustedToolSuccess,
} = require('../packages/ql3-runtime-core/dist/tool-execution/trustedToolSuccessCompletion.js');

const PROJECT_ID = 'ha-tool-result-project';
const RUN_ID = '34000000-0000-4000-8000-000000000001';
const STEP_RUN_ID = 'ha-tool-result-step';
const START_ID = 'ha-tool-result-start';
const TOOL = Object.freeze({
  name: 'ha.result.read',
  version: '1.0.0',
});
const SUBJECT = Object.freeze({
  type: 'user',
  id: 'usr-ha-tool-result',
});
const POLICY_FENCE = Object.freeze({
  projectVersion: 1,
  bindingVersion: 1,
});
const INVOCATION_KEY_ID = 'ha-tool-invocation-key';
const RESULT_KEY_A_ID = 'ha-result-key-a';
const RESULT_KEY_B_ID = 'ha-result-key-b';
const RESULT_KEY_C_ID = 'ha-result-key-c';
const INVOCATION_KEY_BYTE = 21;
const RESULT_KEY_A_BYTE = 22;
const RESULT_KEY_B_BYTE = 23;
const RESULT_KEY_C_BYTE = 24;
const EXPECTED_OUTPUT = Object.freeze({
  summary: 'HA durable Tool result survived rekey and promotion',
});

function copyKey(byte) {
  return Buffer.alloc(32, byte);
}

function snapshot() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-ha-tool-result',
    projectId: PROJECT_ID,
    packageName: 'ha',
    lockDigest: '8'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: '9'.repeat(64),
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: PROJECT_ID,
    contributions: [
      {
        generation,
        revisionDigest: 'a'.repeat(64),
        definitions: [
          {
            ...TOOL,
            description: 'Read one bounded HA result fixture',
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
          },
        ],
      },
    ],
  });
}

function principal(baseTimeMs) {
  return Object.freeze({
    subject: SUBJECT,
    authenticationId: 'auth-ha-tool-result',
    authenticatedAtMs: baseTimeMs - 1_000,
    expiresAtMs: baseTimeMs + 120_000,
    assurance: 'multi_factor',
  });
}

function authorizer() {
  return Object.freeze({
    async authorize() {
      return Object.freeze({
        effect: 'allow',
        reasons: Object.freeze(['role_grant']),
        fence: POLICY_FENCE,
      });
    },
  });
}

function bindingRegistry(definitionSnapshot) {
  const binding = createTrustedToolHandlerBinding(definitionSnapshot, {
    tool: TOOL,
    adapter: {
      id: 'builtin.ha-result-read',
      version: '1.0.0',
    },
    executionClass: 'builtin_in_process',
    profiles: ['cluster-control'],
    authorities: ['database.read'],
    timeoutSeconds: 20,
    redactionContract: {
      id: 'redaction.ha-result-read',
      version: '1.0.0',
    },
    auditContract: {
      id: 'audit.tool-call',
      version: '1.0.0',
    },
  });
  return Object.freeze({
    binding,
    bindings: new TrustedToolHandlerBindingRegistry(definitionSnapshot, [
      binding,
    ]),
  });
}

async function startBundle(readyStepRun, baseTimeMs) {
  const definitionSnapshot = snapshot();
  const { binding, bindings } = bindingRegistry(definitionSnapshot);
  assert.equal(binding.definitionDigest, readyStepRun.definitionDigest);
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(definitionSnapshot),
    {
      projectId: PROJECT_ID,
      principal: principal(baseTimeMs),
      nowMs: baseTimeMs,
      tool: TOOL,
      input: { runId: RUN_ID },
    },
    authorizer(),
  );
  const planBundle = createTrustedToolInvocationPlan(bindings, invocation, {
    actionRef: `tool-plan:${RUN_ID}`,
    inputArtifactId: 'ha-tool-result-input-artifact',
    previewArtifactId: 'ha-tool-result-preview-artifact',
    artifactKeyId: INVOCATION_KEY_ID,
    artifactKey: copyKey(INVOCATION_KEY_BYTE),
    artifactNonce: Buffer.alloc(12, 24),
    profile: 'cluster-control',
    preview: {
      title: 'HA Tool Result',
      summary: 'Creates one encrypted completion before promotion',
      fields: [
        {
          kind: 'identifier',
          label: 'Run',
          value: RUN_ID,
        },
      ],
      warnings: [],
    },
    sealedAtMs: baseTimeMs + 100,
  });
  const plan = planBundle.plan;
  const startedAtMs = baseTimeMs + 200;
  const evidence = createToolExecutionEvidenceBundle({
    traceId: '5'.repeat(32),
    spanId: '6'.repeat(16),
    projectId: PROJECT_ID,
    runId: RUN_ID,
    stepRunId: readyStepRun.id,
    invocationPlanDigest: plan.planDigest,
    bindingDigest: binding.bindingDigest,
    adapterDigest: trustedToolContractIdentityDigest(binding.adapter),
    redactionContractDigest: trustedToolContractIdentityDigest(
      binding.redactionContract,
    ),
    auditContractDigest: trustedToolContractIdentityDigest(
      binding.auditContract,
    ),
    audit: {
      eventId: '34000000-0000-4000-8000-000000000004',
      requestId: 'ha-tool-result-start-request',
      operationId: TOOL_EXECUTION_START_AUDIT_OPERATION,
      projectId: PROJECT_ID,
      subject: SUBJECT,
      authenticationId: 'auth-ha-tool-result',
      outcome: 'allowed',
      reasons: ['tool_execution_start'],
      fence: POLICY_FENCE,
      occurredAtMs: startedAtMs,
    },
    createdAtMs: startedAtMs,
  });
  const admission = await admitTrustedToolExecution(bindings, plan, {
    principal: principal(baseTimeMs),
    profile: 'cluster-control',
    nowMs: startedAtMs,
    authorizer: authorizer(),
    evidence: {
      stepRun: {
        id: readyStepRun.id,
        version: readyStepRun.version,
        digest: readyStepRun.stepRunDigest,
      },
      ...toolExecutionAdmissionEvidence(evidence),
    },
  });
  const mutation = transitionStepRunMutation(
    readyStepRun,
    {
      expectedVersion: readyStepRun.version,
      expectedDigest: readyStepRun.stepRunDigest,
      mutationId: 'ha-tool-result-running-mutation',
      to: 'running',
      atMs: startedAtMs,
    },
    {
      expectedRunVersion: 1,
      expectedRunEventSequence: 1,
      eventId: '34000000-0000-4000-8000-000000000003',
      dedupeKey: 'ha-tool-result:running',
      actor: SUBJECT,
    },
  );
  return Object.freeze({
    command: createToolExecutionStartCommand({
      startId: START_ID,
      admission,
      evidence,
      stepRunMutation: mutation,
    }),
    inputArtifact: planBundle.inputArtifact,
    previewArtifact: planBundle.previewArtifact,
    definitionSnapshot,
    binding,
    bindings,
    startedAtMs,
  });
}

function adapterRegistry(bindings, binding, executionCounter) {
  return new TrustedToolExecutionAdapterRegistry(bindings, [
    {
      binding,
      profile: 'cluster-control',
      recoveryMode: 'retry_safe_read',
      async execute() {
        executionCounter.count += 1;
        return EXPECTED_OUTPUT;
      },
    },
  ]);
}

function keyProvider(keyId, byte) {
  return Object.freeze({
    async resolve(requestedKeyId) {
      return requestedKeyId === keyId
        ? Object.freeze({
            keyId,
            key: copyKey(byte),
          })
        : null;
    },
  });
}

function blockingKeyProvider(keyId, byte) {
  let requestedResolve;
  let releaseResolve;
  let requested = false;
  const keyRequested = new Promise((resolve) => {
    requestedResolve = resolve;
  });
  const released = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  return Object.freeze({
    keyRequested,
    release() {
      releaseResolve();
    },
    provider: Object.freeze({
      async resolve(requestedKeyId) {
        if (requestedKeyId !== keyId) return null;
        if (!requested) {
          requested = true;
          requestedResolve();
        }
        await released;
        return Object.freeze({
          keyId,
          key: copyKey(byte),
        });
      },
    }),
  });
}

function completionDependencies(options) {
  const {
    runtimePool,
    definitionSnapshot,
    binding,
    bindings,
    executionCounter,
    resultKeyId,
    resultKeyByte,
    completedAtMs,
    completionRepository,
    resultKeyProvider,
  } = options;
  return Object.freeze({
    barriers: new PostgresToolExecutionStartBarrierRepository(runtimePool),
    artifacts: new PostgresToolInvocationArtifactRepository(runtimePool),
    keys: keyProvider(INVOCATION_KEY_ID, INVOCATION_KEY_BYTE),
    adapters: adapterRegistry(bindings, binding, executionCounter),
    completions:
      completionRepository ??
      new PostgresToolExecutionCompletionRepository(runtimePool),
    stepRuns: new PostgresStepRunRepository(runtimePool),
    runs: new PostgresRunRepository(runtimePool),
    resultKeyCatalog: new PostgresToolResultKeyCatalogReader(runtimePool),
    resultRekeys: new PostgresToolResultRekeyReader(runtimePool),
    resultKeys: resultKeyProvider ?? keyProvider(resultKeyId, resultKeyByte),
    identities: Object.freeze({
      create() {
        return Object.freeze({
          artifactId: 'ha-tool-result-output-artifact',
          mutationId: 'ha-tool-result-succeeded-mutation',
          eventId: '34000000-0000-4000-8000-000000000005',
        });
      },
    }),
    nonceFactory: () => Buffer.alloc(12, 25),
    now: () => completedAtMs,
    definitionSnapshot,
  });
}

async function readBinding(pool, startId) {
  const result = await pool.query(
    `SELECT
       start_id AS "startId",
       artifact_id AS "artifactId",
       artifact_digest AS "artifactDigest",
       catalog_generation AS "catalogGeneration",
       catalog_digest AS "catalogDigest",
       key_id AS "keyId",
       material_proof AS "materialProof",
       binding_digest AS "bindingDigest"
     FROM "ql3"."tool_execution_result_key_bindings"
     WHERE start_id = $1`,
    [startId],
  );
  assert.equal(result.rowCount, 1);
  return normalizeToolExecutionResultKeyBinding({
    schema: TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
    ...result.rows[0],
  });
}

async function completeParentRun(runtimePool, completion, completedAtMs) {
  const runs = new PostgresRunRepository(runtimePool);
  await runs.transaction(async (transaction) => {
    const current = await transaction.findRunById(RUN_ID);
    assert.ok(current);
    assert.equal(current.status, 'running');
    const next = Object.freeze({
      ...current,
      status: 'succeeded',
      version: current.version + 1,
      eventSequence: current.eventSequence + 1,
      outputRef: completion.resultArtifact.artifactId,
      finishedAtMs: completedAtMs + 1,
    });
    assert.equal(
      await transaction.compareAndSetRun(next, current.version),
      true,
    );
    await transaction.appendEvent(
      Object.freeze({
        id: '34000000-0000-4000-8000-000000000006',
        runId: RUN_ID,
        sequence: next.eventSequence,
        type: 'run.succeeded',
        dedupeKey: 'ha-tool-result:run-succeeded',
        actorType: 'system',
        actorId: 'trusted-tool-runtime',
        stepRunId: STEP_RUN_ID,
        payload: Object.freeze({
          resultArtifactId: completion.resultArtifact.artifactId,
        }),
        createdAtMs: completedAtMs + 1,
      }),
    );
  });
}

async function reopen(runtimePool, fixture, expectedExecutionCount) {
  const executionCounter = { count: 0 };
  const result = await executeAndCompleteTrustedToolSuccess(
    START_ID,
    completionDependencies({
      runtimePool,
      definitionSnapshot: fixture.definitionSnapshot,
      binding: fixture.binding,
      bindings: fixture.bindings,
      executionCounter,
      resultKeyId: fixture.resultKeyId,
      resultKeyByte: fixture.resultKeyByte,
      completedAtMs: fixture.completedAtMs,
    }),
  );
  assert.equal(result.status, 'existing');
  assert.deepEqual(result.output, EXPECTED_OUTPUT);
  assert.equal(executionCounter.count, expectedExecutionCount);
  return result;
}

async function persistNonEmptyToolResultRetirement(options) {
  const {
    runtimePool,
    adminPool,
    catalogCommitFaultPool,
    catalogCommitFaultEvidence,
    completionCommitFaultPool,
    completionCommitFaultEvidence,
    rekeyCommitFaultPool,
    rekeyCommitFaultEvidence,
    baseTimeMs,
  } = options;
  const catalogs = new PostgresToolResultKeyCatalogRepository(adminPool);
  const initialCatalog = await catalogs.append(
    createToolResultKeyCatalogBootstrapCommand({
      keyId: RESULT_KEY_A_ID,
      materialProof: toolResultKeyMaterialProof(
        RESULT_KEY_A_ID,
        copyKey(RESULT_KEY_A_BYTE),
      ),
      mutationId: 'ha-tool-result-key-bootstrap-a',
    }),
  );
  await runtimePool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES (
       $1, 'HA Tool Result', 'ha-tool-result', 'active', 1, $2, $2
     )`,
    [PROJECT_ID, baseTimeMs],
  );
  await runtimePool.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, trigger_type,
       execution_origin, execution_owner, status, version,
       event_sequence, priority, created_at_ms
     ) VALUES (
       $1, $2, 'ha-tool-result-task', 'v1', 'manual',
       'manual', 'runtime', 'running', 0, 0, 0, $3
     )`,
    [RUN_ID, PROJECT_ID, baseTimeMs],
  );
  const definitionSnapshot = snapshot();
  const creation = createStepRunMutation(
    {
      id: STEP_RUN_ID,
      runId: RUN_ID,
      stepKey: 'workflow.ha-result-read',
      kind: 'tool',
      definitionRef: `tool:${TOOL.name}@${TOOL.version}`,
      definitionDigest: definitionSnapshot.definitions[0].definitionDigest,
      required: true,
      initialStatus: 'ready',
      inputRef: 'artifact:ha-tool-result:input',
      mutationId: 'ha-tool-result-create-mutation',
      createdAtMs: baseTimeMs + 50,
    },
    {
      expectedRunVersion: 0,
      expectedRunEventSequence: 0,
      eventId: '34000000-0000-4000-8000-000000000002',
      dedupeKey: 'ha-tool-result:create',
      actor: SUBJECT,
    },
  );
  const steps = new PostgresStepRunRepository(runtimePool);
  assert.equal((await steps.apply(creation)).status, 'applied');
  const bundle = await startBundle(creation.stepRun, baseTimeMs);
  const artifacts = new PostgresToolInvocationArtifactRepository(runtimePool);
  assert.deepEqual(
    await artifacts.put(bundle.inputArtifact, bundle.previewArtifact),
    { status: 'inserted' },
  );
  const starts = new PostgresToolExecutionStartBarrierRepository(runtimePool);
  const start = await starts.prepare(bundle.command);
  assert.equal(start.status, 'created');
  const completedAtMs = bundle.startedAtMs + 100;
  const staleExecutionCounter = { count: 0 };
  const blockedResultKey = blockingKeyProvider(
    RESULT_KEY_A_ID,
    RESULT_KEY_A_BYTE,
  );
  const staleCompletion = executeAndCompleteTrustedToolSuccess(
    START_ID,
    completionDependencies({
      runtimePool,
      definitionSnapshot: bundle.definitionSnapshot,
      binding: bundle.binding,
      bindings: bundle.bindings,
      executionCounter: staleExecutionCounter,
      resultKeyId: RESULT_KEY_A_ID,
      resultKeyByte: RESULT_KEY_A_BYTE,
      resultKeyProvider: blockedResultKey.provider,
      completedAtMs,
    }),
  );
  await blockedResultKey.keyRequested;
  assert.equal(staleExecutionCounter.count, 1);
  const rotateToBCommand = createToolResultKeyRotationCommand(
    initialCatalog.catalog,
    {
      keyId: RESULT_KEY_B_ID,
      materialProof: toolResultKeyMaterialProof(
        RESULT_KEY_B_ID,
        copyKey(RESULT_KEY_B_BYTE),
      ),
      mutationId: 'ha-tool-result-key-rotate-b',
    },
  );
  try {
    await assert.rejects(
      new PostgresToolResultKeyCatalogRepository(catalogCommitFaultPool).append(
        rotateToBCommand,
      ),
      (error) => error?.code === 'TOOL_RESULT_KEY_CATALOG_UNAVAILABLE',
    );
  } finally {
    blockedResultKey.release();
  }
  assert.deepEqual(catalogCommitFaultEvidence, {
    injected: true,
    commitCompletedBeforeFault: true,
    backendTerminationRequested: true,
    backendConnectionRejected: true,
  });
  const rotated = await catalogs.append(rotateToBCommand);
  assert.equal(rotated.status, 'existing');
  await assert.rejects(
    staleCompletion,
    (error) => error?.code === 'TOOL_EXECUTION_COMPLETION_CONFLICT',
  );
  const staleFacts = await runtimePool.query(
    `SELECT
       step.status AS "stepStatus",
       step.version AS "stepVersion",
       run.version AS "runVersion",
       run.event_sequence AS "runEventSequence",
       (SELECT count(*)::integer
          FROM "ql3"."tool_execution_completions"
         WHERE start_id = $3) AS "completionCount",
       (SELECT count(*)::integer
          FROM "ql3"."tool_execution_result_key_bindings"
         WHERE start_id = $3) AS "bindingCount"
     FROM "ql3"."step_runs" AS step
     JOIN "ql3"."runs" AS run ON run.id = step.run_id
     WHERE step.id = $1 AND run.id = $2`,
    [STEP_RUN_ID, RUN_ID, START_ID],
  );
  assert.equal(staleFacts.rowCount, 1);
  assert.deepEqual(staleFacts.rows[0], {
    stepStatus: 'running',
    stepVersion: 2,
    runVersion: 2,
    runEventSequence: 2,
    completionCount: 0,
    bindingCount: 0,
  });

  const winningExecutionCounter = { count: 0 };
  const completion = await executeAndCompleteTrustedToolSuccess(
    START_ID,
    completionDependencies({
      runtimePool,
      definitionSnapshot: bundle.definitionSnapshot,
      binding: bundle.binding,
      bindings: bundle.bindings,
      executionCounter: winningExecutionCounter,
      resultKeyId: RESULT_KEY_B_ID,
      resultKeyByte: RESULT_KEY_B_BYTE,
      completionRepository: new PostgresToolExecutionCompletionRepository(
        completionCommitFaultPool,
      ),
      completedAtMs,
    }),
  );
  assert.equal(completion.status, 'existing');
  assert.equal(winningExecutionCounter.count, 1);
  assert.deepEqual(completion.output, EXPECTED_OUTPUT);
  assert.deepEqual(completionCommitFaultEvidence, {
    injected: true,
    commitCompletedBeforeFault: true,
    backendTerminationRequested: true,
    backendConnectionRejected: true,
  });
  await completeParentRun(runtimePool, completion.completion, completedAtMs);

  const completionRepository = new PostgresToolExecutionCompletionRepository(
    runtimePool,
  );
  const artifact = await completionRepository.findResultArtifact(
    completion.completion.resultArtifact.artifactId,
  );
  assert.ok(artifact);
  const sourceBinding = await readBinding(adminPool, START_ID);
  const rotatedToC = await catalogs.append(
    createToolResultKeyRotationCommand(rotated.catalog, {
      keyId: RESULT_KEY_C_ID,
      materialProof: toolResultKeyMaterialProof(
        RESULT_KEY_C_ID,
        copyKey(RESULT_KEY_C_BYTE),
      ),
      mutationId: 'ha-tool-result-key-rotate-c',
    }),
  );
  const rekeyCommand = createToolExecutionResultRekeyCommand({
    artifact,
    binding: sourceBinding,
    previousOverlay: null,
    overlayId: 'ha-tool-result-rekey-overlay',
    mutationId: 'ha-tool-result-rekey-mutation',
    targetCatalogFence: toolResultKeyCatalogFence(
      rotatedToC.catalog,
      requireActiveToolResultKey(rotatedToC.catalog),
    ),
    targetKey: copyKey(RESULT_KEY_C_BYTE),
    output: completion.output,
    rekeyedAtMs: completedAtMs + 1,
    registry: bundle.bindings.definitionRegistry(),
    nonceFactory: () => Buffer.alloc(12, 26),
  });
  await assert.rejects(
    new PostgresToolResultRekeyRepository(rekeyCommitFaultPool).append(
      rekeyCommand,
    ),
    (error) => error?.code === 'TOOL_EXECUTION_RESULT_REKEY_UNAVAILABLE',
  );
  assert.deepEqual(rekeyCommitFaultEvidence, {
    injected: true,
    commitCompletedBeforeFault: true,
    backendTerminationRequested: true,
    backendConnectionRejected: true,
  });
  const rekeys = new PostgresToolResultRekeyRepository(adminPool);
  const rekeyReplay = await rekeys.append(rekeyCommand);
  assert.equal(rekeyReplay.status, 'existing');
  const receipt = await rekeys.create(
    createToolResultKeyRetirementReceiptCommand({
      expectedCatalogGeneration: rotatedToC.catalog.generation,
      expectedCatalogDigest: rotatedToC.catalog.catalogDigest,
      keyId: RESULT_KEY_B_ID,
      mutationId: 'ha-tool-result-retirement-receipt',
    }),
  );
  assert.equal(receipt.status, 'created');
  assert.equal(receipt.receipt.bindingCount, 1);
  assert.equal(receipt.receipt.overlayHeadCount, 1);
  const retired = await catalogs.append(
    createToolResultKeyRetirementCommand(rotatedToC.catalog, {
      keyId: RESULT_KEY_B_ID,
      retirementReceiptDigest: receipt.receipt.receiptDigest,
      mutationId: 'ha-tool-result-key-retire-b',
    }),
  );
  assert.equal(
    retired.catalog.keys.find((entry) => entry.keyId === RESULT_KEY_B_ID).state,
    'retired',
  );
  const fixture = Object.freeze({
    definitionSnapshot: bundle.definitionSnapshot,
    binding: bundle.binding,
    bindings: bundle.bindings,
    completedAtMs,
    resultKeyId: RESULT_KEY_C_ID,
    resultKeyByte: RESULT_KEY_C_BYTE,
  });
  await reopen(runtimePool, fixture, 0);
  return {
    fixture,
    report: {
      startId: START_ID,
      artifactId: artifact.artifactId,
      activeKeyId: RESULT_KEY_C_ID,
      retiredKeyId: RESULT_KEY_B_ID,
      catalogGeneration: retired.catalog.generation,
      catalogDigest: retired.catalog.catalogDigest,
      retirementReceiptDigest: receipt.receipt.receiptDigest,
      bindingCount: receipt.receipt.bindingCount,
      overlayHeadCount: receipt.receipt.overlayHeadCount,
      overlayRevision: rekeyReplay.overlay.revision,
      catalogRotationCompletionRace: {
        catalogReadBlockedBeforeCompletionCommit: true,
        ...catalogCommitFaultEvidence,
        replayStatus: rotated.status,
        staleCompletionRejected: true,
        partialCompletionCount: staleFacts.rows[0].completionCount,
        partialBindingCount: staleFacts.rows[0].bindingCount,
        stepStatusAfterRejection: staleFacts.rows[0].stepStatus,
        runVersionAfterRejection: staleFacts.rows[0].runVersion,
        runEventSequenceAfterRejection: staleFacts.rows[0].runEventSequence,
      },
      completionCommitResponseLoss: {
        ...completionCommitFaultEvidence,
        coordinatorRecoveryStatus: completion.status,
        adapterExecutionsInWinningAttempt: winningExecutionCounter.count,
        adapterExecutionsAcrossRaceAndRetry:
          staleExecutionCounter.count + winningExecutionCounter.count,
      },
      rekeyCommitResponseLoss: {
        ...rekeyCommitFaultEvidence,
        replayStatus: rekeyReplay.status,
      },
      primaryUnifiedReopen: true,
      replicatedBeforePromotion: false,
      promotedUnifiedReopen: false,
      survivedPromotion: false,
    },
  };
}

async function verifyPromotedNonEmptyToolResult(options) {
  const { runtimePool, adminPool, fixture, report } = options;
  const catalog = await new PostgresToolResultKeyCatalogRepository(
    adminPool,
  ).findCurrent();
  const receipt = await new PostgresToolResultRekeyRepository(
    adminPool,
  ).findByDigest(report.retirementReceiptDigest);
  assert.ok(catalog);
  assert.ok(receipt);
  assert.equal(catalog.generation, report.catalogGeneration);
  assert.equal(catalog.catalogDigest, report.catalogDigest);
  assert.equal(catalog.activeKeyId, report.activeKeyId);
  assert.equal(
    catalog.keys.find((entry) => entry.keyId === report.retiredKeyId).state,
    'retired',
  );
  assert.equal(receipt.bindingCount, 1);
  assert.equal(receipt.overlayHeadCount, 1);
  const reopened = await reopen(runtimePool, fixture, 0);
  assert.equal(reopened.completion.startId, report.startId);
  report.promotedUnifiedReopen = true;
  report.survivedPromotion = true;
}

module.exports = {
  persistNonEmptyToolResultRetirement,
  verifyPromotedNonEmptyToolResult,
};
