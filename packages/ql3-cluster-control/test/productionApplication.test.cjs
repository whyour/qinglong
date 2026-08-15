const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PRODUCTION_CLUSTER_CONTROL_ROUTE_OPERATIONS,
  PRODUCTION_CLUSTER_CONTROL_OPTIONAL_ROUTE_OPERATIONS,
  createProductionClusterControlApplicationStack,
  startProductionClusterControlApplication,
} = require('@qinglong/cluster-control/production');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');

const EVENT_ID = '123e4567-e89b-42d3-a456-426614174092';

function metadata(path, method = 'GET', body = null, query = {}) {
  return {
    method,
    path,
    query,
    headers: Object.freeze({ authorization: 'Bearer test' }),
    remoteAddress: '127.0.0.1',
    requestId: 'request-production-1',
    signal: new AbortController().signal,
    body,
  };
}

function fixture(overrides = {}) {
  const events = [];
  const currentTask = createTaskDefinitionRecord(
    {
      projectId: 'project-1',
      taskId: 'task-1',
      expectedRevision: null,
      mutationId: '123e4567-e89b-42d3-a456-426614174093',
      name: 'Task 1',
      description: 'private',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: { command: { kind: 'shell', command: 'private' } },
      },
      labels: { private: 'value' },
      enabled: true,
      occurredAtMs: 20,
    },
    10,
  );
  const input = {
    evidence: {
      contractName: 'qinglong-cluster-control',
      contractVersion: 14,
      serverMajor: 16,
      migrationIds: [],
    },
    authenticator: {
      authenticate() {
        events.push('authenticate');
        const now = Date.now();
        return {
          subject: { type: 'api_app', id: 'app-production' },
          authenticationId: 'credential-production',
          authenticatedAtMs: now - 1_000,
          expiresAtMs: now + 60_000,
          assurance: 'service',
        };
      },
    },
    policies: {
      async resolve() {
        events.push('authorize');
        return {
          project: {
            id: 'project-1',
            name: 'Production Project',
            slug: 'production-project',
            status: 'active',
            version: 3,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
          binding: {
            projectId: 'project-1',
            subject: { type: 'api_app', id: 'app-production' },
            state: 'active',
            role: 'owner',
            version: 7,
            mutationId: 'binding-production-1',
            changedBy: { type: 'system', id: 'bootstrap' },
            createdAtMs: 1,
          },
        };
      },
    },
    runs: {
      async findRunById(runId) {
        events.push(`read:${runId}`);
        return {
          id: runId,
          projectId: 'project-1',
          taskId: 'task-1',
          taskRevision: 'revision-1',
          status: 'queued',
          version: 2,
          eventSequence: 1,
          priority: 0,
          executionOrigin: 'scheduled_system',
          executionOwner: 'runtime',
          createdAtMs: 1,
          queuedAtMs: 2,
        };
      },
      async listRunsByProject(query) {
        events.push(`list:${query.projectId}:${query.limit}`);
        return [
          {
            id: 'run-1',
            projectId: query.projectId,
            taskId: 'task-1',
            taskRevision: 'revision-1',
            status: 'queued',
            version: 2,
            eventSequence: 1,
            priority: 0,
            executionOrigin: 'scheduled_system',
            executionOwner: 'runtime',
            createdAtMs: 1,
            queuedAtMs: 2,
          },
        ];
      },
      async listEvents(runId, input) {
        events.push(`events:${runId}:${input.afterSequence}:${input.limit}`);
        return [
          {
            id: 'event-1',
            runId,
            sequence: 1,
            type: 'run.created',
            actorType: 'system',
            payload: { secret: 'must-not-cross-projection' },
            createdAtMs: 2,
          },
        ];
      },
      async findAttemptById() {
        return null;
      },
    },
    trustedToolStorage: {
      stepRuns: {
        async listByRun() {
          events.push('steps');
          return { stepRuns: [], truncated: false };
        },
      },
    },
    runCancellation: {
      async requestUserCancellation(command) {
        events.push(`cancel:${command.runId}:${command.eventId}`);
        return {
          status: 'accepted',
          projectId: command.projectId,
          runId: command.runId,
          cancelReason: 'user',
          cancelRequestedAtMs: 20,
          runStatus: 'queued',
          runVersion: 3,
          eventSequence: 2,
        };
      },
    },
    taskStart: {
      async startTask(command) {
        events.push(`task-start:${command.taskId}:${command.mutationId}`);
        return {
          status: 'accepted',
          projectId: command.projectId,
          taskId: command.taskId,
          taskRevision: command.expectedRevision,
          taskContentDigest: command.expectedContentDigest,
          runId: command.runId,
          attemptId: command.attemptId,
          runStatus: 'queued',
          runVersion: 2,
          eventSequence: 2,
          executorType: 'remote_worker',
          executionRevisionDigest: 'f'.repeat(64),
          createdAtMs: 20,
        };
      },
    },
    taskDefinitions: {
      async findCurrentTaskDefinition(projectId, taskId) {
        events.push(`task-get:${projectId}:${taskId}`);
        return projectId === currentTask.projectId &&
          taskId === currentTask.taskId
          ? currentTask
          : null;
      },
      async listTaskDefinitions(query) {
        events.push(`task-list:${query.projectId}:${query.limit}`);
        return {
          definitions: [currentTask],
          truncated: false,
        };
      },
    },
    taskExecutionRevisions: {},
    triggers: {},
    schedules: {},
    securityAudit: {
      record(record) {
        events.push(`audit:${record.operationId}:${record.outcome}`);
      },
    },
    workflowAdministration: {
      async inspect(projectId, packageName) {
        events.push(`workflow-read:${projectId}:${packageName}`);
        return { found: false, publicationState: null, workflows: [] };
      },
      async inspectRun(command) {
        events.push(
          `workflow-run-read:${command.packageName}:${command.workflowId}:${command.runId}`,
        );
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
      async listRuns(command) {
        events.push(
          `workflow-run-list:${command.packageName}:${command.workflowId}:${command.limit}`,
        );
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
      async listStepRuns(command) {
        events.push(
          `workflow-step-list:${command.packageName}:${command.workflowId}:${command.runId}:${command.limit}`,
        );
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
      async listRunEvents(command) {
        events.push(
          `workflow-event-list:${command.packageName}:${command.workflowId}:${command.runId}:${command.limit}:${command.afterSequence}`,
        );
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
      async start(command) {
        events.push(`workflow-start:${command.workflowId}`);
        return {
          status: 'created',
          plan: { planId: command.planId, runId: command.runId },
          receipt: { receiptDigest: 'f'.repeat(64) },
        };
      },
      async cancel(command) {
        events.push(
          `workflow-cancel:${command.packageName}:${command.workflowId}:${command.runId}:${command.eventId}`,
        );
        return {
          status: 'accepted',
          projectId: command.projectId,
          runId: command.runId,
          runStatus: 'running',
          runVersion: 4,
          eventSequence: 4,
          cancelRequestedAtMs: 20,
          cancelReason: 'user',
        };
      },
    },
    ...overrides,
  };
  return { events, input };
}

async function invoke(stack, request) {
  const prepared = await stack.admission.prepare(request);
  return prepared.handle(request.body);
}

test('production composition exposes the reviewed Run and Workflow routes', async () => {
  const { events, input } = fixture();
  const stack = createProductionClusterControlApplicationStack(input, {
    createEventId: () => EVENT_ID,
  });

  assert.deepEqual(PRODUCTION_CLUSTER_CONTROL_ROUTE_OPERATIONS, [
    'task.get',
    'task.list',
    'task.start',
    'run.get',
    'run.list',
    'run.events.list',
    'run.steps.list',
    'run.log.read',
    'run.cancel',
    'workflow.read',
    'workflow.run.read',
    'workflow.run.list',
    'workflow.step.list',
    'workflow.event.list',
    'workflow.start',
    'workflow.cancel',
  ]);
  assert.deepEqual(await stack.reconcile(), {
    safe: true,
    remaining: 0,
    failed: 0,
  });
  assert.equal(await stack.startLifecycles(), true);

  const tasks = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/tasks', 'GET', null, {
      limit: ['8'],
    }),
  );
  assert.equal(tasks.statusCode, 200);
  assert.equal(tasks.body.tasks[0].taskId, 'task-1');
  assert.equal(JSON.stringify(tasks).includes('private'), false);

  const task = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/tasks/task-1'),
  );
  assert.equal(task.statusCode, 200);
  assert.equal(task.body.task.taskId, 'task-1');
  assert.match(task.body.task.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(task).includes('private'), false);

  const read = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/runs/run-1'),
  );
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.run.id, 'run-1');

  const listed = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/runs', 'GET', null, {
      limit: ['8'],
    }),
  );
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.runs[0].id, 'run-1');

  const timeline = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/runs/run-1/events', 'GET', null, {
      after_sequence: ['0'],
      limit: ['8'],
    }),
  );
  assert.equal(timeline.statusCode, 200);
  assert.equal(timeline.body.events[0].type, 'run.created');
  assert.equal(JSON.stringify(timeline).includes('secret'), false);

  const steps = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/runs/run-1/steps', 'GET', null, {
      limit: ['8'],
    }),
  );
  assert.deepEqual(steps, {
    statusCode: 200,
    body: { steps: [], hasMore: false, next: null },
  });

  const log = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/runs/run-1/attempts/attempt-1/log'),
  );
  assert.deepEqual(log, {
    statusCode: 503,
    body: { code: 'artifact_unavailable' },
  });

  const cancellation = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/runs/run-1/cancellation', 'POST', {
      schema: 'qinglong/run-cancellation@v1',
      mutationId: 'mutation-production-1',
    }),
  );
  assert.equal(cancellation.statusCode, 202);
  assert.equal(cancellation.body.status, 'accepted');
  assert.equal(events.includes(`cancel:run-1:${EVENT_ID}`), true);
  assert.equal(events.includes('audit:run.get:allowed'), true);
  assert.equal(events.includes('audit:run.events.list:allowed'), true);
  assert.equal(events.includes('audit:run.steps.list:allowed'), true);
  assert.equal(events.includes('audit:run.log.read:allowed'), true);
  assert.equal(events.includes('audit:run.cancel:allowed'), true);

  const workflows = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/packages/example/workflows'),
  );
  assert.equal(workflows.statusCode, 200);
  assert.equal(workflows.body.found, false);

  const workflowStart = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/packages/example/workflows/daily/runs',
      'POST',
      {
        schema: 'qinglong/cluster-plugin-package-workflow-start-request@v1',
        planId: '123e4567-e89b-42d3-a456-426614174000',
        runId: '123e4567-e89b-42d3-a456-426614174001',
        stepRunIds: {
          run: '123e4567-e89b-42d3-a456-426614174002',
        },
      },
    ),
  );
  assert.equal(workflowStart.statusCode, 201);
  assert.equal(workflowStart.body.replayed, false);
  assert.equal(events.includes('audit:workflow.read:allowed'), true);
  assert.equal(events.includes('audit:workflow.start:allowed'), true);

  const workflowRunRead = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/packages/example/workflows/daily/runs/123e4567-e89b-42d3-a456-426614174001',
    ),
  );
  assert.equal(workflowRunRead.statusCode, 404);
  assert.deepEqual(workflowRunRead.body, { code: 'workflow_run_not_found' });
  assert.equal(
    events.includes(
      'workflow-run-read:example:daily:123e4567-e89b-42d3-a456-426614174001',
    ),
    true,
  );
  assert.equal(events.includes('audit:workflow.run.read:allowed'), true);

  const workflowRunListRequest = metadata(
    '/api/v3/projects/project-1/packages/example/workflows/daily/runs',
  );
  const workflowRunList = await invoke(stack, {
    ...workflowRunListRequest,
    query: { limit: ['16'] },
  });
  assert.equal(workflowRunList.statusCode, 200);
  assert.deepEqual(workflowRunList.body.runs, []);
  assert.equal(events.includes('workflow-run-list:example:daily:16'), true);
  assert.equal(events.includes('audit:workflow.run.list:allowed'), true);

  const workflowStepListRequest = metadata(
    '/api/v3/projects/project-1/packages/example/workflows/daily/runs/123e4567-e89b-42d3-a456-426614174001/steps',
  );
  const workflowStepList = await invoke(stack, {
    ...workflowStepListRequest,
    query: { limit: ['16'] },
  });
  assert.equal(workflowStepList.statusCode, 404);
  assert.deepEqual(workflowStepList.body, { code: 'workflow_run_not_found' });
  assert.equal(
    events.includes(
      'workflow-step-list:example:daily:123e4567-e89b-42d3-a456-426614174001:16',
    ),
    true,
  );
  assert.equal(events.includes('audit:workflow.step.list:allowed'), true);

  const workflowEventListRequest = metadata(
    '/api/v3/projects/project-1/packages/example/workflows/daily/runs/123e4567-e89b-42d3-a456-426614174001/events',
  );
  const workflowEventList = await invoke(stack, {
    ...workflowEventListRequest,
    query: { limit: ['16'], after_sequence: ['2'] },
  });
  assert.equal(workflowEventList.statusCode, 404);
  assert.deepEqual(workflowEventList.body, { code: 'workflow_run_not_found' });
  assert.equal(
    events.includes(
      'workflow-event-list:example:daily:123e4567-e89b-42d3-a456-426614174001:16:2',
    ),
    true,
  );
  assert.equal(events.includes('audit:workflow.event.list:allowed'), true);

  const workflowCancellation = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/packages/example/workflows/daily/runs/123e4567-e89b-42d3-a456-426614174001/cancellation',
      'POST',
      {
        schema: 'qinglong/run-cancellation@v1',
        mutationId: 'workflow-cancel-production-1',
      },
    ),
  );
  assert.equal(workflowCancellation.statusCode, 202);
  assert.equal(workflowCancellation.body.status, 'accepted');
  assert.equal(
    events.includes(
      `workflow-cancel:example:daily:123e4567-e89b-42d3-a456-426614174001:${EVENT_ID}`,
    ),
    true,
  );
  assert.equal(events.includes('audit:workflow.cancel:allowed'), true);
  assert.equal(await stack.stop(), 'stopped');
});

