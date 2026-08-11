const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');

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
  createToolExecutionCompletionCommand,
  createToolExecutionResultArtifact,
  toolExecutionResultKeyBinding,
} = require('@qinglong/runtime-core/tool-execution-completion');
const {
  createToolExecutionEvidenceBundle,
  toolExecutionAdmissionEvidence,
  TOOL_EXECUTION_START_AUDIT_OPERATION,
} = require('@qinglong/runtime-core/tool-execution-evidence');
const {
  createToolExecutionStartCommand,
} = require('@qinglong/runtime-core/tool-execution-start-barrier');
const {
  TrustedToolHandlerBindingRegistry,
  admitTrustedToolExecution,
  createTrustedToolHandlerBinding,
  createTrustedToolInvocationPlan,
  trustedToolContractIdentityDigest,
} = require('@qinglong/runtime-core/trusted-tool-invocation');
const {
  TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
} = require('@qinglong/runtime-core/trusted-tool-execution');
const {
  prepareToolInvocation,
} = require('@qinglong/runtime-core/tool-registry');
const {
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRetirementCommand,
  createToolResultKeyRotationCommand,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');
const {
  createToolExecutionResultRekeyCommand,
  createToolResultKeyRetirementReceiptCommand,
} = require('@qinglong/runtime-core/tool-result-rekey');

const { openLocalSqliteClient } = require('../../dist/storage/config');
const {
  migrateLocalSqliteDatabase,
} = require('../../dist/migration/migration');
const {
  LocalSqliteOperationAuthority,
} = require('../../dist/authority/operationAuthority');
const {
  LocalSqliteStepRunRepository,
} = require('../../dist/run/stepRunRepository');
const {
  LocalSqliteToolExecutionCompletionRepository,
} = require('../../dist/tool-execution/toolExecutionCompletionRepository');
const {
  LocalSqliteToolExecutionStartBarrierRepository,
} = require('../../dist/tool-execution/toolExecutionStartBarrierRepository');
const {
  LocalSqliteToolInvocationArtifactRepository,
} = require('../../dist/tool-execution/toolInvocationArtifactRepository');
const {
  LocalSqliteToolResultKeyCatalogRepository,
} = require('../../dist/tool-execution/toolResultKeyCatalogRepository');
const {
  LocalSqliteToolResultRekeyRepository,
} = require('../../dist/tool-execution/toolResultRekeyRepository');

const PROJECT_ID = 'crash-tool-result-project';
const RUN_ID = 'crash-tool-result-run';
const STEP_RUN_ID = 'crash-tool-result-step';
const START_ID = 'crash-tool-result-start';
const RESULT_KEY_A_ID = 'crash-result-key-a';
const RESULT_KEY_B_ID = 'crash-result-key-b';
const RESULT_KEY_A = Buffer.alloc(32, 41);
const RESULT_KEY_B = Buffer.alloc(32, 42);
const INVOCATION_KEY = Buffer.alloc(32, 43);
const SUBJECT = Object.freeze({
  type: 'user',
  id: 'usr-crash-tool-result',
});
const POLICY_FENCE = Object.freeze({
  projectVersion: 1,
  bindingVersion: 1,
});
const TOOL = Object.freeze({
  name: 'crash.result.read',
  version: '1.0.0',
});
const OUTPUT = Object.freeze({
  summary: 'SQLite crash matrix durable result',
});
const OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
  'utf8',
);
const RESULT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-result-digest@v1\0',
  'utf8',
);

