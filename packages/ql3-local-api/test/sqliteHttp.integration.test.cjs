const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LocalOwnerPepperKeyringFileProvider,
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  createStepRunRecord,
} = require('../../ql3-runtime-core/dist/run/stepRun.js');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  compileLocalCommandTaskDefinition,
} = require('@qinglong/runtime-core/task-definition-execution-compiler');
const {
  RunAttemptLogReadService,
} = require('@qinglong/runtime-core/run-attempt-log-read');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('@qinglong/runtime-core/task-spec-semantic');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  createLocalApiProductSurface,
} = require('../dist/application-runtime/localApiProductSurface.js');
const {
  LocalRunAttemptLogRangeReader,
} = require('../../ql3-local-execution/dist/artifact-read/localRunAttemptLogRangeReader.js');

const NOW = Date.now();
const PEPPER_KEY_ID = 'local-api-pepper-v1';
const CREDENTIAL_ID = 'local-api-owner';
const RUN_ID = 'run_local_api_1';
const ATTEMPT_ID = 'attempt_local_api_1';
const LOG_ARTIFACT_ID = `local-${'a'.repeat(30)}`;
const SECRET = Buffer.alloc(32, 81).toString('base64url');
const PEPPER = Buffer.alloc(32, 82).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function request(
  port,
  authorization,
  requestPath = `/api/v3/projects/default/runs/${RUN_ID}`,
  options = {},
) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        headers: {
          authorization,
          connection: 'close',
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    outgoing.once('error', reject);
    if (options.body) outgoing.write(options.body);
    outgoing.end();
  });
}