test('production composition fails closed for an unreviewed route', async () => {
  const { input } = fixture();
  const stack = createProductionClusterControlApplicationStack(input);
  await assert.rejects(
    stack.admission.prepare(
      metadata('/api/v3/projects/project-1/runs/run-1/retry', 'POST'),
    ),
    (error) => error?.statusCode === 404 && error?.code === 'route_not_found',
  );
});

test('wires the production Worker object reader into the Project-scoped log route', async () => {
  const { input } = fixture();
  const run = await input.runs.findRunById('run-1');
  const logArtifactId = `wlog-${'a'.repeat(30)}`;
  const stack = createProductionClusterControlApplicationStack({
    ...input,
    runs: {
      ...input.runs,
      async findRunById() {
        return { ...run, status: 'running' };
      },
      async findAttemptById() {
        return {
          id: 'attempt-1',
          runId: 'run-1',
          attempt: 1,
          status: 'running',
          executorType: 'remote_worker',
          logArtifactId,
          callbackSequence: 0,
          createdAtMs: 1,
        };
      },
    },
    workerRuntime: {
      offers: { claimNext() {} },
      activation: {
        acknowledgeStarting() {},
        acknowledgeRunning() {},
        failStart() {},
      },
      artifacts: { upload() {} },
      completion: { complete() {} },
      leaseControl: { control() {} },
      runAttemptLogRead: {
        async read(identity, range) {
          assert.equal(identity.logArtifactId, logArtifactId);
          assert.deepEqual(range, { offset: 1, length: 4 });
          return {
            status: 'available',
            content: Buffer.from('prod'),
            start: 1,
            endExclusive: 5,
            totalBytes: 5,
            truncation: { truncated: false },
          };
        },
      },
    },
  });
  const result = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/runs/run-1/attempts/attempt-1/log',
      'GET',
      null,
      { offset: ['1'], length: ['4'] },
    ),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(Buffer.from(result.body.content, 'base64').toString(), 'prod');
});

