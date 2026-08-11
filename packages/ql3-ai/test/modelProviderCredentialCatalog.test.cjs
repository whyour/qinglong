const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
  InvalidModelProviderCredentialTransitionError,
  ModelProviderCredentialTransitionConflictError,
  createModelProviderCredentialTransition,
  createModelProviderCredentialTransitionCommand,
  modelProviderCredentialBindingForTransition,
  normalizeModelProviderCredentialTransition,
} = require('../dist/model-provider-credential/modelProviderCredentialCatalog.js');
const {
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
} = require('../dist/model-provider-credential/providerCredential.js');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

function binding(overrides = {}) {
  return {
    schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
    projectId: 'project-a',
    provider: 'openai-compatible',
    revision: 'credential-v1',
    secretRef: createSecretRef({
      projectId: 'project-a',
      name: 'openai-token',
    }),
    scheme: 'bearer',
    ...overrides,
  };
}

function command(overrides = {}) {
  return createModelProviderCredentialTransitionCommand({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
    mutationId: 'credential-bind-1',
    projectId: 'project-a',
    provider: 'openai-compatible',
    expectedGeneration: 0,
    action: 'bind',
    binding: binding(),
    changedBy: { type: 'user', id: 'owner-a' },
    ...overrides,
  });
}

test('credential catalog creates an immutable bind/revoke hash chain', () => {
  const bind = command();
  const first = createModelProviderCredentialTransition(bind, null, 10);
  assert.equal(first.generation, 1);
  assert.equal(first.action, 'bind');
  assert.equal(first.previousTransitionDigest, null);
  assert.deepEqual(
    modelProviderCredentialBindingForTransition(first, bind.binding),
    bind.binding,
  );
  assert.deepEqual(normalizeModelProviderCredentialTransition(first), first);

  const revoke = command({
    mutationId: 'credential-revoke-2',
    expectedGeneration: 1,
    action: 'revoke',
    binding: null,
  });
  const second = createModelProviderCredentialTransition(revoke, first, 20);
  assert.equal(second.generation, 2);
  assert.equal(second.action, 'revoke');
  assert.equal(second.previousTransitionDigest, first.transitionDigest);
  assert.equal(modelProviderCredentialBindingForTransition(second, null), null);
});

test('credential catalog rejects cross-Project binding and stale CAS', () => {
  assert.throws(
    () => command({ binding: binding({ projectId: 'project-b' }) }),
    InvalidModelProviderCredentialTransitionError,
  );
  const firstCommand = command();
  const first = createModelProviderCredentialTransition(firstCommand, null, 1);
  assert.throws(
    () => createModelProviderCredentialTransition(command(), first, 2),
    ModelProviderCredentialTransitionConflictError,
  );
});

test('credential transition tampering is detected before storage use', () => {
  const first = createModelProviderCredentialTransition(command(), null, 1);
  assert.throws(
    () =>
      normalizeModelProviderCredentialTransition({
        ...first,
        activeBindingRevision: 'credential-v2',
      }),
    InvalidModelProviderCredentialTransitionError,
  );
  assert.throws(
    () =>
      modelProviderCredentialBindingForTransition(
        first,
        binding({ revision: 'credential-v2' }),
      ),
    /unavailable/,
  );
});
