const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowAdmissionBundle,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  createClusterPluginPackageWorkflowAdministrationCapability,
} = require('@qinglong/cluster-control/workflow-administration');
const {
  createClusterControlPluginPackageWorkflowRoutes,
} = require('@qinglong/cluster-control/workflow-routes');

const IDS = Object.freeze({
  planId: '123e4567-e89b-42d3-a456-426614174000',
  runId: '123e4567-e89b-42d3-a456-426614174001',
  collect: '123e4567-e89b-42d3-a456-426614174002',
  summarize: '123e4567-e89b-42d3-a456-426614174003',
});

function productFixture() {
  const value = pluginPackageTaskReconciliationFixture('cluster-product', {
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
  });
  return {
    ...value,
    publication: createInitialPluginPackageAutomationPublication(
      value.revision,
      value.registry,
      2_000,
    ),
  };
}

function principal(now = 3_000) {
  return Object.freeze({
    subject: { type: 'api_app', id: 'workflow-operator' },
    authenticationId: 'api_credential:workflow-product:1',
    authenticatedAtMs: now - 1,
    expiresAtMs: now + 60_000,
    assurance: 'service',
  });
}

test('derives the cluster Workflow plan from current server publications and exactly replays it', async () => {
  const value = productFixture();
  let storedPlan = null;
  let cancellationCommand;
  let inspectionCommand;
  let runListCommand;
  let stepListCommand;
  let runEventListCommand;
  const admissions = [];
  const capability = createClusterPluginPackageWorkflowAdministrationCapability(
    {
      async findCurrent(projectId, packageName) {
        assert.equal(projectId, value.projectId);
        assert.equal(packageName, value.packageName);
        return value.publication;
      },
    },
    {
      async find(generationDigest) {
        assert.equal(
          generationDigest,
          value.revision.generation.generationDigest,
        );
        return value.revision;
      },
    },
    {
      async findPlanByPlanId(planId) {
        assert.equal(planId, IDS.planId);
        return storedPlan;
      },
      async admitAuthorized(admission) {
        admissions.push(admission);
        const bundle = createPluginPackageWorkflowAdmissionBundle(
          admission.plan,
        );
        const status = storedPlan ? 'existing' : 'created';
        storedPlan = admission.plan;
        return { status, receipt: bundle.receipt };
      },
    },
    {
      async inspectRunAuthorized(command) {
        inspectionCommand = command;
        return {
          schema: 'qinglong/plugin-package-workflow-run-inspection@v1',
          found: false,
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          runId: command.runId,
          run: null,
          stepCount: null,
          stepStatusCounts: null,
        };
      },
    },
    {
      async listRunsAuthorized(command) {
        runListCommand = command;
        return {
          schema: 'qinglong/plugin-package-workflow-run-list@v1',
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          after: command.after,
          runs: [],
          truncated: false,
          next: null,
        };
      },
    },
    {
      async listStepRunsAuthorized(command) {
        stepListCommand = command;
        return {
          schema: 'qinglong/plugin-package-workflow-step-run-list@v1',
          found: false,
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          runId: command.runId,
          stepRuns: [],
          truncated: false,
          next: null,
        };
      },
    },
    {
      async listRunEventsAuthorized(command) {
        runEventListCommand = command;
        return {
          schema: 'qinglong/plugin-package-workflow-run-event-list@v1',
          found: false,
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          runId: command.runId,
          afterSequence: command.afterSequence,
          headSequence: null,
          events: [],
          truncated: false,
          nextAfterSequence: null,
        };
      },
    },
    {
      async requestUserCancellation(command) {
        cancellationCommand = command;
        return {
          status: 'accepted',
          projectId: command.projectId,
          runId: command.runId,
          runStatus: 'running',
          runVersion: 4,
          eventSequence: 4,
          cancelRequestedAtMs: 3_100,
          cancelReason: 'user',
        };
      },
    },
    value.registry,
  );

  const listed = await capability.inspect(value.projectId, value.packageName);
  assert.equal(listed.found, true);
  assert.deepEqual(listed.workflows[0].steps, [
    { id: 'collect', task: 'alpha', needs: [] },
    { id: 'summarize', task: 'beta', needs: ['collect'] },
  ]);

  const command = {
    projectId: value.projectId,
    packageName: value.packageName,
    workflowId: 'daily',
    planId: IDS.planId,
    runId: IDS.runId,
    stepRunIds: { collect: IDS.collect, summarize: IDS.summarize },
    principal: principal(),
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    plannedAtMs: 3_000,
  };
  const created = await capability.start(command);
  const replay = await capability.start({ ...command, plannedAtMs: 9_000 });
  assert.equal(created.status, 'created');
  assert.equal(replay.status, 'existing');
  assert.equal(replay.plan.planDigest, created.plan.planDigest);
  assert.equal(
    created.plan.target.publicationDigest,
    value.publication.publicationDigest,
  );
  assert.equal(admissions[0].audit.eventId, IDS.planId);
  assert.equal(admissions[0].audit.requestId, IDS.planId);
  assert.equal(
    admissions[0].audit.authenticationId,
    principal().authenticationId,
  );
  assert.equal(admissions[1].audit.occurredAtMs, created.plan.plannedAtMs);

  assert.equal(
    (
      await capability.cancel({
        projectId: value.projectId,
        packageName: value.packageName,
        workflowId: 'daily',
        runId: IDS.runId,
        mutationId: 'workflow-cancel-mutation-1',
        eventId: '018f0000-0000-7000-8000-000000000091',
        principal: principal(),
        policyFence: { projectVersion: 3, bindingVersion: 7 },
      })
    ).status,
    'accepted',
  );
  assert.deepEqual(cancellationCommand.workflowTarget, {
    packageName: value.packageName,
    workflowId: 'daily',
  });
  const inspected = await capability.inspectRun({
    projectId: value.projectId,
    packageName: value.packageName,
    workflowId: 'daily',
    runId: IDS.runId,
    requestId: 'workflow-run-read-request-1',
    auditEventId: '123e4567-e89b-42d3-a456-426614174093',
    principal: principal(),
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    observedAtMs: 3_200,
  });
  assert.equal(inspected.found, false);
  assert.equal(inspectionCommand.audit.operationId, 'workflow.run.read');
  assert.equal(
    inspectionCommand.audit.requestId,
    'workflow-run-read-request-1',
  );
  assert.deepEqual(inspectionCommand.fence, {
    projectVersion: 3,
    bindingVersion: 7,
  });
  const runPage = await capability.listRuns({
    projectId: value.projectId,
    packageName: value.packageName,
    workflowId: 'daily',
    limit: 16,
    after: { admittedAtMs: 3_100, runId: IDS.runId },
    requestId: 'workflow-run-list-request-1',
    auditEventId: '123e4567-e89b-42d3-a456-426614174096',
    principal: principal(),
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    observedAtMs: 3_250,
  });
  assert.deepEqual(runPage.runs, []);
  assert.equal(runListCommand.audit.operationId, 'workflow.run.list');
  assert.equal(runListCommand.limit, 16);
  assert.deepEqual(runListCommand.after, {
    admittedAtMs: 3_100,
    runId: IDS.runId,
  });
  const stepPage = await capability.listStepRuns({
    projectId: value.projectId,
    packageName: value.packageName,
    workflowId: 'daily',
    runId: IDS.runId,
    limit: 16,
    after: { stepKey: 'collect', id: IDS.collect },
    requestId: 'workflow-step-list-request-1',
    auditEventId: '123e4567-e89b-42d3-a456-426614174094',
    principal: principal(),
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    observedAtMs: 3_300,
  });
  assert.equal(stepPage.found, false);
  assert.equal(stepListCommand.audit.operationId, 'workflow.step.list');
  assert.equal(stepListCommand.limit, 16);
  assert.deepEqual(stepListCommand.after, {
    stepKey: 'collect',
    id: IDS.collect,
  });
  const eventPage = await capability.listRunEvents({
    projectId: value.projectId,
    packageName: value.packageName,
    workflowId: 'daily',
    runId: IDS.runId,
    limit: 16,
    afterSequence: 2,
    requestId: 'workflow-event-list-request-1',
    auditEventId: '123e4567-e89b-42d3-a456-426614174095',
    principal: principal(),
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    observedAtMs: 3_400,
  });
  assert.equal(eventPage.found, false);
  assert.equal(runEventListCommand.audit.operationId, 'workflow.event.list');
  assert.equal(runEventListCommand.limit, 16);
  assert.equal(runEventListCommand.afterSequence, 2);
});

