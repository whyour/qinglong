const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerExecutionAttestationFenceRejectedError,
} = require('@qinglong/runtime-core/worker-attestation');
const {
  RemoteRunActivationFenceRejectedError,
  RemoteRunActivationUnavailableError,
} = require('@qinglong/runtime-core/remote-activation');
const {
  createWorkerIngressAdmissionPipeline,
} = require('@qinglong/cluster-control/worker-ingress');
const {
  createClusterTaskExecutionRevision,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  digestRunDispatchLeaseToken,
} = require('@qinglong/runtime-core');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  RemoteWorkerSecretDeliveryFenceRejectedError,
} = require('@qinglong/runtime-core/remote-secret-delivery');
const {
  REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
  RemoteWorkerCompletionFenceRejectedError,
  createRemoteWorkerCompletionRequestBody,
} = require('@qinglong/runtime-core/remote-worker-completion');
const {
  WORKER_SESSION_HEARTBEAT_SCHEMA,
  WORKER_SESSION_REGISTER_SCHEMA,
  WORKER_SESSION_TRANSITION_SCHEMA,
} = require('@qinglong/runtime-core/worker-session-transport');
const {
  RemoteWorkerLeaseControlFenceRejectedError,
  RemoteWorkerLeaseControlUnavailableError,
} = require('@qinglong/runtime-core/remote-worker-lease-control');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';
const CAPABILITIES_JSON =
  '{"architecture":"arm64","executors":["remote-worker"],"protocolVersion":"1.0.0","supportTier":"tier1"}';
const CAPABILITIES_HASH =
  'b3d79017d91c477ffdf4a4dcc4ce9135ca053c921922ce0221920f905d8a2aa4';

function metadata(operation, workerId = 'edge-1') {
  return {
    requestId: 'request-1',
    method: 'POST',
    path: `/api/v3/worker-ingress/workers/${workerId}/sessions/${SESSION_ID}/${operation}`,
    query: Object.freeze({}),
    headers: Object.freeze({ authorization: 'Worker token' }),
    signal: new AbortController().signal,
  };
}

function principal(workerId = 'edge-1') {
  return Object.freeze({
    workerId,
    credentialId: 'worker_primary',
    credentialVersion: 1,
    authenticationId: 'worker_credential:worker_primary:1',
    authenticatedAtMs: 1,
    expiresAtMs: 60_001,
  });
}

function fixture(overrides = {}) {
  const events = [];
  const pipeline = createWorkerIngressAdmissionPipeline({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return principal();
      },
    },
    workers: {
      async register() { throw new Error('not used'); },
      async heartbeatAuthenticated(command, credential) {
        events.push(
          `heartbeat:${command.expectedVersion}:${credential.credentialId}:${credential.credentialVersion}`,
        );
        return {
          workerId: command.workerId,
          sessionId: command.sessionId,
          generation: command.generation,
          version: command.expectedVersion + 1,
          status: 'online',
          capabilitiesJson: CAPABILITIES_JSON,
          capabilitiesHash: CAPABILITIES_HASH,
          maxConcurrentRuns: 1,
          availableSlots: command.availableSlots,
          registeredAtMs: 1,
          lastHeartbeatAtMs: 2,
          leaseExpiresAtMs: 50_000,
          updatedAtMs: 2,
        };
      },
      async transitionAuthenticated() { throw new Error('not used'); },
      async find() { return null; },
    },
    attestations: {
      async submit(command) {
        events.push(`attest:${command.sequence}`);
        return {
          status: 'created',
          attestation: { ...command, receivedAtMs: 20_000 },
        };
      },
      async findLatestExact() { return null; },
    },
    audit: {
      async record(record) {
        events.push(`audit:${record.outcome}`);
      },
    },
    now: () => 10_000,
    ...overrides,
  });
  return { pipeline, events };
}

