const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createPluginPackageResourceGenerationFromReferences,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createPluginPackageQuarantineEvent,
} = require('@qinglong/runtime-core/plugin-package-quarantine');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionRegistry,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  createStepRunMutation,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  ToolExecutionStartBarrierConflictError,
  ToolExecutionStartBarrierUnavailableError,
  createToolExecutionStartCommand,
} = require('@qinglong/runtime-core/tool-execution-start-barrier');
const {
  TOOL_EXECUTION_START_AUDIT_OPERATION,
  createToolExecutionEvidenceBundle,
  toolExecutionAdmissionEvidence,
} = require('@qinglong/runtime-core/tool-execution-evidence');
const {
  TrustedToolHandlerBindingRegistry,
  admitTrustedToolExecution,
  createTrustedToolHandlerBinding,
  createTrustedToolInvocationPlan,
  trustedToolContractIdentityDigest,
} = require('@qinglong/runtime-core/trusted-tool-invocation');
const {
  prepareToolInvocation,
} = require('@qinglong/runtime-core/tool-registry');
const {
  ToolExecutionCompletionConflictError,
  createToolExecutionCompletionCommand,
  createToolExecutionResultArtifact,
  openToolExecutionResultArtifact,
} = require('@qinglong/runtime-core/tool-execution-completion');
const {
  TOOL_EXECUTION_FAILURE_FACTS,
  ToolExecutionFailureCompletionConflictError,
  createToolExecutionFailureCompletionCommand,
  createToolExecutionFailureResult,
} = require('@qinglong/runtime-core/tool-execution-failure-completion');
const {
  TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
} = require('@qinglong/runtime-core/trusted-tool-execution');
const {
  createToolResultKeyCatalogBootstrapCommand,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');

const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  LocalSqliteStepRunRepository,
} = require('../dist/run/stepRunRepository');
const {
  LocalSqliteToolExecutionStartBarrierRepository,
} = require('../dist/tool-execution/toolExecutionStartBarrierRepository');
const {
  LocalSqliteToolInvocationArtifactRepository,
} = require('../dist/tool-execution/toolInvocationArtifactRepository');
const {
  LocalSqliteToolExecutionCompletionRepository,
} = require('../dist/tool-execution/toolExecutionCompletionRepository');
const {
  LocalSqliteToolExecutionFailureCompletionRepository,
} = require('../dist/tool-execution/toolExecutionFailureCompletionRepository');
const {
  LocalSqliteToolResultKeyCatalogRepository,
} = require('../dist/tool-execution/toolResultKeyCatalogRepository');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const REQUESTER = Object.freeze({ type: 'user', id: 'usr-tool-owner' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 7 });
const NOW_MS = 1_400;
const OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
  'utf8',
);
const RESULT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-result-digest@v1\0',
  'utf8',
);

function hash(domain, value) {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function authorizer() {
  return {
    async authorize() {
      return { effect: 'allow', reasons: ['role_grant'], fence: FENCE };
    },
  };
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

function projectToolSnapshot() {
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
        definitions: [
          {
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
          },
        ],
      },
    ],
  });
}

