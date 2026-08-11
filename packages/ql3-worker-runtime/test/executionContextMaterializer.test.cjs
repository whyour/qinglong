'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createClusterTaskExecutionRevision,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  createClusterRemoteExecutionOffer,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  digestRunDispatchLeaseToken,
} = require('@qinglong/runtime-core/run-dispatch-lease');
const {
  createSecretRef,
} = require('@qinglong/runtime-core/secret-reference');
const {
  BoundedWorkerRemoteExecutionContextMaterializer,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';

function secret(name) {
  return createSecretRef({ projectId: 'project-1', name });
}

function offer(environment) {
  const executionRevision = createClusterTaskExecutionRevision({
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    sourceRevision: 1,
    sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker',
    planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment,
    createdAtMs: 1,
  });
  return createClusterRemoteExecutionOffer({
    offerId: 'offer-materializer-1',
    deliveryKind: 'new_claim',
    executionDigest: executionRevision.contentDigest,
    candidate: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskRevision: TASK_REVISION,
      priority: 1,
      queuedAtMs: 10,
      attemptCreatedAtMs: 11,
      attemptNumber: 1,
      executorType: 'remote_worker',
    },
    worker: { workerId: 'edge-1', sessionId: SESSION_ID, generation: 2 },
    lease: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'leased',
      version: 0,
      leaseGeneration: 1,
      workerId: 'edge-1',
      workerSessionId: SESSION_ID,
      workerGeneration: 2,
      leaseTokenDigest: digestRunDispatchLeaseToken(LEASE_TOKEN),
      acquiredAtMs: 20,
      renewedAtMs: 20,
      expiresAtMs: 30_020,
      updatedAtMs: 20,
    },
    leaseToken: LEASE_TOKEN,
    executionRevision,
    placementScore: 0,
  });
}

test('resolves deduplicated Secrets before allocating one Attempt log', async () => {
  const secretRef = secret('shared');
  const acceptedOffer = offer([
    { name: 'PUBLIC', kind: 'public', value: 'visible' },
    { name: 'SECRET_A', kind: 'secret', secretRef },
    { name: 'SECRET_B', kind: 'secret', secretRef },
  ]);
  const events = [];
  let secretRequest;
  let artifactRequest;
  const output = {
    logArtifactId: 'remote-log-1',
    async write() {},
    async close() {},
  };
  const materializer = new BoundedWorkerRemoteExecutionContextMaterializer({
    secrets: {
      async resolve(request) {
        events.push('secrets');
        secretRequest = request;
        return {
          values: [{ secretRef, value: 'resolved-value' }],
          dispose() { events.push('dispose-secrets'); },
        };
      },
    },
    artifacts: {
      async prepare(request) {
        events.push('artifact');
        artifactRequest = request;
        return {
          logArtifactId: 'remote-log-1',
          takeOutput() { events.push('take-output'); return output; },
          release() { events.push('release-artifact'); },
        };
      },
    },
  });
  const context = await materializer.prepare({
    offer: acceptedOffer,
    completionCallback: { sequence: 1, token: Buffer.alloc(32) },
  });
  assert.deepEqual(secretRequest, {
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-materializer-1',
    executionDigest: acceptedOffer.executionDigest,
    secretRefs: [secretRef],
  });
  assert.deepEqual(artifactRequest, {
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-materializer-1',
  });
  assert.equal(JSON.stringify([secretRequest, artifactRequest]).includes(LEASE_TOKEN), false);
  assert.deepEqual(context.environment, [
    { name: 'PUBLIC', value: 'visible' },
    { name: 'SECRET_A', value: 'resolved-value' },
    { name: 'SECRET_B', value: 'resolved-value' },
  ]);
  assert.equal(context.logArtifactId, 'remote-log-1');
  assert.deepEqual(events, ['secrets', 'artifact']);
  assert.equal(context.takeOutput(), output);
  assert.throws(() => context.takeOutput(), /artifact_response_invalid/);
  await context.dispose();
  await context.dispose();
  assert.deepEqual(events.slice(2).sort(), [
    'dispose-secrets', 'release-artifact', 'take-output',
  ]);
});

test('fails before Artifact allocation when Secret authority is unavailable', async () => {
  let artifacts = 0;
  const materializer = new BoundedWorkerRemoteExecutionContextMaterializer({
    artifacts: { async prepare() { artifacts += 1; } },
  });
  await assert.rejects(
    materializer.prepare({
      offer: offer([{ name: 'SECRET', kind: 'secret', secretRef: secret('one') }]),
    }),
    /secret_unavailable/,
  );
  assert.equal(artifacts, 0);
});

test('disposes malformed Secret and Artifact responses without exposing values', async () => {
  let disposedSecrets = 0;
  let releasedArtifact = 0;
  const secretRef = secret('one');
  const malformedSecrets = new BoundedWorkerRemoteExecutionContextMaterializer({
    secrets: {
      async resolve() {
        return {
          values: [
            { secretRef, value: 'first' },
            { secretRef, value: 'duplicate' },
          ],
          dispose() { disposedSecrets += 1; },
        };
      },
    },
    artifacts: { async prepare() { throw new Error('must not allocate'); } },
  });
  await assert.rejects(
    malformedSecrets.prepare({
      offer: offer([
        { name: 'A', kind: 'secret', secretRef },
        { name: 'B', kind: 'secret', secretRef: secret('two') },
      ]),
    }),
    /secret_response_invalid/,
  );
  assert.equal(disposedSecrets, 1);

  const malformedArtifact = new BoundedWorkerRemoteExecutionContextMaterializer({
    artifacts: {
      async prepare() {
        return {
          logArtifactId: 'x'.repeat(37),
          release() { releasedArtifact += 1; },
        };
      },
    },
  });
  await assert.rejects(
    malformedArtifact.prepare({
      offer: offer([{ name: 'PUBLIC', kind: 'public', value: 'visible' }]),
    }),
    /artifact_response_invalid/,
  );
  assert.equal(releasedArtifact, 1);
});

test('enforces the resolved environment byte budget before Artifact allocation', async () => {
  const bindings = Array.from({ length: 5 }, (_, index) => ({
    name: `SECRET_${index}`,
    kind: 'secret',
    secretRef: secret(`item-${index}`),
  }));
  let disposed = 0;
  let artifacts = 0;
  const materializer = new BoundedWorkerRemoteExecutionContextMaterializer({
    secrets: {
      async resolve(request) {
        return {
          values: request.secretRefs.map((secretRef) => ({
            secretRef,
            value: 'x'.repeat(16 * 1024),
          })),
          dispose() { disposed += 1; },
        };
      },
    },
    artifacts: { async prepare() { artifacts += 1; } },
  });
  await assert.rejects(
    materializer.prepare({ offer: offer(bindings) }),
    /environment_budget_exceeded/,
  );
  assert.equal(disposed, 1);
  assert.equal(artifacts, 0);
});
