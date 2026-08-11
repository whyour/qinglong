const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LocalOwnerBootstrapMutationConflictError,
} = require('@qinglong/runtime-core/local-owner-bootstrap');
const {
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
} = require('@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteAcknowledgementGcDatabase,
} = require('@qinglong/local-sqlite/acknowledgement-gc');
const {
  openLocalSqliteBootstrapDatabase,
} = require('@qinglong/local-sqlite/bootstrap');
const {
  LocalOwnerBootstrapConfigurationError,
  LocalOwnerBootstrapRejectedError,
  LocalOwnerBootstrapServiceUnavailableError,
  createLocalOwnerBootstrapService,
} = require('../dist/bootstrap');

const NOW = 1_760_000_000_000;
const PEPPER = Buffer.alloc(32, 91).toString('base64url');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    databasePath: path.join(directory, 'qinglong3.sqlite'),
    profile: 'edge',
  };
}

function issuer() {
  return {
    subject: { type: 'system', id: 'owner-bootstrap' },
    authenticationId: 'local-console-test',
    authenticatedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    assurance: 'local_console',
  };
}

function restartedIssuer() {
  return {
    ...issuer(),
    authenticatedAtMs: NOW + 1_000,
    expiresAtMs: NOW + 61_000,
  };
}

function entropy(start = 1) {
  let value = start;
  return (size) => Buffer.alloc(size, value++);
}

async function opened(t, start = 1) {
  const options = fixture(t);
  await migrateLocalSqlitePath(options);
  const database = await openLocalSqliteBootstrapDatabase(options);
  const materialDigest = createHash('sha256')
    .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
    .update(PEPPER, 'utf8')
    .digest('hex');
  await database.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000091',
    pepperKeyId: 'legacy-v1',
    materialDigest,
    backupDigest: 'b'.repeat(64),
    registeredAtMs: NOW - 2_000,
  });
  await database.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000092',
    pepperKeyId: 'legacy-v1',
    expectedGeneration: 0,
    activatedAtMs: NOW - 1_500,
  });
  t.after(() => database.close());
  return {
    options,
    database,
    service: createLocalOwnerBootstrapService(
      database.ownerBootstrap,
      database.apiCredentials,
      PEPPER,
      issuer(),
      { now: () => NOW, randomBytes: entropy(start) },
    ),
  };
}

function provisionRequest(overrides = {}) {
  return {
    mutationId: '00000000-0000-4000-8000-000000000101',
    requestId: 'provision-101',
    ...overrides,
  };
}

function issueRequest(overrides = {}) {
  return {
    projectId: 'default',
    mutationId: '00000000-0000-4000-8000-000000000102',
    requestId: 'issue-102',
    ...overrides,
  };
}

function claimRequest(provisioned, challenge, overrides = {}) {
  return {
    projectId: 'default',
    mutationId: '00000000-0000-4000-8000-000000000103',
    requestId: 'claim-103',
    challengeId: challenge.challengeId,
    challengeToken: challenge.challengeToken,
    credentialToken: provisioned.credentialToken,
    ...overrides,
  };
}

test('provisions stable identity and claims one Owner without persisting plaintext', async (t) => {
  const value = await opened(t);
  const provisioned = await value.service.provision(provisionRequest());
  const challenge = await value.service.issue(issueRequest());
  const claimed = await value.service.claim(
    claimRequest(provisioned, challenge),
  );
  assert.equal(provisioned.status, 'inserted');
  assert.match(provisioned.credentialToken, /^ql3c_/);
  assert.equal(challenge.status, 'inserted');
  assert.equal(challenge.challengeToken.length, 43);
  assert.equal(claimed.status, 'inserted');
  assert.equal(claimed.binding.role, 'owner');

  const client = new DatabaseSync(value.options.databasePath, {
    readOnly: true,
  });
  try {
    const credential = client
      .prepare('SELECT secret_digest FROM "QingLong3ApiCredentials" LIMIT 1')
      .get();
    const storedChallenge = client
      .prepare(
        'SELECT token_digest, consumed_at_ms FROM "QingLong3LocalOwnerBootstrapChallenges" LIMIT 1',
      )
      .get();
    assert.match(credential.secret_digest, /^[0-9a-f]{64}$/);
    assert.match(storedChallenge.token_digest, /^[0-9a-f]{64}$/);
    assert.equal(storedChallenge.consumed_at_ms, NOW);
    const bytes = fs.readFileSync(value.options.databasePath);
    assert.equal(
      bytes.includes(Buffer.from(provisioned.credentialToken)),
      false,
    );
    assert.equal(bytes.includes(Buffer.from(challenge.challengeToken)), false);
  } finally {
    client.close();
  }

  const replayProvision = await value.service.provision(provisionRequest());
  const replayIssue = await value.service.issue(issueRequest());
  const replayClaim = await value.service.claim(
    claimRequest(provisioned, challenge),
  );
  assert.equal(replayProvision.status, 'existing');
  assert.equal(replayProvision.credentialToken, null);
  assert.equal(replayIssue.status, 'existing');
  assert.equal(replayIssue.challengeToken, null);
  assert.equal(replayClaim.status, 'existing');
});