test('wires durable retirement authority into the production log route', async () => {
  const {
    createRunAttemptLogRetirementRecord,
  } = require('@qinglong/runtime-core/run-attempt-log-retention');
  const { input } = fixture();
  const run = await input.runs.findRunById('run-1');
  const logArtifactId = `wlog-${'b'.repeat(30)}`;
  let objectReads = 0;
  const stack = createProductionClusterControlApplicationStack({
    ...input,
    runs: {
      ...input.runs,
      async findRunById() {
        return { ...run, status: 'succeeded', finishedAtMs: 10 };
      },
      async findAttemptById() {
        return {
          id: 'attempt-1',
          runId: 'run-1',
          attempt: 1,
          status: 'succeeded',
          executorType: 'remote_worker',
          logArtifactId,
          callbackSequence: 0,
          createdAtMs: 1,
          finishedAtMs: 10,
        };
      },
    },
    runAttemptLogRetention: {
      async inspect(identity) {
        assert.deepEqual(identity, {
          projectId: 'project-1',
          runId: 'run-1',
          attemptId: 'attempt-1',
          logArtifactId,
        });
        return {
          status: 'retired',
          record: createRunAttemptLogRetirementRecord({
            ...identity,
            executorType: 'remote_worker',
            finishedAtMs: 10,
            eligibleAtMs: 20,
            retiredAtMs: 30,
            disposition: 'deleted',
            byteLength: 64,
            truncation: { truncated: 'unknown' },
          }),
        };
      },
    },
    workerRuntime: {
      offers: { claimNext() {} },
      activation: {
        acknowledgeStarting() {},
        acknowledgeRunning() {},
        failStart() {},
      },
      artifacts: { upload() {} },
      completion: { complete() {} },
      leaseControl: { control() {} },
      runAttemptLogRead: {
        async read() {
          objectReads += 1;
          return { status: 'missing' };
        },
      },
    },
  });
  const result = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/runs/run-1/attempts/attempt-1/log'),
  );
  assert.equal(result.statusCode, 410);
  assert.equal(result.body.status, 'retired');
  assert.equal(result.body.retiredAtMs, 30);
  assert.equal(result.body.byteLength, 64);
  assert.equal(objectReads, 0);
});

