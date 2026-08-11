const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  runLocalPluginPackageWorkflowCommandFile,
} = require('@qinglong/local-owner-cli/plugin-package-workflow-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('@qinglong/local-sqlite/plugin-package-materialized-revision');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('@qinglong/local-sqlite/plugin-package-automation-publication');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

const CREDENTIAL_ID = 'workflow-owner';
const PEPPER_KEY_ID = 'workflow-owner-v1';
const PEPPER = Buffer.alloc(32, 131).toString('base64url');
const CREDENTIAL_SECRET = Buffer.alloc(32, 132).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, CREDENTIAL_SECRET);

async function fixture(t, { role = 'owner' } = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-workflow-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const ownerPepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const pepperSummary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 131),
  });
  const now = Date.now();
  const workflow = pluginPackageTaskReconciliationFixture(
    `workflow-product-${role}`,
    {
      workflows: [
        {
          schema: 'qinglong/plugin-package-workflow-resource@v1',
          id: 'daily',
          name: 'Daily workflow',
          enabled: true,
          steps: [
            { id: 'collect', task: 'alpha', needs: [] },
            { id: 'summarize', task: 'beta', needs: ['collect'] },
          ],
        },
      ],
    },
  );
  const publication = createInitialPluginPackageAutomationPublication(
    workflow.revision,
    workflow.registry,
    now - 100,
  );
  const secretDigest = apiCredentialSecretDigest(
    PEPPER,
    CREDENTIAL_ID,
    CREDENTIAL_SECRET,
  );
  const database = new DatabaseSync(databasePath);
  try {
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
        'f'.repeat(64),
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000002',
        now - 2_000,
        now - 1_500,
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
        '91000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'f'.repeat(64),
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'workflow-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'workflow-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        secretDigest,
        now - 1_000,
        now - 1_000,
        now + 10 * 60_000,
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
        `INSERT INTO "QingLong3Projects" (
           "id", "name", "slug", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES (?, ?, ?, 'active', 1, ?, ?)`,
      )
      .run(
        workflow.projectId,
        workflow.projectId,
        workflow.projectId,
        now - 1_000,
        now - 1_000,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           ?, 'user', 'workflow-user', 1, 'active', ?,
           ?, 'user', 'workflow-user', ?
         )`,
      )
      .run(workflow.projectId, role, `workflow-${role}-binding`, now - 500);
    await activateInstall(
      new LocalSqlitePluginPackageInstallRepository(database),
      workflow,
    );
    await new LocalSqlitePluginPackageMaterializedRevisionRepository(
      database,
      workflow.registry,
    ).publish(workflow.revision);
    await new LocalSqlitePluginPackageAutomationPublicationRepository(
      database,
    ).publish(publication);
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    deploymentRoot,
    commandsDirectory,
    databasePath,
    workflow,
    options: {
      deploymentRoot,
      databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory,
      credentialFilePath,
    },
  };
}

function writeCommand(value, operation, request, name) {
  const filePath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation,
      options: value.options,
      request,
    })}\n`,
    { mode: 0o600 },
  );
  return filePath;
}

function inspectRequest(value, suffix = '1') {
  return {
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    requestId: `workflow-inspect-${suffix}`,
    auditEventId: `92000000-0000-4000-8000-00000000000${suffix}`,
    failureAuditEventId: `93000000-0000-4000-8000-00000000000${suffix}`,
  };
}

function startRequest(value, suffix = '1') {
  return {
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    planId: `94000000-0000-4000-8000-00000000000${suffix}`,
    runId: `95000000-0000-4000-8000-00000000000${suffix}`,
    stepRunIds: {
      collect: `96000000-0000-4000-8000-00000000000${suffix}`,
      summarize: `97000000-0000-4000-8000-00000000000${suffix}`,
    },
    requestId: `workflow-start-${suffix}`,
    auditEventId: `98000000-0000-4000-8000-00000000000${suffix}`,
    failureAuditEventId: `99000000-0000-4000-8000-00000000000${suffix}`,
  };
}

