const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteBootstrapDatabase,
} = require('@qinglong/local-sqlite/bootstrap');
const {
  createLocalOwnerBootstrapService,
  LOCAL_IDENTITY_BOOTSTRAP_DEFAULT_TTL_MS,
  LocalOwnerBootstrapServiceUnavailableError,
} = require('../dist/bootstrap');
const {
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  FileLocalOwnerBootstrapSecretDelivery,
  LocalOwnerConsoleConfigurationError,
  LocalOwnerSecretDeliveryError,
  openLocalOwnerConsole,
} = require('@qinglong/local-owner-console');

function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-owner-console-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const pepperPath = path.join(deploymentRoot, 'owner.pepper');
  const secretDeliveryDirectory = path.join(deploymentRoot, 'secrets');
  fs.mkdirSync(secretDeliveryDirectory, { mode: 0o700 });
  fs.writeFileSync(pepperPath, Buffer.alloc(32, 73).toString('base64url'), {
    mode: 0o600,
  });
  return {
    deploymentRoot,
    databasePath,
    pepperPath,
    secretDeliveryDirectory,
    profile: 'edge',
  };
}

async function ready(t) {
  const options = fixture(t);
  await migrateLocalSqlitePath({
    databasePath: options.databasePath,
    profile: options.profile,
  });
  const material = fs.readFileSync(options.pepperPath);
  const materialDigest = createHash('sha256')
    .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
    .update(material)
    .digest('hex');
  material.fill(0);
  const database = await openLocalSqliteBootstrapDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
  });
  await database.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000191',
    pepperKeyId: 'legacy-v1',
    materialDigest,
    backupDigest: 'b'.repeat(64),
    registeredAtMs: 1,
  });
  await database.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000192',
    pepperKeyId: 'legacy-v1',
    expectedGeneration: 0,
    activatedAtMs: 2,
  });
  await database.close();
  return options;
}

function authorityFor(options) {
  const root = fs.lstatSync(options.deploymentRoot, { bigint: true });
  const uid = process.getuid();
  const proofDigest = createHash('sha256')
    .update('qinglong.local-owner-console.proof.v1\0', 'utf8')
    .update(process.platform, 'utf8')
    .update('\0', 'utf8')
    .update(String(uid), 'utf8')
    .update('\0', 'utf8')
    .update(root.dev.toString(), 'utf8')
    .update('\0', 'utf8')
    .update(root.ino.toString(), 'utf8')
    .digest('hex');
  const authenticatedAtMs = Date.now();
  return {
    subject: { type: 'system', id: 'owner-bootstrap' },
    authenticationId: `local-console:${proofDigest}`,
    authenticatedAtMs,
    expiresAtMs: authenticatedAtMs + 60_000,
    assurance: 'local_console',
  };
}

test('proves one bounded delivery crash bridge is clear', (t) => {
  const options = fixture(t);
  const delivery = new FileLocalOwnerBootstrapSecretDelivery(
    options.secretDeliveryDirectory,
  );
  const mutationId = '00000000-0000-4000-8000-000000000b01';
  const evidence = delivery.inspectBridgeClear('credential', mutationId);
  assert.equal(evidence.kind, 'credential');
  assert.equal(evidence.acknowledgementMutationId, mutationId);
  assert.match(evidence.evidenceDigest, /^[0-9a-f]{64}$/);

  fs.writeFileSync(
    path.join(
      options.secretDeliveryDirectory,
      `credential-${mutationId}.pending.json`,
    ),
    '{}',
    { mode: 0o600 },
  );
  assert.throws(
    () => delivery.inspectBridgeClear('credential', mutationId),
    /crash bridge is not clear/,
  );
});

async function directService(options, secretDelivery) {
  const database = await openLocalSqliteBootstrapDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
  });
  const service = createLocalOwnerBootstrapService(
    database.ownerBootstrap,
    database.apiCredentials,
    fs.readFileSync(options.pepperPath, 'utf8'),
    authorityFor(options),
    { secretDelivery },
  );
  return { database, service };
}