test('replays provisioning and issue across a fresh console authentication', async (t) => {
  const value = await opened(t);
  const provisioned = await value.service.provision(provisionRequest());
  const challenge = await value.service.issue(issueRequest());
  const restarted = createLocalOwnerBootstrapService(
    value.database.ownerBootstrap,
    value.database.apiCredentials,
    PEPPER,
    restartedIssuer(),
    { now: () => NOW + 2_000, randomBytes: entropy(90) },
  );
  const replayProvision = await restarted.provision(provisionRequest());
  const replayIssue = await restarted.issue(issueRequest());
  assert.equal(replayProvision.status, 'existing');
  assert.equal(replayProvision.subjectId, provisioned.subjectId);
  assert.equal(replayProvision.credentialToken, null);
  assert.equal(replayIssue.status, 'existing');
  assert.equal(replayIssue.challengeId, challenge.challengeId);
  assert.equal(replayIssue.challengeToken, null);

  const foreignProof = createLocalOwnerBootstrapService(
    value.database.ownerBootstrap,
    value.database.apiCredentials,
    PEPPER,
    { ...restartedIssuer(), authenticationId: 'different-local-console' },
    { now: () => NOW + 2_000, randomBytes: entropy(100) },
  );
  await assert.rejects(
    foreignProof.provision(provisionRequest()),
    LocalOwnerBootstrapMutationConflictError,
  );
  await assert.rejects(
    foreignProof.issue(issueRequest()),
    LocalOwnerBootstrapMutationConflictError,
  );
});

test('replays a compacted acknowledgement without regenerating entropy', async (t) => {
  const value = await opened(t);
  const request = provisionRequest();
  const provisioned = await value.service.provision(request);
  const source = await value.database.ownerBootstrap.resolveProvisioning(
    request.mutationId,
  );
  const acknowledgement = {
    kind: 'credential',
    mutationId: request.mutationId,
    requestId: request.requestId,
    subjectId: provisioned.subjectId,
    credentialId: provisioned.credentialId,
    factDigest: source.credential.secretDigest,
    ttlMs: source.credential.expiresAtMs - source.credential.notBeforeAtMs,
    deliveryDigest: 'd'.repeat(64),
    acknowledgedAtMs: NOW + 1,
  };
  await value.database.ownerBootstrap.recordDeliveryAcknowledgement(
    acknowledgement,
  );
  const compactedAtMs = Math.max(
    source.credential.expiresAtMs,
    NOW + MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
    acknowledgement.acknowledgedAtMs +
      MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
  );
  const gc = await openLocalSqliteAcknowledgementGcDatabase(value.options);
  const gcMutationId = '00000000-0000-4000-8000-0000000001f1';
  const gcRequestId = 'ack-gc-1f1';
  await gc.acknowledgementGc.compact({
    mutationId: gcMutationId,
    requestId: gcRequestId,
    acknowledgementMutationId: request.mutationId,
    expectedKind: 'credential',
    expectedDeliveryDigest: acknowledgement.deliveryDigest,
    bridgeClearEvidence: {
      kind: 'credential',
      acknowledgementMutationId: request.mutationId,
      inspectedAtMs: compactedAtMs,
      evidenceDigest: 'e'.repeat(64),
    },
    retentionPolicy: {
      version: 1,
      replayRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
      auditRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
    },
    compactedAtMs,
    audit: {
      eventId: gcMutationId,
      requestId: gcRequestId,
      operationId: 'owner.delivery_acknowledgement.gc',
      projectId: null,
      subject: { type: 'system', id: 'owner-acknowledgement-gc' },
      authenticationId: 'local-owner-console',
      outcome: 'allowed',
      reasons: ['delivery_acknowledgement_gc'],
      fence: null,
      occurredAtMs: compactedAtMs,
    },
  });
  await gc.close();

  const restarted = createLocalOwnerBootstrapService(
    value.database.ownerBootstrap,
    value.database.apiCredentials,
    PEPPER,
    restartedIssuer(),
    {
      now: () => NOW + 2_000,
      randomBytes: () => {
        throw new Error('entropy must not be requested for a tombstone replay');
      },
    },
  );
  assert.deepEqual(await restarted.provision(request), {
    status: 'existing',
    subjectId: provisioned.subjectId,
    credentialId: provisioned.credentialId,
    credentialToken: null,
    expiresAtMs: provisioned.expiresAtMs,
  });
});

