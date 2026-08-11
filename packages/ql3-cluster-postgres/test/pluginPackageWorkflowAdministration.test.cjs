const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
} = require('@qinglong/runtime-core/plugin-package-workflow-administration');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  PostgresAuthorizedPluginPackageWorkflowAdmissionRepository,
  PostgresAuthorizedPluginPackageWorkflowRunEventListRepository,
  PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository,
  PostgresAuthorizedPluginPackageWorkflowRunListRepository,
  PostgresAuthorizedPluginPackageWorkflowStepRunListRepository,
} = require('@qinglong/cluster-postgres/plugin-package-workflow-administration');

function fixture() {
  const value = pluginPackageTaskReconciliationFixture('postgres-authorized', {
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps: [{ id: 'run', task: 'alpha', needs: [] }],
      },
    ],
  });
  const publication = createInitialPluginPackageAutomationPublication(
    value.revision,
    value.registry,
    2_000,
  );
  const plan = createPluginPackageWorkflowExecutionPlan({
    planId: '123e4567-e89b-42d3-a456-426614174100',
    runId: '123e4567-e89b-42d3-a456-426614174101',
    workflowId: 'daily',
    stepRunIds: { run: '123e4567-e89b-42d3-a456-426614174102' },
    publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
  });
  return { ...value, publication, plan };
}