test('binds POSIX proof at composition time and removes issuer from requests', async (t) => {
  const options = await ready(t);
  const console = await openLocalOwnerConsole(options);
  t.after(() => console.close());
  assert.deepEqual(console.recovery, {
    inspectedPendingRecords: 0,
    publishedRecords: 0,
    retainedUncommittedRecords: 0,
    orphanTemporaryRecords: 0,
  });
  const provisioned = await console.service.provision({
    mutationId: '00000000-0000-4000-8000-000000000201',
    requestId: 'console-provision-201',
  });
  assert.equal(provisioned.status, 'inserted');
  assert.equal(provisioned.credentialToken, null);
  const credentialPath = console.credentialDeliveryPath(
    '00000000-0000-4000-8000-000000000201',
  );
  assert.equal(fs.statSync(credentialPath).mode & 0o777, 0o600);
  const credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  assert.equal(credential.kind, 'credential');
  assert.equal(credential.credentialId, provisioned.credentialId);

  const issued = await console.service.issue({
    projectId: 'default',
    mutationId: '00000000-0000-4000-8000-000000000202',
    requestId: 'console-issue-202',
  });
  assert.equal(issued.status, 'inserted');
  assert.equal(issued.challengeToken, null);
  const challengePath = console.challengeDeliveryPath(
    '00000000-0000-4000-8000-000000000202',
  );
  assert.equal(fs.statSync(challengePath).mode & 0o777, 0o600);
  const challenge = JSON.parse(fs.readFileSync(challengePath, 'utf8'));
  assert.equal(challenge.kind, 'challenge');
  assert.equal(challenge.challengeId, issued.challengeId);

  const claimed = await console.service.claim({
    projectId: 'default',
    mutationId: '00000000-0000-4000-8000-000000000205',
    requestId: 'console-claim-205',
    challengeId: challenge.challengeId,
    challengeToken: challenge.secret,
    credentialToken: formatApiCredentialToken(
      credential.credentialId,
      credential.secret,
    ),
  });
  assert.equal(claimed.status, 'inserted');
  const databaseBytes = fs.readFileSync(options.databasePath);
  assert.equal(databaseBytes.includes(credential.secret), false);
  assert.equal(databaseBytes.includes(challenge.secret), false);
  await assert.rejects(
    console.service.issue({
      projectId: 'default',
      mutationId: '00000000-0000-4000-8000-000000000206',
      requestId: 'console-issue-206',
      issuer: {
        subject: { type: 'system', id: 'owner-bootstrap' },
        authenticationId: 'forged',
        authenticatedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        assurance: 'local_console',
      },
    }),
  );
});

test('claims the first Owner from staged deliveries without crossing the transport with secrets', async (t) => {
  const options = await ready(t);
  const console = await openLocalOwnerConsole(options);
  t.after(() => console.close());
  const credentialMutationId = '00000000-0000-4000-8000-000000000711';
  const challengeMutationId = '00000000-0000-4000-8000-000000000712';
  const claimMutationId = '00000000-0000-4000-8000-000000000713';
  await console.service.provision({
    mutationId: credentialMutationId,
    requestId: 'console-provision-711',
  });
  await console.service.issue({
    projectId: 'default',
    mutationId: challengeMutationId,
    requestId: 'console-issue-712',
  });
  const credentialDelivery =
    console.inspectCredentialDelivery(credentialMutationId);
  const challengeDelivery =
    console.inspectChallengeDelivery(challengeMutationId);
  const claimed = await console.claimOwnerFromDeliveries({
    projectId: 'default',
    mutationId: claimMutationId,
    requestId: 'console-claim-713',
    credentialMutationId,
    challengeMutationId,
  });
  assert.equal(claimed.status, 'inserted');
  assert.equal(claimed.binding.role, 'owner');
  assert.equal(JSON.stringify(claimed).includes('secret'), false);
  await console.acknowledgeCredentialDelivery(
    credentialMutationId,
    credentialDelivery.deliveryDigest,
  );
  await console.acknowledgeChallengeDelivery(
    challengeMutationId,
    challengeDelivery.deliveryDigest,
  );
  const replay = await console.claimOwnerFromDeliveries({
    projectId: 'default',
    mutationId: claimMutationId,
    requestId: 'console-claim-713',
    credentialMutationId,
    challengeMutationId,
  });
  assert.equal(replay.status, 'existing');
  await assert.rejects(
    console.claimOwnerFromDeliveries({
      projectId: 'default',
      mutationId: '00000000-0000-4000-8000-000000000714',
      requestId: 'console-claim-714',
      credentialMutationId,
      challengeMutationId,
      challengeToken: 'forbidden',
    }),
    LocalOwnerSecretDeliveryError,
  );
});