function seed(databasePath, materialDigest) {
  const stepRun = createStepRunRecord({
    id: 'step-local-api-1',
    runId: RUN_ID,
    stepKey: 'build',
    kind: 'tool',
    definitionRef: 'tool:private.internal@1.0.0',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:private-input',
    mutationId: 'create-step-local-api-1',
    createdAtMs: NOW - 75,
  });
  const client = new DatabaseSync(databasePath);
  try {
    client.exec('PRAGMA foreign_keys = ON');
    client
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        PEPPER_KEY_ID,
        materialDigest,
        'b'.repeat(64),
        '00000000-0000-4000-8000-000000000111',
        '00000000-0000-4000-8000-000000000112',
        NOW - 2_000,
        NOW - 1_500,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '00000000-0000-4000-8000-000000000112',
        PEPPER_KEY_ID,
        materialDigest,
        'b'.repeat(64),
        NOW - 1_500,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'local-api-user', 'active', 1, ?, ?)`,
      )
      .run(NOW - 1_000, NOW - 1_000);
    client
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'local-api-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
        NOW - 1_000,
        NOW - 1_000,
        NOW + 60_000,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    client
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'local-api-user', 1, 'active', 'operator',
           'grant-local-api-operator', 'user', 'local-api-user', ?
         )`,
      )
      .run(NOW - 500);
    const taskSemantics = createBuiltInTaskSpecSemanticRegistry();
    const taskCommand = {
      projectId: 'default',
      taskId: 'task-1',
      expectedRevision: null,
      mutationId: '00000000-0000-4000-8000-000000000113',
      name: 'Local API Task',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: {
          command: {
            kind: 'argv',
            file: '/bin/echo',
            args: ['private-command'],
          },
        },
      },
      labels: { private: 'label' },
      enabled: true,
      occurredAtMs: NOW - 200,
    };
    const taskDefinition = createTaskDefinitionRecord(
      {
        ...taskCommand,
        spec: taskSemantics.normalize({
          projectId: taskCommand.projectId,
          taskId: taskCommand.taskId,
          kind: taskCommand.kind,
          spec: taskCommand.spec,
        }),
      },
      NOW - 200,
    );
    const taskExecution = compileLocalCommandTaskDefinition(
      taskDefinition,
      taskSemantics,
    );
    client
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitions" (
           "project_id", "task_id", "current_revision",
           "created_at_ms", "updated_at_ms"
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        taskDefinition.projectId,
        taskDefinition.taskId,
        taskDefinition.revision,
        taskDefinition.createdAtMs,
        taskDefinition.updatedAtMs,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3LocalExecutionContextRecipes" (
           "context_ref", "environment_json", "content_digest",
           "created_at_ms"
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        taskExecution.contextRecipe.contextRef,
        JSON.stringify(taskExecution.contextRecipe.environment),
        taskExecution.contextRecipe.contentDigest,
        taskExecution.contextRecipe.createdAtMs,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3LocalTaskExecutionRevisions" (
           "project_id", "task_id", "task_revision", "executor_type",
           "command_json", "working_directory", "timeout_ms", "context_ref",
           "content_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskExecution.executionRevision.projectId,
        taskExecution.executionRevision.taskId,
        taskExecution.executionRevision.taskRevision,
        taskExecution.executionRevision.executorType,
        JSON.stringify(taskExecution.executionRevision.command),
        taskExecution.executionRevision.workingDirectory ?? null,
        taskExecution.executionRevision.timeoutMs ?? null,
        taskExecution.executionRevision.contextRef,
        taskExecution.executionRevision.contentDigest,
        taskExecution.executionRevision.createdAtMs,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitionRevisions" (
           "project_id", "task_id", "revision", "mutation_id",
           "name", "description", "kind", "spec_json", "labels_json",
           "enabled", "content_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskDefinition.projectId,
        taskDefinition.taskId,
        taskDefinition.revision,
        taskDefinition.mutationId,
        taskDefinition.name,
        null,
        taskDefinition.kind,
        JSON.stringify(taskDefinition.spec),
        JSON.stringify(taskDefinition.labels),
        1,
        taskDefinition.contentDigest,
        taskDefinition.updatedAtMs,
      );
    client
      .prepare(
        `INSERT INTO "Runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, priority, created_at_ms
         ) VALUES (?, 'default', 'task-1', 'revision-1', 'manual',
           'manual', 'runtime', 'running', 1, 1, 0, ?)`,
      )
      .run(RUN_ID, NOW - 100);
    client
      .prepare(
        `INSERT INTO "RunAttempts" (
           "id", "run_id", "attempt", "status", "executor_type",
           "log_artifact_id", "callback_sequence", "created_at_ms",
           "started_at_ms"
         ) VALUES (?, ?, 1, 'running', 'local_process', ?, 0, ?, ?)`,
      )
      .run(ATTEMPT_ID, RUN_ID, LOG_ARTIFACT_ID, NOW - 90, NOW - 80);
    client
      .prepare(
        `INSERT INTO "StepRuns" (
           "id", "run_id", "parent_step_run_id", "step_key", "kind",
           "definition_ref", "definition_digest", "required", "status",
           "version", "attempt_count", "input_ref", "output_ref",
           "approval_request_id", "ready_at_ms", "started_at_ms",
           "finished_at_ms", "result_code", "error_summary", "created_at_ms",
           "updated_at_ms", "last_mutation_id", "step_run_digest",
           "step_run_json"
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?
         )`,
      )
      .run(
        stepRun.id,
        stepRun.runId,
        stepRun.parentStepRunId,
        stepRun.stepKey,
        stepRun.kind,
        stepRun.definitionRef,
        stepRun.definitionDigest,
        stepRun.required ? 1 : 0,
        stepRun.status,
        stepRun.version,
        stepRun.attemptCount,
        stepRun.inputRef,
        stepRun.outputRef,
        stepRun.approvalRequestId,
        stepRun.readyAtMs,
        stepRun.startedAtMs,
        stepRun.finishedAtMs,
        stepRun.resultCode,
        stepRun.errorSummary,
        stepRun.createdAtMs,
        stepRun.updatedAtMs,
        stepRun.lastMutationId,
        stepRun.stepRunDigest,
        JSON.stringify(stepRun),
      );
    client
      .prepare(
        `INSERT INTO "RunEvents" (
           id, run_id, sequence, type, actor_type, payload, created_at_ms
         ) VALUES (?, ?, 1, 'run.started', 'system', '{}', ?)`,
      )
      .run('run-local-api-event-1', RUN_ID, NOW - 50);
    return taskDefinition;
  } finally {
    client.close();
  }
}

