const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackageWorkflowAdministrationMutationError,
  PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
  normalizeAuthorizedPluginPackageWorkflowAdmission,
  normalizeAuthorizedPluginPackageWorkflowCancellation,
  normalizeAuthorizedPluginPackageWorkflowRunEventList,
  normalizeAuthorizedPluginPackageWorkflowRunInspection,
  normalizeAuthorizedPluginPackageWorkflowRunList,
  normalizeAuthorizedPluginPackageWorkflowStepRunList,
  normalizePluginPackageWorkflowCancellationResult,
  normalizePluginPackageWorkflowRunEventListResult,
  normalizePluginPackageWorkflowRunInspectionResult,
  normalizePluginPackageWorkflowRunListResult,
  normalizePluginPackageWorkflowStepRunListResult,
} = require('@qinglong/runtime-core/plugin-package-workflow-administration');
const {
  createInitialPluginPackageAutomationPublication,
} = require('../dist/plugin-package/pluginPackageAutomationPublication');
const {
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

test('binds Workflow administration to one exact allowed audit and explicit subpath', () => {
  const value = pluginPackageTaskReconciliationFixture(
    'workflow-administration',
    {
      workflows: [
        {
          schema: 'qinglong/plugin-package-workflow-resource@v1',
          id: 'daily',
          name: 'Daily workflow',
          enabled: true,
          steps: [{ id: 'collect', task: 'alpha', needs: [] }],
        },
      ],
    },
  );
  const plan = createPluginPackageWorkflowExecutionPlan({
    planId: 'workflow-administration-plan',
    runId: 'workflow-administration-run',
    workflowId: 'daily',
    stepRunIds: { collect: 'workflow-administration-step' },
    publication: createInitialPluginPackageAutomationPublication(
      value.revision,
      value.registry,
      2_000,
    ),
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
  });
  const admission = {
    plan,
    actor: { type: 'user', id: 'workflow-owner' },
    fence: { projectVersion: 2, bindingVersion: 3 },
    audit: {
      eventId: '00000000-0000-4000-8000-000000000001',
      requestId: 'workflow-administration-request',
      operationId: 'workflow.start',
      projectId: plan.target.projectId,
      subject: { type: 'user', id: 'workflow-owner' },
      authenticationId: 'workflow-administration-authentication',
      outcome: 'allowed',
      reasons: ['permission_granted'],
      fence: { projectVersion: 2, bindingVersion: 3 },
      occurredAtMs: plan.plannedAtMs,
    },
  };

  assert.deepEqual(
    normalizeAuthorizedPluginPackageWorkflowAdmission(admission),
    admission,
  );
  assert.throws(
    () =>
      normalizeAuthorizedPluginPackageWorkflowAdmission({
        ...admission,
        audit: { ...admission.audit, operationId: 'workflow.read' },
      }),
    InvalidPluginPackageWorkflowAdministrationMutationError,
  );
  assert.throws(
    () =>
      normalizeAuthorizedPluginPackageWorkflowAdmission({
        ...admission,
        fence: { ...admission.fence, bindingVersion: 4 },
      }),
    InvalidPluginPackageWorkflowAdministrationMutationError,
  );

  const subpath = require('@qinglong/runtime-core/plugin-package-workflow-administration');
  const root = require('../dist');
  assert.equal(
    subpath.normalizeAuthorizedPluginPackageWorkflowAdmission,
    normalizeAuthorizedPluginPackageWorkflowAdmission,
  );
  assert.equal(
    root.normalizeAuthorizedPluginPackageWorkflowAdmission,
    undefined,
  );
});

test('binds Workflow cancellation to run.stop audit identity and low-sensitive result', () => {
  const cancellation = {
    projectId: 'project-1',
    packageName: 'example-package',
    runId: '95000000-0000-4000-8000-000000000001',
    mutationId: '9a000000-0000-4000-8000-000000000001',
    runEventId: '9b000000-0000-4000-8000-000000000001',
    actor: { type: 'user', id: 'workflow-owner' },
    fence: { projectVersion: 2, bindingVersion: 3 },
    audit: {
      eventId: '9c000000-0000-4000-8000-000000000001',
      requestId: 'workflow-cancel-1',
      operationId: 'workflow.cancel',
      projectId: 'project-1',
      subject: { type: 'user', id: 'workflow-owner' },
      authenticationId: 'workflow-administration-authentication',
      outcome: 'allowed',
      reasons: ['permission_granted'],
      fence: { projectVersion: 2, bindingVersion: 3 },
      occurredAtMs: 4_000,
    },
  };
  assert.deepEqual(
    normalizeAuthorizedPluginPackageWorkflowCancellation(cancellation),
    cancellation,
  );
  assert.throws(
    () =>
      normalizeAuthorizedPluginPackageWorkflowCancellation({
        ...cancellation,
        audit: { ...cancellation.audit, operationId: 'workflow.start' },
      }),
    InvalidPluginPackageWorkflowAdministrationMutationError,
  );
  assert.deepEqual(
    normalizePluginPackageWorkflowCancellationResult({
      status: 'accepted',
      projectId: cancellation.projectId,
      packageName: cancellation.packageName,
      workflowId: 'daily',
      runId: cancellation.runId,
      runStatus: 'running',
      runVersion: 5,
      eventSequence: 5,
      cancelRequestedAtMs: 4_000,
      cancelReason: 'user',
    }),
    {
      status: 'accepted',
      projectId: cancellation.projectId,
      packageName: cancellation.packageName,
      workflowId: 'daily',
      runId: cancellation.runId,
      runStatus: 'running',
      runVersion: 5,
      eventSequence: 5,
      cancelRequestedAtMs: 4_000,
      cancelReason: 'user',
    },
  );
});

test('binds Workflow Run inspection to an exact allowed audit fence and target', () => {
  const inspection = {
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000002',
    actor: { type: 'user', id: 'workflow-owner' },
    fence: { projectVersion: 2, bindingVersion: 3 },
    audit: {
      eventId: '9c000000-0000-4000-8000-000000000002',
      requestId: 'workflow-inspect-1',
      operationId: 'workflow.run.read',
      projectId: 'project-1',
      subject: { type: 'user', id: 'workflow-owner' },
      authenticationId: 'workflow-administration-authentication',
      outcome: 'allowed',
      reasons: ['permission_granted'],
      fence: { projectVersion: 2, bindingVersion: 3 },
      occurredAtMs: 4_000,
    },
  };

  assert.deepEqual(
    normalizeAuthorizedPluginPackageWorkflowRunInspection(inspection),
    inspection,
  );
  for (const invalid of [
    {
      ...inspection,
      audit: { ...inspection.audit, operationId: 'workflow.read' },
    },
    {
      ...inspection,
      audit: { ...inspection.audit, projectId: 'project-2' },
    },
    {
      ...inspection,
      fence: { ...inspection.fence, bindingVersion: 4 },
    },
    { ...inspection, workflowId: 'Daily' },
    { ...inspection, unexpected: true },
  ]) {
    assert.throws(
      () => normalizeAuthorizedPluginPackageWorkflowRunInspection(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});

test('normalizes a low-sensitive Workflow Run inspection projection and missing target', () => {
  const target = {
    schema: PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000002',
  };
  const stepStatusCounts = {
    pending: 0,
    ready: 1,
    waiting_approval: 0,
    running: 1,
    lost: 0,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    timed_out: 0,
  };
  const found = {
    ...target,
    found: true,
    run: {
      status: 'running',
      version: 4,
      eventSequence: 3,
      createdAtMs: 1_000,
      queuedAtMs: 1_100,
      startedAtMs: 1_200,
      finishedAtMs: null,
      cancelRequestedAtMs: 1_300,
      cancelReason: 'user',
    },
    stepCount: 3,
    stepStatusCounts,
  };
  const normalized = normalizePluginPackageWorkflowRunInspectionResult(found);
  assert.deepEqual(normalized, found);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.run));
  assert.ok(Object.isFrozen(normalized.stepStatusCounts));

  assert.deepEqual(
    normalizePluginPackageWorkflowRunInspectionResult({
      ...target,
      found: false,
      run: null,
      stepCount: null,
      stepStatusCounts: null,
    }),
    {
      ...target,
      found: false,
      run: null,
      stepCount: null,
      stepStatusCounts: null,
    },
  );

  for (const invalid of [
    { ...found, unexpected: true },
    { ...found, stepCount: 4 },
    {
      ...found,
      run: { ...found.run, cancelRequestedAtMs: null },
    },
    {
      ...found,
      stepStatusCounts: { ...stepStatusCounts, unknown: 0 },
    },
    {
      ...target,
      found: false,
      run: found.run,
      stepCount: null,
      stepStatusCounts: null,
    },
  ]) {
    assert.throws(
      () => normalizePluginPackageWorkflowRunInspectionResult(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});

test('binds a bounded Workflow Run list to run.read authority and a newest-first cursor', () => {
  const query = {
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    limit: 32,
    after: {
      admittedAtMs: 2_000,
      runId: '95000000-0000-4000-8000-000000000012',
    },
    actor: { type: 'user', id: 'workflow-owner' },
    fence: { projectVersion: 2, bindingVersion: 3 },
    audit: {
      eventId: '9c000000-0000-4000-8000-000000000012',
      requestId: 'workflow-run-list-1',
      operationId: 'workflow.run.list',
      projectId: 'project-1',
      subject: { type: 'user', id: 'workflow-owner' },
      authenticationId: 'workflow-administration-authentication',
      outcome: 'allowed',
      reasons: ['permission_granted'],
      fence: { projectVersion: 2, bindingVersion: 3 },
      occurredAtMs: 4_000,
    },
  };
  assert.deepEqual(normalizeAuthorizedPluginPackageWorkflowRunList(query), query);
  for (const invalid of [
    { ...query, limit: 65 },
    { ...query, after: { admittedAtMs: -1, runId: query.after.runId } },
    { ...query, audit: { ...query.audit, operationId: 'workflow.run.read' } },
    { ...query, unexpected: true },
  ]) {
    assert.throws(
      () => normalizeAuthorizedPluginPackageWorkflowRunList(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});

test('normalizes only a low-sensitive newest-first Workflow Run page', () => {
  const target = {
    schema: PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA,
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    after: null,
  };
  const runs = [
    {
      runId: '95000000-0000-4000-8000-000000000012',
      status: 'running',
      version: 2,
      eventSequence: 1,
      stepCount: 2,
      admittedAtMs: 2_000,
      queuedAtMs: 2_001,
      startedAtMs: 2_002,
      finishedAtMs: null,
      cancelRequestedAtMs: null,
      cancelReason: null,
    },
    {
      runId: '95000000-0000-4000-8000-000000000011',
      status: 'queued',
      version: 1,
      eventSequence: 0,
      stepCount: 1,
      admittedAtMs: 2_000,
      queuedAtMs: 2_000,
      startedAtMs: null,
      finishedAtMs: null,
      cancelRequestedAtMs: null,
      cancelReason: null,
    },
  ];
  const page = {
    ...target,
    runs,
    truncated: true,
    next: { admittedAtMs: 2_000, runId: runs[1].runId },
  };
  const normalized = normalizePluginPackageWorkflowRunListResult(page);
  assert.deepEqual(normalized, page);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.runs));
  assert.ok(Object.isFrozen(normalized.runs[0]));
  assert.deepEqual(
    normalizePluginPackageWorkflowRunListResult({
      ...target,
      runs: [],
      truncated: false,
      next: null,
    }),
    { ...target, runs: [], truncated: false, next: null },
  );
  for (const invalid of [
    { ...page, runs: [...runs].reverse() },
    { ...page, next: { admittedAtMs: 2_000, runId: runs[0].runId } },
    {
      ...page,
      runs: [{ ...runs[0], planDigest: 'private' }],
      truncated: false,
      next: null,
    },
    { ...page, unexpected: true },
  ]) {
    assert.throws(
      () => normalizePluginPackageWorkflowRunListResult(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});

test('binds a bounded Workflow StepRun list to run.read authority and a keyset cursor', () => {
  const query = {
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000003',
    limit: 32,
    after: {
      stepKey: 'collect',
      id: '95000000-0000-4000-8000-000000000004',
    },
    actor: { type: 'user', id: 'workflow-owner' },
    fence: { projectVersion: 2, bindingVersion: 3 },
    audit: {
      eventId: '9c000000-0000-4000-8000-000000000003',
      requestId: 'workflow-step-list-1',
      operationId: 'workflow.step.list',
      projectId: 'project-1',
      subject: { type: 'user', id: 'workflow-owner' },
      authenticationId: 'workflow-administration-authentication',
      outcome: 'allowed',
      reasons: ['permission_granted'],
      fence: { projectVersion: 2, bindingVersion: 3 },
      occurredAtMs: 4_000,
    },
  };
  assert.deepEqual(
    normalizeAuthorizedPluginPackageWorkflowStepRunList(query),
    query,
  );
  for (const invalid of [
    { ...query, limit: 65 },
    { ...query, after: { stepKey: 'collect' } },
    {
      ...query,
      audit: { ...query.audit, operationId: 'workflow.run.read' },
    },
    { ...query, unexpected: true },
  ]) {
    assert.throws(
      () => normalizeAuthorizedPluginPackageWorkflowStepRunList(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});

test('normalizes only the low-sensitive ordered Workflow StepRun page', () => {
  const target = {
    schema: PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000003',
  };
  const stepRuns = [
    {
      id: '95000000-0000-4000-8000-000000000004',
      parentStepRunId: null,
      stepKey: 'collect',
      kind: 'task',
      required: true,
      status: 'ready',
      version: 1,
      attemptCount: 0,
      readyAtMs: 1_100,
      startedAtMs: null,
      finishedAtMs: null,
      resultCode: null,
      createdAtMs: 1_000,
      updatedAtMs: 1_100,
    },
    {
      id: '95000000-0000-4000-8000-000000000005',
      parentStepRunId: null,
      stepKey: 'summarize',
      kind: 'task',
      required: true,
      status: 'running',
      version: 2,
      attemptCount: 1,
      readyAtMs: 1_100,
      startedAtMs: 1_200,
      finishedAtMs: null,
      resultCode: null,
      createdAtMs: 1_000,
      updatedAtMs: 1_200,
    },
  ];
  const found = {
    ...target,
    found: true,
    stepRuns,
    truncated: true,
    next: { stepKey: 'summarize', id: stepRuns[1].id },
  };
  const normalized = normalizePluginPackageWorkflowStepRunListResult(found);
  assert.deepEqual(normalized, found);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.stepRuns));
  assert.ok(Object.isFrozen(normalized.stepRuns[0]));
  assert.ok(Object.isFrozen(normalized.next));
  assert.deepEqual(
    normalizePluginPackageWorkflowStepRunListResult({
      ...target,
      found: false,
      stepRuns: [],
      truncated: false,
      next: null,
    }),
    {
      ...target,
      found: false,
      stepRuns: [],
      truncated: false,
      next: null,
    },
  );
  for (const invalid of [
    { ...found, next: { stepKey: 'collect', id: stepRuns[0].id } },
    { ...found, stepRuns: [...stepRuns].reverse() },
    {
      ...found,
      stepRuns: [{ ...stepRuns[0], inputRef: 'artifact:private' }],
      truncated: false,
      next: null,
    },
    { ...found, unexpected: true },
  ]) {
    assert.throws(
      () => normalizePluginPackageWorkflowStepRunListResult(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});

test('binds a bounded Workflow RunEvent list to run.read and a sequence cursor', () => {
  const query = {
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000006',
    limit: 32,
    afterSequence: 4,
    actor: { type: 'user', id: 'workflow-owner' },
    fence: { projectVersion: 2, bindingVersion: 3 },
    audit: {
      eventId: '9c000000-0000-4000-8000-000000000004',
      requestId: 'workflow-event-list-1',
      operationId: 'workflow.event.list',
      projectId: 'project-1',
      subject: { type: 'user', id: 'workflow-owner' },
      authenticationId: 'workflow-administration-authentication',
      outcome: 'allowed',
      reasons: ['permission_granted'],
      fence: { projectVersion: 2, bindingVersion: 3 },
      occurredAtMs: 4_000,
    },
  };
  assert.deepEqual(
    normalizeAuthorizedPluginPackageWorkflowRunEventList(query),
    query,
  );
  for (const invalid of [
    { ...query, limit: 65 },
    { ...query, afterSequence: -1 },
    {
      ...query,
      audit: { ...query.audit, operationId: 'workflow.run.read' },
    },
    { ...query, unexpected: true },
  ]) {
    assert.throws(
      () => normalizeAuthorizedPluginPackageWorkflowRunEventList(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});

test('normalizes only a contiguous content-free Workflow RunEvent page', () => {
  const target = {
    schema: PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
    projectId: 'project-1',
    packageName: 'example-package',
    workflowId: 'daily',
    runId: '95000000-0000-4000-8000-000000000006',
    afterSequence: 1,
  };
  const events = [
    {
      id: '95000000-0000-4000-8000-000000000007',
      sequence: 2,
      type: 'workflow.task_attempt_admitted',
      stepRunId: '95000000-0000-4000-8000-000000000004',
      createdAtMs: 1_100,
    },
    {
      id: '95000000-0000-4000-8000-000000000008',
      sequence: 3,
      type: 'workflow.task_attempt.running',
      stepRunId: '95000000-0000-4000-8000-000000000004',
      createdAtMs: 1_200,
    },
  ];
  const found = {
    ...target,
    found: true,
    headSequence: 4,
    events,
    truncated: true,
    nextAfterSequence: 3,
  };
  const normalized = normalizePluginPackageWorkflowRunEventListResult(found);
  assert.deepEqual(normalized, found);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.events));
  assert.ok(Object.isFrozen(normalized.events[0]));
  assert.deepEqual(
    normalizePluginPackageWorkflowRunEventListResult({
      ...target,
      found: false,
      headSequence: null,
      events: [],
      truncated: false,
      nextAfterSequence: null,
    }),
    {
      ...target,
      found: false,
      headSequence: null,
      events: [],
      truncated: false,
      nextAfterSequence: null,
    },
  );
  for (const invalid of [
    { ...found, nextAfterSequence: 2 },
    { ...found, events: [{ ...events[0], sequence: 3 }, events[1]] },
    {
      ...found,
      events: [{ ...events[0], payload: { secret: 'private' } }],
      headSequence: 2,
      truncated: false,
      nextAfterSequence: null,
    },
    {
      ...found,
      headSequence: 3,
      truncated: false,
      nextAfterSequence: null,
      events: [events[0]],
    },
  ]) {
    assert.throws(
      () => normalizePluginPackageWorkflowRunEventListResult(invalid),
      InvalidPluginPackageWorkflowAdministrationMutationError,
    );
  }
});