test('recovers one credential without revoking the old token before delivery acknowledgement', async (t) => {
  const options = await ready(t);
  const first = await openLocalOwnerConsole(options);
  const provisionMutationId = '00000000-0000-4000-8000-000000000701';
  const provisioned = await first.service.provision({
    mutationId: provisionMutationId,
    requestId: 'console-provision-701',
  });
  const provisionDelivery =
    first.inspectCredentialDelivery(provisionMutationId);
  await first.acknowledgeCredentialDelivery(
    provisionMutationId,
    provisionDelivery.deliveryDigest,
  );

  const issueMutationId = '00000000-0000-4000-8000-000000000702';
  const issued = await first.credentialRecovery.issue({
    mutationId: issueMutationId,
    requestId: 'console-recover-issue-702',
    previousCredentialId: provisioned.credentialId,
    expectedPreviousVersion: 1,
  });
  assert.equal(issued.status, 'inserted');
  assert.equal(issued.state, 'issued');
  assert.equal(issued.replacementCredentialToken, null);
  const recoveryDelivery = first.inspectCredentialDelivery(issueMutationId);
  await assert.rejects(
    first.credentialRecovery.complete({
      issueMutationId,
      mutationId: '00000000-0000-4000-8000-000000000703',
      requestId: 'console-recover-complete-703',
    }),
  );
  const beforeAcknowledgement = await openLocalSqliteBootstrapDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
  });
  assert.equal(
    (
      await beforeAcknowledgement.apiCredentials.resolve(
        provisioned.credentialId,
      )
    ).state,
    'active',
  );
  await beforeAcknowledgement.close();

  await first.close();
  const restarted = await openLocalOwnerConsole(options);
  t.after(() => restarted.close());
  assert.equal(fs.existsSync(recoveryDelivery.path), true);
  await restarted.acknowledgeCredentialRecoveryDelivery(
    issueMutationId,
    recoveryDelivery.deliveryDigest,
  );
  const completed = await restarted.credentialRecovery.complete({
    issueMutationId,
    mutationId: '00000000-0000-4000-8000-000000000703',
    requestId: 'console-recover-complete-703',
  });
  assert.equal(completed.state, 'completed');
  assert.equal(fs.existsSync(recoveryDelivery.path), false);

  const database = await openLocalSqliteBootstrapDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
  });
  assert.equal(
    (await database.apiCredentials.resolve(provisioned.credentialId)).state,
    'revoked',
  );
  assert.equal(
    (await database.apiCredentials.resolve(issued.replacementCredentialId))
      .state,
    'active',
  );
  await database.close();
  const replay = await restarted.credentialRecovery.issue({
    mutationId: issueMutationId,
    requestId: 'console-recover-issue-702',
    previousCredentialId: provisioned.credentialId,
    expectedPreviousVersion: 1,
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.state, 'completed');
  assert.equal(replay.replacementCredentialToken, null);
});