function authorized(plan) {
  return {
    plan,
    actor: { type: 'api_app', id: 'workflow-operator' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    audit: {
      eventId: plan.planId,
      requestId: plan.planId,
      operationId: 'workflow.start',
      projectId: plan.target.projectId,
      subject: { type: 'api_app', id: 'workflow-operator' },
      authenticationId: 'api_credential:workflow-product:2',
      outcome: 'allowed',
      reasons: ['project_policy_allowed'],
      fence: { projectVersion: 3, bindingVersion: 7 },
      occurredAtMs: plan.plannedAtMs,
    },
  };
}

function inspection(plan, overrides = {}) {
  return {
    projectId: plan.target.projectId,
    packageName: plan.target.packageName,
    workflowId: plan.target.workflowId,
    runId: plan.runId,
    actor: { type: 'api_app', id: 'workflow-operator' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    audit: {
      eventId: '123e4567-e89b-42d3-a456-426614174094',
      requestId: 'workflow-run-inspection-request-1',
      operationId: 'workflow.run.read',
      projectId: plan.target.projectId,
      subject: { type: 'api_app', id: 'workflow-operator' },
      authenticationId: 'api_credential:workflow-product:2',
      outcome: 'allowed',
      reasons: ['project_policy_allowed'],
      fence: { projectVersion: 3, bindingVersion: 7 },
      occurredAtMs: 3_200,
    },
    ...overrides,
  };
}

function runList(plan, overrides = {}) {
  return {
    projectId: plan.target.projectId,
    packageName: plan.target.packageName,
    workflowId: plan.target.workflowId,
    limit: 1,
    after: null,
    actor: { type: 'api_app', id: 'workflow-operator' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    audit: {
      eventId: '123e4567-e89b-42d3-a456-426614174093',
      requestId: 'workflow-run-list-request-1',
      operationId: 'workflow.run.list',
      projectId: plan.target.projectId,
      subject: { type: 'api_app', id: 'workflow-operator' },
      authenticationId: 'api_credential:workflow-product:2',
      outcome: 'allowed',
      reasons: ['project_policy_allowed'],
      fence: { projectVersion: 3, bindingVersion: 7 },
      occurredAtMs: 3_200,
    },
    ...overrides,
  };
}

function stepRunList(plan, overrides = {}) {
  return {
    projectId: plan.target.projectId,
    packageName: plan.target.packageName,
    workflowId: plan.target.workflowId,
    runId: plan.runId,
    limit: 1,
    after: null,
    actor: { type: 'api_app', id: 'workflow-operator' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    audit: {
      eventId: '123e4567-e89b-42d3-a456-426614174095',
      requestId: 'workflow-step-list-request-1',
      operationId: 'workflow.step.list',
      projectId: plan.target.projectId,
      subject: { type: 'api_app', id: 'workflow-operator' },
      authenticationId: 'api_credential:workflow-product:2',
      outcome: 'allowed',
      reasons: ['project_policy_allowed'],
      fence: { projectVersion: 3, bindingVersion: 7 },
      occurredAtMs: 3_300,
    },
    ...overrides,
  };
}

function runEventList(plan, overrides = {}) {
  return {
    projectId: plan.target.projectId,
    packageName: plan.target.packageName,
    workflowId: plan.target.workflowId,
    runId: plan.runId,
    limit: 1,
    afterSequence: 0,
    actor: { type: 'api_app', id: 'workflow-operator' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    audit: {
      eventId: '123e4567-e89b-42d3-a456-426614174096',
      requestId: 'workflow-event-list-request-1',
      operationId: 'workflow.event.list',
      projectId: plan.target.projectId,
      subject: { type: 'api_app', id: 'workflow-operator' },
      authenticationId: 'api_credential:workflow-product:2',
      outcome: 'allowed',
      reasons: ['project_policy_allowed'],
      fence: { projectVersion: 3, bindingVersion: 7 },
      occurredAtMs: 3_400,
    },
    ...overrides,
  };
}

function poolFor(value, credentialState = 'active') {
  const queries = [];
  let released = false;
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (
        text.includes('plugin_package_workflow_admissions') &&
        text.includes('WHERE plan_id')
      ) {
        return { rows: [] };
      }
      if (text.includes('FROM "ql3"."api_credentials" AS credential')) {
        return {
          rows: [
            {
              version: 2,
              state: credentialState,
              subjectType: 'api_app',
              subjectId: 'workflow-operator',
              subjectStatus: 'active',
              notBeforeAtMs: 1,
              expiresAtMs: 10_000,
              nowMs: 3_100,
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."projects"')) {
        return { rows: [{ status: 'active', version: 3 }] };
      }
      if (text.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: 7 }] };
      }
      if (text.includes('INSERT INTO "ql3"."security_audit_events"')) {
        return { rows: [{ eventId: value.plan.planId }] };
      }
      if (text.includes('plugin_package_workflow_admission_snapshot')) {
        return {
          rows: [
            {
              publicationJson: value.publication,
              revisionJson: value.revision,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      query: client.query.bind(client),
      async connect() {
        return client;
      },
    },
    queries,
    released: () => released,
  };
}

function inspectionPoolFor(value, options = {}) {
  const queries = [];
  let released = false;
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('FROM "ql3"."api_credentials" AS credential')) {
        return {
          rows: [
            {
              version: 2,
              state: options.credentialState ?? 'active',
              subjectType: 'api_app',
              subjectId: 'workflow-operator',
              subjectStatus: 'active',
              notBeforeAtMs: 1,
              expiresAtMs: 10_000,
              nowMs: 3_100,
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."projects"')) {
        return { rows: [{ status: 'active', version: 3 }] };
      }
      if (text.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: 7 }] };
      }
      if (text.includes('security_audit_events" AS audit')) {
        return { rows: [] };
      }
      if (
        text.includes('plugin_package_workflow_admissions" AS admission') &&
        text.includes('admission.workflow_id')
      ) {
        return options.missing
          ? { rows: [] }
          : {
              rows: [
                {
                  workflowId: value.plan.target.workflowId,
                  stepCount: 1,
                  runStatus: 'running',
                  runVersion: 3,
                  eventSequence: 3,
                  createdAtMs: 3_000,
                  queuedAtMs: 3_010,
                  startedAtMs: 3_020,
                  finishedAtMs: null,
                  cancelRequestedAtMs: null,
                  cancelReason: null,
                },
              ],
            };
      }
      if (text.includes('FROM "ql3"."step_runs"')) {
        return { rows: [{ stepStatus: 'running', statusCount: '1' }] };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      query: client.query.bind(client),
      async connect() {
        return client;
      },
    },
    queries,
    released: () => released,
  };
}

function runListPoolFor(value, options = {}) {
  const queries = [];
  let released = false;
  const rows = options.rows ?? [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('FROM "ql3"."api_credentials" AS credential')) {
        return {
          rows: [
            {
              version: 2,
              state: options.credentialState ?? 'active',
              subjectType: 'api_app',
              subjectId: 'workflow-operator',
              subjectStatus: 'active',
              notBeforeAtMs: 1,
              expiresAtMs: 10_000,
              nowMs: 3_100,
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."projects"')) {
        return { rows: [{ status: 'active', version: 3 }] };
      }
      if (text.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: 7 }] };
      }
      if (
        text.includes('admission.run_id AS "runId"') &&
        text.includes('plugin_package_workflow_admissions')
      ) {
        return { rows };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      query: client.query.bind(client),
      async connect() {
        return client;
      },
    },
    queries,
    released: () => released,
  };
}

function stepRunListPoolFor(value, options = {}) {
  const queries = [];
  let released = false;
  const rows = options.rows ?? [
    {
      id: value.plan.steps[0].stepRunId,
      parentStepRunId: null,
      stepKey: 'run',
      kind: 'task',
      required: true,
      status: 'running',
      version: 2,
      attemptCount: 1,
      readyAtMs: 3_010,
      startedAtMs: 3_020,
      finishedAtMs: null,
      resultCode: null,
      createdAtMs: 3_000,
      updatedAtMs: 3_020,
    },
  ];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('FROM "ql3"."api_credentials" AS credential')) {
        return {
          rows: [
            {
              version: 2,
              state: options.credentialState ?? 'active',
              subjectType: 'api_app',
              subjectId: 'workflow-operator',
              subjectStatus: 'active',
              notBeforeAtMs: 1,
              expiresAtMs: 10_000,
              nowMs: 3_100,
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."projects"')) {
        return { rows: [{ status: 'active', version: 3 }] };
      }
      if (text.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: 7 }] };
      }
      if (text.includes('AS "observedStepCount"')) {
        return options.missing
          ? { rows: [] }
          : {
              rows: [
                {
                  stepCount: options.stepCount ?? rows.length,
                  observedStepCount: options.stepCount ?? rows.length,
                },
              ],
            };
      }
      if (
        text.includes('SELECT id AS "id"') &&
        text.includes('FROM "ql3"."step_runs"')
      ) {
        return { rows };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      query: client.query.bind(client),
      async connect() {
        return client;
      },
    },
    queries,
    released: () => released,
  };
}

function runEventListPoolFor(value, options = {}) {
  const queries = [];
  let released = false;
  const rows = options.rows ?? [
    {
      id: '123e4567-e89b-42d3-a456-426614174104',
      sequence: 1,
      type: 'workflow.admitted',
      stepRunId: null,
      createdAtMs: 3_000,
    },
  ];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('FROM "ql3"."api_credentials" AS credential')) {
        return {
          rows: [
            {
              version: 2,
              state: options.credentialState ?? 'active',
              subjectType: 'api_app',
              subjectId: 'workflow-operator',
              subjectStatus: 'active',
              notBeforeAtMs: 1,
              expiresAtMs: 10_000,
              nowMs: 3_100,
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."projects"')) {
        return { rows: [{ status: 'active', version: 3 }] };
      }
      if (text.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: 7 }] };
      }
      if (
        text.includes('plugin_package_workflow_admissions" AS admission') &&
        text.includes('run.event_sequence AS "headSequence"')
      ) {
        return options.missing
          ? { rows: [] }
          : { rows: [{ headSequence: options.headSequence ?? rows.length }] };
      }
      if (
        text.includes('SELECT id AS "id"') &&
        text.includes('FROM "ql3"."run_events"')
      ) {
        return { rows };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      query: client.query.bind(client),
      async connect() {
        return client;
      },
    },
    queries,
    released: () => released,
  };
}