async function harness() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client.exec(`
    INSERT INTO "QingLong3Projects" (
      id, name, slug, status, version, created_at_ms, updated_at_ms
    ) VALUES (
      'project-001', 'Project', 'project-001', 'active', 1, 1, 1
    );
    INSERT INTO "Runs" (
      id, project_id, task_id, task_revision, trigger_type,
      execution_origin, execution_owner, status, version,
      event_sequence, priority, created_at_ms
    ) VALUES (
      'run-001', 'project-001', 'task-001', 'revision-001', 'manual',
      'manual', 'runtime', 'running', 0, 0, 0, 1
    );
  `);
  const authority = new LocalSqliteOperationAuthority(client);
  const stepRuns = new LocalSqliteStepRunRepository(authority);
  const starts = new LocalSqliteToolExecutionStartBarrierRepository(authority);
  const artifacts = new LocalSqliteToolInvocationArtifactRepository(authority);
  const completions = new LocalSqliteToolExecutionCompletionRepository(
    authority,
  );
  const failureCompletions =
    new LocalSqliteToolExecutionFailureCompletionRepository(authority);
  const resultKeyCatalog = new LocalSqliteToolResultKeyCatalogRepository(
    authority,
  );
  const resultKeyCatalogCommit = await resultKeyCatalog.append(
    createToolResultKeyCatalogBootstrapCommand({
      keyId: 'tool-result-key-test',
      materialProof: toolResultKeyMaterialProof(
        'tool-result-key-test',
        Buffer.alloc(32, 5),
      ),
      mutationId: 'tool-result-key-bootstrap-test',
    }),
  );
  const resultKeyCatalogFence = toolResultKeyCatalogFence(
    resultKeyCatalogCommit.catalog,
    requireActiveToolResultKey(resultKeyCatalogCommit.catalog),
  );
  const toolSnapshot = projectToolSnapshot();
  const creation = createStepRunMutation(
    {
      id: 'step-run-001',
      runId: 'run-001',
      stepKey: 'workflow.compare',
      kind: 'tool',
      definitionRef: 'tool:demo.compare@1.0.0',
      definitionDigest: toolSnapshot.definitions[0].definitionDigest,
      required: true,
      initialStatus: 'ready',
      inputRef: 'artifact:step-input-001',
      mutationId: 'step-create-001',
      createdAtMs: 1_000,
    },
    {
      expectedRunVersion: 0,
      expectedRunEventSequence: 0,
      eventId: '50000000-0000-4000-8000-000000000001',
      dedupeKey: 'step-create:step-run-001',
      actor: REQUESTER,
    },
  );
  await stepRuns.apply(creation);
  return {
    client,
    authority,
    stepRuns,
    starts,
    artifacts,
    completions,
    failureCompletions,
    resultKeyCatalog,
    resultKeyCatalogFence,
    ready: creation.stepRun,
    close: () => authority.close(),
  };
}

function executionResult(barrier, output, completedAtMs) {
  const outputDigest = hash(OUTPUT_DIGEST_DOMAIN, output);
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: barrier.startId,
    barrierDigest: barrier.barrierDigest,
    adapterDigest: barrier.adapterDigest,
    output,
    outputDigest,
    completedAtMs,
  });
  return Object.freeze({
    ...unsigned,
    resultDigest: hash(RESULT_DIGEST_DOMAIN, unsigned),
  });
}

async function command(current, overrides = {}) {
  const snapshot = projectToolSnapshot();
  const binding = createTrustedToolHandlerBinding(snapshot, {
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
  assert.equal(binding.definitionDigest, current.ready.definitionDigest);
  const bindings = new TrustedToolHandlerBindingRegistry(snapshot, [binding]);
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(snapshot),
    {
      projectId: 'project-001',
      principal: principal(),
      nowMs: 900,
      tool: { name: 'demo.compare', version: '1.0.0' },
      input: { runId: 'run-001' },
    },
    authorizer(),
  );
  const bundle = createTrustedToolInvocationPlan(bindings, invocation, {
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
  });
  await current.artifacts.put(bundle.inputArtifact, bundle.previewArtifact);
  const plan = bundle.plan;
  const evidence = createToolExecutionEvidenceBundle({
    traceId: overrides.traceId ?? '1'.repeat(32),
    spanId: '2'.repeat(16),
    projectId: 'project-001',
    runId: 'run-001',
    stepRunId: current.ready.id,
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
      eventId: overrides.auditEventId ?? '40000000-0000-4000-8000-000000000001',
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
        id: current.ready.id,
        version: current.ready.version,
        digest: current.ready.stepRunDigest,
      },
      ...toolExecutionAdmissionEvidence(evidence),
    },
  });
  const mutation = transitionStepRunMutation(
    current.ready,
    {
      expectedVersion: current.ready.version,
      expectedDigest: current.ready.stepRunDigest,
      mutationId: overrides.mutationId ?? 'step-running-002',
      to: 'running',
      atMs: NOW_MS,
    },
    {
      expectedRunVersion: 1,
      expectedRunEventSequence: 1,
      eventId: overrides.eventId ?? '50000000-0000-4000-8000-000000000002',
      dedupeKey: 'step-running:step-run-001',
      actor: REQUESTER,
    },
  );
  return createToolExecutionStartCommand({
    startId: overrides.startId ?? 'tool-start-001',
    admission,
    evidence,
    stepRunMutation: mutation,
  });
}