test('acknowledges exact ready records and replays without regenerating secrets', async (t) => {
  const options = await ready(t);
  const console = await openLocalOwnerConsole(options);
  const credentialMutationId = '00000000-0000-4000-8000-000000000207';
  const provisionRequestId = 'console-provision-207';
  const provisioned = await console.service.provision({
    mutationId: credentialMutationId,
    requestId: provisionRequestId,
  });
  const credentialSummary =
    console.inspectCredentialDelivery(credentialMutationId);
  const credentialReady = fs.readFileSync(credentialSummary.path);
  await assert.rejects(
    console.acknowledgeCredentialDelivery(credentialMutationId, '0'.repeat(64)),
    LocalOwnerSecretDeliveryError,
  );
  assert.equal(fs.existsSync(credentialSummary.path), true);
  const acknowledgementDatabaseA = await openLocalSqliteBootstrapDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
  });
  const acknowledgementDatabaseB = await openLocalSqliteBootstrapDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
  });
  const deliveryA = new FileLocalOwnerBootstrapSecretDelivery(
    options.secretDeliveryDirectory,
  );
  const deliveryB = new FileLocalOwnerBootstrapSecretDelivery(
    options.secretDeliveryDirectory,
  );
  const pepper = fs.readFileSync(options.pepperPath, 'utf8');
  const concurrentAcknowledgements = await Promise.all([
    deliveryA.acknowledge(
      acknowledgementDatabaseA.ownerBootstrap,
      pepper,
      'credential',
      credentialMutationId,
      credentialSummary.deliveryDigest,
      1,
    ),
    deliveryB.acknowledge(
      acknowledgementDatabaseB.ownerBootstrap,
      pepper,
      'credential',
      credentialMutationId,
      credentialSummary.deliveryDigest,
      2,
    ),
  ]);
  await Promise.all([
    acknowledgementDatabaseA.close(),
    acknowledgementDatabaseB.close(),
  ]);
  assert.deepEqual(
    concurrentAcknowledgements[0],
    concurrentAcknowledgements[1],
  );
  const credentialAcknowledgement = await console.acknowledgeCredentialDelivery(
    credentialMutationId,
    credentialSummary.deliveryDigest,
  );
  assert.deepEqual(credentialAcknowledgement, {
    state: 'acknowledged',
    kind: 'credential',
    mutationId: credentialMutationId,
    requestId: provisionRequestId,
    ttlMs: LOCAL_IDENTITY_BOOTSTRAP_DEFAULT_TTL_MS,
  });
  assert.equal(fs.existsSync(credentialSummary.path), false);
  const credentialAcknowledgementPath = path.join(
    options.secretDeliveryDirectory,
    `credential-${credentialMutationId}.acknowledged.json`,
  );
  assert.equal(fs.existsSync(credentialAcknowledgementPath), false);
  const ledgerDatabase = new DatabaseSync(options.databasePath);
  const credentialTombstone = ledgerDatabase
    .prepare(
      `SELECT * FROM "QingLong3LocalOwnerDeliveryAcknowledgements"
       WHERE "mutation_id" = ?`,
    )
    .get(credentialMutationId);
  ledgerDatabase.close();
  assert.equal(
    credentialTombstone.delivery_digest,
    credentialSummary.deliveryDigest,
  );
  assert.equal([1, 2].includes(credentialTombstone.acknowledged_at_ms), true);
  assert.equal(Object.keys(credentialTombstone).includes('secret'), false);
  const replayedProvision = await console.service.provision({
    mutationId: credentialMutationId,
    requestId: provisionRequestId,
  });
  assert.equal(replayedProvision.status, 'existing');
  assert.equal(replayedProvision.subjectId, provisioned.subjectId);
  assert.equal(replayedProvision.credentialId, provisioned.credentialId);
  assert.equal(replayedProvision.credentialToken, null);

  const challengeMutationId = '00000000-0000-4000-8000-000000000208';
  const issueRequestId = 'console-issue-208';
  const issued = await console.service.issue({
    projectId: 'default',
    mutationId: challengeMutationId,
    requestId: issueRequestId,
  });
  const challengeSummary =
    console.inspectChallengeDelivery(challengeMutationId);
  const challengeAcknowledgement = await console.acknowledgeChallengeDelivery(
    challengeMutationId,
    challengeSummary.deliveryDigest,
  );
  assert.deepEqual(challengeAcknowledgement, {
    state: 'acknowledged',
    kind: 'challenge',
    projectId: 'default',
    mutationId: challengeMutationId,
    requestId: issueRequestId,
    ttlMs: 600_000,
  });
  const replayedIssue = await console.service.issue({
    projectId: 'default',
    mutationId: challengeMutationId,
    requestId: issueRequestId,
  });
  assert.equal(replayedIssue.status, 'existing');
  assert.equal(replayedIssue.challengeId, issued.challengeId);
  assert.equal(replayedIssue.challengeToken, null);

  fs.writeFileSync(credentialSummary.path, credentialReady, { mode: 0o600 });
  await console.close();
  const recovered = await openLocalOwnerConsole(options);
  t.after(() => recovered.close());
  assert.equal(fs.existsSync(credentialSummary.path), false);
  assert.deepEqual(recovered.recovery, {
    inspectedPendingRecords: 0,
    publishedRecords: 0,
    retainedUncommittedRecords: 0,
    orphanTemporaryRecords: 0,
  });
  const recoveredReplay = await recovered.service.provision({
    mutationId: credentialMutationId,
    requestId: provisionRequestId,
  });
  assert.equal(recoveredReplay.status, 'existing');
  assert.equal(recoveredReplay.credentialToken, null);
});