test('optionally exposes Prompt execution behind shared admission and policy', async () => {
  const { events, input } = fixture();
  let command;
  const stack = createProductionClusterControlApplicationStack(input, {
    promptExecution: {
      now: () => 2_000,
      maxExecutionMs: 10_000,
      capability: {
        async execute(value) {
          command = value;
          return {
            status: 'executed',
            admission: {
              requestId: value.requestId,
              invocationId: 'ppi:1',
              runId: 'ppr:1',
              stepRunId: 'pps:1',
            },
            finalization: { runStatus: 'succeeded' },
            result: { text: 'live output' },
          };
        },
      },
    },
  });
  assert.deepEqual(PRODUCTION_CLUSTER_CONTROL_OPTIONAL_ROUTE_OPERATIONS, [
    'prompt.read',
    'prompt.execute',
    'prompt.execution.read',
    'prompt.execution.output.read',
    'prompt.output.read',
    'copilot.failure_diagnosis.execute',
    'copilot.failure_diagnosis.read',
    'copilot.failure_diagnosis.output.read',
    'copilot.failure_diagnosis.cancel',
  ]);
  const response = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/packages/example/prompts/summary/executions',
      'POST',
      {
        schema: 'qinglong/cluster-plugin-package-prompt-execution-request@v2',
        requestId: 'prompt-request-1',
        traceId: 'trace-1',
        parameters: { subject: 'private input' },
        provider: 'openai-compatible',
        model: 'model-a',
        maxOutputTokens: 256,
        timeoutMs: 5_000,
      },
    ),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(command.projectId, 'project-1');
  assert.deepEqual(command.policyFence, {
    projectVersion: 3,
    bindingVersion: 7,
  });
  assert.equal(events.includes('audit:prompt.execute:allowed'), true);
});