function counts(client) {
  return {
    ...client
      .prepare(
        `SELECT
         (SELECT COUNT(*) FROM "ToolExecutionStartBarriers") AS barriers,
         (SELECT COUNT(*) FROM "ToolExecutionStartArtifactBindings")
           AS bindings,
         (SELECT COUNT(*) FROM "ToolExecutionTraceAnchors") AS traces,
         (SELECT COUNT(*) FROM "ToolExecutionAuditReceipts") AS receipts,
         (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents") AS audits`,
      )
      .get(),
  };
}

test('atomically records evidence, running transition and exact replay', async () => {
  const current = await harness();
  try {
    const start = await command(current);
    const [first, replay] = await Promise.all([
      current.starts.prepare(start),
      current.starts.prepare(start),
    ]);
    assert.deepEqual([first.status, replay.status].sort(), [
      'created',
      'existing',
    ]);
    assert.deepEqual(counts(current.client), {
      barriers: 1,
      bindings: 1,
      traces: 1,
      receipts: 1,
      audits: 1,
    });
    const step = await current.stepRuns.findById('step-run-001');
    assert.equal(step.status, 'running');
    assert.equal(step.version, 2);
    assert.deepEqual(
      await current.starts.findByStartId('tool-start-001'),
      first.barrier,
    );
    assert.deepEqual(
      await current.starts.findByStepRun('run-001', 'step-run-001', 2),
      first.barrier,
    );
    const run = current.client
      .prepare(
        `SELECT version, event_sequence AS "eventSequence"
         FROM "Runs" WHERE id = 'run-001'`,
      )
      .get();
    assert.deepEqual({ ...run }, { version: 2, eventSequence: 2 });
  } finally {
    await current.close();
  }
});

