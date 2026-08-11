const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InvalidModelProviderCredentialAdministrationMutationError,
  modelProviderCredentialAdministrationOperationId,
  normalizeAuthorizedModelProviderCredentialTransitionMutation,
} = require('../dist/model-provider-credential/modelProviderCredentialAdministration.js');
const {
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
  createModelProviderCredentialTransitionCommand,
} = require('../dist/model-provider-credential/modelProviderCredentialCatalog.js');
const {
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
} = require('../dist/model-provider-credential/providerCredential.js');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const MUTATION_ID = '019f7094-a853-4f3b-82ab-dfa08e6bd1c1';

function command(overrides = {}) {
  return createModelProviderCredentialTransitionCommand({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
    mutationId: MUTATION_ID,
    projectId: 'project-a',
    provider: 'openai-compatible',
    expectedGeneration: 0,
    action: 'bind',
    binding: {
      schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
      projectId: 'project-a',
      provider: 'openai-compatible',
      revision: 'credential-v1',
      secretRef: createSecretRef({
        projectId: 'project-a',
        name: 'openai-token',
      }),
      scheme: 'bearer',
    },
    changedBy: { type: 'user', id: 'owner-a' },
    ...overrides,
  });
}

function mutation(overrides = {}) {
  const { command: commandOverrides, ...mutationOverrides } = overrides;
  const catalogCommand = command(commandOverrides);
  const fence = { projectVersion: 3, bindingVersion: 7 };
  return {
    command: catalogCommand,
    actor: { type: 'user', id: 'owner-a' },
    fence,
    audit: {
      eventId: catalogCommand.mutationId,
      requestId: 'request-1',
      operationId: modelProviderCredentialAdministrationOperationId(
        catalogCommand.action,
      ),
      projectId: catalogCommand.projectId,
      subject: { type: 'user', id: 'owner-a' },
      authenticationId: 'authentication-1',
      outcome: 'allowed',
      reasons: ['project_owner'],
      fence,
      occurredAtMs: 100,
    },
    ...mutationOverrides,
  };
}

test('bind administration binds actor, Project fence and allowed audit', () => {
  const normalized =
    normalizeAuthorizedModelProviderCredentialTransitionMutation(mutation());
  assert.equal(normalized.command.action, 'bind');
  assert.equal(normalized.audit.operationId, 'model_provider_credential.bind');
  assert.deepEqual(normalized.actor, { type: 'user', id: 'owner-a' });
  assert.deepEqual(normalized.fence, {
    projectVersion: 3,
    bindingVersion: 7,
  });
});

test('revoke administration uses the exact revoke audit operation', () => {
  const normalized =
    normalizeAuthorizedModelProviderCredentialTransitionMutation(
      mutation({
        command: {
          action: 'revoke',
          binding: null,
          expectedGeneration: 1,
        },
      }),
    );
  assert.equal(normalized.command.action, 'revoke');
  assert.equal(
    normalized.audit.operationId,
    'model_provider_credential.revoke',
  );
});

test('administration rejects actor, Project, audit and fence drift', () => {
  const candidate = mutation();
  for (const drift of [
    { actor: { type: 'user', id: 'owner-b' } },
    { audit: { ...candidate.audit, projectId: 'project-b' } },
    { audit: { ...candidate.audit, outcome: 'denied' } },
    {
      audit: {
        ...candidate.audit,
        operationId: 'model_provider_credential.revoke',
      },
    },
    { fence: { projectVersion: 3, bindingVersion: 8 } },
  ]) {
    assert.throws(
      () =>
        normalizeAuthorizedModelProviderCredentialTransitionMutation({
          ...candidate,
          ...drift,
        }),
      InvalidModelProviderCredentialAdministrationMutationError,
    );
  }
});