test('optionally exposes Copilot diagnosis behind shared authentication, Policy and audit', async () => {
  const { events, input } = fixture();
  let command;
  let cancellationCommand;
  const capability = {
    async execute(value) {
      command = value;
      events.push(`diagnose:${value.sourceRunId}`);
      return {
        admissionStatus: 'created',
        admission: {
          requestId: value.requestId,
          runId: 'diagnosis-run-1',
          sourceRunId: value.sourceRunId,
        },
        tool: { outcome: 'succeeded' },
        model: {
          outcome: 'succeeded',
          output: {
            artifactId: 'cdo:artifact-1',
            artifactDigest: 'a'.repeat(64),
          },
        },
        terminalization: null,
        terminalizationRequired: false,
      };
    },
    async inspect(value) {
      return {
        schema: 'qinglong/copilot-failure-diagnosis-inspection-result@v1',
        status: 'not_found',
        projectId: value.projectId,
        sourceRunId: value.sourceRunId,
        requestId: value.requestId,
      };
    },
    async readOutput(value) {
      return {
        schema: 'qinglong/copilot-failure-diagnosis-output-read-result@v1',
        status: 'not_found',
        projectId: value.projectId,
        sourceRunId: value.sourceRunId,
        requestId: value.requestId,
      };
    },
    async cancel(value) {
      cancellationCommand = value;
      return {
        schema: 'qinglong/copilot-failure-diagnosis-cancellation-result@v1',
        status: 'accepted',
        convergence: 'terminal',
        projectId: value.projectId,
        sourceRunId: value.sourceRunId,
        requestId: value.requestId,
        diagnosisRunId: 'diagnosis-run-1',
        runStatus: 'cancelled',
        outcome: 'cancelled',
        runVersion: 7,
        eventSequence: 7,
        cancelRequestedAtMs: 2_000,
        cancelReason: 'user',
      };
    },
  };
  const stack = createProductionClusterControlApplicationStack(input, {
    copilotFailureDiagnosis: {
      capability,
      readCapability: capability,
      cancellationCapability: capability,
    },
  });
  const result = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses',
      'POST',
      {
        schema: 'qinglong/cluster-copilot-failure-diagnosis-request@v1',
        traceId: 'trace-production-1',
      },
    ),
  );

  assert.equal(result.statusCode, 201);
  assert.equal(command.requestId, 'request-production-1');
  assert.equal(command.projectId, 'project-1');
  assert.equal(command.sourceRunId, 'run-1');
  assert.equal(command.principal.subject.id, 'app-production');
  assert.equal('policyFence' in command, false);
  assert.deepEqual(events.slice(-4), [
    'authenticate',
    'authorize',
    'audit:copilot.failure_diagnosis.execute:allowed',
    'diagnose:run-1',
  ]);

  const inspection = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses/diagnosis-request-1',
    ),
  );
  const output = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses/diagnosis-request-1/output',
    ),
  );
  assert.equal(inspection.statusCode, 404);
  assert.equal(output.statusCode, 404);
  const cancellation = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses/diagnosis-request-1/cancellation',
      'POST',
      {
        schema: 'qinglong/run-cancellation@v1',
        mutationId: '00000000-0000-4000-8000-000000000099',
      },
    ),
  );
  assert.equal(cancellation.statusCode, 202);
  assert.equal(cancellationCommand.projectId, 'project-1');
  assert.equal(cancellationCommand.sourceRunId, 'run-1');
  assert.equal(cancellationCommand.requestId, 'diagnosis-request-1');
  assert.deepEqual(cancellationCommand.policyFence, {
    projectVersion: 3,
    bindingVersion: 7,
  });
  assert.equal(
    events.includes('audit:copilot.failure_diagnosis.read:allowed'),
    true,
  );
  assert.equal(
    events.includes('audit:copilot.failure_diagnosis.output.read:allowed'),
    true,
  );
  assert.equal(
    events.includes('audit:copilot.failure_diagnosis.cancel:allowed'),
    true,
  );
});

