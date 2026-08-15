const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA,
  CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_ROUTE,
  CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_ROUTE,
  createClusterControlCopilotFailureDiagnosisInspectionRoute,
  createClusterControlCopilotFailureDiagnosisOutputReadRoute,
} = require('@qinglong/cluster-control/copilot-read-routes');

function authorized(path, body = null) {
  return {
    request: {
      requestId: 'transport-request-1',
      method: 'GET',
      path,
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
    operationId: 'copilot.failure_diagnosis.read',
    permission: 'run.read',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
  };
}

const parameters = {
  projectId: 'project-1',
  runId: 'source-run-1',
  requestId: 'diagnosis-request-1',
};

function running(overrides = {}) {
  return {
    schema: 'qinglong/copilot-failure-diagnosis-inspection-result@v1',
    status: 'running',
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'diagnosis-request-1',
    diagnosisRunId: 'diagnosis-run-1',
    outcome: null,
    stage: null,
    reason: null,
    outputAvailable: false,
    admittedAtMs: 100,
    finalizedAtMs: null,
    usage: null,
    ...overrides,
  };
}

test('defines separate run.read inspection and artifact.read output routes', () => {
  assert.deepEqual(CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}',
    operationId: 'copilot.failure_diagnosis.read',
    permission: 'run.read',
    projectParameter: 'projectId',
  });
  assert.deepEqual(
    CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_ROUTE,
    {
      method: 'GET',
      path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}/output',
      operationId: 'copilot.failure_diagnosis.output.read',
      permission: 'artifact.read',
      projectParameter: 'projectId',
    },
  );
});

test('projects a request-keyed running inspection and passes only trusted target facts', async () => {
  let command;
  const route = createClusterControlCopilotFailureDiagnosisInspectionRoute({
    async inspect(value) {
      command = value;
      return running();
    },
  });
  const request = authorized(
    '/api/v3/projects/project-1/runs/source-run-1/copilot/failure-diagnoses/diagnosis-request-1',
  );
  const result = await route.handle(request, parameters);
  assert.deepEqual(command, {
    principal: request.principal,
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'diagnosis-request-1',
  });
  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA,
      status: 'running',
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      requestId: 'diagnosis-request-1',
      diagnosisRunId: 'diagnosis-run-1',
      outcome: null,
      stage: null,
      reason: null,
      outputAvailable: false,
      admittedAtMs: 100,
      finalizedAtMs: null,
      usage: null,
    },
  });
});

test('projects terminal cancellation and settled Model usage without private fields', async () => {
  for (const [value, expected] of [
    [
      running({
        status: 'terminal',
        outcome: 'cancelled',
        stage: 'cancellation',
        reason: 'cancellation_requested',
        finalizedAtMs: 200,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          currency: 'USD',
          costMicros: 0,
        },
      }),
      'cancellation',
    ],
    [
      running({
        status: 'terminal',
        outcome: 'succeeded',
        stage: 'model',
        reason: null,
        outputAvailable: true,
        finalizedAtMs: 200,
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          currency: 'USD',
          costMicros: 29,
        },
      }),
      'model',
    ],
  ]) {
    const route = createClusterControlCopilotFailureDiagnosisInspectionRoute({
      async inspect() {
        return value;
      },
    });
    const result = await route.handle(authorized('/read'), parameters);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.stage, expected);
    assert.equal(JSON.stringify(result).includes('provider'), false);
    assert.equal(JSON.stringify(result).includes('modelId'), false);
  }
});

test('masks absent reads and fails closed on invalid input or widened results', async () => {
  let calls = 0;
  const route = createClusterControlCopilotFailureDiagnosisInspectionRoute({
    async inspect() {
      calls += 1;
      return {
        schema: 'qinglong/copilot-failure-diagnosis-inspection-result@v1',
        status: 'not_found',
        projectId: 'project-1',
        sourceRunId: 'source-run-1',
        requestId: 'diagnosis-request-1',
      };
    },
  });
  assert.equal(
    (await route.handle(authorized('/read'), parameters)).statusCode,
    404,
  );
  assert.equal(
    (await route.handle(authorized('/read', {}), parameters)).statusCode,
    400,
  );
  assert.equal(
    (
      await route.handle(authorized('/read'), {
        ...parameters,
        requestId: '../private',
      })
    ).statusCode,
    400,
  );
  assert.equal(calls, 1);

  const widened = createClusterControlCopilotFailureDiagnosisInspectionRoute({
    async inspect() {
      return running({ privateModel: 'must not cross' });
    },
  });
  assert.equal(
    (await widened.handle(authorized('/read'), parameters)).statusCode,
    503,
  );
});

test('returns only decrypted diagnosis content and low-sensitive Artifact metadata', async () => {
  let command;
  const route = createClusterControlCopilotFailureDiagnosisOutputReadRoute({
    async readOutput(value) {
      command = value;
      return {
        schema: 'qinglong/copilot-failure-diagnosis-output-read-result@v1',
        status: 'available',
        projectId: value.projectId,
        sourceRunId: value.sourceRunId,
        requestId: value.requestId,
        diagnosisRunId: 'diagnosis-run-1',
        reference: {
          artifactId: 'cdo:artifact-1',
          artifactDigest: 'a'.repeat(64),
          contentDigest: 'b'.repeat(64),
          outputBytes: Buffer.byteLength('diagnosis'),
          sealedAtMs: 200,
        },
        result: {
          text: 'diagnosis',
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      };
    },
  });
  const request = authorized('/output');
  request.operationId = 'copilot.failure_diagnosis.output.read';
  request.permission = 'artifact.read';
  const result = await route.handle(request, parameters);
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.body.schema,
    CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA,
  );
  assert.equal(result.body.result.text, 'diagnosis');
  assert.equal('provider' in result.body.result, false);
  assert.equal('model' in result.body.result, false);
  assert.equal(command.principal, request.principal);
});

test('masks absent output and maps dependency/cipher failures to one 503 code', async () => {
  const absent = createClusterControlCopilotFailureDiagnosisOutputReadRoute({
    async readOutput(value) {
      return {
        schema: 'qinglong/copilot-failure-diagnosis-output-read-result@v1',
        status: 'not_found',
        projectId: value.projectId,
        sourceRunId: value.sourceRunId,
        requestId: value.requestId,
      };
    },
  });
  assert.equal(
    (await absent.handle(authorized('/output'), parameters)).statusCode,
    404,
  );

  const unavailable =
    createClusterControlCopilotFailureDiagnosisOutputReadRoute({
      async readOutput() {
        throw new Error('private key failure');
      },
    });
  assert.deepEqual(
    await unavailable.handle(authorized('/output'), parameters),
    {
      statusCode: 503,
      body: { code: 'copilot_failure_diagnosis_output_read_unavailable' },
    },
  );
});
