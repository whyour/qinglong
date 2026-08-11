require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerExecutionOfferRecoveryReconciler,
} = require('../../back/runtime/application/workerExecutionOfferRecoveryReconciler');
const {
  Sha256WorkerExecutionCompletionReceiptAuthenticator,
} = require('../../back/runtime/adapters/crypto/sha256WorkerExecutionCompletionReceiptAuthenticator');
const {
  createWorkerExecutionOfferJournalRecord,
} = require('../../back/runtime/domain/workerExecutionOffer');
const {
  createWorkerExecutionCompletionReceiptAuthentication,
} = require('../../back/runtime/domain/workerExecutionCompletionReceiptAuthentication');
const {
  createExecutionSpecDigest,
  createRunDispatchOfferId,
} = require('../../back/runtime/domain/runDispatchOffer');

const START = 1_760_700_000_000;
const RUN_ID = '019f8100-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f8100-0000-7000-8000-000000000002';
const SESSION_A = '019f8100-0000-7000-8000-000000000003';
const SESSION_B = '019f8100-0000-7000-8000-000000000004';
const TOKEN = 'receipt_capability_abcdefghijklmnopqrstuvwxyz012345';

function offer(overrides = {}) {
  const lease = {
    attemptId: ATTEMPT_ID,
    runId: RUN_ID,
    status: 'leased',
    version: 2,
    leaseGeneration: 1,
    workerId: 'worker-edge',
    workerSessionId: SESSION_A,
    workerGeneration: 1,
    leaseToken: 'lease_capability_abcdefghijklmnopqrstuvwxyz0123456',
    acquiredAtMs: START,
    renewedAtMs: START,
    expiresAtMs: START + 60_000,
    updatedAtMs: START,
    ...overrides.lease,
  };
  const executionSpec = {
    runId: lease.runId,
    attemptId: lease.attemptId,
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environmentPolicy: 'isolated',
    terminationGraceMs: 1_000,
  };
  return {
    offerId: createRunDispatchOfferId(lease),
    executionSpecDigest: createExecutionSpecDigest(executionSpec),
    deliveryKind: 'lease_recovery',
    candidate: {
      runId: lease.runId,
      attemptId: lease.attemptId,
      projectId: 'default',
      taskId: 'task-1',
      taskRevision: 'revision-1',
      executorType: 'remote_worker',
      priority: 0,
      queuedAtMs: START,
      attemptCreatedAtMs: START,
    },
    worker: {
      id: lease.workerId,
      sessionId: lease.workerSessionId,
      generation: lease.workerGeneration,
    },
    lease,
    executionSpec,
  };
}

function record(state = 'started', overrides = {}) {
  const initial = createWorkerExecutionOfferJournalRecord(
    offer(overrides.offer),
    START,
  );
  if (state === 'accepted') return initial;
  const withHandle =
    state === 'started' ||
    state === 'running_acknowledged' ||
    overrides.withHandle;
  const canOwnExecution = [
    'launching',
    'started',
    'running_acknowledged',
    'recovery_required',
  ].includes(state);
  const authentication = canOwnExecution
    ? createWorkerExecutionCompletionReceiptAuthentication({
        token: TOKEN,
        callbackSequence: 1,
      })
    : undefined;
  return {
    ...initial,
    revision: 1,
    state,
    updatedAtMs: START + 10,
    ...(withHandle
      ? {
          executorHandle: 'ql3lp1.durable-handle',
          executorStartedAtMs: START + 5,
        }
      : {}),
    ...(authentication === undefined
      ? {}
      : {
          completionReceiptCallbackSequence: authentication.callbackSequence,
          completionReceiptTokenDigest: authentication.tokenDigest,
        }),
    ...(state === 'recovery_required'
      ? {
          recoveryReason: overrides.recoveryReason || 'launch_outcome_unknown',
        }
      : {}),
  };
}