test('retains a pre-commit secret and publishes it after the matching commit', async (t) => {
  const options = await ready(t);
  const delivery = new FileLocalOwnerBootstrapSecretDelivery(
    options.secretDeliveryDirectory,
  );
  const mutationId = '00000000-0000-4000-8000-000000000211';
  const staged = await delivery.prepare({
    kind: 'credential',
    mutationId,
    requestId: 'console-provision-211',
    subjectId: `usr_${Buffer.alloc(16, 11).toString('base64url')}`,
    credentialId: `own_${Buffer.alloc(16, 12).toString('base64url')}`,
    secret: Buffer.alloc(32, 13).toString('base64url'),
    ttlMs: LOCAL_IDENTITY_BOOTSTRAP_DEFAULT_TTL_MS,
  });
  const pendingPath = delivery
    .readyPath('credential', mutationId)
    .replace('.ready.json', '.pending.json');
  assert.equal(fs.existsSync(pendingPath), true);

  const console = await openLocalOwnerConsole(options);
  t.after(() => console.close());
  assert.deepEqual(console.recovery, {
    inspectedPendingRecords: 1,
    publishedRecords: 0,
    retainedUncommittedRecords: 1,
    orphanTemporaryRecords: 0,
  });
  const provisioned = await console.service.provision({
    mutationId,
    requestId: staged.requestId,
  });
  assert.equal(provisioned.status, 'inserted');
  assert.equal(provisioned.subjectId, staged.subjectId);
  assert.equal(provisioned.credentialId, staged.credentialId);
  assert.equal(provisioned.credentialToken, null);
  assert.equal(fs.existsSync(pendingPath), false);
  assert.equal(fs.existsSync(console.credentialDeliveryPath(mutationId)), true);
});