test('keeps the Copilot route absent by default and never invokes it after Policy denial', async () => {
  const defaultFixture = fixture();
  const defaultStack = createProductionClusterControlApplicationStack(
    defaultFixture.input,
  );
  const request = metadata(
    '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses',
    'POST',
    {
      schema: 'qinglong/cluster-copilot-failure-diagnosis-request@v1',
      traceId: 'trace-production-1',
    },
  );
  await assert.rejects(
    defaultStack.admission.prepare(request),
    (error) => error?.statusCode === 404 && error?.code === 'route_not_found',
  );
  for (const path of [
    '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses/diagnosis-request-1',
    '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses/diagnosis-request-1/output',
    '/api/v3/projects/project-1/runs/run-1/copilot/failure-diagnoses/diagnosis-request-1/cancellation',
  ]) {
    await assert.rejects(
      defaultStack.admission.prepare(metadata(path)),
      (error) => error?.statusCode === 404 && error?.code === 'route_not_found',
    );
  }

  let calls = 0;
  const deniedFixture = fixture({
    policies: {
      async resolve() {
        deniedFixture.events.push('authorize');
        return {
          project: {
            id: 'project-1',
            name: 'Denied Project',
            slug: 'denied-project',
            status: 'active',
            version: 3,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
          binding: {
            projectId: 'project-1',
            subject: { type: 'api_app', id: 'app-production' },
            state: 'active',
            role: 'viewer',
            version: 7,
            mutationId: 'binding-denied-1',
            changedBy: { type: 'system', id: 'bootstrap' },
            createdAtMs: 1,
          },
        };
      },
    },
  });
  const deniedStack = createProductionClusterControlApplicationStack(
    deniedFixture.input,
    {
      copilotFailureDiagnosis: {
        capability: {
          async execute() {
            calls += 1;
          },
        },
      },
    },
  );
  await assert.rejects(
    deniedStack.admission.prepare(request),
    (error) => error?.statusCode === 403 && error?.code === 'forbidden',
  );
  assert.equal(calls, 0);
  assert.equal(
    deniedFixture.events.includes(
      'audit:copilot.failure_diagnosis.execute:denied',
    ),
    true,
  );
});

test('optionally exposes the redacted Prompt catalog behind shared admission and policy', async () => {
  const { events, input } = fixture();
  const stack = createProductionClusterControlApplicationStack(input, {
    promptCatalog: {
      capability: {
        async inspect(projectId, packageName) {
          return {
            schema: 'qinglong/plugin-package-prompt-catalog@v1',
            projectId,
            packageName,
            found: true,
            publicationState: 'active',
            prompts: [
              {
                id: 'summary',
                name: 'Summary',
                description: null,
                parameters: [],
              },
            ],
          };
        },
      },
    },
  });
  const result = await invoke(
    stack,
    metadata('/api/v3/projects/project-1/packages/example/prompts'),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.prompts[0].id, 'summary');
  assert.equal(JSON.stringify(result).includes('template'), false);
  assert.equal(events.includes('audit:prompt.read:allowed'), true);
});

test('optionally inspects one Prompt execution behind shared admission and policy', async () => {
  const { events, input } = fixture();
  let command;
  const stack = createProductionClusterControlApplicationStack(input, {
    createEventId: () => '00000000-0000-4000-8000-000000000011',
    promptExecutionInspection: {
      now: () => 2_000,
      capability: {
        async inspectAuthorized(value) {
          command = value;
          return {
            schema: 'qinglong/plugin-package-prompt-execution-inspection@v1',
            found: true,
            projectId: value.projectId,
            packageName: value.packageName,
            promptId: value.promptId,
            executionRequestId: value.executionRequestId,
            execution: {
              invocationId: 'invocation-1',
              runId: '00000000-0000-4000-8000-000000000010',
              stepRunId: 'step-1',
              runStatus: 'running',
              runVersion: 2,
              eventSequence: 2,
              stepStatus: 'running',
              stepVersion: 2,
              admittedAtMs: 1_000,
              startedAtMs: 1_000,
              finishedAtMs: null,
              finalizedAtMs: null,
            },
          };
        },
      },
    },
  });
  const result = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/packages/example/prompts/summary/executions/execution-request-1',
    ),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(command.executionRequestId, 'execution-request-1');
  assert.equal(command.audit.operationId, 'prompt.execution.read');
  assert.equal(events.includes('audit:prompt.execution.read:allowed'), true);
});

