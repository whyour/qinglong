const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_CONTROL_RUN_STEP_LIST_ROUTE,
  createClusterControlRunStepListRoute,
} = require('@qinglong/cluster-control/run-routes');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');
const {
  createStepRunRecord,
} = require('../../ql3-runtime-core/dist/run/stepRun.js');

function run(projectId = 'prj_default') {
  return { id: 'run-1', projectId };
}

function step(id, stepKey) {
  return createStepRunRecord({
    id,
    runId: 'run-1',
    parentStepRunId: 'step-parent',
    stepKey,
    kind: 'tool',
    definitionRef: 'tool:private.internal@1.0.0',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:private-input',
    mutationId: `create-${id}`,
    createdAtMs: 1_000,
  });
}

function authorized(query = {}, body = null) {
  return { projectId: 'prj_default', request: { query, body } };
}

test('publishes one reviewed bounded Run Step list route', () => {
  assert.deepEqual(CLUSTER_CONTROL_RUN_STEP_LIST_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/runs/{runId}/steps',
    operationId: 'run.steps.list',
    permission: 'run.read',
    projectParameter: 'projectId',
    allowedQuery: ['after_step_key', 'after_step_run_id', 'limit'],
  });
  assert.throws(() => createClusterControlRunStepListRoute({}, {}), TypeError);
});

test('returns the shared projection with the paired Step keyset cursor', async () => {
  const calls = [];
  const first = step('step-1', 'build');
  const second = step('step-2', 'deploy');
  const route = createClusterControlRunStepListRoute(
    {
      async findRunById(runId) {
        calls.push(['run', runId]);
        return run();
      },
    },
    {
      async listByRun(query) {
        calls.push(['steps', query]);
        return {
          stepRuns: [first, second],
          truncated: true,
          next: { stepKey: second.stepKey, id: second.id },
        };
      },
    },
  );
  const result = await route.handle(
    authorized({
      after_step_key: ['admit'],
      after_step_run_id: ['step-0'],
      limit: ['2'],
    }),
    { runId: 'run-1' },
  );
  assert.deepEqual(calls[1], [
    'steps',
    {
      runId: 'run-1',
      limit: 2,
      after: { stepKey: 'admit', id: 'step-0' },
    },
  ]);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.steps.length, 2);
  assert.deepEqual(result.body.next, {
    stepKey: 'deploy',
    stepRunId: 'step-2',
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('rejects an unpaired or malformed cursor before authentication', async () => {
  const route = createClusterControlRunStepListRoute(
    {
      async findRunById() {
        return run();
      },
    },
    {
      async listByRun() {
        return { stepRuns: [], truncated: false };
      },
    },
  );
  let authentications = 0;
  const pipeline = createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([route]),
    authenticator: {
      authenticate() {
        authentications += 1;
        return null;
      },
    },
    policy: {
      authorize() {
        throw new Error('must not authorize');
      },
    },
    audit: {
      record() {
        throw new Error('must not audit');
      },
    },
    now: () => 10_000,
  });
  for (const query of [
    { after_step_key: ['build'] },
    { after_step_run_id: ['step-1'] },
    { after_step_key: ['bad value'], after_step_run_id: ['step-1'] },
    { after_step_key: ['build'], after_step_run_id: ['step-1'], limit: ['65'] },
  ]) {
    await assert.rejects(
      pipeline.prepare({
        requestId: 'request-invalid-run-step-list',
        method: 'GET',
        path: '/api/v3/projects/prj_default/runs/run-1/steps',
        query,
        headers: {},
        signal: new AbortController().signal,
      }),
      (error) =>
        error.statusCode === 400 && error.code === 'invalid_route_query',
    );
  }
  assert.equal(authentications, 0);
});