test('authenticates and durably audits before accepting a heartbeat body', async () => {
  const { pipeline, events } = fixture();
  const prepared = await pipeline.prepare(metadata('heartbeat'));
  assert.deepEqual(events, ['authenticate', 'audit:allowed']);
  const response = await prepared.handle({
    schema: WORKER_SESSION_HEARTBEAT_SCHEMA,
    generation: 2,
    expectedVersion: 3,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    schema: WORKER_SESSION_HEARTBEAT_SCHEMA,
    workerId: 'edge-1',
    sessionId: SESSION_ID,
    generation: 2,
    version: 4,
    status: 'online',
    leaseExpiresAtMs: 50_000,
  });
  assert.deepEqual(events, [
    'authenticate',
    'audit:allowed',
    'heartbeat:3:worker_primary:1',
  ]);
});

test('uses exact versioned register and transition contracts', async () => {
  const baseRecord = {
    workerId: 'edge-1',
    sessionId: SESSION_ID,
    generation: 1,
    version: 0,
    status: 'online',
    capabilitiesJson: CAPABILITIES_JSON,
    capabilitiesHash: CAPABILITIES_HASH,
    maxConcurrentRuns: 1,
    availableSlots: 1,
    registeredAtMs: 1,
    lastHeartbeatAtMs: 1,
    leaseExpiresAtMs: 50_000,
    updatedAtMs: 1,
  };
  const context = fixture({
    workers: {
      async register(command) {
        return { worker: { ...baseRecord, ...command }, replacedSession: false };
      },
      async heartbeatAuthenticated() { throw new Error('not used'); },
      async transitionAuthenticated(command, credential) {
        assert.deepEqual(credential, {
          workerId: 'edge-1',
          credentialId: 'worker_primary',
          credentialVersion: 1,
        });
        return {
          ...baseRecord,
          version: command.expectedVersion + 1,
          status: command.status,
          availableSlots: 0,
          updatedAtMs: 2,
        };
      },
      async findById() { return null; },
      async listAvailable() { throw new Error('not used'); },
    },
  });
  const register = await (
    await context.pipeline.prepare(metadata('register'))
  ).handle({
    schema: WORKER_SESSION_REGISTER_SCHEMA,
    capabilitiesJson: CAPABILITIES_JSON,
    capabilitiesHash: baseRecord.capabilitiesHash,
    maxConcurrentRuns: 1,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  });
  assert.equal(register.statusCode, 200);
  assert.equal(register.body.schema, WORKER_SESSION_REGISTER_SCHEMA);
  const transition = await (
    await context.pipeline.prepare(metadata('transition'))
  ).handle({
    schema: WORKER_SESSION_TRANSITION_SCHEMA,
    generation: 1,
    expectedVersion: 0,
    status: 'draining',
  });
  assert.equal(transition.body.schema, WORKER_SESSION_TRANSITION_SCHEMA);
  assert.equal(transition.body.status, 'draining');
});

test('rejects unversioned Worker capabilities before repository registration', async () => {
  let registered = false;
  const context = fixture({
    workers: {
      async register() { registered = true; throw new Error('must not register'); },
      async heartbeatAuthenticated() { throw new Error('not used'); },
      async transitionAuthenticated() { throw new Error('not used'); },
      async findById() { return null; },
      async listAvailable() { throw new Error('not used'); },
    },
  });
  const prepared = await context.pipeline.prepare(metadata('register'));
  await assert.rejects(prepared.handle({
    schema: WORKER_SESSION_REGISTER_SCHEMA,
    capabilitiesJson: '{}',
    capabilitiesHash:
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    maxConcurrentRuns: 1,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  }), (error) =>
    error.statusCode === 400 && error.code === 'invalid_worker_request');
  assert.equal(registered, false);
});

test('binds the credential Worker to the path and rejects before body access', async () => {
  const { pipeline, events } = fixture();
  await assert.rejects(
    pipeline.prepare(metadata('heartbeat', 'other-worker')),
    (error) => error.statusCode === 401 && error.code === 'worker_authentication_required',
  );
  assert.deepEqual(events, ['authenticate', 'audit:authentication_rejected']);
});

