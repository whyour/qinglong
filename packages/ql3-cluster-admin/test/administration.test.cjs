const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ApiCredentialAdministrationMutationConflictError,
} = require('@qinglong/runtime-core/api-credential-administration');
const {
  apiCredentialSecretDigest,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  ClusterAdministrationAuthenticationError,
  createClusterAdministrationService,
} = require('@qinglong/cluster-admin/administration');

const NOW = 1_000;
const PEPPER = 'A'.repeat(43);
const SUBJECT = { type: 'api_app', id: 'app_primary' };
const PRINCIPAL = {
  subject: { type: 'user', id: 'usr_admin' },
  authenticationId: 'session:admin:1',
  authenticatedAtMs: 900,
  expiresAtMs: 2_000,
  assurance: 'multi_factor',
};

function request(overrides = {}) {
  return {
    mutationId: '123e4567-e89b-42d3-a456-426614174301',
    requestId: 'request-credential-issue-1',
    expectedCurrentVersion: 0,
    credentialId: 'credential_primary',
    subject: SUBJECT,
    principal: PRINCIPAL,
    notBeforeAtMs: NOW,
    expiresAtMs: 2_000,
    ...overrides,
  };
}

function repositories() {
  let credentialMutation = null;
  const credentialCommands = [];
  const identityCommands = [];
  const identity = {
    subject: SUBJECT,
    status: 'active',
    version: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
  };
  return {
    identityCommands,
    credentialCommands,
    identities: {
      async resolve() {
        return identity;
      },
      async resolveMutation() {
        return null;
      },
      async append(command) {
        identityCommands.push(command);
        return {
          status: 'inserted',
          identity: {
            subject: command.mutation.subject,
            status: command.mutation.status,
            version: command.mutation.subjectVersion,
            createdAtMs: command.mutation.createdAtMs,
            updatedAtMs: command.mutation.createdAtMs,
          },
          mutation: command.mutation,
        };
      },
    },
    credentials: {
      async resolveMutation() {
        return credentialMutation;
      },
      async append(command) {
        credentialCommands.push(command);
        credentialMutation = {
          credential: command.credential,
          mutation: command.mutation,
          audit: command.audit,
        };
        return {
          status: 'inserted',
          credential: command.credential,
          mutation: command.mutation,
        };
      },
      conflictWith(stored) {
        credentialMutation = stored;
      },
    },
  };
}

test('issues one token, stores only its digest and clears mutable secret bytes', async () => {
  const repos = repositories();
  const generated = Buffer.alloc(32, 7);
  const expectedSecret = generated.toString('base64url');
  const service = createClusterAdministrationService(
    repos.identities,
    repos.credentials,
    PEPPER,
    { now: () => NOW, randomBytes: () => generated },
  );

  const result = await service.issueCredential(request());
  assert.equal(result.status, 'inserted');
  assert.equal(result.token, `ql3c_credential_primary_${expectedSecret}`);
  assert.equal(repos.credentialCommands.length, 1);
  assert.equal(
    repos.credentialCommands[0].credential.secretDigest,
    apiCredentialSecretDigest(PEPPER, 'credential_primary', expectedSecret),
  );
  assert.equal(repos.credentialCommands[0].audit.eventId, request().mutationId);
  assert.equal(
    generated.every((value) => value === 0),
    true,
  );
});

test('semantic mutation replay returns no token and does not generate a new secret', async () => {
  const repos = repositories();
  let randomCalls = 0;
  const service = createClusterAdministrationService(
    repos.identities,
    repos.credentials,
    PEPPER,
    {
      now: () => NOW,
      randomBytes() {
        randomCalls += 1;
        return Buffer.alloc(32, randomCalls);
      },
    },
  );

  assert.ok((await service.issueCredential(request())).token);
  const replay = await service.issueCredential(request());
  assert.equal(replay.status, 'existing');
  assert.equal(replay.token, null);
  assert.equal(randomCalls, 1);

  await assert.rejects(
    service.issueCredential(request({ requestId: 'different-request' })),
    ApiCredentialAdministrationMutationConflictError,
  );
});

test('rejects weak principals and widened requests before repository mutation', async () => {
  const repos = repositories();
  const service = createClusterAdministrationService(
    repos.identities,
    repos.credentials,
    PEPPER,
    { now: () => NOW, randomBytes: () => Buffer.alloc(32, 1) },
  );
  await assert.rejects(
    service.issueCredential(
      request({ principal: { ...PRINCIPAL, assurance: 'single_factor' } }),
    ),
    ClusterAdministrationAuthenticationError,
  );
  await assert.rejects(
    service.issueCredential(request({ debug: true })),
    /request shape is invalid/,
  );
  assert.equal(repos.credentialCommands.length, 0);
});

test('maps malformed entropy output to a stable configuration error', async () => {
  const repos = repositories();
  const service = createClusterAdministrationService(
    repos.identities,
    repos.credentials,
    PEPPER,
    { now: () => NOW, randomBytes: () => 'not-a-buffer' },
  );
  await assert.rejects(
    service.issueCredential(request()),
    /randomBytes returned invalid secret material/,
  );
  assert.equal(repos.credentialCommands.length, 0);
});
