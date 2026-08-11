const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LocalIdentityCredentialAdministrationAuthorizationError,
  createLocalIdentityCredentialAdministrationService,
} = require('@qinglong/local-admin/identity-credential-administration');

const MUTATION_ID = '82000000-0000-4000-8000-000000000001';
const SUBJECT = Object.freeze({ type: 'agent', id: 'agent-planner' });
const PRINCIPAL = Object.freeze({
  subject: { type: 'user', id: 'owner-user' },
  authenticationId: 'local_identity_admin:test',
  authenticatedAtMs: 0,
  expiresAtMs: 120_000,
  assurance: 'local_console',
});

function projectPolicy(role = 'owner') {
  return {
    async resolve() {
      return {
        project: {
          id: 'default',
          name: 'Default',
          slug: 'default',
          status: 'active',
          version: 1,
          createdAtMs: 0,
          updatedAtMs: 0,
        },
        binding: {
          projectId: 'default',
          subject: PRINCIPAL.subject,
          version: 1,
          state: 'active',
          role,
          mutationId: 'owner-binding',
          changedBy: PRINCIPAL.subject,
          createdAtMs: 0,
        },
      };
    },
    async append() {
      throw new Error('not used');
    },
  };
}

test('replays a committed credential after time advances without rereading Identity state', async () => {
  let nowMs = 1_000;
  let identityReads = 0;
  let stored;
  const repository = {
    async resolveAuthorityProjectId() {
      return 'default';
    },
    async resolveIdentity() {
      identityReads += 1;
      return {
        subject: SUBJECT,
        status: 'active',
        version: 1,
        createdAtMs: 0,
        updatedAtMs: 0,
      };
    },
    async resolveIdentityMutation() {
      return null;
    },
    async appendAuthorizedIdentity() {
      throw new Error('not used');
    },
    async inspectAuthorizedIdentity() {
      throw new Error('not used');
    },
    async resolveCredentialMutation() {
      return stored ?? null;
    },
    async appendAuthorizedCredential(command) {
      if (!stored) {
        stored = Object.freeze({
          projectId: command.authorization.projectId,
          credential: Object.freeze({ ...command.credential }),
          mutation: Object.freeze({ ...command.mutation }),
          delivery: command.delivery,
          audit: command.audit,
        });
        return Object.freeze({ status: 'inserted', ...stored });
      }
      assert.deepEqual(command.credential, stored.credential);
      assert.deepEqual(command.mutation, stored.mutation);
      assert.deepEqual(command.delivery, stored.delivery);
      return Object.freeze({ status: 'existing', ...stored });
    },
    async inspectAuthorizedCredential() {
      throw new Error('not used');
    },
    async resolveDeliveryAcknowledgement() {
      return null;
    },
    async appendAuthorizedDeliveryAcknowledgement() {
      throw new Error('not used');
    },
    async record() {},
  };
  const service = createLocalIdentityCredentialAdministrationService(
    projectPolicy(),
    repository,
    { now: () => nowMs },
  );
  const request = {
    projectId: 'default',
    operation: 'issue',
    credentialId: 'agent-planner-primary',
    target: SUBJECT,
    expectedCurrentVersion: 0,
    pepperKeyId: 'owner-v1',
    secretDigest: 'a'.repeat(64),
    deliveryDigest: 'b'.repeat(64),
    notBeforeAtMs: 1_000,
    expiresAtMs: 61_000,
    mutationId: MUTATION_ID,
    requestId: 'identity-credential-replay',
    principal: PRINCIPAL,
  };

  assert.equal((await service.changeCredential(request)).status, 'inserted');
  nowMs = 30_000;
  assert.equal((await service.changeCredential(request)).status, 'existing');
  assert.equal(identityReads, 1);
  assert.equal(stored.mutation.createdAtMs, 1_000);
  assert.equal(stored.credential.notBeforeAtMs, 1_000);
});

test('inspects current versions only after Owner authorization', async () => {
  const audits = [];
  const identity = Object.freeze({
    subject: SUBJECT,
    status: 'active',
    version: 7,
    createdAtMs: 100,
    updatedAtMs: 700,
  });
  const credential = Object.freeze({
    credentialId: 'agent-planner-primary',
    version: 5,
    pepperKeyId: 'owner-v1',
    state: 'active',
    subject: SUBJECT,
    subjectStatus: 'active',
    secretDigest: 'a'.repeat(64),
    createdAtMs: 500,
    notBeforeAtMs: 500,
    expiresAtMs: 60_500,
  });
  const repository = {
    async resolveAuthorityProjectId() {
      return 'default';
    },
    async resolveIdentity() {
      throw new Error('not used');
    },
    async resolveIdentityMutation() {
      throw new Error('not used');
    },
    async appendAuthorizedIdentity() {
      throw new Error('not used');
    },
    async inspectAuthorizedIdentity(command) {
      assert.equal(command.audit.operationId, 'identity.inspect');
      assert.equal(command.authorization.actor.id, 'owner-user');
      return { identity, audit: command.audit };
    },
    async resolveCredentialMutation() {
      throw new Error('not used');
    },
    async appendAuthorizedCredential() {
      throw new Error('not used');
    },
    async inspectAuthorizedCredential(command) {
      assert.equal(command.audit.operationId, 'credential.inspect');
      assert.equal(command.credentialId, credential.credentialId);
      return { credential, audit: command.audit };
    },
    async resolveDeliveryAcknowledgement() {
      throw new Error('not used');
    },
    async appendAuthorizedDeliveryAcknowledgement() {
      throw new Error('not used');
    },
    async record(audit) {
      audits.push(audit);
    },
  };
  const owner = createLocalIdentityCredentialAdministrationService(
    projectPolicy(),
    repository,
    { now: () => 1_000 },
  );
  const identityResult = await owner.inspectIdentity({
    projectId: 'default',
    target: SUBJECT,
    auditEventId: '82000000-0000-4000-8000-000000000002',
    requestId: 'identity-inspect',
    principal: PRINCIPAL,
  });
  const credentialResult = await owner.inspectCredential({
    projectId: 'default',
    credentialId: credential.credentialId,
    auditEventId: '82000000-0000-4000-8000-000000000003',
    requestId: 'credential-inspect',
    principal: PRINCIPAL,
  });
  assert.equal(identityResult.identity.version, 7);
  assert.equal(credentialResult.credential.version, 5);

  const nonOwner = createLocalIdentityCredentialAdministrationService(
    projectPolicy('admin'),
    repository,
    { now: () => 1_000 },
  );
  await assert.rejects(
    nonOwner.inspectIdentity({
      projectId: 'default',
      target: SUBJECT,
      auditEventId: '82000000-0000-4000-8000-000000000004',
      requestId: 'identity-inspect-denied',
      principal: PRINCIPAL,
    }),
    LocalIdentityCredentialAdministrationAuthorizationError,
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operationId, 'identity.inspect');
  assert.equal(audits[0].outcome, 'denied');

  const foreignProjectOwner =
    createLocalIdentityCredentialAdministrationService(
      projectPolicy(),
      repository,
      { now: () => 1_000 },
    );
  await assert.rejects(
    foreignProjectOwner.inspectCredential({
      projectId: 'secondary',
      credentialId: credential.credentialId,
      auditEventId: '82000000-0000-4000-8000-000000000005',
      requestId: 'credential-inspect-foreign-project',
      principal: PRINCIPAL,
    }),
    LocalIdentityCredentialAdministrationAuthorizationError,
  );
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[1].reasons, ['instance_authority_project_required']);
});