test('forwards the complete execution fence and maps stale attestations to conflict', async () => {
  let observed;
  const { pipeline } = fixture({
    attestations: {
      async submit(command) {
        observed = command;
        throw new WorkerExecutionAttestationFenceRejectedError('authority_mismatch');
      },
      async findLatestExact() { return null; },
    },
  });
  const prepared = await pipeline.prepare(metadata('attestations'));
  const body = {
    attestationId: '018f5c64-9b9d-7f1a-8c2d-1234567890ab',
    runId: 'run-1',
    attemptId: 'attempt-1',
    sequence: 1,
    state: 'running',
    workerGeneration: 2,
    leaseTokenDigest: 'a'.repeat(64),
    leaseGeneration: 3,
    leaseVersion: 4,
    offerId: 'offer-1',
    callbackSequence: 5,
    executorHandle: 'remote:handle-1',
    journalRevision: 6,
  };
  await assert.rejects(
    prepared.handle(body),
    (error) => error.statusCode === 409 && error.code === 'worker_attestation_fenced',
  );
  assert.deepEqual(observed, {
    ...body,
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
  });
});

test('fails closed when authentication or durable audit is unavailable', async () => {
  const unavailableAuth = fixture({
    authenticator: { async authenticate() { throw new Error('down'); } },
  });
  await assert.rejects(
    unavailableAuth.pipeline.prepare(metadata('heartbeat')),
    (error) => error.statusCode === 503 && error.code === 'worker_authentication_unavailable',
  );
  const unavailableAudit = fixture({
    audit: { async record() { throw new Error('down'); } },
  });
  await assert.rejects(
    unavailableAudit.pipeline.prepare(metadata('heartbeat')),
    (error) => error.statusCode === 503 && error.code === 'worker_audit_unavailable',
  );
});

