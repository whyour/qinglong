const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  createPluginPackageResourceGenerationFromReferences,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
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
  toolExecutionStartBarrierRecord,
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
  createToolExecutionCompletionCommand,
  createToolExecutionResultArtifact,
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
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');
const {
  PostgresToolExecutionStartBarrierRepository,
} = require('@qinglong/cluster-postgres/tool-execution-start-barrier');
const {
  PostgresToolExecutionCompletionRepository,
} = require('@qinglong/cluster-postgres/tool-execution-completion');
const {
  PostgresToolExecutionFailureCompletionRepository,
} = require('@qinglong/cluster-postgres/tool-execution-failure-completion');

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

function resultKeyCatalog() {
  const command = createToolResultKeyCatalogBootstrapCommand({
    keyId: 'tool-result-key-test',
    materialProof: toolResultKeyMaterialProof(
      'tool-result-key-test',
      Buffer.alloc(32, 5),
    ),
    mutationId: 'tool-result-key-bootstrap-test',
  });
  return normalizeToolResultKeyCatalogRecord({
    ...command.next,
    committedAtMs: 1_200,
  });
}

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

async function command(overrides = {}) {
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
  const creation = createStepRunMutation(
    {
      id: 'step-run-001',
      runId: 'run-001',
      stepKey: 'workflow.compare',
      kind: 'tool',
      definitionRef: 'tool:demo.compare@1.0.0',
      definitionDigest: snapshot.definitions[0].definitionDigest,
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
  const evidence = createToolExecutionEvidenceBundle({
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    projectId: 'project-001',
    runId: 'run-001',
    stepRunId: creation.stepRun.id,
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
        id: creation.stepRun.id,
        version: creation.stepRun.version,
        digest: creation.stepRun.stepRunDigest,
      },
      ...toolExecutionAdmissionEvidence(evidence),
    },
  });
  const mutation = transitionStepRunMutation(
    creation.stepRun,
    {
      expectedVersion: creation.stepRun.version,
      expectedDigest: creation.stepRun.stepRunDigest,
      mutationId: 'step-running-002',
      to: 'running',
      atMs: NOW_MS,
    },
    {
      expectedRunVersion: 1,
      expectedRunEventSequence: 1,
      eventId: '50000000-0000-4000-8000-000000000002',
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

function barrierRow(barrier, overrides = {}) {
  return {
    barrierJson: barrier,
    storedStartId: barrier.startId,
    storedProjectId: barrier.projectId,
    storedRunId: barrier.runId,
    storedStepRunId: barrier.stepRunId,
    storedStepRunVersion: String(barrier.startedStepRunVersion),
    storedMutationId: barrier.stepRunMutationId,
    storedRunEventId: barrier.runEventId,
    storedTraceId: barrier.traceId,
    storedSpanId: barrier.spanId,
    storedAuditEventId: barrier.auditEventId,
    storedCommandDigest: barrier.commandDigest,
    storedBarrierDigest: barrier.barrierDigest,
    storedStartedAtMs: String(barrier.startedAtMs),
    storedMutationDigest: barrier.stepRunMutationDigest,
    storedStartedStepRunDigest: barrier.startedStepRunDigest,
    storedTraceDigest: barrier.traceDigest,
    storedAuditReceiptDigest: barrier.auditReceiptDigest,
    storedArtifactProjectId: barrier.projectId,
    storedArtifactActionRef: barrier.actionRef,
    storedInputArtifactId: barrier.invocationArtifact.artifactId,
    storedInputArtifactDigest: barrier.invocationArtifact.artifactDigest,
    storedInputDigest: barrier.invocationArtifact.inputDigest,
    storedPreviewArtifactId: barrier.previewArtifact.artifactId,
    storedPreviewArtifactDigest: barrier.previewArtifact.artifactDigest,
    storedArtifactActionDigest: barrier.previewArtifact.actionDigest,
    storedPreviewDigest: barrier.previewArtifact.previewDigest,
    storedArtifactRedactionContractDigest:
      barrier.previewArtifact.redactionContractDigest,
    storedArtifactBoundAtMs: String(barrier.startedAtMs),
    ...overrides,
  };
}

function clientWith(handler) {
  const calls = [];
  let released = false;
  return {
    calls,
    get released() {
      return released;
    },
    async query(text, values = []) {
      calls.push({ text, values });
      if (
        text.startsWith('BEGIN') ||
        text.includes("set_config('") ||
        text.includes('pg_advisory_xact_lock') ||
        text === 'COMMIT' ||
        text === 'ROLLBACK'
      ) {
        return { rows: [] };
      }
      if (text.includes('plugin_package_tool_start_allowed')) {
        return { rows: [{ allowed: true }] };
      }
      return handler(text, values, calls);
    },
    release() {
      released = true;
    },
  };
}

function repositoryFor(client) {
  return new PostgresToolExecutionStartBarrierRepository({
    async query() {
      throw new Error('pool query is not used by prepare');
    },
    async connect() {
      return client;
    },
  });
}

function completionRepositoryFor(client) {
  return new PostgresToolExecutionCompletionRepository({
    async query() {
      throw new Error('pool query is not used by commit');
    },
    async connect() {
      return client;
    },
  });
}

function failureCompletionRepositoryFor(client) {
  return new PostgresToolExecutionFailureCompletionRepository({
    async query() {
      throw new Error('pool query is not used by commit');
    },
    async connect() {
      return client;
    },
  });
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

test('atomically commits evidence, StepRun start and the barrier', async () => {
  const start = await command();
  const mutation = start.stepRunMutation;
  const client = clientWith(async (sql) => {
    if (sql.includes('FROM "ql3"."tool_execution_start_barriers"')) {
      return { rows: [] };
    }
    if (sql.includes('FROM "ql3"."step_runs" AS step')) {
      return {
        rows: [
          {
            stepKind: 'tool',
            stepStatus: mutation.previousStatus,
            stepVersion: String(mutation.expectedStepRunVersion),
            stepDigest: mutation.expectedStepRunDigest,
            definitionRef: mutation.stepRun.definitionRef,
            definitionDigest: mutation.stepRun.definitionDigest,
            projectId: 'project-001',
            runStatus: 'running',
            runVersion: String(mutation.expectedRunVersion),
            runEventSequence: String(mutation.expectedRunEventSequence),
          },
        ],
      };
    }
    if (sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE "ql3"')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });

  const result = await repositoryFor(client).prepare(start);
  assert.deepEqual(result, {
    status: 'created',
    barrier: toolExecutionStartBarrierRecord(start),
  });
  assert.equal(client.released, true);
  assert.deepEqual(
    client.calls
      .map(({ text }) => text)
      .filter(
        (sql) =>
          sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE "ql3"'),
      )
      .map((sql) => {
        const match = sql.match(/"ql3"\."([^"]+)"/);
        return `${sql.startsWith('UPDATE') ? 'update' : 'insert'}:${match[1]}`;
      }),
    [
      'insert:security_audit_events',
      'insert:tool_execution_trace_anchors',
      'insert:tool_execution_audit_receipts',
      'update:step_runs',
      'update:runs',
      'insert:run_events',
      'insert:step_run_mutations',
      'insert:tool_execution_start_barriers',
      'insert:tool_execution_start_artifact_bindings',
    ],
  );
  const mutationInsert = client.calls.find(({ text }) =>
    text.includes('INSERT INTO "ql3"."step_run_mutations"'),
  );
  assert.match(mutationInsert.text, /transaction_timestamp\(\)/);
  assert.equal(mutationInsert.values.length, 9);
  assert.equal(
    client.calls.some(({ text }) => text === 'COMMIT'),
    true,
  );
  assert.equal(
    client.calls.some(({ text }) => text === 'ROLLBACK'),
    false,
  );
});

test('atomically persists encrypted result and the succeeded StepRun fence', async () => {
  const start = await command();
  const barrier = toolExecutionStartBarrierRecord(start);
  const result = executionResult(barrier, { summary: 'Run is healthy' }, 1_500);
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
  const running = start.stepRunMutation.stepRun;
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
    resultKeyCatalogFence: toolResultKeyCatalogFence(
      resultKeyCatalog(),
      requireActiveToolResultKey(resultKeyCatalog()),
    ),
    stepRunMutation: mutation,
  });
  const client = clientWith(async (sql) => {
    if (sql.includes('FROM "ql3"."tool_execution_completions"')) {
      return { rows: [] };
    }
    if (sql.includes('FROM "ql3"."tool_execution_failure_completions"')) {
      return { rows: [] };
    }
    if (sql.includes('FROM "ql3"."tool_result_key_catalog_generations"')) {
      return { rows: [{ catalogJson: resultKeyCatalog() }] };
    }
    if (sql.includes('FROM "ql3"."tool_execution_start_barriers" AS barrier')) {
      return {
        rows: [
          {
            barrierJson: barrier,
            startedRunVersion: '2',
            startedEventSequence: '2',
            stepKind: 'tool',
            stepStatus: 'running',
            stepVersion: String(mutation.expectedStepRunVersion),
            stepDigest: mutation.expectedStepRunDigest,
            projectId: barrier.projectId,
            runStatus: 'running',
            runVersion: '2',
            runEventSequence: '2',
          },
        ],
      };
    }
    if (sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE "ql3"')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });

  const committed = await completionRepositoryFor(client).commit(
    completionCommand,
  );
  assert.equal(committed.status, 'created');
  assert.equal(committed.completion.startId, barrier.startId);
  assert.equal(client.released, true);
  assert.deepEqual(
    client.calls
      .map(({ text }) => text)
      .filter(
        (sql) =>
          sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE "ql3"'),
      )
      .map((sql) => {
        const match = sql.match(/"ql3"\."([^"]+)"/);
        return `${sql.startsWith('UPDATE') ? 'update' : 'insert'}:${match[1]}`;
      }),
    [
      'update:step_runs',
      'update:runs',
      'insert:run_events',
      'insert:step_run_mutations',
      'insert:tool_execution_completions',
      'insert:tool_execution_result_key_bindings',
    ],
  );
});

test('atomically persists fixed Tool failure facts and excludes success', async () => {
  const start = await command();
  const barrier = toolExecutionStartBarrierRecord(start);
  const failure = createToolExecutionFailureResult(barrier, 'timed_out', 1_500);
  const running = start.stepRunMutation.stepRun;
  const mutation = transitionStepRunMutation(
    running,
    {
      expectedVersion: running.version,
      expectedDigest: running.stepRunDigest,
      mutationId: 'step-timed-out-003',
      to: 'timed_out',
      atMs: failure.completedAtMs,
      ...TOOL_EXECUTION_FAILURE_FACTS.timed_out,
    },
    {
      expectedRunVersion: 2,
      expectedRunEventSequence: 2,
      eventId: '50000000-0000-4000-8000-000000000003',
      dedupeKey: 'step-timed-out:step-run-001',
      actor: REQUESTER,
    },
  );
  const completionCommand = createToolExecutionFailureCompletionCommand({
    barrier,
    failure,
    stepRunMutation: mutation,
  });
  const client = clientWith(async (sql) => {
    if (sql.includes('FROM "ql3"."tool_execution_failure_completions"')) {
      return { rows: [] };
    }
    if (sql.includes('FROM "ql3"."tool_execution_completions"')) {
      return { rows: [] };
    }
    if (sql.includes('FROM "ql3"."tool_execution_start_barriers" AS barrier')) {
      return {
        rows: [
          {
            barrierJson: barrier,
            startedRunVersion: '2',
            startedEventSequence: '2',
            stepKind: 'tool',
            stepStatus: 'running',
            stepVersion: String(mutation.expectedStepRunVersion),
            stepDigest: mutation.expectedStepRunDigest,
            projectId: barrier.projectId,
            runStatus: 'running',
            runVersion: '2',
            runEventSequence: '2',
          },
        ],
      };
    }
    if (sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE "ql3"')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });

  const committed = await failureCompletionRepositoryFor(client).commit(
    completionCommand,
  );
  assert.equal(committed.status, 'created');
  assert.equal(committed.completion.outcome, 'timed_out');
  assert.equal(
    committed.completion.errorSummary,
    'Trusted Tool execution deadline exceeded',
  );
  assert.deepEqual(
    client.calls
      .map(({ text }) => text)
      .filter(
        (sql) =>
          sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE "ql3"'),
      )
      .map((sql) => {
        const match = sql.match(/"ql3"\."([^"]+)"/);
        return `${sql.startsWith('UPDATE') ? 'update' : 'insert'}:${match[1]}`;
      }),
    [
      'update:step_runs',
      'update:runs',
      'insert:run_events',
      'insert:step_run_mutations',
      'insert:tool_execution_failure_completions',
    ],
  );

  const conflictClient = clientWith(async (sql) => {
    if (sql.includes('FROM "ql3"."tool_execution_failure_completions"')) {
      return { rows: [] };
    }
    if (sql.includes('FROM "ql3"."tool_execution_completions"')) {
      return { rows: [{ exists: 1 }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    failureCompletionRepositoryFor(conflictClient).commit(completionCommand),
    ToolExecutionFailureCompletionConflictError,
  );
  assert.equal(
    conflictClient.calls.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
});

test('exactly replays a committed start and rejects identity drift', async () => {
  const start = await command();
  const stored = toolExecutionStartBarrierRecord(start);
  const exactClient = clientWith(async (sql) => {
    if (sql.includes('FROM "ql3"."tool_execution_start_barriers"')) {
      return { rows: [barrierRow(stored)] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  assert.deepEqual(await repositoryFor(exactClient).prepare(start), {
    status: 'existing',
    barrier: stored,
  });
  assert.equal(
    exactClient.calls.some(({ text }) => text.startsWith('INSERT INTO')),
    false,
  );

  const drift = await command({ startId: 'tool-start-other' });
  const conflictClient = clientWith(async (sql) => {
    if (sql.includes('FROM "ql3"."tool_execution_start_barriers"')) {
      return { rows: [barrierRow(stored)] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    repositoryFor(conflictClient).prepare(drift),
    ToolExecutionStartBarrierConflictError,
  );
  assert.equal(
    conflictClient.calls.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
  assert.equal(conflictClient.released, true);
});

test('rolls back before evidence writes when the durable fence changed', async () => {
  const start = await command();
  const mutation = start.stepRunMutation;
  const client = clientWith(async (sql) => {
    if (sql.includes('FROM "ql3"."tool_execution_start_barriers"')) {
      return { rows: [] };
    }
    if (sql.includes('FROM "ql3"."step_runs" AS step')) {
      return {
        rows: [
          {
            stepKind: 'tool',
            stepStatus: 'cancelled',
            stepVersion: String(mutation.expectedStepRunVersion),
            stepDigest: mutation.expectedStepRunDigest,
            definitionRef: mutation.stepRun.definitionRef,
            definitionDigest: mutation.stepRun.definitionDigest,
            projectId: 'project-001',
            runStatus: 'running',
            runVersion: String(mutation.expectedRunVersion),
            runEventSequence: String(mutation.expectedRunEventSequence),
          },
        ],
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    repositoryFor(client).prepare(start),
    ToolExecutionStartBarrierConflictError,
  );
  assert.equal(
    client.calls.some(({ text }) => text.startsWith('INSERT INTO')),
    false,
  );
  assert.equal(
    client.calls.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
  assert.equal(client.released, true);
});

test('fails closed when a stored barrier projection is corrupted', async () => {
  const start = await command();
  const barrier = toolExecutionStartBarrierRecord(start);
  const repository = new PostgresToolExecutionStartBarrierRepository({
    async query(sql) {
      if (sql.includes('FROM "ql3"."tool_execution_start_barriers"')) {
        return {
          rows: [
            barrierRow(barrier, {
              storedBarrierDigest: '0'.repeat(64),
            }),
          ],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async connect() {
      throw new Error('unused');
    },
  });
  await assert.rejects(
    repository.findByStartId(barrier.startId),
    ToolExecutionStartBarrierUnavailableError,
  );
});

test('fails closed when a historical barrier has no Artifact binding', async () => {
  const start = await command();
  const barrier = toolExecutionStartBarrierRecord(start);
  const repository = new PostgresToolExecutionStartBarrierRepository({
    async query(sql) {
      if (sql.includes('FROM "ql3"."tool_execution_start_barriers"')) {
        return {
          rows: [
            barrierRow(barrier, {
              storedInputArtifactId: null,
            }),
          ],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async connect() {
      throw new Error('unused');
    },
  });
  await assert.rejects(
    repository.findByStartId(barrier.startId),
    ToolExecutionStartBarrierUnavailableError,
  );
});