function cancelRequest(value, suffix = '1') {
  return {
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    runId: `95000000-0000-4000-8000-00000000000${suffix}`,
    mutationId: `9a000000-0000-4000-8000-00000000000${suffix}`,
    runEventId: `9b000000-0000-4000-8000-00000000000${suffix}`,
    requestId: `workflow-cancel-${suffix}`,
    auditEventId: `9c000000-0000-4000-8000-00000000000${suffix}`,
    failureAuditEventId: `9d000000-0000-4000-8000-00000000000${suffix}`,
  };
}

function inspectRunRequest(value, suffix = '1') {
  return {
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    runId: `95000000-0000-4000-8000-00000000000${suffix}`,
    requestId: `workflow-run-inspect-${suffix}`,
    auditEventId: `9e000000-0000-4000-8000-00000000000${suffix}`,
    failureAuditEventId: `9f000000-0000-4000-8000-00000000000${suffix}`,
  };
}

function listRunsRequest(value, suffix = '1') {
  return {
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    limit: 1,
    after: null,
    requestId: `workflow-run-list-${suffix}`,
    auditEventId: `a4000000-0000-4000-8000-00000000000${suffix}`,
    failureAuditEventId: `a5000000-0000-4000-8000-00000000000${suffix}`,
  };
}

function listStepRunsRequest(value, suffix = '1') {
  return {
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    runId: `95000000-0000-4000-8000-00000000000${suffix}`,
    limit: 1,
    after: null,
    requestId: `workflow-step-list-${suffix}`,
    auditEventId: `a0000000-0000-4000-8000-00000000000${suffix}`,
    failureAuditEventId: `a1000000-0000-4000-8000-00000000000${suffix}`,
  };
}

function listRunEventsRequest(value, suffix = '1') {
  return {
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    runId: `95000000-0000-4000-8000-00000000000${suffix}`,
    limit: 2,
    afterSequence: 0,
    requestId: `workflow-event-list-${suffix}`,
    auditEventId: `a2000000-0000-4000-8000-00000000000${suffix}`,
    failureAuditEventId: `a3000000-0000-4000-8000-00000000000${suffix}`,
  };
}

