const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OpenAiCompatibleConfigurationError,
  OpenAiCompatibleProtocolError,
  OpenAiCompatibleProvider,
} = require('../dist/model-gateway/openAiCompatibleProvider.js');

function context() {
  return {
    projectId: 'project-a',
    runId: 'run-a',
    stepRunId: 'step-a',
    traceId: 'trace-a',
    requestId: 'request-a',
    deadlineAtMs: Date.now() + 10_000,
  };
}

function request() {
  return {
    provider: 'openai-compatible',
    model: 'model-a',
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 32,
  };
}

test('remote endpoints require HTTPS while explicit loopback HTTP remains possible', () => {
  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        type: 'openai-compatible',
        baseUrl: 'http://models.example.test/v1/',
      }),
    OpenAiCompatibleConfigurationError,
  );
  assert.doesNotThrow(
    () =>
      new OpenAiCompatibleProvider({
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1/',
        allowPlaintextLoopback: true,
      }),
  );
});

test('generate sends one bounded OpenAI-compatible request without retry', async () => {
  const calls = [];
  const credentialRequests = [];
  let credentialDisposed = 0;
  const instance = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    credentials: {
      async authorizationHeader(request) {
        credentialRequests.push(request);
        return {
          value: 'Bearer ephemeral-token',
          dispose() {
            credentialDisposed += 1;
          },
        };
      },
    },
    async fetch(url, init) {
      assert.equal(credentialDisposed, 0);
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          model: 'model-a',
          choices: [
            {
              message: { role: 'assistant', content: 'world' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });

  const result = await instance.generate(request(), context());

  assert.equal(calls.length, 1);
  assert.equal(credentialDisposed, 1);
  assert.deepEqual(credentialRequests, [
    {
      operation: 'generate',
      provider: 'openai-compatible',
      projectId: 'project-a',
      requestId: 'request-a',
    },
  ]);
  assert.equal(calls[0].url, 'https://models.example.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ephemeral-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'model-a',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  });
  assert.deepEqual(result, {
    provider: 'openai-compatible',
    model: 'model-a',
    text: 'world',
    finishReason: 'stop',
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
  });
});

test('credential leases are disposed on network failure and malformed leases never reach fetch', async () => {
  let disposed = 0;
  const failing = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    credentials: {
      async authorizationHeader() {
        return {
          value: 'Bearer short-lived',
          dispose() {
            disposed += 1;
          },
        };
      },
    },
    async fetch() {
      throw new Error('network unavailable');
    },
  });
  await assert.rejects(
    failing.generate(request(), context()),
    /network unavailable/,
  );
  assert.equal(disposed, 1);

  let calls = 0;
  const malformed = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    credentials: {
      async authorizationHeader() {
        return {
          value: 'Bearer value',
          dispose() {
            disposed += 1;
          },
          retained: true,
        };
      },
    },
    async fetch() {
      calls += 1;
      throw new Error('must not run');
    },
  });
  await assert.rejects(
    malformed.generate(request(), context()),
    OpenAiCompatibleConfigurationError,
  );
  assert.equal(calls, 0);
  assert.equal(disposed, 2);
});

test('adapter rejects provider identity drift before network access', async () => {
  let calls = 0;
  const instance = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    async fetch() {
      calls += 1;
      throw new Error('must not run');
    },
  });

  await assert.rejects(
    instance.generate(
      { ...request(), provider: 'another-provider' },
      context(),
    ),
    /request provider does not match the adapter/,
  );
  assert.equal(calls, 0);
});

test('stream parses arbitrarily split CRLF SSE and preserves final usage', async () => {
  const encoder = new TextEncoder();
  const payload = [
    'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\r',
    '\n\r\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\r\n\r\n',
    'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ];
  const instance = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    async fetch(_url, init) {
      assert.equal(JSON.parse(init.body).stream_options.include_usage, true);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const part of payload)
              controller.enqueue(encoder.encode(part));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  });

  const chunks = [];
  for await (const chunk of instance.stream(request(), context())) {
    chunks.push(chunk);
  }

  assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'hello');
  assert.equal(chunks[1].finishReason, 'stop');
  assert.deepEqual(chunks[2].usage, {
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  });
});

test('protocol rejects missing usage and over-limit responses', async () => {
  const missingUsage = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    async fetch() {
      return new Response(
        JSON.stringify({
          model: 'model-a',
          choices: [
            {
              message: { content: 'world' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    },
  });
  await assert.rejects(
    missingUsage.generate(request(), context()),
    OpenAiCompatibleProtocolError,
  );

  const tooLarge = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    maxResponseBytes: 32,
    async fetch() {
      return new Response(JSON.stringify({ data: [{ id: 'x'.repeat(64) }] }));
    },
  });
  await assert.rejects(tooLarge.listModels(), OpenAiCompatibleProtocolError);
});