test('binds pull-based offer claims to the authenticated Session without echoing the lease token', async () => {
  let observed;
  const sourceDigest = 'b'.repeat(64);
  const taskRevision = `qltd:v1:1:${sourceDigest}`;
  const executionRevision = createClusterTaskExecutionRevision({
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision,
    sourceRevision: 1,
    sourceContentDigest: sourceDigest,
    executorType: 'remote_worker',
    planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment: [],
    createdAtMs: 1,
  });
  const { pipeline, events } = fixture({
    offers: {
      async claimNext(principal, command) {
        observed = { principal, command };
        return {
          status: 'offered',
          offer: {
            offerId: command.offerId,
            deliveryKind: 'new_claim',
            executionDigest: executionRevision.contentDigest,
            candidate: {
              runId: 'run-1',
              attemptId: 'attempt-1',
              projectId: 'project-1',
              taskId: 'task-1',
              taskRevision,
              priority: 0,
              queuedAtMs: 1,
              attemptCreatedAtMs: 1,
              attemptNumber: 1,
              executorType: 'remote_worker',
            },
            worker: {
              workerId: principal.workerId,
              sessionId: command.workerSessionId,
              generation: command.workerGeneration,
            },
            lease: {
              attemptId: 'attempt-1',
              runId: 'run-1',
              status: 'leased',
              version: 0,
              leaseGeneration: 1,
              workerId: principal.workerId,
              workerSessionId: command.workerSessionId,
              workerGeneration: command.workerGeneration,
              leaseTokenDigest: digestRunDispatchLeaseToken(command.leaseToken),
              acquiredAtMs: 10,
              renewedAtMs: 10,
              expiresAtMs: 30_010,
              updatedAtMs: 10,
            },
            leaseToken: command.leaseToken,
            executionRevision,
            placementScore: 0,
          },
          stats: {
            pages: 1,
            candidates: 1,
            plansUnavailable: 0,
            placementMismatches: 0,
            claimAttempts: 1,
            claimRaces: 0,
          },
          truncated: false,
        };
      },
    },
  });
  const leaseToken = 'worker_generated_lease_capability_0000000000000001';
  const prepared = await pipeline.prepare(metadata('offers'));
  const result = await prepared.handle({
    workerGeneration: 2,
    offerId: 'offer-1',
    leaseToken,
  });
  assert.deepEqual(observed, {
    principal: { workerId: 'edge-1' },
    command: {
      workerSessionId: SESSION_ID,
      workerGeneration: 2,
      offerId: 'offer-1',
      leaseToken,
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'offered');
  assert.equal(result.body.schema, 'qinglong/remote-execution-offer@v1');
  assert.equal('leaseToken' in result.body.offer, false);
  assert.equal('leaseTokenDigest' in result.body.offer.lease, false);
  assert.deepEqual(events, ['authenticate', 'audit:allowed']);
});

test('maps an internally malformed offer projection to unavailable, not a client error', async () => {
  const { pipeline } = fixture({
    offers: {
      async claimNext() {
        return {
          status: 'offered',
          offer: { offerId: 'broken' },
          stats: {
            pages: 1,
            candidates: 1,
            plansUnavailable: 0,
            placementMismatches: 0,
            claimAttempts: 1,
            claimRaces: 0,
          },
          truncated: false,
        };
      },
    },
  });
  await assert.rejects(
    (await pipeline.prepare(metadata('offers'))).handle({
      workerGeneration: 2,
      offerId: 'offer-1',
      leaseToken: 'worker_generated_lease_capability_0000000000000001',
    }),
    (error) =>
      error.statusCode === 503 && error.code === 'worker_ingress_unavailable',
  );
});

test('binds activation ACKs to the authenticated Worker and never echoes capabilities', async () => {
  const observed = [];
  const activation = {
    async acknowledgeStarting(principal, command) {
      observed.push(['starting', principal, command]);
      return {
        status: 'applied',
        snapshot: {
          runId: command.runId,
          attemptId: command.attemptId,
          runStatus: 'dispatching',
          attemptStatus: 'starting',
          leaseVersion: command.expectedLeaseVersion,
          leaseGeneration: command.leaseGeneration,
          callbackSequence: 0,
        },
      };
    },
    async acknowledgeRunning(principal, command) {
      observed.push(['running', principal, command]);
      return {
        status: 'applied',
        snapshot: {
          runId: command.runId,
          attemptId: command.attemptId,
          runStatus: 'running',
          attemptStatus: 'running',
          leaseVersion: command.expectedLeaseVersion,
          leaseGeneration: command.leaseGeneration,
          callbackSequence: command.callbackSequence,
          executorHandle: command.executorHandle,
          startedAtMs: 20_000,
        },
      };
    },
    async failStart(principal, command) {
      observed.push(['start-failure', principal, command]);
      return {
        status: 'already_terminal',
        snapshot: {
          runId: command.runId,
          attemptId: command.attemptId,
          runStatus: 'failed',
          attemptStatus: 'failed',
          leaseVersion: command.expectedLeaseVersion + 1,
          leaseGeneration: command.leaseGeneration,
          callbackSequence: 1,
          finishedAtMs: 20_000,
          errorCode: 'executor_start_rejected',
        },
      };
    },
  };
  const base = {
    runId: 'run-1',
    attemptId: 'attempt-1',
    workerGeneration: 2,
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4,
  };
  const { pipeline } = fixture({ activation });
  const starting = await (await pipeline.prepare(metadata('starting'))).handle(base);
  const running = await (await pipeline.prepare(metadata('running'))).handle({
    ...base,
    executorHandle: 'remote:handle-1',
    logArtifactId: null,
    callbackSequence: 1,
    callbackTokenDigest: 'a'.repeat(64),
  });
  const failed = await (await pipeline.prepare(metadata('start-failure'))).handle(base);
  assert.equal(starting.statusCode, 200);
  assert.equal(running.statusCode, 200);
  assert.equal(failed.statusCode, 200);
  assert.deepEqual(
    [starting.body.schema, running.body.schema, failed.body.schema],
    Array(3).fill('qinglong/remote-run-activation@v1'),
  );
  assert.equal(JSON.stringify([starting.body, running.body, failed.body]).includes(base.leaseToken), false);
  assert.equal(JSON.stringify([starting.body, running.body, failed.body]).includes('a'.repeat(64)), false);
  assert.deepEqual(observed, [
    ['starting', { workerId: 'edge-1' }, {
      ...base, workerSessionId: SESSION_ID,
    }],
    ['running', { workerId: 'edge-1' }, {
      ...base,
      workerSessionId: SESSION_ID,
      executorHandle: 'remote:handle-1',
      callbackSequence: 1,
      callbackTokenDigest: 'a'.repeat(64),
    }],
    ['start-failure', { workerId: 'edge-1' }, {
      ...base, workerSessionId: SESSION_ID,
    }],
  ]);
});

test('maps stale activation authority to conflict', async () => {
  const fenced = async () => {
    throw new RemoteRunActivationFenceRejectedError('attempt-1', 'version_mismatch');
  };
  const { pipeline } = fixture({
    activation: {
      acknowledgeStarting: fenced,
      acknowledgeRunning: fenced,
      failStart: fenced,
    },
  });
  await assert.rejects(
    (await pipeline.prepare(metadata('starting'))).handle({
      runId: 'run-1',
      attemptId: 'attempt-1',
      workerGeneration: 2,
      offerId: 'offer-1',
      leaseGeneration: 3,
      leaseToken: 'worker_generated_lease_capability_0000000000000001',
      expectedLeaseVersion: 4,
    }),
    (error) => error.statusCode === 409 && error.code === 'worker_activation_fenced',
  );
});

test('maps activation storage failures to unavailable', async () => {
  const unavailable = async () => {
    throw new RemoteRunActivationUnavailableError();
  };
  const { pipeline } = fixture({
    activation: {
      acknowledgeStarting: unavailable,
      acknowledgeRunning: unavailable,
      failStart: unavailable,
    },
  });
  await assert.rejects(
    (await pipeline.prepare(metadata('starting'))).handle({
      runId: 'run-1',
      attemptId: 'attempt-1',
      workerGeneration: 2,
      offerId: 'offer-1',
      leaseGeneration: 3,
      leaseToken: 'worker_generated_lease_capability_0000000000000001',
      expectedLeaseVersion: 4,
    }),
    (error) => error.statusCode === 503 && error.code === 'worker_ingress_unavailable',
  );
});

test('binds one Secret batch to path identity and never echoes capabilities', async () => {
  const secretRef = createSecretRef({ projectId: 'project-1', name: 'token' });
  const executionDigest = 'c'.repeat(64);
  let observed;
  let disposed = 0;
  const { pipeline } = fixture({
    secrets: {
      async deliver(principal, command) {
        observed = { principal, command };
        return {
          runId: command.runId,
          attemptId: command.attemptId,
          offerId: command.offerId,
          executionDigest: command.executionDigest,
          values: [{ secretRef, value: 'resolved-value' }],
          dispose() { disposed += 1; },
        };
      },
    },
  });
  const leaseToken = 'worker_generated_lease_capability_0000000000000001';
  const body = {
    schema: 'qinglong/remote-secret-delivery@v1',
    runId: 'run-1', attemptId: 'attempt-1', projectId: 'project-1',
    taskId: 'task-1', taskRevision: 'revision-1', executionDigest,
    workerGeneration: 2, offerId: 'offer-1', leaseGeneration: 3,
    leaseToken, expectedLeaseVersion: 4, secretRefs: [secretRef],
  };
  const result = await (await pipeline.prepare(metadata('secrets'))).handle(body);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.schema, 'qinglong/remote-secret-delivery@v1');
  assert.deepEqual(result.body.values, [
    { secretRef, value: 'resolved-value' },
  ]);
  assert.equal(JSON.stringify(result.body).includes(leaseToken), false);
  const { schema: _schema, ...commandBody } = body;
  assert.deepEqual(observed, {
    principal: { workerId: 'edge-1' },
    command: {
      ...commandBody,
      workerSessionId: SESSION_ID,
    },
  });
  assert.equal(disposed, 1);
});

test('maps stale Secret delivery authority to conflict before any response', async () => {
  const secretRef = createSecretRef({ projectId: 'project-1', name: 'token' });
  const { pipeline } = fixture({
    secrets: {
      async deliver() {
        throw new RemoteWorkerSecretDeliveryFenceRejectedError('authority_mismatch');
      },
    },
  });
  await assert.rejects(
    (await pipeline.prepare(metadata('secrets'))).handle({
      schema: 'qinglong/remote-secret-delivery@v1',
      runId: 'run-1', attemptId: 'attempt-1', projectId: 'project-1',
      taskId: 'task-1', taskRevision: 'revision-1',
      executionDigest: 'c'.repeat(64), workerGeneration: 2,
      offerId: 'offer-1', leaseGeneration: 3,
      leaseToken: 'worker_generated_lease_capability_0000000000000001',
      expectedLeaseVersion: 4, secretRefs: [secretRef],
    }),
    (error) =>
      error.statusCode === 409 && error.code === 'worker_secret_delivery_fenced',
  );
});

test('rejects a Secret service response whose authority drifts', async () => {
  const secretRef = createSecretRef({ projectId: 'project-1', name: 'token' });
  const { pipeline } = fixture({
    secrets: {
      async deliver(command) {
        return {
          runId: 'run-other', attemptId: 'attempt-1', offerId: 'offer-1',
          executionDigest: 'c'.repeat(64),
          values: [{ secretRef, value: 'must-not-escape' }],
        };
      },
    },
  });
  await assert.rejects(
    (await pipeline.prepare(metadata('secrets'))).handle({
      schema: 'qinglong/remote-secret-delivery@v1',
      runId: 'run-1', attemptId: 'attempt-1', projectId: 'project-1',
      taskId: 'task-1', taskRevision: 'revision-1',
      executionDigest: 'c'.repeat(64), workerGeneration: 2,
      offerId: 'offer-1', leaseGeneration: 3,
      leaseToken: 'worker_generated_lease_capability_0000000000000001',
      expectedLeaseVersion: 4, secretRefs: [secretRef],
    }),
    (error) =>
      error.statusCode === 503 && error.code === 'worker_ingress_unavailable',
  );
});

test('authenticates and audits before exposing one bounded Artifact stream', async () => {
  const content = Buffer.from('worker-log');
  let observed;
  const { pipeline, events } = fixture({
    artifacts: {
      async upload(input) {
        const chunks = [];
        for await (const chunk of input.chunks) chunks.push(Buffer.from(chunk));
        observed = { ...input, chunks: undefined, content: Buffer.concat(chunks) };
        return {
          status: 'stored',
          projectId: 'project-1',
          runId: 'run-1',
          attemptId: 'attempt-1',
          logArtifactId: `wlog-${'a'.repeat(30)}`,
          byteLength: content.byteLength,
          sha256: 'b'.repeat(64),
          truncated: false,
        };
      },
    },
  });
  const request = metadata('artifacts');
  const prepared = await pipeline.prepare(request);
  assert.deepEqual(events, ['authenticate', 'audit:allowed']);
  assert.equal(prepared.bodyMode, 'stream');
  assert.equal(prepared.contentType, REMOTE_WORKER_ARTIFACT_CONTENT_TYPE);
  assert.equal(prepared.maximumBodyBytes, 64 * 1024 * 1024 + 4 * 1024 + 4);
  const result = await prepared.handleStream({
    contentLength: content.byteLength,
    contentType: REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
    chunks: (async function* () { yield content; })(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.schema, 'qinglong/remote-worker-artifact-upload@v1');
  assert.equal(result.body.sha256, 'b'.repeat(64));
  assert.equal(observed.workerId, 'edge-1');
  assert.equal(observed.workerSessionId, SESSION_ID);
  assert.equal(observed.contentLength, content.byteLength);
  assert.equal(observed.signal, request.signal);
  assert.deepEqual(observed.content, content);
});

test('binds completion JSON to path identity and maps stale authority', async () => {
  const command = {
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4,
    callbackSequence: 1,
    callbackTokenDigest: 'c'.repeat(64),
    result: {
      outcome: 'succeeded',
      startedAtMs: 100,
      finishedAtMs: 200,
      exitCode: 0,
    },
    artifact: {
      logArtifactId: `wlog-${'a'.repeat(30)}`,
      byteLength: 10,
      sha256: 'b'.repeat(64),
      truncated: false,
    },
  };
  let observed;
  const { pipeline } = fixture({
    completion: {
      async complete(value, signal) {
        observed = { value, signal };
        return {
          status: 'applied',
          runId: value.runId,
          attemptId: value.attemptId,
          callbackSequence: value.callbackSequence,
        };
      },
    },
  });
  const request = metadata('completion');
  const result = await (await pipeline.prepare(request)).handle(
    createRemoteWorkerCompletionRequestBody(command),
  );
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    schema: 'qinglong/remote-worker-completion@v1',
    status: 'applied',
    runId: 'run-1',
    attemptId: 'attempt-1',
    callbackSequence: 1,
  });
  assert.deepEqual(observed.value, command);
  assert.equal(observed.signal, request.signal);

  const fenced = fixture({
    completion: {
      async complete() {
        throw new RemoteWorkerCompletionFenceRejectedError(
          'attempt-1',
          'authority_mismatch',
        );
      },
    },
  });
  await assert.rejects(
    (await fenced.pipeline.prepare(metadata('completion'))).handle(
      createRemoteWorkerCompletionRequestBody(command),
    ),
    (error) =>
      error.statusCode === 409 && error.code === 'worker_completion_fenced',
  );
});

test('binds lease control to path authority and returns a capability-free response', async () => {
  const leaseToken = 'worker_generated_lease_capability_0000000000000001';
  let observed;
  const { pipeline } = fixture({
    leaseControl: {
      async control(command) {
        observed = command;
        return {
          status: 'stop_requested',
          projectId: command.projectId,
          runId: command.runId,
          attemptId: command.attemptId,
          offerId: command.offerId,
          leaseGeneration: command.leaseGeneration,
          leaseVersion: command.expectedLeaseVersion + 1,
          renewedAtMs: 20_000,
          expiresAtMs: 50_000,
          stop: { reason: 'timeout', requestedAtMs: 19_000 },
        };
      },
    },
  });
  const result = await (await pipeline.prepare(metadata('lease-control'))).handle({
    schema: 'qinglong/remote-worker-lease-control@v1',
    workerGeneration: 2,
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken,
    expectedLeaseVersion: 4,
  });
  assert.deepEqual(observed, {
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken,
    expectedLeaseVersion: 4,
  });
  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      schema: 'qinglong/remote-worker-lease-control@v1',
      status: 'stop_requested',
      projectId: 'project-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      offerId: 'offer-1',
      leaseGeneration: 3,
      leaseVersion: 5,
      renewedAtMs: 20_000,
      expiresAtMs: 50_000,
      stop: { reason: 'timeout', requestedAtMs: 19_000 },
      terminalStatus: null,
    },
  });
  assert.equal(JSON.stringify(result).includes(leaseToken), false);
});

test('maps fenced and unavailable lease control without leaking authority', async () => {
  const body = {
    schema: 'qinglong/remote-worker-lease-control@v1',
    workerGeneration: 2,
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4,
  };
  const fenced = fixture({
    leaseControl: {
      async control() {
        throw new RemoteWorkerLeaseControlFenceRejectedError(
          'attempt-1', 'version_mismatch',
        );
      },
    },
  });
  await assert.rejects(
    (await fenced.pipeline.prepare(metadata('lease-control'))).handle(body),
    (error) => error.statusCode === 409 && error.code === 'worker_lease_control_fenced',
  );
  const unavailable = fixture({
    leaseControl: {
      async control() { throw new RemoteWorkerLeaseControlUnavailableError(); },
    },
  });
  await assert.rejects(
    (await unavailable.pipeline.prepare(metadata('lease-control'))).handle(body),
    (error) => error.statusCode === 503 && error.code === 'worker_ingress_unavailable',
  );
});