test('recovers database-committed credential and challenge after publish failure', async (t) => {
  const options = await ready(t);
  const delivery = new FileLocalOwnerBootstrapSecretDelivery(
    options.secretDeliveryDirectory,
  );
  const failingDelivery = {
    prepare(candidate) {
      return delivery.prepare(candidate);
    },
    async publish() {
      throw new Error('injected publish failure');
    },
  };

  const provisionMutationId = '00000000-0000-4000-8000-000000000221';
  const first = await directService(options, failingDelivery);
  await assert.rejects(
    first.service.provision({
      mutationId: provisionMutationId,
      requestId: 'console-provision-221',
    }),
    LocalOwnerBootstrapServiceUnavailableError,
  );
  await first.database.close();

  const recoveredCredential = await openLocalOwnerConsole(options);
  assert.deepEqual(recoveredCredential.recovery, {
    inspectedPendingRecords: 1,
    publishedRecords: 1,
    retainedUncommittedRecords: 0,
    orphanTemporaryRecords: 0,
  });
  const replayedProvision = await recoveredCredential.service.provision({
    mutationId: provisionMutationId,
    requestId: 'console-provision-221',
  });
  assert.equal(replayedProvision.status, 'existing');
  assert.equal(replayedProvision.credentialToken, null);
  await recoveredCredential.close();

  const challengeMutationId = '00000000-0000-4000-8000-000000000222';
  const second = await directService(options, failingDelivery);
  await assert.rejects(
    second.service.issue({
      projectId: 'default',
      mutationId: challengeMutationId,
      requestId: 'console-issue-222',
    }),
    LocalOwnerBootstrapServiceUnavailableError,
  );
  await second.database.close();

  const recoveredChallenge = await openLocalOwnerConsole(options);
  t.after(() => recoveredChallenge.close());
  assert.deepEqual(recoveredChallenge.recovery, {
    inspectedPendingRecords: 1,
    publishedRecords: 1,
    retainedUncommittedRecords: 0,
    orphanTemporaryRecords: 0,
  });
  const replayedIssue = await recoveredChallenge.service.issue({
    projectId: 'default',
    mutationId: challengeMutationId,
    requestId: 'console-issue-222',
  });
  assert.equal(replayedIssue.status, 'existing');
  assert.equal(replayedIssue.challengeToken, null);
});

test('fails closed on tampered delivery records and bounded-directory overflow', async (t) => {
  await t.test('private record mode', async (t) => {
    const options = await ready(t);
    const console = await openLocalOwnerConsole(options);
    const mutationId = '00000000-0000-4000-8000-000000000231';
    await console.service.provision({
      mutationId,
      requestId: 'console-provision-231',
    });
    const recordPath = console.credentialDeliveryPath(mutationId);
    await console.close();
    fs.chmodSync(recordPath, 0o644);
    await assert.rejects(
      openLocalOwnerConsole(options),
      LocalOwnerSecretDeliveryError,
    );
  });

  await t.test('database digest mismatch', async (t) => {
    const options = await ready(t);
    const console = await openLocalOwnerConsole(options);
    const mutationId = '00000000-0000-4000-8000-000000000232';
    await console.service.provision({
      mutationId,
      requestId: 'console-provision-232',
    });
    const recordPath = console.credentialDeliveryPath(mutationId);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    await console.close();
    record.secret = Buffer.alloc(32, 99).toString('base64url');
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      openLocalOwnerConsole(options),
      LocalOwnerSecretDeliveryError,
    );
  });

  await t.test('entry budget', async (t) => {
    const options = await ready(t);
    for (let index = 0; index < 65; index += 1) {
      const name = `.credential-${randomUUID()}.${randomUUID()}.tmp`;
      fs.writeFileSync(path.join(options.secretDeliveryDirectory, name), 'x', {
        mode: 0o600,
      });
    }
    await assert.rejects(
      openLocalOwnerConsole(options),
      LocalOwnerSecretDeliveryError,
    );
  });

  await t.test('tampered acknowledgement fact', async (t) => {
    const options = await ready(t);
    const console = await openLocalOwnerConsole(options);
    const mutationId = '00000000-0000-4000-8000-000000000233';
    await console.service.provision({
      mutationId,
      requestId: 'console-provision-233',
    });
    const summary = console.inspectCredentialDelivery(mutationId);
    await console.acknowledgeCredentialDelivery(
      mutationId,
      summary.deliveryDigest,
    );
    await console.close();
    const database = new DatabaseSync(options.databasePath);
    database
      .prepare(
        `UPDATE "QingLong3LocalOwnerDeliveryAcknowledgements"
         SET "fact_digest" = ? WHERE "mutation_id" = ?`,
      )
      .run('0'.repeat(64), mutationId);
    database.close();
    const reopened = await openLocalOwnerConsole(options);
    t.after(() => reopened.close());
    await assert.rejects(
      reopened.service.provision({
        mutationId,
        requestId: 'console-provision-233',
      }),
      LocalOwnerBootstrapServiceUnavailableError,
    );
  });

  await t.test('acknowledged mutation with pending record', async (t) => {
    const options = await ready(t);
    const console = await openLocalOwnerConsole(options);
    const mutationId = '00000000-0000-4000-8000-000000000234';
    await console.service.provision({
      mutationId,
      requestId: 'console-provision-234',
    });
    const summary = console.inspectCredentialDelivery(mutationId);
    const readyMaterial = fs.readFileSync(summary.path);
    await console.acknowledgeCredentialDelivery(
      mutationId,
      summary.deliveryDigest,
    );
    await console.close();
    fs.writeFileSync(
      summary.path.replace('.ready.json', '.pending.json'),
      readyMaterial,
      { mode: 0o600 },
    );
    await assert.rejects(
      openLocalOwnerConsole(options),
      LocalOwnerSecretDeliveryError,
    );
  });
});