test('serves an authenticated Run through one real SQLite authority and durable audit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-api-sqlite-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'qinglong3.sqlite');
  const artifactRoot = path.join(root, 'artifacts');
  const artifactShard = path.join(artifactRoot, 'aa');
  fs.mkdirSync(artifactShard, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactRoot, 0o700);
  fs.chmodSync(artifactShard, 0o700);
  const logContent = Buffer.from('local-api-log-line\n', 'utf8');
  const logPath = path.join(artifactShard, `${LOG_ARTIFACT_ID}.log`);
  fs.writeFileSync(logPath, logContent, { mode: 0o600 });
  fs.chmodSync(logPath, 0o600);
  const keyringDirectory = path.join(root, 'owner-pepper');
  fs.mkdirSync(keyringDirectory, { mode: 0o700 });
  const summary = provisionLocalOwnerPepperKey({
    keyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 82),
  });
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const taskDefinition = seed(databasePath, summary.digest);
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  const port = await reservePort();
  let uuidSequence = 0;
  const surface = createLocalApiProductSurface(
    {
      schema: 'qinglong/local-api-process@v1',
      deploymentRoot: root,
      applicationConfigFilePath: path.join(root, 'application.json'),
      ownerPepperKeyringDirectory: keyringDirectory,
      listener: { host: '127.0.0.1', port },
    },
    {
      now: () => NOW,
      randomUuid() {
        uuidSequence += 1;
        return `00000000-0000-4000-8000-${String(uuidSequence).padStart(
          12,
          '0',
        )}`;
      },
    },
  );
  const active = await surface.start({
    profile: 'edge',
    runs: runtime.runRepository,
    stepRuns: await runtime.stepRunReader(),
    runCancellation: await runtime.runCancellationRepository(),
    taskStart: await runtime.taskStartRepository(),
    runAttemptLogRead: new RunAttemptLogReadService(
      runtime.runRepository,
      new LocalRunAttemptLogRangeReader(artifactRoot),
      {
        executorType: 'local_process',
        artifactIdPattern: /^local-[a-f0-9]{30}$/,
        maximumReadBytes: 32 * 1024,
      },
    ),
    taskDefinitions: runtime.taskDefinitions,
    taskDefinitionAdministrationForCredential:
      runtime.taskDefinitionAdministrationForCredential,
    triggers: runtime.triggers,
    triggerAdministrationForCredential:
      runtime.triggerAdministrationForCredential,
    apiCredentials: runtime.apiCredentials,
    ownerPepper: runtime.ownerPepper,
    projectPolicy: runtime.projectPolicy,
    securityAudit: runtime.securityAudit,
  });
  t.after(() => active.stopAndDrain());

  const accepted = await request(port, `Bearer ${TOKEN}`);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.run.id, RUN_ID);
  assert.equal(accepted.body.run.projectId, 'default');
  assert.deepEqual(accepted.body.run.latestAttempt, {
    id: ATTEMPT_ID,
    attempt: 1,
    status: 'running',
    logAvailable: true,
    createdAtMs: NOW - 90,
    startedAtMs: NOW - 80,
  });
  assert.equal(JSON.stringify(accepted).includes('secret'), false);

  const listed = await request(
    port,
    `Bearer ${TOKEN}`,
    '/api/v3/projects/default/runs?limit=1',
  );
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.runs[0].id, RUN_ID);
  assert.equal(listed.body.hasMore, false);
  assert.equal(JSON.stringify(listed).includes('secret'), false);

  const tasks = await request(
    port,
    `Bearer ${TOKEN}`,
    '/api/v3/projects/default/tasks?limit=1',
  );
  assert.deepEqual(tasks, {
    statusCode: 200,
    body: {
      tasks: [
        {
          taskId: 'task-1',
          revision: 1,
          name: 'Local API Task',
          kind: 'command',
          specSchema: 'qinglong/command@v1',
          enabled: true,
          updatedAtMs: NOW - 200,
        },
      ],
      hasMore: false,
    },
  });
  assert.equal(JSON.stringify(tasks).includes('private'), false);

  const currentTask = await request(
    port,
    `Bearer ${TOKEN}`,
    '/api/v3/projects/default/tasks/task-1',
  );
  assert.equal(currentTask.statusCode, 200);
  assert.deepEqual(
    {
      ...currentTask.body.task,
      contentDigest: '<digest>',
    },
    {
      taskId: 'task-1',
      revision: 1,
      name: 'Local API Task',
      kind: 'command',
      specSchema: 'qinglong/command@v1',
      enabled: true,
      contentDigest: '<digest>',
      createdAtMs: NOW - 200,
      updatedAtMs: NOW - 200,
    },
  );
  assert.match(currentTask.body.task.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(currentTask).includes('private'), false);
  assert.deepEqual(
    await request(
      port,
      `Bearer ${TOKEN}`,
      '/api/v3/projects/default/tasks/task-absent',
    ),
    { statusCode: 404, body: { code: 'task_not_found' } },
  );

  const taskCreateBody = JSON.stringify({
    expectedRevision: null,
    mutationId: '019f7300-0000-4000-8000-000000000701',
    name: 'Console-created Task',
    description: 'Created through request-scoped local presence',
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: {
          kind: 'argv',
          file: '/bin/echo',
          args: ['console-created'],
        },
      },
    },
    labels: { source: 'local-console' },
    enabled: true,
    occurredAtMs: NOW,
  });
  const taskCreatePath = '/api/v3/projects/default/tasks/task-console-created';
  const taskCreateOptions = {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(taskCreateBody)),
    },
    body: taskCreateBody,
  };
  const challenge = await request(
    port,
    `Bearer ${TOKEN}`,
    taskCreatePath,
    taskCreateOptions,
  );
  assert.equal(challenge.statusCode, 428);
  assert.equal(challenge.body.code, 'local_presence_required');
  assert.match(challenge.body.requestDigest, /^[0-9a-f]{64}$/);
  const proofDocument = JSON.parse(
    fs.readFileSync(
      path.join(root, 'console-presence', challenge.body.proofFileName),
      'utf8',
    ),
  );
  const taskCreated = await request(port, `Bearer ${TOKEN}`, taskCreatePath, {
    ...taskCreateOptions,
    headers: {
      ...taskCreateOptions.headers,
      'x-qinglong-local-presence': proofDocument.proof,
    },
  });
  assert.equal(taskCreated.statusCode, 201);
  assert.equal(taskCreated.body.status, 'created');
  assert.equal(taskCreated.body.task.taskId, 'task-console-created');
  assert.equal(taskCreated.body.task.revision, 1);
  assert.equal(JSON.stringify(taskCreated).includes('console-created'), true);
  assert.equal(JSON.stringify(taskCreated).includes('/bin/echo'), false);

  const authoringPath = '/api/v3/projects/default/tasks/task-1/authoring';
  const authoringChallenge = await request(
    port,
    `Bearer ${TOKEN}`,
    authoringPath,
    { method: 'POST' },
  );
  assert.equal(authoringChallenge.statusCode, 428);
  assert.equal(authoringChallenge.body.code, 'local_presence_required');
  const authoringProof = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'console-presence',
        authoringChallenge.body.proofFileName,
      ),
      'utf8',
    ),
  );
  const authoring = await request(port, `Bearer ${TOKEN}`, authoringPath, {
    method: 'POST',
    headers: {
      'x-qinglong-local-presence': authoringProof.proof,
    },
  });
  assert.equal(authoring.statusCode, 200);
  assert.equal(authoring.body.task.revision, 1);
  assert.deepEqual(
    authoring.body.task.spec,
    JSON.parse(JSON.stringify(taskDefinition.spec)),
  );
  assert.deepEqual(
    authoring.body.task.labels,
    JSON.parse(JSON.stringify(taskDefinition.labels)),
  );
  assert.equal(
    authoring.body.authoring.contentDigest,
    taskDefinition.contentDigest,
  );
  assert.match(authoring.body.authoring.lease, /^ql3a_[A-Za-z0-9_-]+$/);

  const taskUpdateBody = JSON.stringify({
    expectedRevision: authoring.body.task.revision,
    mutationId: '019f7300-0000-4000-8000-000000000702',
    name: 'Local API Task updated',
    ...(authoring.body.task.description === undefined
      ? {}
      : { description: authoring.body.task.description }),
    kind: authoring.body.task.kind,
    spec: authoring.body.task.spec,
    labels: authoring.body.task.labels,
    enabled: true,
    occurredAtMs: NOW,
  });
  const taskUpdateOptions = {
    method: 'PUT',
    headers: {
      'x-qinglong-task-authoring-lease': authoring.body.authoring.lease,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(taskUpdateBody)),
    },
    body: taskUpdateBody,
  };
  const taskUpdateChallenge = await request(
    port,
    `Bearer ${TOKEN}`,
    '/api/v3/projects/default/tasks/task-1',
    taskUpdateOptions,
  );
  assert.equal(taskUpdateChallenge.statusCode, 428);
  const taskUpdateProof = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'console-presence',
        taskUpdateChallenge.body.proofFileName,
      ),
      'utf8',
    ),
  );
  const taskUpdated = await request(
    port,
    `Bearer ${TOKEN}`,
    '/api/v3/projects/default/tasks/task-1',
    {
      ...taskUpdateOptions,
      headers: {
        ...taskUpdateOptions.headers,
        'x-qinglong-local-presence': taskUpdateProof.proof,
      },
    },
  );
  assert.equal(taskUpdated.statusCode, 200);
  assert.equal(taskUpdated.body.status, 'updated');
  assert.equal(taskUpdated.body.task.revision, 2);
  assert.equal(taskUpdated.body.task.name, 'Local API Task updated');
  assert.equal(taskUpdated.body.task.enabled, true);

  const updatedTask = await request(
    port,
    `Bearer ${TOKEN}`,
    '/api/v3/projects/default/tasks/task-1',
  );
  assert.equal(updatedTask.body.task.revision, 2);
  assert.equal(updatedTask.body.task.name, 'Local API Task updated');
  assert.equal(updatedTask.body.task.enabled, true);
  assert.equal(JSON.stringify(updatedTask).includes('/bin/echo'), false);

  const triggerPath = '/api/v3/projects/default/triggers/cron:task-1';
  const triggerBody = JSON.stringify({
    expectedRevision: null,
    mutationId: '019f7300-0000-4000-8000-000000000703',
    taskId: 'task-1',
    taskRevision: updatedTask.body.task.revision,
    taskContentDigest: updatedTask.body.task.contentDigest,
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '0 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      },
    },
    enabled: true,
    occurredAtMs: NOW,
  });
  const triggerOptions = {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(triggerBody)),
    },
    body: triggerBody,
  };
  const triggerChallenge = await request(
    port,
    `Bearer ${TOKEN}`,
    triggerPath,
    triggerOptions,
  );
  assert.equal(triggerChallenge.statusCode, 428);
  assert.equal(triggerChallenge.body.code, 'local_presence_required');
  const triggerProof = JSON.parse(
    fs.readFileSync(
      path.join(root, 'console-presence', triggerChallenge.body.proofFileName),
      'utf8',
    ),
  );
  const triggerCreated = await request(port, `Bearer ${TOKEN}`, triggerPath, {
    ...triggerOptions,
    headers: {
      ...triggerOptions.headers,
      'x-qinglong-local-presence': triggerProof.proof,
    },
  });
  assert.equal(triggerCreated.statusCode, 201, JSON.stringify(triggerCreated));
  assert.equal(triggerCreated.body.status, 'created');
  assert.equal(triggerCreated.body.trigger.revision, 1);
  assert.equal(triggerCreated.body.trigger.enabled, true);

  const triggerList = await request(
    port,
    `Bearer ${TOKEN}`,
    '/api/v3/projects/default/triggers?limit=16',
  );
  assert.equal(triggerList.statusCode, 200);
  assert.equal(triggerList.body.triggers.length, 1);
  assert.equal(triggerList.body.triggers[0].triggerId, 'cron:task-1');
  assert.equal(triggerList.body.triggers[0].spec, undefined);

  const triggerRead = await request(port, `Bearer ${TOKEN}`, triggerPath);
  assert.equal(triggerRead.statusCode, 200);
  assert.deepEqual(triggerRead.body.trigger.spec, {
    schema: 'qinglong/cron@v1',
    config: {
      expression: '0 * * * *',
      timezone: 'UTC',
      misfirePolicy: 'skip',
    },
  });
  assert.equal(
    triggerRead.body.trigger.taskContentDigest,
    updatedTask.body.task.contentDigest,
  );

  const triggerDisableBody = JSON.stringify({
    ...JSON.parse(triggerBody),
    expectedRevision: 1,
    mutationId: '019f7300-0000-4000-8000-000000000704',
    enabled: false,
  });
  const triggerDisableOptions = {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(triggerDisableBody)),
    },
    body: triggerDisableBody,
  };
  const triggerDisableChallenge = await request(
    port,
    `Bearer ${TOKEN}`,
    triggerPath,
    triggerDisableOptions,
  );
  assert.equal(triggerDisableChallenge.statusCode, 428);
  const triggerDisableProof = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'console-presence',
        triggerDisableChallenge.body.proofFileName,
      ),
      'utf8',
    ),
  );
  const triggerDisabled = await request(port, `Bearer ${TOKEN}`, triggerPath, {
    ...triggerDisableOptions,
    headers: {
      ...triggerDisableOptions.headers,
      'x-qinglong-local-presence': triggerDisableProof.proof,
    },
  });
  assert.equal(triggerDisabled.statusCode, 200);
  assert.equal(triggerDisabled.body.status, 'updated');
  assert.equal(triggerDisabled.body.trigger.revision, 2);
  assert.equal(triggerDisabled.body.trigger.enabled, false);

  const taskStartBody = JSON.stringify({
    schema: 'qinglong/task-start@v1',
    mutationId: '019f7300-0000-7000-8000-000000000800',
    expectedRevision: updatedTask.body.task.revision,
    expectedContentDigest: updatedTask.body.task.contentDigest,
  });
  const taskStartOptions = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(taskStartBody)),
    },
    body: taskStartBody,
  };
  const taskStartPath = '/api/v3/projects/default/tasks/task-1/runs';
  const started = await request(
    port,
    `Bearer ${TOKEN}`,
    taskStartPath,
    taskStartOptions,
  );
  assert.equal(started.statusCode, 202, JSON.stringify(started));
  assert.equal(started.body.schema, 'qinglong/task-start@v1');
  assert.equal(started.body.status, 'accepted');
  assert.equal(started.body.runStatus, 'queued');
  assert.equal(started.body.executorType, 'local_process');
  assert.equal(
    started.body.taskContentDigest,
    updatedTask.body.task.contentDigest,
  );
  const taskStartReplay = await request(
    port,
    `Bearer ${TOKEN}`,
    taskStartPath,
    taskStartOptions,
  );
  assert.equal(taskStartReplay.statusCode, 200);
  assert.equal(taskStartReplay.body.status, 'existing');
  assert.equal(taskStartReplay.body.runId, started.body.runId);
  assert.equal(taskStartReplay.body.attemptId, started.body.attemptId);

  const timeline = await request(
    port,
    `Bearer ${TOKEN}`,
    `/api/v3/projects/default/runs/${RUN_ID}/events?limit=1`,
  );
  assert.deepEqual(timeline, {
    statusCode: 200,
    body: {
      events: [
        {
          sequence: 1,
          type: 'run.started',
          actorType: 'system',
          createdAtMs: NOW - 50,
        },
      ],
      hasMore: false,
      nextAfterSequence: 1,
    },
  });
  assert.equal(JSON.stringify(timeline).includes('payload'), false);

  const steps = await request(
    port,
    `Bearer ${TOKEN}`,
    `/api/v3/projects/default/runs/${RUN_ID}/steps?limit=1`,
  );
  assert.deepEqual(steps, {
    statusCode: 200,
    body: {
      steps: [
        {
          id: 'step-local-api-1',
          parentStepRunId: null,
          stepKey: 'build',
          kind: 'tool',
          required: true,
          status: 'ready',
          version: 1,
          attemptCount: 0,
          readyAtMs: NOW - 75,
          startedAtMs: null,
          finishedAtMs: null,
          resultCode: null,
          createdAtMs: NOW - 75,
          updatedAtMs: NOW - 75,
        },
      ],
      hasMore: false,
      next: null,
    },
  });
  assert.equal(JSON.stringify(steps).includes('private'), false);

  const log = await request(
    port,
    `Bearer ${TOKEN}`,
    `/api/v3/projects/default/runs/${RUN_ID}/attempts/${ATTEMPT_ID}/log?offset=0&length=8`,
  );
  assert.equal(log.statusCode, 200);
  assert.equal(log.body.schema, 'qinglong/run-attempt-log-read-result@v1');
  assert.equal(log.body.status, 'available');
  assert.equal(log.body.encoding, 'base64');
  assert.equal(Buffer.from(log.body.content, 'base64').toString(), 'local-ap');
  assert.deepEqual(log.body.range, {
    start: 0,
    endExclusive: 8,
    totalBytes: logContent.byteLength,
    nextOffset: 8,
  });
  assert.deepEqual(log.body.truncation, { truncated: 'unknown' });

  const cancellationBody = JSON.stringify({
    schema: 'qinglong/run-cancellation@v1',
    mutationId: 'cancel-local-api-1',
  });
  const cancellationPath = `/api/v3/projects/default/runs/${RUN_ID}/cancellation`;
  const cancellationOptions = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(cancellationBody)),
    },
    body: cancellationBody,
  };
  const cancelled = await request(
    port,
    `Bearer ${TOKEN}`,
    cancellationPath,
    cancellationOptions,
  );
  assert.equal(cancelled.statusCode, 202);
  assert.equal(cancelled.body.schema, 'qinglong/run-cancellation@v1');
  assert.equal(cancelled.body.status, 'accepted');
  assert.equal(cancelled.body.cancelReason, 'user');

  const replayed = await request(
    port,
    `Bearer ${TOKEN}`,
    cancellationPath,
    cancellationOptions,
  );
  assert.equal(replayed.statusCode, 200);
  assert.equal(replayed.body.status, 'already_requested');

  const wrongSecret = Buffer.alloc(32, 83).toString('base64url');
  assert.deepEqual(
    await request(
      port,
      `Bearer ${formatApiCredentialToken(CREDENTIAL_ID, wrongSecret)}`,
    ),
    { statusCode: 401, body: { code: 'authentication_required' } },
  );
  const auditReader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      auditReader
        .prepare(
          `SELECT operation_id, outcome FROM "QingLong3SecurityAuditEvents"
           WHERE operation_id IN (
             'run.get', 'run.list', 'run.events.list', 'run.steps.list',
             'run.cancel', 'task.authoring.read', 'task.create', 'task.get',
             'task.list', 'task.start', 'task.update', 'run.log.read',
             'trigger.create', 'trigger.get', 'trigger.list', 'trigger.update'
           )
           ORDER BY operation_id, outcome`,
        )
        .all()
        .map(({ operation_id, outcome }) => `${operation_id}:${outcome}`),
      [
        'run.cancel:allowed',
        'run.cancel:allowed',
        'run.events.list:allowed',
        'run.get:allowed',
        'run.get:authentication_rejected',
        'run.list:allowed',
        'run.log.read:allowed',
        'run.steps.list:allowed',
        'task.authoring.read:allowed',
        'task.authoring.read:approval_required',
        'task.create:allowed',
        'task.create:approval_required',
        'task.get:allowed',
        'task.get:allowed',
        'task.get:allowed',
        'task.list:allowed',
        'task.start:allowed',
        'task.start:allowed',
        'task.update:allowed',
        'task.update:approval_required',
        'trigger.create:allowed',
        'trigger.create:approval_required',
        'trigger.get:allowed',
        'trigger.list:allowed',
        'trigger.update:allowed',
        'trigger.update:approval_required',
      ],
    );
    assert.deepEqual(
      {
        ...auditReader
          .prepare(
            `SELECT "status", "version", "event_sequence" AS "eventSequence",
                    "trigger_type" AS "triggerType"
             FROM "Runs" WHERE "id" = ?`,
          )
          .get(started.body.runId),
      },
      {
        status: 'queued',
        version: 2,
        eventSequence: 2,
        triggerType: 'task_start',
      },
    );
    assert.deepEqual(
      {
        ...auditReader
          .prepare(
            `SELECT "version", "event_sequence" AS "eventSequence",
                    "cancel_reason" AS "cancelReason"
             FROM "Runs" WHERE "id" = ?`,
          )
          .get(RUN_ID),
      },
      { version: 2, eventSequence: 2, cancelReason: 'user' },
    );
    assert.equal(
      auditReader
        .prepare(
          `SELECT COUNT(*) AS count FROM "RunEvents"
           WHERE "run_id" = ? AND "type" = 'run.cancel_requested'`,
        )
        .get(RUN_ID).count,
      1,
    );
  } finally {
    auditReader.close();
  }
});
