const assert = require('node:assert/strict');
const test = require('node:test');

const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  BoundModelProviderCredentialProvider,
  InvalidModelProviderCredentialBindingError,
  MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
  ModelProviderCredentialUnavailableError,
  digestModelProviderCredentialBinding,
  normalizeModelProviderCredentialBinding,
} = require('../dist/model-provider-credential/providerCredential.js');
const {
  OpenAiCompatibleProvider,
} = require('../dist/model-gateway/openAiCompatibleProvider.js');
const credentialSubpath = require('@qinglong/ai/provider-credential');

const SECRET_REF = createSecretRef({
  projectId: 'project-a',
  name: 'OPENAI_API_KEY',
});

function binding(overrides = {}) {
  return {
    schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
    projectId: 'project-a',
    provider: 'openai-compatible',
    revision: 'credential-binding-v1',
    secretRef: SECRET_REF,
    scheme: 'bearer',
    ...overrides,
  };
}

function authorizationRequest(overrides = {}) {
  return {
    operation: 'generate',
    projectId: 'project-a',
    provider: 'openai-compatible',
    requestId: 'request-a',
    ...overrides,
  };
}

test('publishes credential binding through one explicit AI package subpath', () => {
  assert.equal(
    credentialSubpath.BoundModelProviderCredentialProvider,
    BoundModelProviderCredentialProvider,
  );
  assert.equal(
    credentialSubpath.MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
    MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
  );
});

test('normalizes one canonical Project-bound binding and derives a stable content digest', () => {
  const normalized = normalizeModelProviderCredentialBinding(binding());
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(normalized, binding());
  assert.match(
    digestModelProviderCredentialBinding(normalized),
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    digestModelProviderCredentialBinding(normalized),
    digestModelProviderCredentialBinding(binding()),
  );
  assert.throws(
    () =>
      normalizeModelProviderCredentialBinding(
        binding({
          secretRef: createSecretRef({
            projectId: 'project-b',
            name: 'OPENAI_API_KEY',
          }),
        }),
      ),
    InvalidModelProviderCredentialBindingError,
  );
  assert.throws(
    () =>
      normalizeModelProviderCredentialBinding({ ...binding(), extra: true }),
    InvalidModelProviderCredentialBindingError,
  );
});

test('resolves, audits and disposes one short-lived bearer credential without content leakage', async () => {
  const lookups = [];
  const resolutions = [];
  const audits = [];
  let sourceDisposed = 0;
  let sourceBytes;
  const credentials = new BoundModelProviderCredentialProvider({
    bindings: {
      async resolveModelProviderCredentialBinding(lookup) {
        lookups.push(lookup);
        return binding();
      },
    },
    secrets: {
      async resolveProjectSecretMaterial(request) {
        resolutions.push(request);
        sourceBytes = Buffer.from('sk-ephemeral_123', 'ascii');
        return {
          secretRef: request.secretRef,
          bytes: sourceBytes,
          dispose() {
            sourceDisposed += 1;
            sourceBytes.fill(0);
          },
        };
      },
    },
    audit: {
      async record(record) {
        audits.push(record);
      },
    },
    now: () => 1234,
  });

  const lease = await credentials.authorizationHeader(authorizationRequest());
  assert.equal(lease.value, 'Bearer sk-ephemeral_123');
  assert.equal(sourceDisposed, 1);
  assert.deepEqual([...sourceBytes], new Array(sourceBytes.length).fill(0));
  assert.deepEqual(lookups, [
    { projectId: 'project-a', provider: 'openai-compatible' },
  ]);
  assert.deepEqual(resolutions, [
    { projectId: 'project-a', secretRef: SECRET_REF },
  ]);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    schema: MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
    operation: 'generate',
    projectId: 'project-a',
    provider: 'openai-compatible',
    requestId: 'request-a',
    bindingRevision: 'credential-binding-v1',
    bindingDigest: digestModelProviderCredentialBinding(binding()),
    occurredAtMs: 1234,
  });
  assert.equal(JSON.stringify(audits).includes('ephemeral'), false);
  await lease.dispose();
  assert.throws(() => lease.value, ModelProviderCredentialUnavailableError);
  await lease.dispose();
});

test('re-resolves an unversioned SecretRef on every operation without a cache or watcher', async () => {
  const values = ['token-a', 'token-b'];
  let resolved = 0;
  const credentials = new BoundModelProviderCredentialProvider({
    bindings: {
      async resolveModelProviderCredentialBinding() {
        return binding();
      },
    },
    secrets: {
      async resolveProjectSecretMaterial(request) {
        const bytes = Buffer.from(values[resolved++], 'ascii');
        return {
          secretRef: request.secretRef,
          bytes,
          dispose() {
            bytes.fill(0);
          },
        };
      },
    },
    audit: { async record() {} },
  });

  const first = await credentials.authorizationHeader(authorizationRequest());
  const second = await credentials.authorizationHeader(
    authorizationRequest({ operation: 'stream', requestId: 'request-b' }),
  );
  assert.equal(first.value, 'Bearer token-a');
  assert.equal(second.value, 'Bearer token-b');
  assert.equal(resolved, 2);
  await first.dispose();
  await second.dispose();
});