test('atomically revalidates credential and Project Policy before Workflow admission', async () => {
  const value = fixture();
  const fake = poolFor(value);
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowAdmissionRepository(fake.pool);

  const result = await repository.admitAuthorized(authorized(value.plan));
  assert.equal(result.status, 'created');
  assert.equal(fake.released(), true);
  const credentialIndex = fake.queries.findIndex(({ text }) =>
    text.includes('api_credentials'),
  );
  const policyIndex = fake.queries.findIndex(({ text }) =>
    text.includes('project_role_bindings'),
  );
  const auditIndex = fake.queries.findIndex(({ text }) =>
    text.includes('security_audit_events'),
  );
  const snapshotIndex = fake.queries.findIndex(({ text }) =>
    text.includes('plugin_package_workflow_admission_snapshot'),
  );
  const runIndex = fake.queries.findIndex(({ text }) =>
    text.includes('INSERT INTO "ql3"."runs"'),
  );
  assert.equal(
    credentialIndex < policyIndex &&
      policyIndex < auditIndex &&
      auditIndex < snapshotIndex &&
      snapshotIndex < runIndex,
    true,
  );
  assert.equal(fake.queries.at(-1).text, 'COMMIT');
});

test('rolls back before audit and Run writes when the API credential fence changed', async () => {
  const value = fixture();
  const fake = poolFor(value, 'revoked');
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowAdmissionRepository(fake.pool);

  await assert.rejects(
    repository.admitAuthorized(authorized(value.plan)),
    PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(
    fake.queries.some(({ text }) => text.includes('security_audit_events')),
    false,
  );
  assert.equal(
    fake.queries.some(({ text }) => text.includes('INSERT INTO "ql3"."runs"')),
    false,
  );
  assert.equal(fake.queries.at(-1).text, 'ROLLBACK');
  assert.equal(fake.released(), true);
});

test('reads one low-sensitive Package-bound Workflow Run snapshot behind fresh fences', async () => {
  const value = fixture();
  const fake = inspectionPoolFor(value);
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository(
      fake.pool,
    );

  const result = await repository.inspectRunAuthorized(inspection(value.plan));
  assert.equal(result.found, true);
  assert.equal(result.run.status, 'running');
  assert.equal(result.stepCount, 1);
  assert.equal(result.stepStatusCounts.running, 1);
  assert.equal(
    Object.values(result.stepStatusCounts).reduce((a, b) => a + b, 0),
    1,
  );
  assert.deepEqual(Object.keys(result.run).sort(), [
    'cancelReason',
    'cancelRequestedAtMs',
    'createdAtMs',
    'eventSequence',
    'finishedAtMs',
    'queuedAtMs',
    'startedAtMs',
    'status',
    'version',
  ]);
  const target = fake.queries.find(({ text }) =>
    text.includes('plugin_package_workflow_admissions" AS admission'),
  );
  assert.deepEqual(target.values, [
    value.plan.runId,
    value.plan.target.projectId,
    value.plan.target.packageName,
    value.plan.target.workflowId,
  ]);
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ),
    true,
  );
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('security_audit_events" AS audit'),
    ),
    false,
  );
  assert.equal(fake.queries.at(-1).text, 'COMMIT');
  assert.equal(fake.released(), true);
});