function session(overrides = {}) {
  return {
    id: 'worker-edge',
    sessionId: SESSION_A,
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: { memoryBytes: 256 * 1024 * 1024 },
      features: ['direct_file_log'],
    },
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: START,
    lastHeartbeatAtMs: START,
    leaseExpiresAtMs: START + 120_000,
    updatedAtMs: START,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    token: TOKEN,
    startedAtMs: START + 5,
    finishedAtMs: START + 50,
    exitCode: 0,
    ...overrides,
  };
}

function reconciler(options = {}) {
  const calls = [];
  const receiptValues = [...(options.receipts || [undefined])];
  const authenticator =
    options.authenticate === undefined
      ? new Sha256WorkerExecutionCompletionReceiptAuthenticator()
      : {
          async authenticate(candidate) {
            calls.push(['authenticate', candidate.attemptId]);
            if (options.authenticate instanceof Error) {
              throw options.authenticate;
            }
            return options.authenticate;
          },
        };
  const value = new WorkerExecutionOfferRecoveryReconciler(
    {
      async read(attemptId) {
        calls.push(['receipt', attemptId]);
        const next = receiptValues.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    authenticator,
    {
      executorType: 'local_process',
      async inspect(handle) {
        calls.push(['inspect', handle]);
        if (options.inspection instanceof Error) throw options.inspection;
        return options.inspection || { status: 'running', identityPid: 42 };
      },
    },
    {
      clock: { now: () => options.now ?? START + 20 },
      receiptPublishGraceMs: options.receiptPublishGraceMs,
      wait: async (delayMs) => {
        calls.push(['wait', delayMs]);
      },
    },
  );
  return { calls, reconciler: value };
}

test('trusted completion receipt wins before process inspection and is sanitized', async () => {
  const context = reconciler({ receipts: [receipt()] });
  const result = await context.reconciler.reconcile(record(), session());
  assert.deepEqual(result, {
    offerId: record().offer.offerId,
    attemptId: ATTEMPT_ID,
    state: 'started',
    observedAtMs: START + 20,
    authority: 'current',
    finding: 'completion_observed',
    receiptChecks: 1,
    processChecks: 0,
    completionSubmission: 'ready',
    completion: {
      callbackSequence: 1,
      outcome: 'succeeded',
      startedAtMs: START + 5,
      finishedAtMs: START + 50,
      exitCode: 0,
    },
  });
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['receipt'],
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /receipt_capability|lease_capability/,
  );
});

test('completion stays fenced when Session or Lease authority is no longer valid', async () => {
  const cases = [
    [
      session({ sessionId: SESSION_B, generation: 2 }),
      'session_fenced',
      'blocked_session_fenced',
    ],
    [
      session({ status: 'offline' }),
      'worker_offline',
      'blocked_worker_offline',
    ],
    [
      session({ leaseExpiresAtMs: START + 20 }),
      'worker_session_expired',
      'blocked_worker_session_expired',
    ],
    [
      session(),
      'run_lease_expired',
      'blocked_run_lease_expired',
      record('started', { offer: { lease: { expiresAtMs: START + 20 } } }),
    ],
  ];
  for (const [current, authority, submission, value = record()] of cases) {
    const context = reconciler({ receipts: [receipt()] });
    const result = await context.reconciler.reconcile(value, current);
    assert.equal(result.finding, 'completion_observed');
    assert.equal(result.authority, authority);
    assert.equal(result.completionSubmission, submission);
  }

  const terminal = record('recovery_required', {
    withHandle: true,
    recoveryReason: 'control_plane_terminal',
  });
  const result = await reconciler({
    receipts: [receipt()],
  }).reconciler.reconcile(terminal, session());
  assert.equal(result.authority, 'current');
  assert.equal(result.completionSubmission, 'blocked_control_plane_terminal');
});

test('untrusted, conflicting or unreadable receipts fail closed before handle probing', async () => {
  const cases = [
    [
      reconciler({ receipts: [receipt()], authenticate: false }),
      record(),
      'completion_receipt_conflict',
    ],
    [
      reconciler({ receipts: [receipt({ startedAtMs: START + 6 })] }),
      record(),
      'completion_receipt_conflict',
    ],
    [
      reconciler({ receipts: [new Error('EIO')] }),
      record(),
      'completion_receipt_unavailable',
    ],
    [
      reconciler({
        receipts: [receipt()],
        authenticate: new Error('vault down'),
      }),
      record(),
      'completion_receipt_unavailable',
    ],
  ];
  for (const [context, value, finding] of cases) {
    const result = await context.reconciler.reconcile(value, session());
    assert.equal(result.finding, finding);
    assert.equal(result.processChecks, 0);
    assert.equal(
      context.calls.some(([name]) => name === 'inspect'),
      false,
    );
  }
});

test('non-owning states and launching without a handle never invoke the inspector', async () => {
  const accepted = reconciler();
  assert.equal(
    (await accepted.reconciler.reconcile(record('accepted'), session()))
      .finding,
    'no_execution_expected',
  );
  const launching = reconciler();
  assert.equal(
    (await launching.reconciler.reconcile(record('launching'), session()))
      .finding,
    'launch_outcome_unknown',
  );
  assert.equal(
    [...accepted.calls, ...launching.calls].some(
      ([name]) => name === 'inspect',
    ),
    false,
  );
});

test('a durable running identity proves ownership without resuming an ACK', async () => {
  const context = reconciler({
    inspection: { status: 'running', identityPid: 4242 },
  });
  const result = await context.reconciler.reconcile(
    record('running_acknowledged'),
    session(),
  );
  assert.equal(result.finding, 'execution_running');
  assert.equal(result.identityPid, 4242);
  assert.equal(result.receiptChecks, 1);
  assert.equal(result.processChecks, 1);
  assert.equal(result.completionSubmission, undefined);
});

test('an exited process rechecks the receipt before and after a bounded grace', async () => {
  const published = reconciler({
    receipts: [undefined, receipt({ exitCode: 9 })],
    inspection: { status: 'exited', identityPid: 52 },
    receiptPublishGraceMs: 100,
  });
  const observed = await published.reconciler.reconcile(record(), session());
  assert.equal(observed.finding, 'completion_observed');
  assert.equal(observed.completion.outcome, 'failed');
  assert.equal(observed.receiptChecks, 2);
  assert.equal(
    published.calls.some(([name]) => name === 'wait'),
    false,
  );

  const missing = reconciler({
    receipts: [undefined, undefined, undefined],
    inspection: { status: 'exited', identityPid: 53 },
    receiptPublishGraceMs: 125,
  });
  const unresolved = await missing.reconciler.reconcile(record(), session());
  assert.equal(unresolved.finding, 'execution_exited_without_receipt');
  assert.equal(unresolved.identityPid, 53);
  assert.equal(unresolved.receiptChecks, 3);
  assert.deepEqual(
    missing.calls.filter(([name]) => name === 'wait'),
    [['wait', 125]],
  );
});

test('unsafe or unavailable process identity evidence remains conservative', async () => {
  const cases = [
    [{ status: 'invalid' }, 'execution_handle_invalid'],
    [
      { status: 'identity_mismatch', identityPid: 64 },
      'execution_identity_mismatch',
    ],
    [{ status: 'unsupported', identityPid: 65 }, 'execution_probe_unsupported'],
    [new Error('proc denied'), 'execution_probe_unavailable'],
  ];
  for (const [inspection, finding] of cases) {
    const context = reconciler({ inspection });
    const result = await context.reconciler.reconcile(record(), session());
    assert.equal(result.finding, finding);
    assert.equal(result.processChecks, 1);
  }
});

test('configuration and clock bounds reject unsafe recovery passes', async () => {
  assert.throws(
    () => reconciler({ receiptPublishGraceMs: 5_001 }),
    /receiptPublishGraceMs must be between/,
  );
  const context = reconciler({ now: -1 });
  await assert.rejects(
    context.reconciler.reconcile(record(), session()),
    /clock returned an invalid time/,
  );
});