test('atomically seals result, succeeds StepRun and exactly replays completion', async () => {
  const current = await harness();
  try {
    const prepared = await current.starts.prepare(await command(current));
    const barrier = prepared.barrier;
    const result = executionResult(
      barrier,
      { summary: 'Run is healthy' },
      1_500,
    );
    const registry = projectToolDefinitionRegistry(projectToolSnapshot());
    const artifact = createToolExecutionResultArtifact(
      {
        artifactId: 'artifact-result-001',
        projectId: barrier.projectId,
        runId: barrier.runId,
        stepRunId: barrier.stepRunId,
        tool: { name: 'demo.compare', version: '1.0.0' },
        executionResult: result,
        keyId: 'tool-result-key-test',
        key: Buffer.alloc(32, 5),
      },
      registry,
      () => Buffer.alloc(12, 4),
    );
    const running = await current.stepRuns.findById('step-run-001');
    const mutation = transitionStepRunMutation(
      running,
      {
        expectedVersion: running.version,
        expectedDigest: running.stepRunDigest,
        mutationId: 'step-succeeded-003',
        to: 'succeeded',
        atMs: result.completedAtMs,
        outputRef: artifact.artifactId,
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: '50000000-0000-4000-8000-000000000003',
        dedupeKey: 'step-succeeded:step-run-001',
        actor: REQUESTER,
      },
    );
    const completionCommand = createToolExecutionCompletionCommand({
      barrier,
      executionResult: result,
      resultArtifact: artifact,
      resultKeyCatalogFence: current.resultKeyCatalogFence,
      stepRunMutation: mutation,
    });
    const [first, replay] = await Promise.all([
      current.completions.commit(completionCommand),
      current.completions.commit(completionCommand),
    ]);
    assert.deepEqual([first.status, replay.status].sort(), [
      'created',
      'existing',
    ]);
    assert.deepEqual(
      await current.completions.findByStartId(barrier.startId),
      first.completion,
    );
    const storedArtifact = await current.completions.findResultArtifact(
      artifact.artifactId,
    );
    assert.deepEqual(
      openToolExecutionResultArtifact(
        storedArtifact,
        Buffer.alloc(32, 5),
        registry,
      ),
      result.output,
    );
    assert.equal(
      current.client
        .prepare(`SELECT COUNT(*) AS count FROM "ToolExecutionCompletions"`)
        .get().count,
      1,
    );
    const step = await current.stepRuns.findById('step-run-001');
    assert.equal(step.status, 'succeeded');
    assert.equal(step.outputRef, artifact.artifactId);
    assert.deepEqual(
      {
        ...current.client
          .prepare(
            `SELECT version, event_sequence AS "eventSequence"
             FROM "Runs" WHERE id = 'run-001'`,
          )
          .get(),
      },
      { version: 3, eventSequence: 3 },
    );
    const failure = createToolExecutionFailureResult(barrier, 'failed', 1_600);
    const failedMutation = transitionStepRunMutation(
      running,
      {
        expectedVersion: running.version,
        expectedDigest: running.stepRunDigest,
        mutationId: 'step-failed-after-success-004',
        to: 'failed',
        atMs: failure.completedAtMs,
        ...TOOL_EXECUTION_FAILURE_FACTS.failed,
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: '50000000-0000-4000-8000-000000000004',
        dedupeKey: 'step-failed-after-success:step-run-001',
        actor: REQUESTER,
      },
    );
    await assert.rejects(
      current.failureCompletions.commit(
        createToolExecutionFailureCompletionCommand({
          barrier,
          failure,
          stepRunMutation: failedMutation,
        }),
      ),
      ToolExecutionFailureCompletionConflictError,
    );
  } finally {
    await current.close();
  }
});