test('masks a cross-target Workflow Run and fails before reads when the credential changed', async () => {
  const value = fixture();
  const missing = inspectionPoolFor(value, { missing: true });
  const missingRepository =
    new PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository(
      missing.pool,
    );
  const masked = await missingRepository.inspectRunAuthorized(
    inspection(value.plan, { packageName: 'another-package' }),
  );
  assert.deepEqual(masked, {
    schema: 'qinglong/plugin-package-workflow-run-inspection@v1',
    found: false,
    projectId: value.plan.target.projectId,
    packageName: 'another-package',
    workflowId: value.plan.target.workflowId,
    runId: value.plan.runId,
    run: null,
    stepCount: null,
    stepStatusCounts: null,
  });

  const revoked = inspectionPoolFor(value, { credentialState: 'revoked' });
  const revokedRepository =
    new PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository(
      revoked.pool,
    );
  await assert.rejects(
    revokedRepository.inspectRunAuthorized(inspection(value.plan)),
    PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(
    revoked.queries.some(({ text }) =>
      text.includes('plugin_package_workflow_admissions" AS admission'),
    ),
    false,
  );
  assert.equal(revoked.queries.at(-1).text, 'ROLLBACK');
  assert.equal(revoked.released(), true);
});

test('lists one newest-first low-sensitive Workflow Run page behind fresh fences', async () => {
  const value = fixture();
  const rows = [
    {
      runId: '123e4567-e89b-42d3-a456-426614174109',
      stepCount: 1,
      admittedAtMs: 3_200,
      runStatus: 'running',
      runVersion: 2,
      eventSequence: 1,
      queuedAtMs: 3_200,
      startedAtMs: 3_210,
      finishedAtMs: null,
      cancelRequestedAtMs: null,
      cancelReason: null,
    },
    {
      runId: value.plan.runId,
      stepCount: 1,
      admittedAtMs: 3_000,
      runStatus: 'queued',
      runVersion: 1,
      eventSequence: 0,
      queuedAtMs: 3_000,
      startedAtMs: null,
      finishedAtMs: null,
      cancelRequestedAtMs: null,
      cancelReason: null,
    },
  ];
  const fake = runListPoolFor(value, { rows });
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowRunListRepository(fake.pool);
  const result = await repository.listRunsAuthorized(runList(value.plan));
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].runId, rows[0].runId);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.next, {
    admittedAtMs: rows[0].admittedAtMs,
    runId: rows[0].runId,
  });
  assert.deepEqual(Object.keys(result.runs[0]).sort(), [
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
  const page = fake.queries.find(({ text }) =>
    text.includes('admission.run_id AS "runId"'),
  );
  assert.deepEqual(page.values, [
    value.plan.target.projectId,
    value.plan.target.packageName,
    value.plan.target.workflowId,
    null,
    null,
    2,
  ]);
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ),
    true,
  );
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('security_audit_events" AS audit'),
    ),
    false,
  );
  assert.equal(fake.queries.at(-1).text, 'COMMIT');
  assert.equal(fake.released(), true);
});