test('inspects and exactly starts one authenticated Plugin Package Workflow', async (t) => {
  const value = await fixture(t);
  const inspectPath = writeCommand(
    value,
    'workflow.inspect',
    inspectRequest(value),
    'inspect',
  );
  const inspected = await runLocalPluginPackageWorkflowCommandFile(inspectPath);
  assert.deepEqual(inspected.workflows, [
    {
      id: 'daily',
      name: 'Daily workflow',
      enabled: true,
      steps: [
        { id: 'collect', task: 'alpha', needs: [] },
        { id: 'summarize', task: 'beta', needs: ['collect'] },
      ],
    },
  ]);

  const startPath = writeCommand(
    value,
    'workflow.start',
    startRequest(value),
    'start',
  );
  const created = await runLocalPluginPackageWorkflowCommandFile(startPath);
  assert.deepEqual(created, {
    schemaVersion: 1,
    operation: 'workflow.start',
    status: 'created',
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000001',
    stepCount: 2,
    admittedAtMs: created.admittedAtMs,
  });
  const replay = await runLocalPluginPackageWorkflowCommandFile(startPath);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.admittedAtMs, created.admittedAtMs);

  const secondStartPath = writeCommand(
    value,
    'workflow.start',
    startRequest(value, '2'),
    'start-second',
  );
  const secondCreated = await runLocalPluginPackageWorkflowCommandFile(
    secondStartPath,
  );
  assert.equal(secondCreated.status, 'created');

  const firstRunPagePath = writeCommand(
    value,
    'workflow.run.list',
    listRunsRequest(value),
    'list-runs-first',
  );
  const firstRunPage = await runLocalPluginPackageWorkflowCommandFile(
    firstRunPagePath,
  );
  assert.equal(firstRunPage.operation, 'workflow.run.list');
  assert.deepEqual(firstRunPage.after, null);
  assert.equal(firstRunPage.runs.length, 1);
  assert.equal(firstRunPage.runs[0].runId, secondCreated.runId);
  assert.equal(firstRunPage.truncated, true);
  assert.deepEqual(firstRunPage.next, {
    admittedAtMs: firstRunPage.runs[0].admittedAtMs,
    runId: secondCreated.runId,
  });
  assert.deepEqual(Object.keys(firstRunPage.runs[0]).sort(), [
    'admittedAtMs',
    'cancelReason',
    'cancelRequestedAtMs',
    'eventSequence',
    'finishedAtMs',
    'queuedAtMs',
    'runId',
    'startedAtMs',
    'status',
    'stepCount',
    'version',
  ]);
  const secondRunPagePath = writeCommand(
    value,
    'workflow.run.list',
    {
      ...listRunsRequest(value, '2'),
      after: firstRunPage.next,
    },
    'list-runs-second',
  );
  const secondRunPage = await runLocalPluginPackageWorkflowCommandFile(
    secondRunPagePath,
  );
  assert.deepEqual(
    secondRunPage.runs.map(({ runId }) => runId),
    [created.runId],
  );
  assert.equal(secondRunPage.truncated, false);
  assert.equal(secondRunPage.next, null);
  const serializedRunPage = JSON.stringify(firstRunPage);
  for (const forbidden of [
    'planDigest',
    'receiptDigest',
    'definitionDigest',
    'inputRef',
    'errorSummary',
    'leaseOwner',
  ]) {
    assert.equal(serializedRunPage.includes(forbidden), false);
  }

  const inspectRunPath = writeCommand(
    value,
    'workflow.run.inspect',
    inspectRunRequest(value),
    'inspect-run',
  );
  const inspectedRun = await runLocalPluginPackageWorkflowCommandFile(
    inspectRunPath,
  );
  assert.deepEqual(inspectedRun, {
    schemaVersion: 1,
    operation: 'workflow.run.inspect',
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000001',
    found: true,
    run: {
      status: 'running',
      version: 3,
      eventSequence: 3,
      createdAtMs: created.admittedAtMs,
      queuedAtMs: null,
      startedAtMs: created.admittedAtMs,
      finishedAtMs: null,
      cancelRequestedAtMs: null,
      cancelReason: null,
    },
    stepCount: 2,
    stepStatusCounts: {
      pending: 1,
      ready: 1,
      waiting_approval: 0,
      running: 0,
      lost: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      timed_out: 0,
    },
  });
  assert.deepEqual(
    await runLocalPluginPackageWorkflowCommandFile(inspectRunPath),
    inspectedRun,
  );
  assert.equal(JSON.stringify(inspectedRun).includes('planDigest'), false);
  assert.equal(
    JSON.stringify(inspectedRun).includes('definitionDigest'),
    false,
  );
  assert.equal(JSON.stringify(inspectedRun).includes('inputRef'), false);
  assert.equal(JSON.stringify(inspectedRun).includes('errorSummary'), false);

  const firstStepPagePath = writeCommand(
    value,
    'workflow.step.list',
    listStepRunsRequest(value),
    'list-steps-first',
  );
  const firstStepPage = await runLocalPluginPackageWorkflowCommandFile(
    firstStepPagePath,
  );
  assert.equal(firstStepPage.operation, 'workflow.step.list');
  assert.equal(firstStepPage.found, true);
  assert.equal(firstStepPage.stepRuns.length, 1);
  assert.equal(firstStepPage.stepRuns[0].stepKey, 'collect');
  assert.equal(firstStepPage.stepRuns[0].status, 'ready');
  assert.equal(firstStepPage.truncated, true);
  assert.deepEqual(firstStepPage.next, {
    stepKey: 'collect',
    id: '96000000-0000-4000-8000-000000000001',
  });
  assert.deepEqual(Object.keys(firstStepPage.stepRuns[0]).sort(), [
    'attemptCount',
    'createdAtMs',
    'finishedAtMs',
    'id',
    'kind',
    'parentStepRunId',
    'readyAtMs',
    'required',
    'resultCode',
    'startedAtMs',
    'status',
    'stepKey',
    'updatedAtMs',
    'version',
  ]);
  const secondStepPagePath = writeCommand(
    value,
    'workflow.step.list',
    {
      ...listStepRunsRequest(value, '2'),
      runId: '95000000-0000-4000-8000-000000000001',
      after: firstStepPage.next,
    },
    'list-steps-second',
  );
  const secondStepPage = await runLocalPluginPackageWorkflowCommandFile(
    secondStepPagePath,
  );
  assert.equal(secondStepPage.stepRuns[0].stepKey, 'summarize');
  assert.equal(secondStepPage.stepRuns[0].status, 'pending');
  assert.equal(secondStepPage.truncated, false);
  assert.equal(secondStepPage.next, null);
  const serializedStepPage = JSON.stringify(firstStepPage);
  for (const forbidden of [
    'definitionRef',
    'definitionDigest',
    'inputRef',
    'outputRef',
    'approvalRequestId',
    'errorSummary',
    'lastMutationId',
    'stepRunDigest',
  ]) {
    assert.equal(serializedStepPage.includes(forbidden), false);
  }

  const firstEventPagePath = writeCommand(
    value,
    'workflow.event.list',
    listRunEventsRequest(value),
    'list-events-first',
  );
  const firstEventPage = await runLocalPluginPackageWorkflowCommandFile(
    firstEventPagePath,
  );
  assert.equal(firstEventPage.operation, 'workflow.event.list');
  assert.equal(firstEventPage.found, true);
  assert.equal(firstEventPage.afterSequence, 0);
  assert.equal(firstEventPage.headSequence, 3);
  assert.deepEqual(
    firstEventPage.events.map(({ sequence }) => sequence),
    [1, 2],
  );
  assert.equal(firstEventPage.truncated, true);
  assert.equal(firstEventPage.nextAfterSequence, 2);
  assert.deepEqual(Object.keys(firstEventPage.events[0]).sort(), [
    'createdAtMs',
    'id',
    'sequence',
    'stepRunId',
    'type',
  ]);
  const secondEventPagePath = writeCommand(
    value,
    'workflow.event.list',
    {
      ...listRunEventsRequest(value, '2'),
      runId: '95000000-0000-4000-8000-000000000001',
      afterSequence: firstEventPage.nextAfterSequence,
    },
    'list-events-second',
  );
  const secondEventPage = await runLocalPluginPackageWorkflowCommandFile(
    secondEventPagePath,
  );
  assert.deepEqual(
    secondEventPage.events.map(({ sequence }) => sequence),
    [3],
  );
  assert.equal(secondEventPage.truncated, false);
  assert.equal(secondEventPage.nextAfterSequence, null);
  const serializedEventPage = JSON.stringify(firstEventPage);
  for (const forbidden of [
    'payload',
    'dedupeKey',
    'actorType',
    'actorId',
    'attemptId',
    'errorSummary',
    'inputRef',
    'outputRef',
  ]) {
    assert.equal(serializedEventPage.includes(forbidden), false);
  }

  const emptyRunPagePath = writeCommand(
    value,
    'workflow.run.list',
    {
      ...listRunsRequest(value, '3'),
      workflowId: 'other',
    },
    'list-runs-cross-target',
  );
  const emptyRunPage = await runLocalPluginPackageWorkflowCommandFile(
    emptyRunPagePath,
  );
  assert.equal(emptyRunPage.workflowId, 'other');
  assert.deepEqual(emptyRunPage.runs, []);
  assert.equal(emptyRunPage.truncated, false);
  assert.equal(emptyRunPage.next, null);

  const missingRunPath = writeCommand(
    value,
    'workflow.run.inspect',
    {
      ...inspectRunRequest(value, '2'),
      workflowId: 'other',
      runId: '95000000-0000-4000-8000-000000000001',
    },
    'inspect-run-cross-target',
  );
  assert.deepEqual(
    await runLocalPluginPackageWorkflowCommandFile(missingRunPath),
    {
      schemaVersion: 1,
      operation: 'workflow.run.inspect',
      projectId: value.workflow.projectId,
      packageName: value.workflow.packageName,
      workflowId: 'other',
      runId: '95000000-0000-4000-8000-000000000001',
      found: false,
      run: null,
      stepCount: null,
      stepStatusCounts: null,
    },
  );

  const cli = spawnSync(
    process.execPath,
    [
      path.join(
        __dirname,
        '../dist/plugin-package/pluginPackageWorkflowCli.js',
      ),
      'run',
      '--command-file',
      startPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'existing');
  assert.equal(cli.stdout.includes('planDigest'), false);
  assert.equal(cli.stdout.includes(value.databasePath), false);

  const cancelPath = writeCommand(
    value,
    'workflow.cancel',
    cancelRequest(value),
    'cancel',
  );
  const accepted = await runLocalPluginPackageWorkflowCommandFile(cancelPath);
  assert.deepEqual(accepted, {
    schemaVersion: 1,
    operation: 'workflow.cancel',
    status: 'accepted',
    projectId: value.workflow.projectId,
    packageName: value.workflow.packageName,
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000001',
    runStatus: 'running',
    runVersion: 4,
    eventSequence: 4,
    cancelRequestedAtMs: accepted.cancelRequestedAtMs,
    cancelReason: 'user',
  });
  const cancelReplay = await runLocalPluginPackageWorkflowCommandFile(
    cancelPath,
  );
  assert.equal(cancelReplay.status, 'existing');
  assert.equal(cancelReplay.cancelRequestedAtMs, accepted.cancelRequestedAtMs);
  const cancelCli = spawnSync(
    process.execPath,
    [
      path.join(
        __dirname,
        '../dist/plugin-package/pluginPackageWorkflowCli.js',
      ),
      'run',
      '--command-file',
      cancelPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cancelCli.status, 0, cancelCli.stderr);
  assert.equal(JSON.parse(cancelCli.stdout).status, 'existing');
  assert.equal(cancelCli.stdout.includes('policy_fence'), false);
  assert.equal(cancelCli.stdout.includes(value.databasePath), false);
  const secondCancelPath = writeCommand(
    value,
    'workflow.cancel',
    {
      ...cancelRequest(value, '2'),
      runId: '95000000-0000-4000-8000-000000000001',
    },
    'cancel-already-requested',
  );
  const alreadyRequested = await runLocalPluginPackageWorkflowCommandFile(
    secondCancelPath,
  );
  assert.equal(alreadyRequested.status, 'already_requested');
  assert.equal(
    alreadyRequested.cancelRequestedAtMs,
    accepted.cancelRequestedAtMs,
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM "Runs") AS runs,
               (SELECT COUNT(*) FROM "StepRuns") AS steps,
               (SELECT COUNT(*) FROM "QingLong3PluginPackageWorkflowAdmissions") AS admissions,
               (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents"
                WHERE operation_id = 'workflow.start') AS startAudits,
               (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents"
                WHERE operation_id = 'workflow.cancel') AS cancelAudits,
               (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents"
                WHERE operation_id = 'workflow.run.read') AS runReadAudits,
               (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents"
                WHERE operation_id = 'workflow.run.list') AS runListAudits,
               (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents"
                WHERE operation_id = 'workflow.step.list') AS stepListAudits,
               (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents"
                WHERE operation_id = 'workflow.event.list') AS eventListAudits,
               (SELECT COUNT(*) FROM "RunEvents"
                WHERE type = 'run.cancel_requested') AS cancelEvents`,
          )
          .get(),
      },
      {
        runs: 2,
        steps: 4,
        admissions: 2,
        startAudits: 2,
        cancelAudits: 2,
        runReadAudits: 2,
        runListAudits: 3,
        stepListAudits: 2,
        eventListAudits: 2,
        cancelEvents: 1,
      },
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT cancel_reason AS "cancelReason",
                    cancel_requested_at_ms AS "cancelRequestedAtMs"
             FROM "Runs" WHERE id = ?`,
          )
          .get('95000000-0000-4000-8000-000000000001'),
      },
      {
        cancelReason: 'user',
        cancelRequestedAtMs: accepted.cancelRequestedAtMs,
      },
    );
  } finally {
    database.close();
  }
});