test('replays a compacted challenge acknowledgement without regenerating entropy', async (t) => {
  const value = await opened(t);
  await value.service.provision(provisionRequest());
  const request = issueRequest();
  const issued = await value.service.issue(request);
  const source = await value.database.ownerBootstrap.resolveIssuedChallenge(
    request.mutationId,
  );
  const acknowledgement = {
    kind: 'challenge',
    mutationId: request.mutationId,
    requestId: request.requestId,
    projectId: request.projectId,
    challengeId: issued.challengeId,
    factDigest: source.tokenDigest,
    ttlMs: source.expiresAtMs - source.issuedAtMs,
    deliveryDigest: 'f'.repeat(64),
    acknowledgedAtMs: NOW + 1,
  };
  await value.database.ownerBootstrap.recordDeliveryAcknowledgement(
    acknowledgement,
  );
  const compactedAtMs = Math.max(
    source.expiresAtMs,
    NOW + MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
    acknowledgement.acknowledgedAtMs +
      MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
  );
  const gc = await openLocalSqliteAcknowledgementGcDatabase(value.options);
  const gcMutationId = '00000000-0000-4000-8000-0000000001f2';
  const gcRequestId = 'ack-gc-1f2';
  await gc.acknowledgementGc.compact({
    mutationId: gcMutationId,
    requestId: gcRequestId,
    acknowledgementMutationId: request.mutationId,
    expectedKind: 'challenge',
    expectedDeliveryDigest: acknowledgement.deliveryDigest,
    bridgeClearEvidence: {
      kind: 'challenge',
      acknowledgementMutationId: request.mutationId,
      inspectedAtMs: compactedAtMs,
      evidenceDigest: '1'.repeat(64),
    },
    retentionPolicy: {
      version: 1,
      replayRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
      auditRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
    },
    compactedAtMs,
    audit: {
      eventId: gcMutationId,
      requestId: gcRequestId,
      operationId: 'owner.delivery_acknowledgement.gc',
      projectId: null,
      subject: { type: 'system', id: 'owner-acknowledgement-gc' },
      authenticationId: 'local-owner-console',
      outcome: 'allowed',
      reasons: ['delivery_acknowledgement_gc'],
      fence: null,
      occurredAtMs: compactedAtMs,
    },
  });
  await gc.close();

  const restarted = createLocalOwnerBootstrapService(
    value.database.ownerBootstrap,
    value.database.apiCredentials,
    PEPPER,
    restartedIssuer(),
    {
      now: () => NOW + 2_000,
      randomBytes: () => {
        throw new Error('entropy must not be requested for a tombstone replay');
      },
    },
  );
  assert.deepEqual(await restarted.issue(request), {
    status: 'existing',
    challengeId: issued.challengeId,
    challengeToken: null,
    expiresAtMs: issued.expiresAtMs,
  });
});

test('public requests reject caller-supplied identity fields', async (t) => {
  const value = await opened(t);
  await assert.rejects(
    value.service.provision(
      provisionRequest({
        issuer: issuer(),
        userId: 'chosen-user',
        credentialId: 'chosen-key',
      }),
    ),
    LocalOwnerBootstrapConfigurationError,
  );
  await assert.rejects(
    value.service.claim({
      ...claimRequest(
        { credentialToken: 'x' },
        { challengeId: 'A'.repeat(22), challengeToken: 'B'.repeat(43) },
      ),
      principal: issuer(),
    }),
    LocalOwnerBootstrapConfigurationError,
  );
});

test('authentication rejection is audited and consumes the mutation identity', async (t) => {
  const value = await opened(t);
  const provisioned = await value.service.provision(provisionRequest());
  const challenge = await value.service.issue(issueRequest());
  const request = claimRequest(provisioned, challenge, {
    credentialToken: `${provisioned.credentialToken.slice(0, -1)}A`,
  });
  await assert.rejects(
    value.service.claim(request),
    LocalOwnerBootstrapRejectedError,
  );
  await assert.rejects(
    value.service.claim({
      ...request,
      credentialToken: provisioned.credentialToken,
    }),
    LocalOwnerBootstrapMutationConflictError,
  );
  const client = new DatabaseSync(value.options.databasePath, {
    readOnly: true,
  });
  try {
    const event = client
      .prepare(
        'SELECT outcome, reasons_json FROM "QingLong3SecurityAuditEvents" WHERE event_id = ?',
      )
      .get(request.mutationId);
    assert.equal(event.outcome, 'authentication_rejected');
    assert.equal(event.reasons_json, '["credential_rejected"]');
    assert.equal(
      client
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3ProjectRoleBindings"')
        .get().count,
      0,
    );
  } finally {
    client.close();
  }
});

