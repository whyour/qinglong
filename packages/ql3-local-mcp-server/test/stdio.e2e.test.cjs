const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  approvalRequestDigest,
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const { createTriggerRecord } = require('@qinglong/runtime-core/trigger');

const NOW = Date.now();
const PEPPER_KEY_ID = 'mcp-owner-v1';
const CREDENTIAL_ID = 'mcp-owner';
const PEPPER_BYTES = Buffer.alloc(32, 31);
const PEPPER = PEPPER_BYTES.toString('base64url');
const SECRET = Buffer.alloc(32, 32).toString('base64url');

function privateDirectory(parent, name) {
  const value = path.join(parent, name);
  fs.mkdirSync(value, { mode: 0o700 });
  return value;
}

async function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-mcp-stdio-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const dataDirectory = privateDirectory(deploymentRoot, 'data');
  const operatorDirectory = privateDirectory(deploymentRoot, 'operator');
  const ownerPepperKeyringDirectory = privateDirectory(
    deploymentRoot,
    'owner-peppers',
  );
  const databasePath = path.join(dataDirectory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  await runtime.runRepository.transaction(async (transaction) => {
    await transaction.insertRun({
      id: 'run-mcp-e2e',
      projectId: 'default',
      taskId: 'task-mcp',
      taskRevision: 'revision-1',
      taskName: 'MCP test',
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      triggeredBy: 'user:mcp-owner',
      status: 'created',
      version: 0,
      eventSequence: 2,
      priority: 0,
      createdAtMs: NOW - 2_000,
    });
    await transaction.insertRun({
      id: 'run-mcp-e2e-candidate',
      projectId: 'default',
      taskId: 'task-mcp',
      taskRevision: 'revision-2',
      taskName: 'MCP test candidate',
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      triggeredBy: 'user:mcp-owner',
      status: 'created',
      version: 0,
      eventSequence: 0,
      priority: 1,
      createdAtMs: NOW - 3_000,
    });
    await transaction.appendEvent({
      id: 'mcp-e2e-event-1',
      runId: 'run-mcp-e2e',
      sequence: 1,
      type: 'run.created',
      actorType: 'user',
      actorId: 'mcp-user',
      payload: Object.freeze({ secret: 'must-not-leak' }),
      createdAtMs: NOW - 1_999,
    });
    await transaction.appendEvent({
      id: 'mcp-e2e-event-2',
      runId: 'run-mcp-e2e',
      sequence: 2,
      type: 'run.queued',
      actorType: 'system',
      payload: Object.freeze({ private: 'must-not-leak' }),
      createdAtMs: NOW - 1_998,
    });
  });
  await runtime.close();

  const pepperSummary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.from(PEPPER_BYTES),
  });
  const database = new DatabaseSync(databasePath);
  let taskContentDigest;
  try {
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'b'.repeat(64),
        '92000000-0000-4000-8000-000000000001',
        '92000000-0000-4000-8000-000000000002',
        NOW - 1_900,
        NOW - 1_800,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '92000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'b'.repeat(64),
        NOW - 1_800,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'mcp-user', 'active', 1, ?, ?)`,
      )
      .run(NOW - 1_700, NOW - 1_700);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'mcp-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
        NOW - 1_600,
        NOW - 1_600,
        NOW + 600_000,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'mcp-user', 1, 'active', 'owner',
           'mcp-owner-binding', 'user', 'mcp-user', ?
         )`,
      )
      .run(NOW - 1_500);
    const taskDefinition = createTaskDefinitionRecord(
      {
        projectId: 'default',
        taskId: 'task-mcp',
        expectedRevision: null,
        mutationId: '92000000-0000-4000-8000-000000000003',
        name: 'MCP Task',
        kind: 'script',
        spec: {
          schema: 'qinglong/script@v1',
          config: { command: 'private command' },
        },
        labels: { private: 'label' },
        enabled: true,
        occurredAtMs: NOW - 1_400,
      },
      NOW - 1_400,
    );
    taskContentDigest = taskDefinition.contentDigest;
    database
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
    database
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
    const trigger = createTriggerRecord(
      {
        projectId: 'default',
        triggerId: 'trigger-mcp',
        expectedRevision: null,
        mutationId: '92000000-0000-4000-8000-000000000004',
        taskId: taskDefinition.taskId,
        taskRevision: taskDefinition.revision,
        taskContentDigest: taskDefinition.contentDigest,
        spec: {
          schema: 'qinglong/cron@v1',
          config: {
            expression: '*/5 * * * *',
            timezone: 'Etc/UTC',
            misfirePolicy: 'skip',
          },
        },
        enabled: true,
        occurredAtMs: NOW - 1_300,
      },
      NOW - 1_300,
    );
    database
      .prepare(
        `INSERT INTO "QingLong3Triggers" (
           "project_id", "trigger_id", "task_id", "current_revision",
           "created_at_ms", "updated_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.projectId,
        trigger.triggerId,
        trigger.taskId,
        trigger.revision,
        trigger.createdAtMs,
        trigger.updatedAtMs,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3TriggerRevisions" (
           "project_id", "trigger_id", "revision", "mutation_id",
           "task_id", "task_revision", "task_content_digest",
           "spec_json", "enabled", "content_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.projectId,
        trigger.triggerId,
        trigger.revision,
        trigger.mutationId,
        trigger.taskId,
        trigger.taskRevision,
        trigger.taskContentDigest,
        JSON.stringify(trigger.spec),
        1,
        trigger.contentDigest,
        trigger.updatedAtMs,
      );
    const approval = createApprovalRequest({
      id: 'approval-mcp',
      projectId: 'default',
      action: {
        permission: 'run.start',
        actionType: 'tool.invoke',
        actionRef: 'private-action-ref',
        actionDigest: 'a'.repeat(64),
        previewDigest: 'b'.repeat(64),
      },
      risk: 'medium',
      decisionMode: 'human_confirmation',
      requestedBy: { type: 'agent', id: 'private-agent' },
      requestedAtMs: NOW - 1_200,
      expiresAtMs: NOW + 60_000,
      requestFence: { projectVersion: 1, bindingVersion: 1 },
    });
    database
      .prepare(
        `INSERT INTO "QingLong3ApprovalRequests" (
           "request_id", "project_id", "version", "state", "action_type",
           "action_ref", "action_digest", "preview_digest",
           "requested_by_type", "requested_by_id", "decision_id",
           "consumption_id", "dispatch_id", "expires_at_ms", "request_json",
           "request_digest", "updated_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.projectId,
        approval.version,
        approval.state,
        approval.action.actionType,
        approval.action.actionRef,
        approval.action.actionDigest,
        approval.action.previewDigest,
        approval.requestedBy.type,
        approval.requestedBy.id,
        approval.decisionId,
        approval.consumptionId,
        approval.dispatchId,
        approval.expiresAtMs,
        JSON.stringify(approval),
        approvalRequestDigest(approval),
        approval.requestedAtMs,
      );
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);

  const credentialFilePath = path.join(operatorDirectory, 'credential.json');
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: formatApiCredentialToken(CREDENTIAL_ID, SECRET),
    })}\n`,
    { mode: 0o600 },
  );
  const configFilePath = path.join(deploymentRoot, 'mcp.json');
  fs.writeFileSync(
    configFilePath,
    `${JSON.stringify({
      schema: 'qinglong/local-mcp-server@v1',
      profile: 'edge',
      projectId: 'default',
      deploymentRoot,
      databasePath,
      ownerPepperKeyringDirectory,
      credentialFilePath,
      busyTimeoutMs: 500,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    configFilePath,
    databasePath,
    taskContentDigest,
  };
}

test('serves the authenticated Run Tool over the real stdio protocol and persists allowed audit', async (t) => {
  const value = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      path.resolve(__dirname, '../dist/cli.js'),
      '--config',
      value.configFilePath,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  let buffered = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  let id = 0;
  const request = (method, params) => {
    id += 1;
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`,
    );
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      const timer = setTimeout(
        () => reject(new Error(`timeout: ${method}`)),
        5_000,
      );
      timer.unref();
    });
  };

  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'ql3-e2e', version: '1.0.0' },
  });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })}\n`,
  );
  const listed = await request('tools/list', {});
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      'qinglong.run.list',
      'qinglong.run.get',
      'qinglong.run.compare',
      'qinglong.run.events.list',
      'qinglong.run.steps.list',
      'qinglong.task.get',
      'qinglong.task.list',
      'qinglong.trigger.list',
      'qinglong.approval.list',
      'qinglong.approval.get',
    ],
  );
  const tasks = await request('tools/call', {
    name: 'qinglong.task.list',
    arguments: { limit: 1 },
  });
  assert.equal(tasks.result.isError, undefined, JSON.stringify(tasks));
  assert.deepEqual(tasks.result.structuredContent, {
    tasks: [
      {
        taskId: 'task-mcp',
        revision: 1,
        name: 'MCP Task',
        kind: 'script',
        specSchema: 'qinglong/script@v1',
        enabled: true,
        updatedAtMs: NOW - 1_400,
      },
    ],
    hasMore: false,
  });
  assert.equal(JSON.stringify(tasks).includes('private'), false);
  const currentTask = await request('tools/call', {
    name: 'qinglong.task.get',
    arguments: { taskId: 'task-mcp' },
  });
  assert.equal(
    currentTask.result.isError,
    undefined,
    JSON.stringify(currentTask),
  );
  assert.deepEqual(currentTask.result.structuredContent, {
    found: true,
    taskId: 'task-mcp',
    revision: 1,
    name: 'MCP Task',
    kind: 'script',
    specSchema: 'qinglong/script@v1',
    enabled: true,
    contentDigest: value.taskContentDigest,
    createdAtMs: NOW - 1_400,
    updatedAtMs: NOW - 1_400,
  });
  assert.equal(JSON.stringify(currentTask).includes('private'), false);
  const triggers = await request('tools/call', {
    name: 'qinglong.trigger.list',
    arguments: { limit: 1 },
  });
  assert.equal(triggers.result.isError, undefined, JSON.stringify(triggers));
  assert.deepEqual(triggers.result.structuredContent, {
    triggers: [
      {
        triggerId: 'trigger-mcp',
        revision: 1,
        taskId: 'task-mcp',
        taskRevision: 1,
        specSchema: 'qinglong/cron@v1',
        enabled: true,
        updatedAtMs: NOW - 1_300,
      },
    ],
    hasMore: false,
  });
  assert.equal(JSON.stringify(triggers).includes('*/5'), false);
  assert.equal(JSON.stringify(triggers).includes('Etc/UTC'), false);
  const approvals = await request('tools/call', {
    name: 'qinglong.approval.list',
    arguments: { limit: 1 },
  });
  assert.equal(approvals.result.isError, undefined, JSON.stringify(approvals));
  assert.deepEqual(approvals.result.structuredContent, {
    approvals: [
      {
        requestId: 'approval-mcp',
        version: 1,
        state: 'pending',
        risk: 'medium',
        decisionMode: 'human_confirmation',
        permission: 'run.start',
        actionType: 'tool.invoke',
        requestedByType: 'agent',
        requestedAtMs: NOW - 1_200,
        expiresAtMs: NOW + 60_000,
        updatedAtMs: NOW - 1_200,
      },
    ],
    hasMore: false,
  });
  assert.equal(JSON.stringify(approvals).includes('private'), false);
  const approvalDetail = await request('tools/call', {
    name: 'qinglong.approval.get',
    arguments: { requestId: 'approval-mcp' },
  });
  assert.equal(
    approvalDetail.result.isError,
    undefined,
    JSON.stringify(approvalDetail),
  );
  assert.deepEqual(approvalDetail.result.structuredContent, {
    found: true,
    approval: {
      requestId: 'approval-mcp',
      version: 1,
      state: 'pending',
      risk: 'medium',
      decisionMode: 'human_confirmation',
      permission: 'run.start',
      actionType: 'tool.invoke',
      requestedByType: 'agent',
      requestedAtMs: NOW - 1_200,
      expiresAtMs: NOW + 60_000,
      previewAvailable: false,
    },
  });
  assert.equal(JSON.stringify(approvalDetail).includes('private'), false);
  const discovered = await request('tools/call', {
    name: 'qinglong.run.list',
    arguments: { limit: 1 },
  });
  assert.equal(
    discovered.result.isError,
    undefined,
    JSON.stringify(discovered),
  );
  assert.deepEqual(discovered.result.structuredContent, {
    runs: [
      {
        id: 'run-mcp-e2e',
        taskId: 'task-mcp',
        taskRevision: 'revision-1',
        status: 'created',
        version: 0,
        eventSequence: 2,
        priority: 0,
        executionOrigin: 'manual',
        executionOwner: 'runtime',
        createdAtMs: NOW - 2_000,
      },
    ],
    hasMore: true,
    next: {
      createdAtMs: NOW - 2_000,
      runId: 'run-mcp-e2e',
    },
  });
  const called = await request('tools/call', {
    name: 'qinglong.run.get',
    arguments: { runId: 'run-mcp-e2e' },
  });
  assert.equal(called.result.isError, undefined, JSON.stringify(called));
  assert.deepEqual(called.result.structuredContent, {
    found: true,
    id: 'run-mcp-e2e',
    taskId: 'task-mcp',
    taskRevision: 'revision-1',
    status: 'created',
    version: 0,
    eventSequence: 2,
    priority: 0,
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    createdAtMs: NOW - 2_000,
  });
  const compared = await request('tools/call', {
    name: 'qinglong.run.compare',
    arguments: {
      baselineRunId: 'run-mcp-e2e',
      candidateRunId: 'run-mcp-e2e-candidate',
    },
  });
  assert.equal(compared.result.isError, undefined, JSON.stringify(compared));
  assert.deepEqual(compared.result.structuredContent, {
    baseline: {
      found: true,
      id: 'run-mcp-e2e',
      taskId: 'task-mcp',
      taskRevision: 'revision-1',
      status: 'created',
      version: 0,
      eventSequence: 2,
      priority: 0,
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      createdAtMs: NOW - 2_000,
    },
    candidate: {
      found: true,
      id: 'run-mcp-e2e-candidate',
      taskId: 'task-mcp',
      taskRevision: 'revision-2',
      status: 'created',
      version: 0,
      eventSequence: 0,
      priority: 1,
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      createdAtMs: NOW - 3_000,
    },
    comparable: true,
    sameTask: true,
    sameTaskRevision: false,
    changedFields: ['taskRevision', 'priority'],
    consistency: 'ordered_independent_point_reads',
  });
  const events = await request('tools/call', {
    name: 'qinglong.run.events.list',
    arguments: { runId: 'run-mcp-e2e', limit: 1 },
  });
  assert.equal(events.result.isError, undefined, JSON.stringify(events));
  assert.deepEqual(events.result.structuredContent, {
    found: true,
    events: [
      {
        sequence: 1,
        type: 'run.created',
        actorType: 'user',
        createdAtMs: NOW - 1_999,
      },
    ],
    hasMore: true,
    nextAfterSequence: 1,
  });
  assert.equal(JSON.stringify(events).includes('must-not-leak'), false);
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, '');

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    const audit = database
      .prepare(
        `SELECT operation_id AS "operationId", outcome, subject_id AS "subjectId"
           FROM "QingLong3SecurityAuditEvents"
          WHERE operation_id = 'mcp.tool.call'`,
      )
      .all();
    assert.deepEqual(
      audit.map((row) => ({ ...row })),
      [
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
        {
          operationId: 'mcp.tool.call',
          outcome: 'allowed',
          subjectId: 'mcp-user',
        },
      ],
    );
  } finally {
    database.close();
  }
});
