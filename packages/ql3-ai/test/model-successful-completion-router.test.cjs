const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BoundedModelGateway,
  InvalidModelInvocationSuccessfulCompletionRouterError,
  ModelInvocationSuccessfulCompletionRouter,
} = require('@qinglong/ai/gateway');

function sink(name, handled = false) {
  return {
    async record(audit) {
      audit.order.push(name);
      return handled
        ? { handled: true, disposition: { status: 'created' } }
        : { handled: false };
    },
  };
}

test('successful completion router exposes exact children and stops at the owning sink', async () => {
  const first = sink('prompt');
  const second = sink('copilot', true);
  const third = sink('unreachable', true);
  const nested = new ModelInvocationSuccessfulCompletionRouter([
    second,
    third,
  ]);
  const router = new ModelInvocationSuccessfulCompletionRouter([first, nested]);
  const order = [];
  assert.equal(router.supportsSuccessfulCompletionSink(first), true);
  assert.equal(router.supportsSuccessfulCompletionSink(second), true);
  assert.equal(router.supportsSuccessfulCompletionSink({ record() {} }), false);
  assert.deepEqual(await router.record({ order }, {}), {
    handled: true,
    disposition: { status: 'created' },
  });
  assert.deepEqual(order, ['prompt', 'copilot']);

  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'test',
        async generate() { throw new Error('unused'); },
        async *stream() { throw new Error('unused'); },
        async listModels() { return []; },
      },
    ],
    policies: { async resolve() { throw new Error('unused'); } },
    pricing: { async resolve() { return null; } },
    audit: { async record() {} },
    successfulCompletion: router,
    maxConcurrent: 1,
  });
  assert.equal(gateway.supportsSuccessfulCompletionSink(router), true);
  assert.equal(gateway.supportsSuccessfulCompletionSink(second), true);
});

test('successful completion router rejects unbounded, duplicate and malformed sinks', async () => {
  const valid = sink('valid');
  assert.throws(
    () => new ModelInvocationSuccessfulCompletionRouter([valid]),
    InvalidModelInvocationSuccessfulCompletionRouterError,
  );
  assert.throws(
    () => new ModelInvocationSuccessfulCompletionRouter([valid, valid]),
    InvalidModelInvocationSuccessfulCompletionRouterError,
  );
  assert.throws(
    () => new ModelInvocationSuccessfulCompletionRouter([valid, {}]),
    InvalidModelInvocationSuccessfulCompletionRouterError,
  );
  const malformed = new ModelInvocationSuccessfulCompletionRouter([
    valid,
    { async record() { return { handled: false, widened: true }; } },
  ]);
  await assert.rejects(
    malformed.record({ order: [] }, {}),
    InvalidModelInvocationSuccessfulCompletionRouterError,
  );
});
