const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  openLocalSqliteBootstrapDatabase,
} = require('@qinglong/local-sqlite/bootstrap');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalOwnerCliConfigurationError,
  createLocalOwnerCommandRunner,
} = require('@qinglong/local-owner-cli');

async function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-owner-cli-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const pepperPath = path.join(deploymentRoot, 'owner.pepper');
  const secretDeliveryDirectory = path.join(deploymentRoot, 'secrets');
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  fs.mkdirSync(secretDeliveryDirectory, { mode: 0o700 });
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.writeFileSync(pepperPath, Buffer.alloc(32, 83).toString('base64url'), {
    mode: 0o600,
  });
  const options = {
    deploymentRoot,
    databasePath,
    pepperPath,
    pepperKeyId: 'legacy-v1',
    secretDeliveryDirectory,
    profile: 'edge',
  };
  await migrateLocalSqlitePath(options);
  const material = fs.readFileSync(pepperPath);
  const materialDigest = createHash('sha256')
    .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
    .update(material)
    .digest('hex');
  material.fill(0);
  const database = await openLocalSqliteBootstrapDatabase(options);
  await database.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000c91',
    pepperKeyId: 'legacy-v1',
    materialDigest,
    backupDigest: 'b'.repeat(64),
    registeredAtMs: 1,
  });
  await database.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000c92',
    pepperKeyId: 'legacy-v1',
    expectedGeneration: 0,
    activatedAtMs: 2,
  });
  await database.close();
  return { options, commandsDirectory };
}

function commandFile(state, operation, request, suffix) {
  const filePath = path.join(state.commandsDirectory, `${suffix}.json`);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation,
      options: state.options,
      request,
    })}\n`,
    { mode: 0o600 },
  );
  return filePath;
}

function assertNoSecretFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key, /secret|token/i);
    assertNoSecretFields(nested);
  }
}

test('completes fresh Owner and credential recovery ceremonies without returning secrets', async (t) => {
  const state = await fixture(t);
  const runner = createLocalOwnerCommandRunner();
  const credentialMutationId = '00000000-0000-4000-8000-000000000c01';
  const challengeMutationId = '00000000-0000-4000-8000-000000000c02';
  const claimMutationId = '00000000-0000-4000-8000-000000000c03';
  const provisioned = await runner.run(
    commandFile(
      state,
      'owner.identity.provision',
      {
        mutationId: credentialMutationId,
        requestId: 'owner-cli-provision-c01',
      },
      '01-provision',
    ),
  );
  assert.equal(provisioned.status, 'inserted');
  assert.equal(provisioned.delivery.kind, 'credential');
  const issued = await runner.run(
    commandFile(
      state,
      'owner.challenge.issue',
      {
        projectId: 'default',
        mutationId: challengeMutationId,
        requestId: 'owner-cli-issue-c02',
      },
      '02-issue',
    ),
  );
  assert.equal(issued.delivery.kind, 'challenge');
  const inspected = await runner.run(
    commandFile(
      state,
      'owner.delivery.inspect',
      { kind: 'challenge', mutationId: challengeMutationId },
      '03-inspect',
    ),
  );
  assert.equal(
    inspected.delivery.deliveryDigest,
    issued.delivery.deliveryDigest,
  );
  const claimFile = commandFile(
    state,
    'owner.claim.from-deliveries',
    {
      projectId: 'default',
      mutationId: claimMutationId,
      requestId: 'owner-cli-claim-c03',
      credentialMutationId,
      challengeMutationId,
    },
    '04-claim',
  );
  const claimed = await runner.run(claimFile);
  assert.equal(claimed.status, 'inserted');
  assert.equal(claimed.role, 'owner');
  assert.equal(JSON.stringify(claimed).includes('secret'), false);
  for (const [purpose, mutationId, digest, suffix] of [
    [
      'credential-provisioning',
      credentialMutationId,
      provisioned.delivery.deliveryDigest,
      '05-ack-credential',
    ],
    [
      'challenge',
      challengeMutationId,
      issued.delivery.deliveryDigest,
      '06-ack-challenge',
    ],
  ]) {
    const acknowledged = await runner.run(
      commandFile(
        state,
        'owner.delivery.acknowledge',
        { purpose, mutationId, expectedDeliveryDigest: digest },
        suffix,
      ),
    );
    assert.equal(acknowledged.mutationId, mutationId);
  }
  const replay = await runner.run(claimFile);
  assert.equal(replay.status, 'existing');
  const recoveryMutationId = '00000000-0000-4000-8000-000000000c04';
  const recovery = await runner.run(
    commandFile(
      state,
      'owner.credential-recovery.issue',
      {
        mutationId: recoveryMutationId,
        requestId: 'owner-cli-recovery-c04',
        previousCredentialId: provisioned.credentialId,
        expectedPreviousVersion: 1,
      },
      '07-recovery-issue',
    ),
  );
  assert.equal(recovery.state, 'issued');
  assert.equal(recovery.delivery.kind, 'credential');
  await runner.run(
    commandFile(
      state,
      'owner.delivery.acknowledge',
      {
        purpose: 'credential-recovery',
        mutationId: recoveryMutationId,
        expectedDeliveryDigest: recovery.delivery.deliveryDigest,
      },
      '08-recovery-ack',
    ),
  );
  const completed = await runner.run(
    commandFile(
      state,
      'owner.credential-recovery.complete',
      {
        issueMutationId: recoveryMutationId,
        mutationId: '00000000-0000-4000-8000-000000000c05',
        requestId: 'owner-cli-recovery-complete-c05',
      },
      '09-recovery-complete',
    ),
  );
  assert.equal(completed.state, 'completed');
  for (const result of [
    provisioned,
    issued,
    inspected,
    claimed,
    recovery,
    completed,
  ]) {
    assertNoSecretFields(result);
  }
});

test('rejects widened command intent and exposes only a command-file binary', async (t) => {
  const state = await fixture(t);
  const widened = commandFile(
    state,
    'owner.delivery.inspect',
    {
      kind: 'credential',
      mutationId: '00000000-0000-4000-8000-000000000d01',
      secret: 'forbidden',
    },
    'widened',
  );
  await assert.rejects(
    createLocalOwnerCommandRunner().run(widened),
    LocalOwnerCliConfigurationError,
  );
  const help = spawnSync(
    process.execPath,
    [path.join(__dirname, '../dist/cli.js'), '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-owner run --command-file /);
  const invalid = spawnSync(
    process.execPath,
    [path.join(__dirname, '../dist/cli.js'), 'run'],
    { encoding: 'utf8' },
  );
  assert.equal(invalid.status, 64);
  assert.equal(
    JSON.parse(invalid.stderr).code,
    'LOCAL_OWNER_CLI_USAGE_INVALID',
  );
});