test('returns an empty Workflow Run page and fences revoked credentials before reads', async () => {
  const value = fixture();
  const empty = runListPoolFor(value);
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowRunListRepository(empty.pool);
  const result = await repository.listRunsAuthorized(
    runList(value.plan, { workflowId: 'other' }),
  );
  assert.deepEqual(result, {
    schema: 'qinglong/plugin-package-workflow-run-list@v1',
    projectId: value.plan.target.projectId,
    packageName: value.plan.target.packageName,
    workflowId: 'other',
    after: null,
    runs: [],
    truncated: false,
    next: null,
  });

  const revoked = runListPoolFor(value, { credentialState: 'revoked' });
  const revokedRepository =
    new PostgresAuthorizedPluginPackageWorkflowRunListRepository(revoked.pool);
  await assert.rejects(
    revokedRepository.listRunsAuthorized(runList(value.plan)),
    PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(
    revoked.queries.some(({ text }) =>
      text.includes('admission.run_id AS "runId"'),
    ),
    false,
  );
  assert.equal(revoked.queries.at(-1).text, 'ROLLBACK');
  assert.equal(revoked.released(), true);
});

test('lists one bounded low-sensitive Workflow StepRun page behind fresh fences', async () => {
  const value = fixture();
  const second = {
    id: '123e4567-e89b-42d3-a456-426614174103',
    parentStepRunId: null,
    stepKey: 'summarize',
    kind: 'task',
    required: true,
    status: 'pending',
    version: 1,
    attemptCount: 0,
    readyAtMs: null,
    startedAtMs: null,
    finishedAtMs: null,
    resultCode: null,
    createdAtMs: 3_000,
    updatedAtMs: 3_000,
  };
  const first = {
    id: value.plan.steps[0].stepRunId,
    parentStepRunId: null,
    stepKey: 'run',
    kind: 'task',
    required: true,
    status: 'running',
    version: 2,
    attemptCount: 1,
    readyAtMs: 3_010,
    startedAtMs: 3_020,
    finishedAtMs: null,
    resultCode: null,
    createdAtMs: 3_000,
    updatedAtMs: 3_020,
  };
  const fake = stepRunListPoolFor(value, { rows: [first, second] });
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowStepRunListRepository(fake.pool);

  const result = await repository.listStepRunsAuthorized(
    stepRunList(value.plan),
  );
  assert.equal(result.found, true);
  assert.equal(result.stepRuns.length, 1);
  assert.equal(result.stepRuns[0].stepKey, 'run');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.next, { stepKey: 'run', id: first.id });
  assert.deepEqual(Object.keys(result.stepRuns[0]).sort(), [
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
  const target = fake.queries.find(({ text }) =>
    text.includes('AS "observedStepCount"'),
  );
  assert.deepEqual(target.values, [
    value.plan.runId,
    value.plan.target.projectId,
    value.plan.target.packageName,
    value.plan.target.workflowId,
  ]);
  const page = fake.queries.find(({ text }) =>
    text.includes('SELECT id AS "id"'),
  );
  assert.deepEqual(page.values, [value.plan.runId, null, '', 2]);
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ),
    true,
  );
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('security_audit_events" AS audit'),
    ),
    false,
  );
  assert.equal(fake.queries.at(-1).text, 'COMMIT');
  assert.equal(fake.released(), true);
});