const CRASH_POINTS = Object.freeze({
  completion_before_begin: Object.freeze({
    operation: 'completion',
    timing: 'beforeExec',
    sql: 'BEGIN IMMEDIATE',
    durable: false,
  }),
  completion_after_binding: Object.freeze({
    operation: 'completion',
    timing: 'afterRun',
    sql: 'INSERT INTO "ToolExecutionResultKeyBindings"',
    durable: false,
  }),
  completion_after_commit: Object.freeze({
    operation: 'completion',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
  rekey_after_overlay: Object.freeze({
    operation: 'rekey',
    timing: 'afterRun',
    sql: 'INSERT INTO "ToolExecutionResultRekeyOverlays"',
    durable: false,
  }),
  rekey_after_head: Object.freeze({
    operation: 'rekey',
    timing: 'afterRun',
    sql: 'INSERT INTO "ToolExecutionResultRekeyHeads"',
    durable: false,
  }),
  rekey_after_commit: Object.freeze({
    operation: 'rekey',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
  receipt_after_insert: Object.freeze({
    operation: 'receipt',
    timing: 'afterRun',
    sql: 'INSERT INTO "ToolResultKeyRetirementReceipts"',
    durable: false,
  }),
  receipt_after_commit: Object.freeze({
    operation: 'receipt',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
  retire_after_insert: Object.freeze({
    operation: 'retire',
    timing: 'afterRun',
    sql: 'INSERT INTO "ToolResultKeyCatalogGenerations"',
    durable: false,
  }),
  retire_after_commit: Object.freeze({
    operation: 'retire',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
});

function hash(domain, value) {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function snapshot() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-crash-tool-result',
    projectId: PROJECT_ID,
    packageName: 'crash',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: PROJECT_ID,
    contributions: [
      {
        generation,
        revisionDigest: 'c'.repeat(64),
        definitions: [
          {
            ...TOOL,
            description: 'Read one SQLite crash matrix fixture',
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

function principal() {
  return Object.freeze({
    subject: SUBJECT,
    authenticationId: 'auth-crash-tool-result',
    authenticatedAtMs: 800,
    expiresAtMs: 10_000,
    assurance: 'local_console',
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
      id: 'builtin.crash-result-read',
      version: '1.0.0',
    },
    executionClass: 'builtin_in_process',
    profiles: ['edge', 'standalone'],
    authorities: ['database.read'],
    timeoutSeconds: 20,
    redactionContract: {
      id: 'redaction.crash-result-read',
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

function openClient(databasePath, profile) {
  return openLocalSqliteClient(
    {
      databasePath,
      profile,
      busyTimeoutMs: 5_000,
    },
    false,
  );
}

async function prepareCompletionFixture(client, authority, profile) {
  client.exec(`
    INSERT INTO "QingLong3Projects" (
      id, name, slug, status, version, created_at_ms, updated_at_ms
    ) VALUES (
      '${PROJECT_ID}', 'Crash Tool Result', 'crash-tool-result',
      'active', 1, 1, 1
    );
    INSERT INTO "Runs" (
      id, project_id, task_id, task_revision, trigger_type,
      execution_origin, execution_owner, status, version,
      event_sequence, priority, created_at_ms
    ) VALUES (
      '${RUN_ID}', '${PROJECT_ID}', 'crash-tool-result-task', 'v1',
      'manual', 'manual', 'runtime', 'running', 0, 0, 0, 1
    );
  `);
  const definitionSnapshot = snapshot();
  const { binding, bindings } = bindingRegistry(definitionSnapshot);
  const stepRuns = new LocalSqliteStepRunRepository(authority);
  const creation = createStepRunMutation(
    {
      id: STEP_RUN_ID,
      runId: RUN_ID,
      stepKey: 'workflow.crash-result-read',
      kind: 'tool',
      definitionRef: `tool:${TOOL.name}@${TOOL.version}`,
      definitionDigest: definitionSnapshot.definitions[0].definitionDigest,
      required: true,
      initialStatus: 'ready',
      inputRef: 'artifact:crash-tool-result-input',
      mutationId: 'crash-tool-result-create',
      createdAtMs: 1_000,
    },
    {
      expectedRunVersion: 0,
      expectedRunEventSequence: 0,
      eventId: '51000000-0000-4000-8000-000000000001',
      dedupeKey: 'crash-tool-result:create',
      actor: SUBJECT,
    },
  );
  assert.equal((await stepRuns.apply(creation)).status, 'applied');

  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(definitionSnapshot),
    {
      projectId: PROJECT_ID,
      principal: principal(),
      nowMs: 900,
      tool: TOOL,
      input: { runId: RUN_ID },
    },
    authorizer(),
  );
  const planBundle = createTrustedToolInvocationPlan(bindings, invocation, {
    actionRef: `tool-plan:${RUN_ID}`,
    inputArtifactId: 'crash-tool-result-input-artifact',
    previewArtifactId: 'crash-tool-result-preview-artifact',
    artifactKeyId: 'crash-tool-invocation-key',
    artifactKey: INVOCATION_KEY,
    artifactNonce: Buffer.alloc(12, 44),
    profile,
    preview: {
      title: 'SQLite Crash Tool Result',
      summary: 'Creates one encrypted crash-matrix completion',
      fields: [
        {
          kind: 'identifier',
          label: 'Run',
          value: RUN_ID,
        },
      ],
      warnings: [],
    },
    sealedAtMs: 1_100,
  });
  assert.deepEqual(
    await new LocalSqliteToolInvocationArtifactRepository(authority).put(
      planBundle.inputArtifact,
      planBundle.previewArtifact,
    ),
    { status: 'inserted' },
  );
  const startedAtMs = 1_200;
  const evidence = createToolExecutionEvidenceBundle({
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    projectId: PROJECT_ID,
    runId: RUN_ID,
    stepRunId: STEP_RUN_ID,
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
      eventId: '41000000-0000-4000-8000-000000000001',
      requestId: 'crash-tool-result-request',
      operationId: TOOL_EXECUTION_START_AUDIT_OPERATION,
      projectId: PROJECT_ID,
      subject: SUBJECT,
      authenticationId: 'auth-crash-tool-result',
      outcome: 'allowed',
      reasons: ['tool_execution_start'],
      fence: POLICY_FENCE,
      occurredAtMs: startedAtMs,
    },
    createdAtMs: startedAtMs,
  });
  const admission = await admitTrustedToolExecution(
    bindings,
    planBundle.plan,
    {
      principal: principal(),
      profile,
      nowMs: startedAtMs,
      authorizer: authorizer(),
      evidence: {
        stepRun: {
          id: creation.stepRun.id,
          version: creation.stepRun.version,
          digest: creation.stepRun.stepRunDigest,
        },
        ...toolExecutionAdmissionEvidence(evidence),
      },
    },
  );
  const runningMutation = transitionStepRunMutation(
    creation.stepRun,
    {
      expectedVersion: creation.stepRun.version,
      expectedDigest: creation.stepRun.stepRunDigest,
      mutationId: 'crash-tool-result-running',
      to: 'running',
      atMs: startedAtMs,
    },
    {
      expectedRunVersion: 1,
      expectedRunEventSequence: 1,
      eventId: '51000000-0000-4000-8000-000000000002',
      dedupeKey: 'crash-tool-result:running',
      actor: SUBJECT,
    },
  );
  const start = await new LocalSqliteToolExecutionStartBarrierRepository(
    authority,
  ).prepare(
    createToolExecutionStartCommand({
      startId: START_ID,
      admission,
      evidence,
      stepRunMutation: runningMutation,
    }),
  );
  assert.equal(start.status, 'created');

  const catalogRepository =
    new LocalSqliteToolResultKeyCatalogRepository(authority);
  const catalog = await catalogRepository.append(
    createToolResultKeyCatalogBootstrapCommand({
      keyId: RESULT_KEY_A_ID,
      materialProof: toolResultKeyMaterialProof(
        RESULT_KEY_A_ID,
        RESULT_KEY_A,
      ),
      mutationId: 'crash-result-key-bootstrap-a',
    }),
  );
  const executionResultUnsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: START_ID,
    barrierDigest: start.barrier.barrierDigest,
    adapterDigest: start.barrier.adapterDigest,
    output: OUTPUT,
    outputDigest: hash(OUTPUT_DIGEST_DOMAIN, OUTPUT),
    completedAtMs: 1_300,
  });
  const executionResult = Object.freeze({
    ...executionResultUnsigned,
    resultDigest: hash(RESULT_DIGEST_DOMAIN, executionResultUnsigned),
  });
  const resultArtifact = createToolExecutionResultArtifact(
    {
      artifactId: 'crash-tool-result-output-artifact',
      projectId: PROJECT_ID,
      runId: RUN_ID,
      stepRunId: STEP_RUN_ID,
      tool: TOOL,
      executionResult,
      keyId: RESULT_KEY_A_ID,
      key: RESULT_KEY_A,
    },
    projectToolDefinitionRegistry(definitionSnapshot),
    () => Buffer.alloc(12, 45),
  );
  const running = await stepRuns.findById(STEP_RUN_ID);
  assert.ok(running);
  const succeededMutation = transitionStepRunMutation(
    running,
    {
      expectedVersion: running.version,
      expectedDigest: running.stepRunDigest,
      mutationId: 'crash-tool-result-succeeded',
      to: 'succeeded',
      atMs: executionResult.completedAtMs,
      outputRef: resultArtifact.artifactId,
    },
    {
      expectedRunVersion: 2,
      expectedRunEventSequence: 2,
      eventId: '51000000-0000-4000-8000-000000000003',
      dedupeKey: 'crash-tool-result:succeeded',
      actor: SUBJECT,
    },
  );
  return Object.freeze({
    catalogRepository,
    definitionSnapshot,
    completionCommand: createToolExecutionCompletionCommand({
      barrier: start.barrier,
      executionResult,
      resultArtifact,
      resultKeyCatalogFence: toolResultKeyCatalogFence(
        catalog.catalog,
        requireActiveToolResultKey(catalog.catalog),
      ),
      stepRunMutation: succeededMutation,
    }),
  });
}

async function setupScenario({
  databasePath,
  statePath,
  profile,
  operation,
}) {
  const client = openClient(databasePath, profile);
  await migrateLocalSqliteDatabase(client);
  const authority = new LocalSqliteOperationAuthority(client);
  try {
    const prepared = await prepareCompletionFixture(
      client,
      authority,
      profile,
    );
    const state = {
      profile,
      operation,
      completionCommand: prepared.completionCommand,
    };
    if (operation !== 'completion') {
      const completed =
        await new LocalSqliteToolExecutionCompletionRepository(
          authority,
        ).commit(prepared.completionCommand);
      assert.equal(completed.status, 'created');
      const rotated = await prepared.catalogRepository.append(
        createToolResultKeyRotationCommand(
          await prepared.catalogRepository.findCurrent(),
          {
            keyId: RESULT_KEY_B_ID,
            materialProof: toolResultKeyMaterialProof(
              RESULT_KEY_B_ID,
              RESULT_KEY_B,
            ),
            mutationId: 'crash-result-key-rotate-b',
          },
        ),
      );
      const rekeyCommand = createToolExecutionResultRekeyCommand({
        artifact: prepared.completionCommand.resultArtifact,
        binding: toolExecutionResultKeyBinding(
          prepared.completionCommand,
        ),
        previousOverlay: null,
        overlayId: 'crash-tool-result-rekey-overlay',
        mutationId: 'crash-tool-result-rekey',
        targetCatalogFence: toolResultKeyCatalogFence(
          rotated.catalog,
          requireActiveToolResultKey(rotated.catalog),
        ),
        targetKey: RESULT_KEY_B,
        output: OUTPUT,
        rekeyedAtMs: 1_400,
        registry: projectToolDefinitionRegistry(
          prepared.definitionSnapshot,
        ),
        nonceFactory: () => Buffer.alloc(12, 46),
      });
      state.rekeyCommand = rekeyCommand;
      state.receiptCommand =
        createToolResultKeyRetirementReceiptCommand({
          expectedCatalogGeneration: rotated.catalog.generation,
          expectedCatalogDigest: rotated.catalog.catalogDigest,
          keyId: RESULT_KEY_A_ID,
          mutationId: 'crash-tool-result-retirement-receipt',
        });
      if (operation !== 'rekey') {
        const rekeyed =
          await new LocalSqliteToolResultRekeyRepository(
            authority,
          ).append(rekeyCommand);
        assert.equal(rekeyed.status, 'created');
      }
      if (operation === 'retire') {
        const receipt =
          await new LocalSqliteToolResultRekeyRepository(
            authority,
          ).create(state.receiptCommand);
        assert.equal(receipt.status, 'created');
        state.retireCommand = createToolResultKeyRetirementCommand(
          rotated.catalog,
          {
            keyId: RESULT_KEY_A_ID,
            retirementReceiptDigest: receipt.receipt.receiptDigest,
            mutationId: 'crash-result-key-retire-a',
          },
        );
      }
    }
    fs.writeFileSync(statePath, JSON.stringify(state), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } finally {
    await authority.close();
  }
}

function writeCrashMarker(markerPath, pointName) {
  const file = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(
      file,
      JSON.stringify({
        schema: 'qinglong/sqlite-tool-result-crash-marker@v1',
        point: pointName,
        pid: process.pid,
      }),
    );
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
}

function crashClient(client, pointName, markerPath) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  let triggered = false;
  const crash = () => {
    if (triggered) return;
    triggered = true;
    writeCrashMarker(markerPath, pointName);
    process.kill(process.pid, 'SIGKILL');
    throw new Error(`SIGKILL did not terminate ${pointName}`);
  };
  const matches = (timing, sql) =>
    !triggered &&
    point.timing === timing &&
    sql.trim().includes(point.sql);
  return new Proxy(client, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (matches('beforeExec', sql)) crash();
          const result = target.exec(sql);
          if (matches('afterExec', sql)) crash();
          return result;
        };
      }
      if (property === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              );
              if (statementProperty === 'run') {
                return (...values) => {
                  const result = value.apply(statementTarget, values);
                  if (matches('afterRun', sql)) crash();
                  return result;
                };
              }
              return typeof value === 'function'
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runCrashScenario({
  databasePath,
  statePath,
  markerPath,
  pointName,
}) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.operation !== point.operation) {
    throw new Error(
      `crash point ${pointName} does not match ${state.operation}`,
    );
  }
  const client = openClient(databasePath, state.profile);
  const authority = new LocalSqliteOperationAuthority(
    crashClient(client, pointName, markerPath),
  );
  if (point.operation === 'completion') {
    await new LocalSqliteToolExecutionCompletionRepository(
      authority,
    ).commit(state.completionCommand);
  } else if (point.operation === 'rekey') {
    await new LocalSqliteToolResultRekeyRepository(authority).append(
      state.rekeyCommand,
    );
  } else if (point.operation === 'receipt') {
    await new LocalSqliteToolResultRekeyRepository(authority).create(
      state.receiptCommand,
    );
  } else {
    await new LocalSqliteToolResultKeyCatalogRepository(authority).append(
      state.retireCommand,
    );
  }
  throw new Error(`crash point ${pointName} was not reached`);
}

function completionFacts(client) {
  return {
    ...client
      .prepare(
        `SELECT
           step.status AS "stepStatus",
           step.version AS "stepVersion",
           run.version AS "runVersion",
           run.event_sequence AS "runEventSequence",
           (SELECT count(*) FROM "ToolExecutionCompletions"
             WHERE start_id = ?) AS "completionCount",
           (SELECT count(*) FROM "ToolExecutionResultKeyBindings"
             WHERE start_id = ?) AS "bindingCount",
           (SELECT count(*) FROM "StepRunMutations"
             WHERE mutation_id = 'crash-tool-result-succeeded')
             AS "completionMutationCount",
           (SELECT count(*) FROM "RunEvents"
             WHERE id = '51000000-0000-4000-8000-000000000003')
             AS "completionEventCount"
         FROM "StepRuns" AS step
         JOIN "Runs" AS run ON run.id = step.run_id
         WHERE step.id = ? AND run.id = ?`,
      )
      .get(START_ID, START_ID, STEP_RUN_ID, RUN_ID),
  };
}

function rekeyFacts(client) {
  return {
    ...client
      .prepare(
        `SELECT
           (SELECT count(*) FROM "ToolExecutionResultRekeyOverlays"
             WHERE overlay_id = 'crash-tool-result-rekey-overlay')
             AS "overlayCount",
           (SELECT count(*) FROM "ToolExecutionResultRekeyHeads"
             WHERE artifact_id = 'crash-tool-result-output-artifact')
             AS "headCount"`,
      )
      .get(),
  };
}

function receiptCount(client) {
  return client
    .prepare(
      `SELECT count(*) AS count
         FROM "ToolResultKeyRetirementReceipts"
        WHERE mutation_id = 'crash-tool-result-retirement-receipt'`,
    )
    .get().count;
}

async function verifyScenario({
  databasePath,
  statePath,
  pointName,
}) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const client = openClient(databasePath, state.profile);
  const authority = new LocalSqliteOperationAuthority(client);
  try {
    assert.equal(
      client.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
    assert.equal(
      client.prepare('PRAGMA journal_mode').get().journal_mode,
      state.profile === 'edge' ? 'delete' : 'wal',
    );
    let replayStatus;
    if (point.operation === 'completion') {
      assert.deepEqual(
        completionFacts(client),
        point.durable
          ? {
              stepStatus: 'succeeded',
              stepVersion: 3,
              runVersion: 3,
              runEventSequence: 3,
              completionCount: 1,
              bindingCount: 1,
              completionMutationCount: 1,
              completionEventCount: 1,
            }
          : {
              stepStatus: 'running',
              stepVersion: 2,
              runVersion: 2,
              runEventSequence: 2,
              completionCount: 0,
              bindingCount: 0,
              completionMutationCount: 0,
              completionEventCount: 0,
            },
      );
      const repository =
        new LocalSqliteToolExecutionCompletionRepository(authority);
      replayStatus = (
        await repository.commit(state.completionCommand)
      ).status;
      assert.equal(
        (
          await repository.commit(state.completionCommand)
        ).status,
        'existing',
      );
      assert.deepEqual(completionFacts(client), {
        stepStatus: 'succeeded',
        stepVersion: 3,
        runVersion: 3,
        runEventSequence: 3,
        completionCount: 1,
        bindingCount: 1,
        completionMutationCount: 1,
        completionEventCount: 1,
      });
    } else if (point.operation === 'rekey') {
      assert.deepEqual(
        rekeyFacts(client),
        point.durable
          ? { overlayCount: 1, headCount: 1 }
          : { overlayCount: 0, headCount: 0 },
      );
      const repository =
        new LocalSqliteToolResultRekeyRepository(authority);
      replayStatus = (
        await repository.append(state.rekeyCommand)
      ).status;
      assert.equal(
        (await repository.append(state.rekeyCommand)).status,
        'existing',
      );
      assert.deepEqual(rekeyFacts(client), {
        overlayCount: 1,
        headCount: 1,
      });
    } else if (point.operation === 'receipt') {
      assert.equal(receiptCount(client), point.durable ? 1 : 0);
      const repository =
        new LocalSqliteToolResultRekeyRepository(authority);
      replayStatus = (
        await repository.create(state.receiptCommand)
      ).status;
      assert.equal(
        (await repository.create(state.receiptCommand)).status,
        'existing',
      );
      assert.equal(receiptCount(client), 1);
    } else {
      const catalogRepository =
        new LocalSqliteToolResultKeyCatalogRepository(authority);
      const before = await catalogRepository.findCurrent();
      assert.ok(before);
      assert.equal(before.generation, point.durable ? 3 : 2);
      assert.equal(
        before.keys.find((entry) => entry.keyId === RESULT_KEY_A_ID)
          .state,
        point.durable ? 'retired' : 'decrypt_only',
      );
      replayStatus = (
        await catalogRepository.append(state.retireCommand)
      ).status;
      assert.equal(
        (
          await catalogRepository.append(state.retireCommand)
        ).status,
        'existing',
      );
      const after = await catalogRepository.findCurrent();
      assert.ok(after);
      assert.equal(after.generation, 3);
      assert.equal(
        after.keys.find((entry) => entry.keyId === RESULT_KEY_A_ID)
          .state,
        'retired',
      );
    }
    assert.equal(replayStatus, point.durable ? 'existing' : 'created');
    return Object.freeze({
      point: pointName,
      operation: point.operation,
      crashBeforeCommit: !point.durable,
      durableAfterCrash: point.durable,
      replayStatus,
      integrityCheck: 'ok',
      journalMode: state.profile === 'edge' ? 'delete' : 'wal',
    });
  } finally {
    await authority.close();
  }
}

if (require.main === module) {
  const [, , action, databasePath, statePath, markerPath, pointName] =
    process.argv;
  if (action !== 'crash') {
    throw new Error('fixture action must be crash');
  }
  runCrashScenario({
    databasePath,
    statePath,
    markerPath,
    pointName,
  }).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  CRASH_POINTS,
  setupScenario,
  verifyScenario,
};
