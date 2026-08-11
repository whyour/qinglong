const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  WorkerCredentialManagementRequestError,
} = require('@qinglong/cluster-admin/worker-credential-management');
const {
  runClusterWorkerCredentialExecution,
} = require('@qinglong/cluster-admin/worker-credential-management-executor');

function options(overrides = {}) {
  let opens = 0;
  let sessions = 0;
  const value = {
    openDatabase: async () => {
      opens += 1;
      throw new Error('database must not open');
    },
    tokenRequestSession: {
      async withDelivery() {
        sessions += 1;
        throw new Error('TokenRequest must not start');
      },
    },
    workerCredentialPepper: 'pepper-value',
    actionRef: 'worker-credential:worker-a:generation-2',
    approvalRequestId: 'approval-worker-a-generation-2',
    consumptionId: 'consume-worker-a-generation-2',
    dispatchId: 'dispatch-worker-a-generation-2',
    auditEventId: '123e4567-e89b-42d3-a456-426614174705',
    confirmAuthorization: async () => {
      throw new Error('operator session expired');
    },
    now: () => 1_000,
    ...overrides,
  };
  return { value, opens: () => opens, sessions: () => sessions };
}

test('fails before PostgreSQL and TokenRequest when caller authorization is absent', async () => {
  const fixture = options();
  await assert.rejects(
    runClusterWorkerCredentialExecution(fixture.value),
    /operator session expired/,
  );
  assert.equal(fixture.opens(), 0);
  assert.equal(fixture.sessions(), 0);
});

test('rejects widened executor inputs before acquiring any authority', async () => {
  const fixture = options({ debug: true });
  await assert.rejects(
    runClusterWorkerCredentialExecution(fixture.value),
    WorkerCredentialManagementRequestError,
  );
  assert.equal(fixture.opens(), 0);
  assert.equal(fixture.sessions(), 0);
});