test('cleans staged files after ENOSPC and read-only delivery failures', async (t) => {
  for (const [index, code] of ['ENOSPC', 'EROFS'].entries()) {
    await t.test(code, async (t) => {
      const options = await ready(t);
      const console = await openLocalOwnerConsole(options);
      t.after(() => console.close());
      const originalWriteFileSync = fs.writeFileSync;
      fs.writeFileSync = function injectedWriteFailure(target, ...args) {
        if (typeof target === 'number') {
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
        return originalWriteFileSync.call(this, target, ...args);
      };
      try {
        await assert.rejects(
          console.service.provision({
            mutationId: `00000000-0000-4000-8000-00000000024${index}`,
            requestId: `console-provision-24${index}`,
          }),
          LocalOwnerBootstrapServiceUnavailableError,
        );
      } finally {
        fs.writeFileSync = originalWriteFileSync;
      }
      assert.deepEqual(fs.readdirSync(options.secretDeliveryDirectory), []);
    });
  }
});

test('rejects broad deployment permissions and pepper symlinks', async (t) => {
  const broad = await ready(t);
  fs.chmodSync(broad.deploymentRoot, 0o755);
  await assert.rejects(
    openLocalOwnerConsole(broad),
    LocalOwnerConsoleConfigurationError,
  );

  const linked = await ready(t);
  const actualPepper = path.join(linked.deploymentRoot, 'actual.pepper');
  fs.renameSync(linked.pepperPath, actualPepper);
  fs.symlinkSync(actualPepper, linked.pepperPath);
  await assert.rejects(
    openLocalOwnerConsole(linked),
    LocalOwnerConsoleConfigurationError,
  );
});

test('rechecks database identity before every authority operation', async (t) => {
  const options = await ready(t);
  const console = await openLocalOwnerConsole(options);
  t.after(() => console.close());
  const moved = path.join(options.deploymentRoot, 'moved.sqlite');
  fs.renameSync(options.databasePath, moved);
  fs.copyFileSync(moved, options.databasePath);
  fs.chmodSync(options.databasePath, 0o600);
  await assert.rejects(
    async () =>
      console.service.provision({
        mutationId: '00000000-0000-4000-8000-000000000203',
        requestId: 'console-provision-203',
      }),
    LocalOwnerConsoleConfigurationError,
  );
});

test('close is idempotent and no CLI or default-runtime authority is exported', async (t) => {
  const options = await ready(t);
  const console = await openLocalOwnerConsole(options);
  await Promise.all([console.close(), console.close()]);
  await assert.rejects(
    console.service.provision({
      mutationId: '00000000-0000-4000-8000-000000000204',
      requestId: 'console-provision-204',
    }),
  );
  const manifest = require('../package.json');
  assert.equal('bin' in manifest, false);
  const localRuntime = require('@qinglong/local-sqlite/runtime');
  assert.equal('openLocalOwnerConsole' in localRuntime, false);
});
