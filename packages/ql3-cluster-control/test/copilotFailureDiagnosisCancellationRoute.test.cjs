const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CopilotFailureDiagnosisCancellationNotFoundError,
} = require('@qinglong/ai/failure-diagnosis-cancellation');
const {
  CLUSTER_RUN_CANCELLATION_SCHEMA,
  ClusterRunCancellationFenceRejectedError,
} = require('@qinglong/runtime-core/cluster-run-cancellation');
const {
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA,
  CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_ROUTE,
  createClusterControlCopilotFailureDiagnosisCancellationRoute,
} = require('@qinglong/cluster-control/copilot-cancellation-route');

function authorized(body, overrides = {}) {
  return {
    request: {
      requestId: 'transport-request-1',
      method: 'POST',
      path: '/api/v3/projects/project-1/runs/source-run-1/copilot/failure-diagnoses/diagnosis-request-1/cancellation',
      query: {},
      headers: {},
      signal: new AbortController().signal,
      body,
    },
    principal: {
      subject: { type: 'user', id: 'owner-1' },
      authenticationId: 'credential-1',
      authenticatedAtMs: 1,
      expiresAtMs: 10_000,
      assurance: 'multi_factor',
    },
    operationId: 'copilot.failure_diagnosis.cancel',
    permission: 'run.stop',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    ...overrides,
  };
}

const parameters = {
  projectId: 'project-1',
  runId: 'source-run-1',
  requestId: 'diagnosis-request-1',
};

function body(overrides = {}) {
  return {
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    schema: 'qinglong/copilot-failure-diagnosis-cancellation-result@v1',
    status: 'accepted',
    convergence: 'terminal',
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'diagnosis-request-1',
    diagnosisRunId: 'diagnosis-run-1',
    runStatus: 'cancelled',
    outcome: 'cancelled',
    runVersion: 7,
    eventSequence: 7,
    cancelRequestedAtMs: 500,
    cancelReason: 'user',
    ...overrides,
  };
}

test('defines an exact run.stop route and passes only fenced target facts', async () => {
  let command;
  const request = authorized(body());
  const route = createClusterControlCopilotFailureDiagnosisCancellationRoute(
    {
      async cancel(value) {
        command = value;
        return result();
      },
    },
    () => '22222222-2222-4222-8222-222222222222',
  );
  const response = await route.handle(request, parameters);
  assert.deepEqual(
    CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_ROUTE,
    {
      method: 'POST',
      path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}/cancellation',
      operationId: 'copilot.failure_diagnosis.cancel',
      permission: 'run.stop',
      projectParameter: 'projectId',
    },
  );
  assert.deepEqual(command, {
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'diagnosis-request-1',
    mutationId: '11111111-1111-4111-8111-111111111111',
    eventId: '22222222-2222-4222-8222-222222222222',
    subject: request.principal.subject,
    policyFence: request.policyFence,
  });
  assert.deepEqual(response, {
    statusCode: 202,
    body: {
      schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA,
      status: 'accepted',
      convergence: 'terminal',
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      requestId: 'diagnosis-request-1',
      diagnosisRunId: 'diagnosis-run-1',
      runStatus: 'cancelled',
      outcome: 'cancelled',
      runVersion: 7,
      eventSequence: 7,
      cancelRequestedAtMs: 500,
      cancelReason: 'user',
    },
  });
});

test('projects an in-flight durable intent without claiming Provider abort', async () => {
  const route = createClusterControlCopilotFailureDiagnosisCancellationRoute(
    {
      async cancel() {
        return result({
          status: 'already_requested',
          convergence: 'model_in_flight',
          runStatus: 'running',
          outcome: null,
          runVersion: 6,
          eventSequence: 6,
        });
      },
    },
    () => '22222222-2222-4222-8222-222222222222',
  );
  const response = await route.handle(authorized(body()), parameters);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.convergence, 'model_in_flight');
  assert.equal(response.body.runStatus, 'running');
  assert.equal(response.body.outcome, null);
  assert.equal('providerAborted' in response.body, false);
});

test('rejects non-exact bodies before invoking the capability', async () => {
  let calls = 0;
  const route = createClusterControlCopilotFailureDiagnosisCancellationRoute(
    {
      async cancel() {
        calls += 1;
        return result();
      },
    },
    () => '22222222-2222-4222-8222-222222222222',
  );
  for (const value of [
    null,
    {},
    body({ runId: 'caller-selected' }),
    body({ reason: 'timeout' }),
    body({ mutationId: '' }),
  ]) {
    const response = await route.handle(authorized(value), parameters);
    assert.equal(response.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test('fails closed on widened or identity-drifted capability results', async () => {
  for (const value of [
    result({ sourceRunId: 'other' }),
    result({ privateProvider: 'must-not-cross' }),
    result({ runVersion: 8 }),
    result({ convergence: 'model_in_flight' }),
  ]) {
    const route = createClusterControlCopilotFailureDiagnosisCancellationRoute(
      {
        async cancel() {
          return value;
        },
      },
      () => '22222222-2222-4222-8222-222222222222',
    );
    const response = await route.handle(authorized(body()), parameters);
    assert.deepEqual(response, {
      statusCode: 503,
      body: {
        code: 'copilot_failure_diagnosis_cancellation_unavailable',
      },
    });
  }
});

test('maps hidden targets, Policy races and storage failures to stable codes', async () => {
  for (const [error, statusCode, code] of [
    [
      new CopilotFailureDiagnosisCancellationNotFoundError(),
      404,
      'copilot_failure_diagnosis_not_found',
    ],
    [
      new ClusterRunCancellationFenceRejectedError('authorization_changed'),
      409,
      'copilot_failure_diagnosis_cancellation_fence_rejected',
    ],
    [
      new Error('private storage detail'),
      503,
      'copilot_failure_diagnosis_cancellation_unavailable',
    ],
  ]) {
    const route = createClusterControlCopilotFailureDiagnosisCancellationRoute(
      {
        async cancel() {
          throw error;
        },
      },
      () => '22222222-2222-4222-8222-222222222222',
    );
    const response = await route.handle(authorized(body()), parameters);
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.body.code, code);
    assert.equal(JSON.stringify(response).includes('private'), false);
  }
});