test('optionally exposes Prompt output read behind shared admission and policy', async () => {
  const { events, input } = fixture();
  let command;
  const stack = createProductionClusterControlApplicationStack(input, {
    promptOutputRead: {
      capability: {
        async read(value) {
          command = value;
          return {
            schema: 'qinglong/plugin-package-prompt-output-read-result@v1',
            status: 'not_found',
          };
        },
      },
    },
  });
  const request = metadata(
    '/api/v3/projects/project-1/runs/run-1/prompt-output-artifacts/pao:1',
  );
  const result = await invoke(stack, {
    ...request,
    query: { artifact_digest: ['a'.repeat(64)] },
  });

  assert.equal(result.statusCode, 404);
  assert.equal(command.projectId, 'project-1');
  assert.equal(command.runId, 'run-1');
  assert.equal(command.artifactId, 'pao:1');
  assert.equal(command.principal.subject.id, 'app-production');
  assert.equal(events.includes('audit:prompt.output.read:allowed'), true);
});

test('optionally recovers Prompt output by execution requestId behind artifact.read', async () => {
  const { events, input } = fixture();
  let command;
  const stack = createProductionClusterControlApplicationStack(input, {
    promptExecutionOutputRead: {
      capability: {
        async read(value) {
          command = value;
          return {
            schema:
              'qinglong/plugin-package-prompt-execution-output-read-result@v1',
            status: 'not_found',
            projectId: value.projectId,
            packageName: value.packageName,
            promptId: value.promptId,
            executionRequestId: value.executionRequestId,
          };
        },
      },
    },
  });
  const result = await invoke(
    stack,
    metadata(
      '/api/v3/projects/project-1/packages/example/prompts/summary/executions/execution-request-1/output',
    ),
  );
  assert.equal(result.statusCode, 404);
  assert.equal(command.projectId, 'project-1');
  assert.equal(command.packageName, 'example');
  assert.equal(command.promptId, 'summary');
  assert.equal(command.executionRequestId, 'execution-request-1');
  assert.equal(command.principal.subject.id, 'app-production');
  assert.equal(
    events.includes('audit:prompt.execution.output.read:allowed'),
    true,
  );
});