test('denies Workflow cancellation without run.stop and preserves the Run', async (t) => {
  const value = await fixture(t);
  const startPath = writeCommand(
    value,
    'workflow.start',
    startRequest(value, '3'),
    'start-before-denied-cancel',
  );
  await runLocalPluginPackageWorkflowCommandFile(startPath);
  const database = new DatabaseSync(value.databasePath);
  try {
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (?, 'user', 'workflow-user', 2, 'active', 'viewer',
                   ?, 'user', 'workflow-user', ?)`,
      )
      .run(
        value.workflow.projectId,
        'workflow-viewer-cancel-binding',
        Date.now(),
      );
  } finally {
    database.close();
  }
  const viewerInspectPath = writeCommand(
    value,
    'workflow.run.inspect',
    {
      ...inspectRunRequest(value, '3'),
      runId: '95000000-0000-4000-8000-000000000003',
    },
    'viewer-inspect-run',
  );
  const viewerInspection = await runLocalPluginPackageWorkflowCommandFile(
    viewerInspectPath,
  );
  assert.equal(viewerInspection.found, true);
  assert.equal(viewerInspection.run.status, 'running');
  assert.equal(viewerInspection.stepCount, 2);
  const cancelPath = writeCommand(
    value,
    'workflow.cancel',
    cancelRequest(value, '3'),
    'viewer-cancel',
  );
  await assert.rejects(
    runLocalPluginPackageWorkflowCommandFile(cancelPath),
    (error) =>
      error?.code === 'LOCAL_PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_FORBIDDEN',
  );
  const reader = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...reader
          .prepare(
            `SELECT cancel_requested_at_ms AS "cancelRequestedAtMs",
                    cancel_reason AS "cancelReason"
             FROM "Runs" WHERE id = ?`,
          )
          .get('95000000-0000-4000-8000-000000000003'),
      },
      { cancelRequestedAtMs: null, cancelReason: null },
    );
    assert.equal(
      reader
        .prepare(
          `SELECT COUNT(*) AS count FROM "RunEvents"
           WHERE run_id = ? AND type = 'run.cancel_requested'`,
        )
        .get('95000000-0000-4000-8000-000000000003').count,
      0,
    );
  } finally {
    reader.close();
  }
});

test('denies Workflow start without run.start and writes no Run', async (t) => {
  const value = await fixture(t, { role: 'viewer' });
  const startPath = writeCommand(
    value,
    'workflow.start',
    startRequest(value, '2'),
    'viewer-start',
  );
  await assert.rejects(
    runLocalPluginPackageWorkflowCommandFile(startPath),
    (error) =>
      error?.code === 'LOCAL_PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_FORBIDDEN',
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM "Runs"').get().count,
      0,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT outcome, reasons_json AS reasons
             FROM "QingLong3SecurityAuditEvents"
             WHERE event_id = ?`,
          )
          .get('98000000-0000-4000-8000-000000000002'),
      },
      { outcome: 'denied', reasons: '["permission_missing"]' },
    );
  } finally {
    database.close();
  }
});
