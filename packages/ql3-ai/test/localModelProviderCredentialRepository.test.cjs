const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
  ModelProviderCredentialTransitionConflictError,
  createModelProviderCredentialTransitionCommand,
} = require('../dist/model-provider-credential/modelProviderCredentialCatalog.js');
const {
  ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
  modelProviderCredentialAdministrationOperationId,
} = require('../dist/model-provider-credential/modelProviderCredentialAdministration.js');
const {
  LocalModelProviderCredentialRepository,
} = require('../dist/model-provider-credential/localModelProviderCredentialRepository.js');
const {
  LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
  digestModelProviderCredentialBinding,
} = require('../dist/model-provider-credential/providerCredential.js');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const PROJECT_ID = 'project-a';
const PROVIDER = 'openai-compatible';
const ACTOR = Object.freeze({ type: 'user', id: 'owner-a' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 7 });
const BIND_MUTATION_ID = '019f7094-a853-4f3b-82ab-dfa08e6bd1c1';

function createMainContract(client) {
  client.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "QingLong3SchemaMigrations" (
      migration_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      dialect TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE "Runs" (id TEXT PRIMARY KEY);
    CREATE TABLE "RunEvents" (id TEXT PRIMARY KEY);
    CREATE TABLE "StepRuns" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      UNIQUE (run_id, id)
    );
    CREATE TABLE "StepRunMutations" (mutation_id TEXT PRIMARY KEY);
    CREATE TABLE "QingLong3LocalSecretEnvelopes" (
      project_id TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (project_id, secret_name, version)
    );
  `);
}

async function fixture(options = {}) {
  const client = new DatabaseSync(':memory:');
  createMainContract(client);
  await migrateLocalModelInvocationFeature(client);
  client
    .prepare(
      `INSERT INTO "QingLong3LocalSecretEnvelopes"
         (project_id, secret_name, version) VALUES (?, ?, ?)`,
    )
    .run(PROJECT_ID, 'openai-token', 1);
  return {
    client,
    repository: new LocalModelProviderCredentialRepository(client, {
      now: options.now ?? (() => 100),
      ...(options.authorization
        ? { authorization: options.authorization }
        : {}),
    }),
  };
}

function binding(overrides = {}) {
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
    projectId: PROJECT_ID,
    provider: PROVIDER,
    revision: 'credential-v1',
    secretRef: createSecretRef({
      projectId: PROJECT_ID,
      name: 'openai-token',
      version: 1,
    }),
    scheme: 'bearer',
    ...overrides,
  });
}

function command(overrides = {}) {
  return createModelProviderCredentialTransitionCommand({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
    mutationId: BIND_MUTATION_ID,
    projectId: PROJECT_ID,
    provider: PROVIDER,
    expectedGeneration: 0,
    action: 'bind',
    binding: binding(),
    changedBy: ACTOR,
    ...overrides,
  });
}

function allowedAudit(catalogCommand, overrides = {}) {
  return Object.freeze({
    eventId: catalogCommand.mutationId,
    requestId: 'request-administration-1',
    operationId: modelProviderCredentialAdministrationOperationId(
      catalogCommand.action,
    ),
    projectId: catalogCommand.projectId,
    subject: ACTOR,
    authenticationId: 'authentication-1',
    outcome: 'allowed',
    reasons: ['project_owner'],
    fence: FENCE,
    occurredAtMs: 99,
    ...overrides,
  });
}

function authorized(catalogCommand) {
  return Object.freeze({
    command: catalogCommand,
    actor: ACTOR,
    fence: FENCE,
    audit: allowedAudit(catalogCommand),
  });
}

function useAudit(activeBinding, requestId, occurredAtMs) {
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
    operation: 'generate',
    projectId: PROJECT_ID,
    provider: PROVIDER,
    requestId,
    bindingRevision: activeBinding.revision,
    bindingDigest: digestModelProviderCredentialBinding(activeBinding),
    occurredAtMs,
  });
}

test('local credential repository binds an existing SecretRef and replays exactly', async () => {
  const { client, repository } = await fixture();
  const bind = command();

  const created = await repository.commit(bind);
  const replay = await repository.commit(bind);
  assert.equal(created.status, 'created');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.transition, created.transition);
  assert.deepEqual(
    await repository.findCurrentTransition(PROJECT_ID, PROVIDER),
    created.transition,
  );
  assert.deepEqual(
    await repository.resolveModelProviderCredentialBinding({
      projectId: PROJECT_ID,
      provider: PROVIDER,
    }),
    bind.binding,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
           FROM "${LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"`,
      )
      .get().count,
    13,
  );
  client.close();
});