test('atomically records fixed failure facts and excludes a success outcome', async () => {
  const current = await harness();
  try {
    const prepared = await current.starts.prepare(await command(current));
    const barrier = prepared.barrier;
    const running = await current.stepRuns.findById('step-run-001');
    const failure = createToolExecutionFailureResult(barrier, 'failed', 1_500);
    const failedMutation = transitionStepRunMutation(
      running,
      {
        expectedVersion: running.version,
        expectedDigest: running.stepRunDigest,
        mutationId: 'step-failed-003',
        to: 'failed',
        atMs: failure.completedAtMs,
        ...TOOL_EXECUTION_FAILURE_FACTS.failed,
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: '50000000-0000-4000-8000-000000000003',
        dedupeKey: 'step-failed:step-run-001',
        actor: REQUESTER,
      },
    );
    const failureCommand = createToolExecutionFailureCompletionCommand({
      barrier,
      failure,
      stepRunMutation: failedMutation,
    });
    const [first, replay] = await Promise.all([
      current.failureCompletions.commit(failureCommand),
      current.failureCompletions.commit(failureCommand),
    ]);
    assert.deepEqual([first.status, replay.status].sort(), [
      'created',
      'existing',
    ]);
    assert.deepEqual(
      await current.failureCompletions.findByStartId(barrier.startId),
      first.completion,
    );
    const failedStep = await current.stepRuns.findById('step-run-001');
    assert.equal(failedStep.status, 'failed');
    assert.equal(failedStep.outputRef, null);
    assert.equal(failedStep.resultCode, 'tool_adapter_failed');
    assert.equal(failedStep.errorSummary, 'Trusted Tool execution failed');
    assert.deepEqual(
      {
        ...current.client
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM "ToolExecutionFailureCompletions")
                 AS failureCount,
               (SELECT COUNT(*) FROM "ToolExecutionCompletions")
                 AS successCount`,
          )
          .get(),
      },
      { failureCount: 1, successCount: 0 },
    );

    const result = executionResult(
      barrier,
      { summary: 'late success must lose' },
      1_600,
    );
    const registry = projectToolDefinitionRegistry(projectToolSnapshot());
    const artifact = createToolExecutionResultArtifact(
      {
        artifactId: 'artifact-result-late-001',
        projectId: barrier.projectId,
        runId: barrier.runId,
        stepRunId: barrier.stepRunId,
        tool: { name: 'demo.compare', version: '1.0.0' },
        executionResult: result,
        keyId: 'tool-result-key-test',
        key: Buffer.alloc(32, 5),
      },
      registry,
      () => Buffer.alloc(12, 4),
    );
    const succeededMutation = transitionStepRunMutation(
      running,
      {
        expectedVersion: running.version,
        expectedDigest: running.stepRunDigest,
        mutationId: 'step-succeeded-after-failure-004',
        to: 'succeeded',
        atMs: result.completedAtMs,
        outputRef: artifact.artifactId,
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: '50000000-0000-4000-8000-000000000004',
        dedupeKey: 'step-succeeded-after-failure:step-run-001',
        actor: REQUESTER,
      },
    );
    await assert.rejects(
      current.completions.commit(
        createToolExecutionCompletionCommand({
          barrier,
          executionResult: result,
          resultArtifact: artifact,
          resultKeyCatalogFence: current.resultKeyCatalogFence,
          stepRunMutation: succeededMutation,
        }),
      ),
      ToolExecutionCompletionConflictError,
    );
  } finally {
    await current.close();
  }
});

test('rejects replay identity drift without changing durable state', async () => {
  const current = await harness();
  try {
    const first = await command(current);
    const drift = await command(current, {
      startId: 'tool-start-other',
    });
    await current.starts.prepare(first);
    await assert.rejects(
      current.starts.prepare(drift),
      ToolExecutionStartBarrierConflictError,
    );
    assert.deepEqual(counts(current.client), {
      barriers: 1,
      bindings: 1,
      traces: 1,
      receipts: 1,
      audits: 1,
    });
  } finally {
    await current.close();
  }
});

test('rolls back every fact when an audit identity already exists', async () => {
  const current = await harness();
  try {
    const start = await command(current);
    const audit = start.evidence.audit;
    current.client
      .prepare(
        `INSERT INTO "QingLong3SecurityAuditEvents" (
           event_id, request_id, operation_id, project_id, subject_type,
           subject_id, authentication_id, outcome, reasons_json,
           fence_project_version, fence_binding_version, occurred_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        audit.eventId,
        audit.requestId,
        audit.operationId,
        audit.projectId,
        audit.subject.type,
        audit.subject.id,
        audit.authenticationId,
        audit.outcome,
        JSON.stringify(audit.reasons),
        audit.fence.projectVersion,
        audit.fence.bindingVersion,
        audit.occurredAtMs,
      );
    await assert.rejects(
      current.starts.prepare(start),
      ToolExecutionStartBarrierConflictError,
    );
    assert.deepEqual(counts(current.client), {
      barriers: 0,
      bindings: 0,
      traces: 0,
      receipts: 0,
      audits: 1,
    });
    assert.equal(
      (await current.stepRuns.findById('step-run-001')).status,
      'ready',
    );
    assert.equal(
      current.client
        .prepare(`SELECT version FROM "Runs" WHERE id = 'run-001'`)
        .get().version,
      1,
    );
  } finally {
    await current.close();
  }
});

test('fails closed when a stored barrier projection is corrupted', async () => {
  const current = await harness();
  try {
    const start = await command(current);
    await current.starts.prepare(start);
    current.client.exec('PRAGMA ignore_check_constraints = ON');
    current.client
      .prepare(
        `UPDATE "ToolExecutionStartBarriers"
         SET barrier_json = json_set(
           barrier_json, '$.startedAtMs', 1401
         ) WHERE start_id = 'tool-start-001'`,
      )
      .run();
    await assert.rejects(
      current.starts.findByStartId('tool-start-001'),
      ToolExecutionStartBarrierUnavailableError,
    );
  } finally {
    await current.close();
  }
});

test('fails closed when a historical barrier has no Artifact binding', async () => {
  const current = await harness();
  try {
    const start = await command(current);
    await current.starts.prepare(start);
    current.client
      .prepare(
        `DELETE FROM "ToolExecutionStartArtifactBindings"
         WHERE start_id = 'tool-start-001'`,
      )
      .run();
    await assert.rejects(
      current.starts.findByStartId('tool-start-001'),
      ToolExecutionStartBarrierUnavailableError,
    );
  } finally {
    await current.close();
  }
});

test('rejects a new Tool start pinned to a quarantined Package lock', async () => {
  const current = await harness();
  try {
    const start = await command(current);
    const snapshot = projectToolSnapshot();
    const source = snapshot.sources[0];
    const quarantine = createPluginPackageQuarantineEvent({
      mutationId: 'quarantine-tool-demo',
      revocationReceiptDigest: DIGEST_B,
      impactDigest: DIGEST_C,
      target: {
        projectId: snapshot.projectId,
        packageName: source.packageName,
        installationId: source.installationId,
        lockDigest: source.lockDigest,
        installState: 'active',
        installVersion: 1,
        installRecordDigest: 'd'.repeat(64),
        activeLockDigest: source.lockDigest,
      },
      proposer: { type: 'user', id: 'owner-a' },
      confirmer: { type: 'user', id: 'owner-b' },
      authorizationMode: 'dual_control',
      reasonCode: 'confirmed_key_compromise',
      occurredAtMs: 1_300,
    });
    current.client.exec('PRAGMA foreign_keys = OFF');
    current.client
      .prepare(
        `INSERT INTO "QingLong3ProjectToolDefinitionSnapshots" (
           project_id, active_vector_digest, definitions_digest,
           snapshot_digest, snapshot_json, committed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.projectId,
        snapshot.activeVectorDigest,
        snapshot.definitionsDigest,
        snapshot.snapshotDigest,
        JSON.stringify(snapshot),
        1_200,
      );
    current.client
      .prepare(
        `INSERT INTO "QingLong3ProjectToolDefinitionSnapshotSources" (
           project_id, active_vector_digest, package_name, installation_id,
           generation, generation_digest, lock_digest, revision_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.projectId,
        snapshot.activeVectorDigest,
        source.packageName,
        source.installationId,
        source.generation,
        source.generationDigest,
        source.lockDigest,
        source.revisionDigest,
      );
    current.client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageQuarantineEvents" (
           event_digest, mutation_id, revocation_receipt_digest, impact_digest,
           project_id, package_name, installation_id, lock_digest,
           install_state, install_version, install_record_digest,
           active_lock_digest, proposer_type, proposer_id, confirmer_type,
           confirmer_id, authorization_mode, reason_code, occurred_at_ms,
           event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quarantine.eventDigest,
        quarantine.mutationId,
        quarantine.revocationReceiptDigest,
        quarantine.impactDigest,
        quarantine.target.projectId,
        quarantine.target.packageName,
        quarantine.target.installationId,
        quarantine.target.lockDigest,
        quarantine.target.installState,
        quarantine.target.installVersion,
        quarantine.target.installRecordDigest,
        quarantine.target.activeLockDigest,
        quarantine.proposer.type,
        quarantine.proposer.id,
        quarantine.confirmer.type,
        quarantine.confirmer.id,
        quarantine.authorizationMode,
        quarantine.reasonCode,
        quarantine.occurredAtMs,
        JSON.stringify(quarantine),
      );
    const before = counts(current.client);
    await assert.rejects(
      current.starts.prepare(start),
      ToolExecutionStartBarrierConflictError,
    );
    assert.deepEqual(counts(current.client), before);
  } finally {
    await current.close();
  }
});

test('rejects a Package Tool while lifecycle is disabled and admits it after enable', async () => {
  const current = await harness();
  try {
    const start = await command(current);
    const snapshot = projectToolSnapshot();
    const source = snapshot.sources[0];
    current.client.exec('PRAGMA foreign_keys = OFF');
    current.client
      .prepare(
        `INSERT INTO "QingLong3ProjectToolDefinitionSnapshots" (
           project_id, active_vector_digest, definitions_digest,
           snapshot_digest, snapshot_json, committed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.projectId,
        snapshot.activeVectorDigest,
        snapshot.definitionsDigest,
        snapshot.snapshotDigest,
        JSON.stringify(snapshot),
        1_200,
      );
    current.client
      .prepare(
        `INSERT INTO "QingLong3ProjectToolDefinitionSnapshotSources" (
           project_id, active_vector_digest, package_name, installation_id,
           generation, generation_digest, lock_digest, revision_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.projectId,
        snapshot.activeVectorDigest,
        source.packageName,
        source.installationId,
        source.generation,
        source.generationDigest,
        source.lockDigest,
        source.revisionDigest,
      );
    current.client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageLifecycleHeads" (
           project_id, package_name, installation_id, lock_digest,
           install_record_digest, version, disposition, event_digest,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, 1, 'disabled', ?, 1300)`,
      )
      .run(
        snapshot.projectId,
        source.packageName,
        source.installationId,
        source.lockDigest,
        'd'.repeat(64),
        'e'.repeat(64),
      );
    current.client.exec('PRAGMA foreign_keys = ON');

    const before = counts(current.client);
    await assert.rejects(
      current.starts.prepare(start),
      ToolExecutionStartBarrierConflictError,
    );
    assert.deepEqual(counts(current.client), before);

    current.client
      .prepare(
        `UPDATE "QingLong3PluginPackageLifecycleHeads"
         SET disposition = 'active', version = 2, updated_at_ms = 1301
         WHERE project_id = ? AND package_name = ?`,
      )
      .run(snapshot.projectId, source.packageName);
    const prepared = await current.starts.prepare(start);
    assert.equal(prepared.status, 'created');
  } finally {
    await current.close();
  }
});

test('publishes only the explicit adapter subpath', () => {
  const root = require('../dist');
  const runtime = require('@qinglong/local-sqlite/runtime');
  const subpath = require('@qinglong/local-sqlite/tool-execution-start-barrier');
  const completion = require('@qinglong/local-sqlite/tool-execution-completion');
  const failureCompletion = require('@qinglong/local-sqlite/tool-execution-failure-completion');
  assert.equal(root.LocalSqliteToolExecutionStartBarrierRepository, undefined);
  assert.equal(root.LocalSqliteToolExecutionCompletionRepository, undefined);
  assert.equal(
    root.LocalSqliteToolExecutionFailureCompletionRepository,
    undefined,
  );
  assert.equal(
    runtime.LocalSqliteToolExecutionStartBarrierRepository,
    undefined,
  );
  assert.equal(runtime.LocalSqliteToolExecutionCompletionRepository, undefined);
  assert.equal(
    runtime.LocalSqliteToolExecutionFailureCompletionRepository,
    undefined,
  );
  assert.equal(
    subpath.LocalSqliteToolExecutionStartBarrierRepository,
    LocalSqliteToolExecutionStartBarrierRepository,
  );
  assert.equal(
    completion.LocalSqliteToolExecutionCompletionRepository,
    LocalSqliteToolExecutionCompletionRepository,
  );
  assert.equal(
    failureCompletion.LocalSqliteToolExecutionFailureCompletionRepository,
    LocalSqliteToolExecutionFailureCompletionRepository,
  );
});