test('masks a cross-target Workflow StepRun page and fences revoked credentials before reads', async () => {
  const value = fixture();
  const missing = stepRunListPoolFor(value, { missing: true });
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowStepRunListRepository(
      missing.pool,
    );
  const result = await repository.listStepRunsAuthorized(
    stepRunList(value.plan, { packageName: 'another-package' }),
  );
  assert.deepEqual(result, {
    schema: 'qinglong/plugin-package-workflow-step-run-list@v1',
    found: false,
    projectId: value.plan.target.projectId,
    packageName: 'another-package',
    workflowId: value.plan.target.workflowId,
    runId: value.plan.runId,
    stepRuns: [],
    truncated: false,
    next: null,
  });
  assert.equal(
    missing.queries.some(({ text }) => text.includes('SELECT id AS "id"')),
    false,
  );

  const revoked = stepRunListPoolFor(value, { credentialState: 'revoked' });
  const revokedRepository =
    new PostgresAuthorizedPluginPackageWorkflowStepRunListRepository(
      revoked.pool,
    );
  await assert.rejects(
    revokedRepository.listStepRunsAuthorized(stepRunList(value.plan)),
    PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(
    revoked.queries.some(({ text }) => text.includes('AS "observedStepCount"')),
    false,
  );
  assert.equal(revoked.queries.at(-1).text, 'ROLLBACK');
  assert.equal(revoked.released(), true);
});

test('lists one bounded content-free Workflow RunEvent page behind fresh fences', async () => {
  const value = fixture();
  const rows = [
    {
      id: '123e4567-e89b-42d3-a456-426614174104',
      sequence: 1,
      type: 'workflow.admitted',
      stepRunId: null,
      createdAtMs: 3_000,
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174105',
      sequence: 2,
      type: 'workflow.task_attempt_admitted',
      stepRunId: value.plan.steps[0].stepRunId,
      createdAtMs: 3_100,
    },
  ];
  const fake = runEventListPoolFor(value, { rows, headSequence: 3 });
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowRunEventListRepository(
      fake.pool,
    );
  const result = await repository.listRunEventsAuthorized(
    runEventList(value.plan),
  );
  assert.equal(result.found, true);
  assert.equal(result.headSequence, 3);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'workflow.admitted');
  assert.equal(result.truncated, true);
  assert.equal(result.nextAfterSequence, 1);
  assert.deepEqual(Object.keys(result.events[0]).sort(), [
    'createdAtMs',
    'id',
    'sequence',
    'stepRunId',
    'type',
  ]);
  const target = fake.queries.find(({ text }) =>
    text.includes('run.event_sequence AS "headSequence"'),
  );
  assert.deepEqual(target.values, [
    value.plan.runId,
    value.plan.target.projectId,
    value.plan.target.packageName,
    value.plan.target.workflowId,
  ]);
  const page = fake.queries.find(({ text }) =>
    text.includes('FROM "ql3"."run_events"'),
  );
  assert.deepEqual(page.values, [value.plan.runId, 0, 2]);
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ),
    true,
  );
  assert.equal(
    fake.queries.some(({ text }) =>
      text.includes('security_audit_events" AS audit'),
    ),
    false,
  );
  assert.equal(fake.queries.at(-1).text, 'COMMIT');
  assert.equal(fake.released(), true);
});

test('masks a cross-target Workflow RunEvent page and fences revoked credentials before reads', async () => {
  const value = fixture();
  const missing = runEventListPoolFor(value, { missing: true });
  const repository =
    new PostgresAuthorizedPluginPackageWorkflowRunEventListRepository(
      missing.pool,
    );
  const result = await repository.listRunEventsAuthorized(
    runEventList(value.plan, { packageName: 'another-package' }),
  );
  assert.deepEqual(result, {
    schema: 'qinglong/plugin-package-workflow-run-event-list@v1',
    found: false,
    projectId: value.plan.target.projectId,
    packageName: 'another-package',
    workflowId: value.plan.target.workflowId,
    runId: value.plan.runId,
    afterSequence: 0,
    headSequence: null,
    events: [],
    truncated: false,
    nextAfterSequence: null,
  });
  assert.equal(
    missing.queries.some(({ text }) =>
      text.includes('FROM "ql3"."run_events"'),
    ),
    false,
  );

  const revoked = runEventListPoolFor(value, {
    credentialState: 'revoked',
  });
  const revokedRepository =
    new PostgresAuthorizedPluginPackageWorkflowRunEventListRepository(
      revoked.pool,
    );
  await assert.rejects(
    revokedRepository.listRunEventsAuthorized(runEventList(value.plan)),
    PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(
    revoked.queries.some(({ text }) =>
      text.includes('run.event_sequence AS "headSequence"'),
    ),
    false,
  );
  assert.equal(revoked.queries.at(-1).text, 'ROLLBACK');
  assert.equal(revoked.released(), true);
});