test('local credential repository fails closed for missing SecretRef and stale generation', async () => {
  const { client, repository } = await fixture();
  const missing = command({
    mutationId: '019f7094-a853-4f3b-82ab-dfa08e6bd1c2',
    binding: binding({
      secretRef: createSecretRef({
        projectId: PROJECT_ID,
        name: 'missing-token',
        version: 1,
      }),
    }),
  });
  await assert.rejects(
    repository.commit(missing),
    ModelProviderCredentialTransitionConflictError,
  );
  assert.equal(
    await repository.findCurrentTransition(PROJECT_ID, PROVIDER),
    null,
  );

  await repository.commit(command());
  await assert.rejects(
    repository.commit(
      command({
        mutationId: '019f7094-a853-4f3b-82ab-dfa08e6bd1c3',
      }),
    ),
    ModelProviderCredentialTransitionConflictError,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
           FROM "ModelInvocationProviderCredentialTransitions"`,
      )
      .get().count,
    1,
  );
  client.close();
});

test('authorized mutation and inspection revalidate inside the repository transaction', async () => {
  const confirmations = [];
  const authorization = {
    confirm(input) {
      assert.equal(input.value.actor.id, ACTOR.id);
      assert.equal(input.value.fence.projectVersion, FENCE.projectVersion);
      confirmations.push({ kind: input.kind, replay: input.replay });
    },
  };
  const { client, repository } = await fixture({ authorization });
  const bind = command();

  assert.equal(
    (await repository.commitAuthorized(authorized(bind))).status,
    'created',
  );
  assert.equal(
    (await repository.commitAuthorized(authorized(bind))).status,
    'existing',
  );
  const inspected = await repository.inspectAuthorized({
    projectId: PROJECT_ID,
    provider: PROVIDER,
    actor: ACTOR,
    fence: FENCE,
    audit: {
      ...allowedAudit(bind),
      eventId: '019f7094-a853-4f3b-82ab-dfa08e6bd1c4',
      operationId: 'model_provider_credential.inspect',
    },
  });
  assert.equal(inspected.generation, 1);
  assert.deepEqual(confirmations, [
    { kind: 'mutation', replay: false },
    { kind: 'mutation', replay: true },
    { kind: 'inspection', replay: false },
  ]);
  client.close();
});

test('authorized replay fails closed when no authorization guard is installed', async () => {
  const { client, repository } = await fixture();
  const bind = command();
  await repository.commit(bind);
  await assert.rejects(
    repository.commitAuthorized(authorized(bind)),
    ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
  );
  client.close();
});

test('authorization fence rejection rolls the complete credential mutation back', async () => {
  const authorization = {
    confirm() {
      throw new ModelProviderCredentialAdministrationAuthorizationFenceConflictError();
    },
  };
  const { client, repository } = await fixture({ authorization });
  await assert.rejects(
    repository.commitAuthorized(authorized(command())),
    ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
             (SELECT count(*) FROM "ModelInvocationProviderCredentialBindings") AS bindings,
             (SELECT count(*) FROM "ModelInvocationProviderCredentialTransitions") AS transitions`,
        )
        .get(),
    },
    { bindings: 0, transitions: 0 },
  );
  client.close();
});

test('credential use audit is content-free, idempotent and invalid after revoke', async () => {
  const { client, repository } = await fixture();
  const bind = command();
  await repository.commit(bind);

  await repository.record(useAudit(bind.binding, 'provider-request-1', 110));
  await repository.record(useAudit(bind.binding, 'provider-request-1', 999));
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
           FROM "ModelInvocationProviderCredentialAudits"`,
      )
      .get().count,
    1,
  );
  assert.equal(
    client
      .prepare(
        `SELECT audit_json AS value
           FROM "ModelInvocationProviderCredentialAudits"`,
      )
      .get()
      .value.includes('secretRef'),
    false,
  );

  const revoke = command({
    mutationId: '019f7094-a853-4f3b-82ab-dfa08e6bd1c5',
    expectedGeneration: 1,
    action: 'revoke',
    binding: null,
  });
  await repository.commit(revoke);
  assert.equal(
    await repository.resolveModelProviderCredentialBinding({
      projectId: PROJECT_ID,
      provider: PROVIDER,
    }),
    null,
  );
  await assert.rejects(
    repository.record(useAudit(bind.binding, 'provider-request-2', 120)),
    ModelProviderCredentialTransitionConflictError,
  );
  client.close();
});