test('publishes strict authenticated list and content-free start routes', async () => {
  let startCommand;
  let cancellationError;
  const routes = createClusterControlPluginPackageWorkflowRoutes(
    {
      async inspect() {
        return { found: false, publicationState: null, workflows: [] };
      },
      async inspectRun(command) {
        return {
          schema: 'qinglong/plugin-package-workflow-run-inspection@v1',
          found: true,
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          runId: command.runId,
          run: {
            status: 'running',
            version: 4,
            eventSequence: 4,
            createdAtMs: 3_000,
            queuedAtMs: 3_010,
            startedAtMs: 3_020,
            finishedAtMs: null,
            cancelRequestedAtMs: null,
            cancelReason: null,
          },
          stepCount: 1,
          stepStatusCounts: {
            pending: 0,
            ready: 0,
            waiting_approval: 0,
            running: 1,
            lost: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            cancelled: 0,
            timed_out: 0,
          },
        };
      },
      async listRuns(command) {
        return {
          schema: 'qinglong/plugin-package-workflow-run-list@v1',
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          after: command.after,
          runs: [
            {
              runId: IDS.runId,
              status: 'running',
              version: 4,
              eventSequence: 4,
              stepCount: 2,
              admittedAtMs: 3_000,
              queuedAtMs: 3_010,
              startedAtMs: 3_020,
              finishedAtMs: null,
              cancelRequestedAtMs: null,
              cancelReason: null,
            },
          ],
          truncated: true,
          next: { admittedAtMs: 3_000, runId: IDS.runId },
        };
      },
      async listStepRuns(command) {
        return {
          schema: 'qinglong/plugin-package-workflow-step-run-list@v1',
          found: true,
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          runId: command.runId,
          stepRuns: [
            {
              id: IDS.collect,
              parentStepRunId: null,
              stepKey: 'collect',
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
          ],
          truncated: true,
          next: { stepKey: 'collect', id: IDS.collect },
        };
      },
      async listRunEvents(command) {
        return {
          schema: 'qinglong/plugin-package-workflow-run-event-list@v1',
          found: true,
          projectId: command.projectId,
          packageName: command.packageName,
          workflowId: command.workflowId,
          runId: command.runId,
          afterSequence: command.afterSequence,
          headSequence: 4,
          events: [
            {
              id: '123e4567-e89b-42d3-a456-426614174004',
              sequence: 3,
              type: 'workflow.task_attempt.running',
              stepRunId: IDS.collect,
              createdAtMs: 3_020,
            },
          ],
          truncated: true,
          nextAfterSequence: 3,
        };
      },
      async start(command) {
        startCommand = command;
        return {
          status: 'created',
          plan: { planId: command.planId, runId: command.runId },
          receipt: { receiptDigest: 'a'.repeat(64) },
        };
      },
      async cancel(command) {
        if (cancellationError) {
          throw cancellationError;
        }
        return {
          status: 'accepted',
          projectId: command.projectId,
          runId: command.runId,
          runStatus: 'running',
          runVersion: 4,
          eventSequence: 4,
          cancelRequestedAtMs: 3_100,
          cancelReason: 'user',
        };
      },
    },
    () => 3_000,
    () => '123e4567-e89b-42d3-a456-426614174092',
  );
  const start = routes.find(
    ({ operationId }) => operationId === 'workflow.start',
  );
  assert.ok(start);
  const authorized = {
    request: {
      requestId: 'transport-request-1',
      body: {
        schema: 'qinglong/cluster-plugin-package-workflow-start-request@v1',
        planId: IDS.planId,
        runId: IDS.runId,
        stepRunIds: { collect: IDS.collect },
      },
      signal: new AbortController().signal,
    },
    principal: principal(),
    operationId: 'workflow.start',
    permission: 'run.start',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
  };
  const result = await start.handle(authorized, {
    packageName: 'example',
    workflowId: 'daily',
  });
  assert.equal(result.statusCode, 201);
  assert.deepEqual(Object.keys(result.body).sort(), [
    'planId',
    'receiptDigest',
    'replayed',
    'runId',
    'schema',
    'status',
  ]);
  assert.equal(startCommand.principal.subject.id, 'workflow-operator');
  assert.equal(startCommand.plannedAtMs, 3_000);

  const inspectRun = routes.find(
    ({ operationId }) => operationId === 'workflow.run.read',
  );
  assert.ok(inspectRun);
  assert.equal(inspectRun.permission, 'run.read');
  const inspected = await inspectRun.handle(
    {
      ...authorized,
      operationId: 'workflow.run.read',
      permission: 'run.read',
      request: { ...authorized.request, body: null },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(inspected.statusCode, 200);
  assert.equal(
    inspected.body.schema,
    'qinglong/plugin-package-workflow-run-inspection@v1',
  );
  assert.deepEqual(Object.keys(inspected.body.run).sort(), [
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

  const listRuns = routes.find(
    ({ operationId }) => operationId === 'workflow.run.list',
  );
  assert.ok(listRuns);
  assert.equal(listRuns.permission, 'run.read');
  assert.deepEqual(listRuns.allowedQuery, [
    'after_admitted_at_ms',
    'after_run_id',
    'limit',
  ]);
  const listedRuns = await listRuns.handle(
    {
      ...authorized,
      operationId: 'workflow.run.list',
      permission: 'run.read',
      request: {
        ...authorized.request,
        body: null,
        query: {
          limit: ['1'],
          after_admitted_at_ms: ['3100'],
          after_run_id: [IDS.runId],
        },
      },
    },
    { packageName: 'example', workflowId: 'daily' },
  );
  assert.equal(listedRuns.statusCode, 200);
  assert.equal(
    listedRuns.body.schema,
    'qinglong/plugin-package-workflow-run-list@v1',
  );
  assert.deepEqual(Object.keys(listedRuns.body.runs[0]).sort(), [
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
  const invalidRunCursor = await listRuns.handle(
    {
      ...authorized,
      request: {
        ...authorized.request,
        body: null,
        query: { after_admitted_at_ms: ['3100'] },
      },
    },
    { packageName: 'example', workflowId: 'daily' },
  );
  assert.equal(invalidRunCursor.statusCode, 400);

  const listSteps = routes.find(
    ({ operationId }) => operationId === 'workflow.step.list',
  );
  assert.ok(listSteps);
  assert.equal(listSteps.permission, 'run.read');
  assert.deepEqual(listSteps.allowedQuery, [
    'after_step_key',
    'after_step_run_id',
    'limit',
  ]);
  const listedSteps = await listSteps.handle(
    {
      ...authorized,
      operationId: 'workflow.step.list',
      permission: 'run.read',
      request: {
        ...authorized.request,
        body: null,
        query: {
          limit: ['1'],
          after_step_key: ['collect'],
          after_step_run_id: [IDS.collect],
        },
      },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(listedSteps.statusCode, 200);
  assert.equal(
    listedSteps.body.schema,
    'qinglong/plugin-package-workflow-step-run-list@v1',
  );
  assert.deepEqual(Object.keys(listedSteps.body.stepRuns[0]).sort(), [
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
  const invalidStepCursor = await listSteps.handle(
    {
      ...authorized,
      request: {
        ...authorized.request,
        body: null,
        query: { after_step_key: ['collect'] },
      },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(invalidStepCursor.statusCode, 400);

  const listEvents = routes.find(
    ({ operationId }) => operationId === 'workflow.event.list',
  );
  assert.ok(listEvents);
  assert.equal(listEvents.permission, 'run.read');
  assert.deepEqual(listEvents.allowedQuery, ['after_sequence', 'limit']);
  const listedEvents = await listEvents.handle(
    {
      ...authorized,
      operationId: 'workflow.event.list',
      permission: 'run.read',
      request: {
        ...authorized.request,
        body: null,
        query: { limit: ['1'], after_sequence: ['2'] },
      },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(listedEvents.statusCode, 200);
  assert.equal(
    listedEvents.body.schema,
    'qinglong/plugin-package-workflow-run-event-list@v1',
  );
  assert.deepEqual(Object.keys(listedEvents.body.events[0]).sort(), [
    'createdAtMs',
    'id',
    'sequence',
    'stepRunId',
    'type',
  ]);
  const invalidEventCursor = await listEvents.handle(
    {
      ...authorized,
      request: {
        ...authorized.request,
        body: null,
        query: { after_sequence: ['02'] },
      },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(invalidEventCursor.statusCode, 400);

  const invalid = await start.handle(
    {
      ...authorized,
      request: {
        ...authorized.request,
        body: { ...authorized.request.body, extra: true },
      },
    },
    { packageName: 'example', workflowId: 'daily' },
  );
  assert.equal(invalid.statusCode, 400);

  const cancellation = routes.find(
    ({ operationId }) => operationId === 'workflow.cancel',
  );
  assert.ok(cancellation);
  const cancelled = await cancellation.handle(
    {
      ...authorized,
      operationId: 'workflow.cancel',
      permission: 'run.stop',
      request: {
        ...authorized.request,
        body: {
          schema: 'qinglong/run-cancellation@v1',
          mutationId: 'workflow-cancel-mutation-1',
        },
      },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(cancelled.statusCode, 202);
  assert.equal(cancelled.body.status, 'accepted');
  assert.deepEqual(
    Object.keys(cancelled.body).sort(),
    [
      'cancelReason',
      'cancelRequestedAtMs',
      'eventSequence',
      'projectId',
      'runId',
      'runStatus',
      'runVersion',
      'schema',
      'status',
    ].sort(),
  );
  const invalidCancellation = await cancellation.handle(
    {
      ...authorized,
      operationId: 'workflow.cancel',
      permission: 'run.stop',
      request: {
        ...authorized.request,
        body: {
          schema: 'qinglong/run-cancellation@v1',
          mutationId: 'workflow-cancel-mutation-1',
          reason: 'shutdown',
        },
      },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(invalidCancellation.statusCode, 400);

  cancellationError = Object.assign(new Error('private adapter detail'), {
    code: 'CLUSTER_RUN_CANCELLATION_FENCE_REJECTED',
    reason: 'private_adapter_detail',
  });
  const closedCancellationFailure = await cancellation.handle(
    {
      ...authorized,
      operationId: 'workflow.cancel',
      permission: 'run.stop',
      request: {
        ...authorized.request,
        body: {
          schema: 'qinglong/run-cancellation@v1',
          mutationId: 'workflow-cancel-mutation-2',
        },
      },
    },
    {
      packageName: 'example',
      workflowId: 'daily',
      runId: IDS.runId,
    },
  );
  assert.equal(closedCancellationFailure.statusCode, 409);
  assert.deepEqual(closedCancellationFailure.body, {
    code: 'workflow_cancellation_fence_rejected',
    reason: 'state_mismatch',
  });
});