test('production start requires an enabled configuration before owning resources', () => {
  assert.throws(
    () =>
      startProductionClusterControlApplication({
        config: { enabled: false, profile: 'standalone' },
        recovery: { ownerId: 'production-test' },
        audit() {},
      }),
    /database binding requires an enabled cluster-control config/,
  );
});
test('production composition rejects an invalid event ID factory', () => {
  const { input } = fixture();
  assert.throws(
    () =>
      createProductionClusterControlApplicationStack(input, {
        createEventId: 'invalid',
      }),
    /event ID factory is invalid/,
  );
});

test('starts and stops Worker ingress through the injected runtime port', async () => {
  const events = [];
  const runtime = Object.freeze({
    offers: { claimNext() {} },
    activation: {
      acknowledgeStarting() {},
      acknowledgeRunning() {},
      failStart() {},
    },
    artifacts: { upload() {} },
    completion: { complete() {} },
    leaseControl: { control() {} },
  });
  const { input } = fixture({ workerRuntime: runtime });
  const config = {
    enabled: true,
    profile: 'cluster-control',
    http: { host: '127.0.0.1', port: 5801 },
    transport: {},
    database: {},
    security: { workerCredentialPepper: 'A'.repeat(43) },
    artifact: {},
  };
  const stack = createProductionClusterControlApplicationStack(input, {
    workerIngress: { config },
    async startWorkerIngress(options) {
      events.push('start-worker-ingress');
      assert.equal(options.config, config);
      assert.equal(options.runtime, runtime);
      return {
        status: 'active',
        protocol: 'https',
        transport: 'mutual-tls',
        address: { host: '127.0.0.1', port: 5801 },
        evidence: input.evidence,
        reloadTransport() {
          return 1;
        },
        async stop() {
          events.push('stop-worker-ingress');
          return 'stopped';
        },
      };
    },
  });

  assert.equal(await stack.startLifecycles(), true);
  assert.equal(await stack.startLifecycles(), true);
  assert.equal(await stack.stop(), 'stopped');
  assert.equal(await stack.stop(), 'stopped');
  assert.deepEqual(events, ['start-worker-ingress', 'stop-worker-ingress']);
});

test('fails closed when Worker ingress has no runtime service port', async () => {
  const { input } = fixture();
  const stack = createProductionClusterControlApplicationStack(input, {
    workerIngress: {
      config: {
        enabled: true,
        profile: 'cluster-control',
      },
    },
    async startWorkerIngress() {
      throw new Error('must not start');
    },
  });
  await assert.rejects(
    stack.startLifecycles(),
    /requires an injected runtime service port/,
  );
});

test('drains a Worker listener when its Pool fails during activation', async () => {
  let stops = 0;
  const diagnostics = [];
  const { input } = fixture({
    workerRuntime: {
      offers: { claimNext() {} },
      activation: {
        acknowledgeStarting() {},
        acknowledgeRunning() {},
        failStart() {},
      },
      artifacts: { upload() {} },
      completion: { complete() {} },
      leaseControl: { control() {} },
    },
  });
  const stack = createProductionClusterControlApplicationStack(input, {
    workerIngress: {
      config: { enabled: true, profile: 'cluster-control' },
      onDiagnostic(error) {
        diagnostics.push(error);
      },
    },
    async startWorkerIngress(options) {
      options.onPoolError(new Error('worker database unavailable'));
      return {
        status: 'active',
        protocol: 'https',
        transport: 'mutual-tls',
        address: { host: '127.0.0.1', port: 5801 },
        evidence: input.evidence,
        reloadTransport() {
          return 1;
        },
        async stop() {
          stops += 1;
          return 'stopped';
        },
      };
    },
  });

  await assert.rejects(
    stack.startLifecycles(),
    /became unavailable during activation/,
  );
  assert.equal(stops, 1);
  assert.equal(diagnostics.length, 1);
});