test('fails closed on missing or drifted bindings and disposes material when audit fails', async () => {
  let secretCalls = 0;
  const missing = new BoundModelProviderCredentialProvider({
    bindings: {
      async resolveModelProviderCredentialBinding() {
        return null;
      },
    },
    secrets: {
      async resolveProjectSecretMaterial() {
        secretCalls += 1;
        throw new Error('must not run');
      },
    },
    audit: { async record() {} },
  });
  await assert.rejects(
    missing.authorizationHeader(authorizationRequest()),
    ModelProviderCredentialUnavailableError,
  );
  assert.equal(secretCalls, 0);

  const drifted = new BoundModelProviderCredentialProvider({
    bindings: {
      async resolveModelProviderCredentialBinding() {
        return binding({ provider: 'another-provider' });
      },
    },
    secrets: {
      async resolveProjectSecretMaterial() {
        secretCalls += 1;
        throw new Error('must not run');
      },
    },
    audit: { async record() {} },
  });
  await assert.rejects(
    drifted.authorizationHeader(authorizationRequest()),
    ModelProviderCredentialUnavailableError,
  );
  assert.equal(secretCalls, 0);

  let disposed = 0;
  const bytes = Buffer.from('token-a', 'ascii');
  const unavailableAudit = new BoundModelProviderCredentialProvider({
    bindings: {
      async resolveModelProviderCredentialBinding() {
        return binding();
      },
    },
    secrets: {
      async resolveProjectSecretMaterial(request) {
        return {
          secretRef: request.secretRef,
          bytes,
          dispose() {
            disposed += 1;
            bytes.fill(0);
          },
        };
      },
    },
    audit: {
      async record() {
        throw new Error('audit unavailable');
      },
    },
  });
  await assert.rejects(
    unavailableAudit.authorizationHeader(authorizationRequest()),
    ModelProviderCredentialUnavailableError,
  );
  assert.equal(disposed, 1);
  assert.deepEqual([...bytes], new Array(bytes.length).fill(0));
});

test('credential audit failure prevents OpenAI-compatible network access', async () => {
  let fetchCalls = 0;
  let disposed = 0;
  const credentials = new BoundModelProviderCredentialProvider({
    bindings: {
      async resolveModelProviderCredentialBinding() {
        return binding();
      },
    },
    secrets: {
      async resolveProjectSecretMaterial(request) {
        const bytes = Buffer.from('token-a', 'ascii');
        return {
          secretRef: request.secretRef,
          bytes,
          dispose() {
            disposed += 1;
            bytes.fill(0);
          },
        };
      },
    },
    audit: {
      async record() {
        throw new Error('audit unavailable');
      },
    },
  });
  const provider = new OpenAiCompatibleProvider({
    type: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1/',
    credentials,
    async fetch() {
      fetchCalls += 1;
      throw new Error('must not run');
    },
  });

  await assert.rejects(
    provider.generate(
      {
        provider: 'openai-compatible',
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 16,
      },
      {
        projectId: 'project-a',
        runId: 'run-a',
        stepRunId: 'step-a',
        traceId: 'trace-a',
        requestId: 'request-a',
        deadlineAtMs: Date.now() + 10_000,
      },
    ),
    ModelProviderCredentialUnavailableError,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(disposed, 1);
});

test('rejects unscoped model listing and malformed or oversized Secret material', async () => {
  const materials = [
    Buffer.from('token with spaces', 'ascii'),
    Buffer.alloc(4096, 0x61),
    Buffer.from([0xff, 0xfe]),
  ];
  let disposed = 0;
  const credentials = new BoundModelProviderCredentialProvider({
    bindings: {
      async resolveModelProviderCredentialBinding() {
        return binding();
      },
    },
    secrets: {
      async resolveProjectSecretMaterial(request) {
        const bytes = materials.shift();
        return {
          secretRef: request.secretRef,
          bytes,
          dispose() {
            disposed += 1;
            bytes.fill(0);
          },
        };
      },
    },
    audit: { async record() {} },
  });

  await assert.rejects(
    credentials.authorizationHeader({
      operation: 'list_models',
      provider: 'openai-compatible',
    }),
    InvalidModelProviderCredentialBindingError,
  );
  for (const requestId of ['malformed-a', 'malformed-b', 'malformed-c']) {
    await assert.rejects(
      credentials.authorizationHeader(authorizationRequest({ requestId })),
      ModelProviderCredentialUnavailableError,
    );
  }
  assert.equal(disposed, 3);
});
