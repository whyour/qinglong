const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA,
  CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_ROUTE,
  createClusterControlCopilotFailureDiagnosisRoute,
} = require('@qinglong/cluster-control/copilot-routes');

function authorized(body, overrides = {}) {
  return {
    request: {
      requestId: 'diagnosis-request-1',
      method: 'POST',
      path: '/api/v3/projects/project-1/runs/source-run-1/copilot/failure-diagnoses',
      query: {},
      headers: {},
      signal: new AbortController().signal,
      body,
    },
    principal: {
      subject: { type: 'api_app', id: 'app-1' },
      authenticationId: 'credential-1',
      authenticatedAtMs: 1,
      expiresAtMs: 10_000,
      assurance: 'service',
    },
    operationId: 'copilot.failure_diagnosis.execute',
    permission: 'model.invoke',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    ...overrides,
  };
}

function body(overrides = {}) {
  return {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA,
    traceId: 'trace-1',
    ...overrides,
  };
}

function succeeded(admissionStatus = 'created') {
  return {
    admissionStatus,
    admission: {
      requestId: 'diagnosis-request-1',
      runId: 'diagnosis-run-1',
      sourceRunId: 'source-run-1',
    },
    tool: { outcome: 'succeeded', output: { private: 'must not cross' } },
    model: {
      outcome: 'succeeded',
      output: {
        artifactId: 'cdo:artifact-1',
        artifactDigest: 'a'.repeat(64),
        provider: 'private-provider',
      },
      plaintext: 'private diagnosis',
    },
    terminalization: null,
    terminalizationRequired: false,
  };
}

test('defines one exact model.invoke route and binds HTTP request identity', async () => {
  let command;
  const route = createClusterControlCopilotFailureDiagnosisRoute({
    async execute(value) {
      command = value;
      return succeeded();
    },
  });
  const request = authorized(body());
  const result = await route.handle(request, {
    projectId: 'project-1',
    runId: 'source-run-1',
  });

  assert.deepEqual(CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_ROUTE, {
    method: 'POST',
    path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses',
    operationId: 'copilot.failure_diagnosis.execute',
    permission: 'model.invoke',
    projectParameter: 'projectId',
  });
  assert.deepEqual(command, {
    requestId: 'diagnosis-request-1',
    traceId: 'trace-1',
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    principal: request.principal,
  });
  assert.equal('policyFence' in command, false);
  assert.equal('model' in command, false);
  assert.equal('attemptId' in command, false);
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.body, {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA,
    requestId: 'diagnosis-request-1',
    status: 'created',
    replayed: false,
    sourceRunId: 'source-run-1',
    diagnosisRunId: 'diagnosis-run-1',
    outcome: 'succeeded',
    stage: 'model',
    reason: null,
    outputArtifact: {
      artifactId: 'cdo:artifact-1',
      artifactDigest: 'a'.repeat(64),
    },
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('returns a content-free existing receipt for exact replay', async () => {
  const route = createClusterControlCopilotFailureDiagnosisRoute({
    async execute() {
      return succeeded('existing');
    },
  });
  const result = await route.handle(authorized(body()), {
    projectId: 'project-1',
    runId: 'source-run-1',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'existing');
  assert.equal(result.body.replayed, true);
});

test('projects pre-Model terminalization without Tool or log content', async () => {
  const route = createClusterControlCopilotFailureDiagnosisRoute({
    async execute() {
      return {
        admissionStatus: 'created',
        admission: {
          requestId: 'diagnosis-request-1',
          runId: 'diagnosis-run-1',
          sourceRunId: 'source-run-1',
        },
        tool: { outcome: 'failed', privateLog: 'must not cross' },
        model: null,
        terminalization: {
          stage: 'log',
          reason: 'log_retired',
          outcome: 'failed',
          privateEvidence: 'must not cross',
        },
        terminalizationRequired: false,
      };
    },
  });
  const result = await route.handle(authorized(body()), {
    projectId: 'project-1',
    runId: 'source-run-1',
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.stage, 'log');
  assert.equal(result.body.reason, 'log_retired');
  assert.equal(result.body.outcome, 'failed');
  assert.equal(result.body.outputArtifact, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('rejects non-exact bodies before invoking the capability', async () => {
  let calls = 0;
  const route = createClusterControlCopilotFailureDiagnosisRoute({
    async execute() {
      calls += 1;
      return succeeded();
    },
  });
  for (const invalid of [
    null,
    {},
    body({ requestId: 'body-request-must-not-exist' }),
    body({ provider: 'caller-selected' }),
    body({ traceId: '' }),
    Object.assign(Object.create(null), body()),
  ]) {
    const result = await route.handle(authorized(invalid), {
      projectId: 'project-1',
      runId: 'source-run-1',
    });
    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, {
      code: 'invalid_copilot_failure_diagnosis_request',
    });
  }
  assert.equal(calls, 0);
});

test('fails closed on capability responses that do not bind the durable identity', async () => {
  for (const mutation of [
    (value) => ({
      ...value,
      admission: { ...value.admission, requestId: 'other' },
    }),
    (value) => ({
      ...value,
      admission: { ...value.admission, sourceRunId: 'other' },
    }),
    (value) => ({ ...value, terminalizationRequired: true }),
    (value) => ({ ...value, model: null }),
    (value) => ({ ...value, model: { ...value.model, output: null } }),
  ]) {
    const route = createClusterControlCopilotFailureDiagnosisRoute({
      async execute() {
        return mutation(succeeded());
      },
    });
    const result = await route.handle(authorized(body()), {
      projectId: 'project-1',
      runId: 'source-run-1',
    });
    assert.deepEqual(result, {
      statusCode: 503,
      body: { code: 'copilot_failure_diagnosis_unavailable' },
    });
  }
});

test('maps internal failures to stable low-sensitive transport codes', async () => {
  for (const [internal, statusCode, external] of [
    [
      'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_CONFLICT',
      409,
      'copilot_failure_diagnosis_conflict',
    ],
    [
      'TRUSTED_TOOL_EXECUTION_POLICY_DENIED',
      403,
      'copilot_failure_diagnosis_forbidden',
    ],
    [
      'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_BUSY',
      429,
      'copilot_failure_diagnosis_capacity_exceeded',
    ],
    [
      'COPILOT_MODEL_EGRESS_DENIED',
      422,
      'copilot_failure_diagnosis_policy_rejected',
    ],
    [
      'MODEL_INVOCATION_DEADLINE_EXCEEDED',
      504,
      'copilot_failure_diagnosis_deadline_exceeded',
    ],
    ['MODEL_INVOCATION_ABORTED', 408, 'copilot_failure_diagnosis_aborted'],
    ['PRIVATE_STORAGE_FAILURE', 503, 'copilot_failure_diagnosis_unavailable'],
  ]) {
    const route = createClusterControlCopilotFailureDiagnosisRoute({
      async execute() {
        throw Object.assign(new Error('private internal detail'), {
          code: internal,
        });
      },
    });
    const result = await route.handle(authorized(body()), {
      projectId: 'project-1',
      runId: 'source-run-1',
    });
    assert.equal(result.statusCode, statusCode, internal);
    assert.deepEqual(result.body, { code: external });
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});
