const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLocalOwnerCredentialRecoveryService,
} = require('../dist/credential-recovery');

test('issues a distinct credential and replays acknowledged completion', async () => {
  const previous = {
    credentialId: `own_${'a'.repeat(22)}`,
    version: 1,
    pepperKeyId: 'owner-key-1',
    state: 'active',
    subject: { type: 'user', id: `usr_${'b'.repeat(22)}` },
    subjectStatus: 'active',
    secretDigest: '1'.repeat(64),
    createdAtMs: 100,
    notBeforeAtMs: 100,
    expiresAtMs: 100000000,
  };
  let recovery = null;
  const credentials = {
    async resolve(credentialId) {
      return credentialId === previous.credentialId ? previous : null;
    },
  };
  const repository = {
    async resolve() {
      return recovery;
    },
    async issue(command) {
      recovery = {
        issueMutationId: command.mutationId,
        issueRequestId: command.requestId,
        subjectId: command.replacementCredential.subject.id,
        previousCredentialId: command.previousCredentialId,
        previousCredentialVersion: command.expectedPreviousVersion,
        replacementCredential: command.replacementCredential,
        state: 'issued',
        issuedAtMs: command.replacementCredential.createdAtMs,
      };
      return { status: 'inserted', recovery };
    },
    async acknowledge() {
      throw new Error('not used');
    },
    async complete(command) {
      assert.equal(recovery.state, 'acknowledged');
      recovery = {
        ...recovery,
        state: 'completed',
        completeMutationId: command.mutationId,
        completeRequestId: command.requestId,
        revokedCredentialVersion: command.revokedCredential.version,
        completedAtMs: command.revokedCredential.createdAtMs,
      };
      return { status: 'inserted', recovery };
    },
  };
  let nowMs = 1000;
  const service = createLocalOwnerCredentialRecoveryService(
    repository,
    credentials,
    Buffer.alloc(32, 7).toString('base64url'),
    {
      pepperKeyId: 'owner-key-1',
      now: () => nowMs,
      randomBytes: (size) => Buffer.alloc(size, size),
    },
  );
  const issueMutationId = '00000000-0000-4000-8000-000000000801';
  const issued = await service.issue({
    mutationId: issueMutationId,
    requestId: 'recover-issue-801',
    previousCredentialId: previous.credentialId,
    expectedPreviousVersion: 1,
  });
  assert.equal(issued.status, 'inserted');
  assert.notEqual(issued.replacementCredentialId, previous.credentialId);
  assert.match(issued.replacementCredentialToken, /^ql3c_/);

  recovery = {
    ...recovery,
    state: 'acknowledged',
    deliveryDigest: '2'.repeat(64),
    acknowledgedAtMs: 1100,
  };
  nowMs = 1200;
  const completion = {
    issueMutationId,
    mutationId: '00000000-0000-4000-8000-000000000802',
    requestId: 'recover-complete-802',
  };
  assert.equal((await service.complete(completion)).status, 'inserted');
  assert.equal((await service.complete(completion)).status, 'existing');
});
