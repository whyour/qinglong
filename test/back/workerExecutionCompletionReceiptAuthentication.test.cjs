require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  Sha256WorkerExecutionCompletionReceiptAuthenticator,
} = require('../../back/runtime/adapters/crypto/sha256WorkerExecutionCompletionReceiptAuthenticator');
const {
  createWorkerExecutionCompletionReceiptAuthentication,
  matchesWorkerExecutionCompletionReceiptAuthentication,
} = require('../../back/runtime/domain/workerExecutionCompletionReceiptAuthentication');

const TOKEN = 'worker_receipt_capability_abcdefghijklmnopqrstuvwxyz01';

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: '019f8200-0000-7000-8000-000000000001',
    attemptId: '019f8200-0000-7000-8000-000000000002',
    callbackSequence: 1,
    token: TOKEN,
    startedAtMs: 10,
    finishedAtMs: 20,
    exitCode: 0,
    ...overrides,
  };
}

test('derives only a bounded SHA-256 digest from the ephemeral callback', () => {
  assert.equal(
    createWorkerExecutionCompletionReceiptAuthentication(undefined),
    undefined,
  );
  const authentication = createWorkerExecutionCompletionReceiptAuthentication({
    token: TOKEN,
    callbackSequence: 1,
  });
  assert.deepEqual(Object.keys(authentication).sort(), [
    'callbackSequence',
    'tokenDigest',
  ]);
  assert.match(authentication.tokenDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(authentication), new RegExp(TOKEN));
});

test('matches token and callback sequence without accepting partial authority', () => {
  const expected = createWorkerExecutionCompletionReceiptAuthentication({
    token: TOKEN,
    callbackSequence: 1,
  });
  assert.equal(
    matchesWorkerExecutionCompletionReceiptAuthentication(receipt(), expected),
    true,
  );
  assert.equal(
    matchesWorkerExecutionCompletionReceiptAuthentication(
      receipt({ token: `${TOKEN}x` }),
      expected,
    ),
    false,
  );
  assert.equal(
    matchesWorkerExecutionCompletionReceiptAuthentication(
      receipt({ callbackSequence: 2 }),
      expected,
    ),
    false,
  );
  assert.equal(
    matchesWorkerExecutionCompletionReceiptAuthentication(receipt(), {
      ...expected,
      tokenDigest: 'A'.repeat(64),
    }),
    false,
  );
});

test('adapter refuses records without both persisted authentication fields', () => {
  const authenticator =
    new Sha256WorkerExecutionCompletionReceiptAuthenticator();
  const expected = createWorkerExecutionCompletionReceiptAuthentication({
    token: TOKEN,
    callbackSequence: 1,
  });
  assert.equal(authenticator.authenticate(receipt(), {}), false);
  assert.equal(
    authenticator.authenticate(receipt(), {
      completionReceiptCallbackSequence: expected.callbackSequence,
    }),
    false,
  );
  assert.equal(
    authenticator.authenticate(receipt(), {
      completionReceiptCallbackSequence: expected.callbackSequence,
      completionReceiptTokenDigest: expected.tokenDigest,
    }),
    true,
  );
});

test('rejects malformed callback capability before it can be persisted', () => {
  assert.throws(
    () =>
      createWorkerExecutionCompletionReceiptAuthentication({
        token: 'short',
        callbackSequence: 1,
      }),
    /token is invalid/,
  );
  assert.throws(
    () =>
      createWorkerExecutionCompletionReceiptAuthentication({
        token: TOKEN,
        callbackSequence: 0,
      }),
    /positive safe integer/,
  );
});