test('two independent connections have exactly one claim winner', async (t) => {
  const value = await opened(t);
  const provisioned = await value.service.provision(provisionRequest());
  const challenge = await value.service.issue(issueRequest());
  const secondDatabase = await openLocalSqliteBootstrapDatabase(value.options);
  t.after(() => secondDatabase.close());
  const secondService = createLocalOwnerBootstrapService(
    secondDatabase.ownerBootstrap,
    secondDatabase.apiCredentials,
    PEPPER,
    issuer(),
    { now: () => NOW, randomBytes: entropy(40) },
  );
  const results = await Promise.allSettled([
    value.service.claim(claimRequest(provisioned, challenge)),
    secondService.claim(
      claimRequest(provisioned, challenge, {
        mutationId: '00000000-0000-4000-8000-000000000104',
        requestId: 'claim-104',
      }),
    ),
  ]);
  assert.equal(
    results.filter(({ status }) => status === 'fulfilled').length,
    1,
  );
  const client = new DatabaseSync(value.options.databasePath, {
    readOnly: true,
  });
  try {
    assert.equal(
      client
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3ProjectRoleBindings"')
        .get().count,
      1,
    );
  } finally {
    client.close();
  }
});

test('any historical binding permanently closes the bootstrap bypass', async (t) => {
  const value = await opened(t);
  const provisioned = await value.service.provision(provisionRequest());
  const challenge = await value.service.issue(issueRequest());
  await value.service.claim(claimRequest(provisioned, challenge));
  const client = new DatabaseSync(value.options.databasePath);
  try {
    client
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES ('default', 'user', ?, 2, 'revoked', NULL,
                   'binding-revoke-2', 'system', 'owner-bootstrap', ?)`,
      )
      .run(provisioned.subjectId, NOW + 1);
  } finally {
    client.close();
  }
  await assert.rejects(
    value.service.issue(
      issueRequest({
        mutationId: '00000000-0000-4000-8000-000000000105',
        requestId: 'issue-105',
      }),
    ),
  );
});

test('claim audit failure rolls back binding and challenge consumption', async (t) => {
  const value = await opened(t);
  const provisioned = await value.service.provision(provisionRequest());
  const challenge = await value.service.issue(issueRequest());
  const trigger = new DatabaseSync(value.options.databasePath);
  trigger.exec(`
    CREATE TRIGGER fail_owner_claim_audit
    BEFORE INSERT ON "QingLong3SecurityAuditEvents"
    WHEN NEW."operation_id" = 'project.owner_bootstrap_claim'
    BEGIN
      SELECT RAISE(ABORT, 'injected audit failure');
    END
  `);
  trigger.close();
  await assert.rejects(
    value.service.claim(claimRequest(provisioned, challenge)),
    LocalOwnerBootstrapServiceUnavailableError,
  );
  const client = new DatabaseSync(value.options.databasePath, {
    readOnly: true,
  });
  try {
    assert.equal(
      client
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3ProjectRoleBindings"')
        .get().count,
      0,
    );
    assert.equal(
      client
        .prepare(
          'SELECT consumed_at_ms FROM "QingLong3LocalOwnerBootstrapChallenges" LIMIT 1',
        )
        .get().consumed_at_ms,
      null,
    );
    assert.equal(
      client
        .prepare(
          `SELECT COUNT(*) AS count FROM "QingLong3SecurityAuditEvents"
           WHERE event_id = '00000000-0000-4000-8000-000000000103'`,
        )
        .get().count,
      0,
    );
  } finally {
    client.close();
  }
});

test('bootstrap authority closes once and rejects later work', async (t) => {
  const value = await opened(t);
  await Promise.all([value.database.close(), value.database.close()]);
  await assert.rejects(
    value.database.ownerBootstrap.resolveProjectVersion('default'),
  );
  await assert.rejects(value.database.apiCredentials.resolve('missing'));
  const root = require('@qinglong/local-sqlite');
  const runtime = require('@qinglong/local-sqlite/runtime');
  assert.equal('openLocalSqliteBootstrapDatabase' in root, false);
  assert.equal('openLocalSqliteBootstrapDatabase' in runtime, false);
});
