const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LocalSecretMutationConflictError,
  LocalSecretUnavailableError,
  LocalSecretVersionConflictError,
  createLocalSecretRef,
  parseLocalSecretRef,
} = require('@qinglong/runtime-core/local-secret');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  EncryptedLocalSecretService,
  LocalSecretKeyringConflictError,
  LocalSecretKeyringFileProvider,
  decryptLocalSecretEnvelopeToBuffer,
  encryptLocalSecretEnvelope,
  provisionLocalSecretKeyring,
  rotateLocalSecretKeyring,
} = require('../dist');

const KEY = Buffer.alloc(32, 0x11);

function fixture(t, profile = 'edge') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-secret-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    profile,
    databasePath: path.join(directory, 'qinglong3.sqlite'),
    keyringPath: path.join(directory, 'secret-keyring.json'),
  };
}

function candidate(projectId = 'default') {
  return {
    runId: 'run-secret',
    attemptId: 'attempt-secret',
    projectId,
    taskId: 'task-secret',
    taskRevision: 'revision-secret',
    attemptNumber: 1,
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: 1_760_000_000_000,
    attemptCreatedAtMs: 1_760_000_000_000,
  };
}

async function store(t, profile = 'edge') {
  const value = fixture(t, profile);
  await migrateLocalSqlitePath(value);
  await provisionLocalSecretKeyring(value.keyringPath);
  const runtime = await openLocalSqliteRuntimeDatabase(value);
  t.after(() => runtime.close());
  const keys = new LocalSecretKeyringFileProvider(value.keyringPath);
  return {
    ...value,
    runtime,
    keys,
    service: new EncryptedLocalSecretService(runtime.localSecrets, keys),
  };
}

test('uses canonical Project-bound refs and metadata-authenticated AES-GCM', () => {
  const ref = createLocalSecretRef({
    projectId: 'default',
    name: 'TOKEN',
    version: 2,
  });
  assert.deepEqual(parseLocalSecretRef(ref), {
    projectId: 'default',
    name: 'TOKEN',
    version: 2,
  });
  const unknown = Buffer.from(
    JSON.stringify({ projectId: 'default', name: 'TOKEN', extra: true }),
  ).toString('base64url');
  assert.throws(() => parseLocalSecretRef(`qlsecret:v1:${unknown}`));

  const envelope = encryptLocalSecretEnvelope(
    {
      projectId: 'default',
      name: 'TOKEN',
      version: 1,
      mutationId: 'create-token',
      keyId: 'edge-key-1',
      algorithm: 'aes-256-gcm',
      createdAtMs: 100,
    },
    'fixed-secret',
    KEY,
    () => Buffer.alloc(12, 0x22),
  );
  assert.deepEqual(
    {
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      authTag: envelope.authTag,
    },
    {
      nonce: 'IiIiIiIiIiIiIiIi',
      ciphertext: 'cZ5_LKTi7DqGTbtI',
      authTag: '2af0_G7xHiOEBvMlsBSr0Q',
    },
  );
  const plaintext = decryptLocalSecretEnvelopeToBuffer(envelope, KEY);
  assert.equal(plaintext.toString('utf8'), 'fixed-secret');
  plaintext.fill(0);
  assert.throws(
    () =>
      decryptLocalSecretEnvelopeToBuffer(
        { ...envelope, projectId: 'another-project' },
        KEY,
      ),
    LocalSecretUnavailableError,
  );
});

test('provisions once, reloads active rotation and keeps historical keys', async (t) => {
  const value = fixture(t);
  const first = await provisionLocalSecretKeyring(value.keyringPath);
  assert.equal(first.keyIds.length, 1);
  assert.equal(fs.statSync(value.keyringPath).mode & 0o777, 0o600);
  await assert.rejects(
    provisionLocalSecretKeyring(value.keyringPath),
    LocalSecretUnavailableError,
  );

  const provider = new LocalSecretKeyringFileProvider(value.keyringPath);
  const firstMaterial = await provider.active();
  assert.equal(firstMaterial.keyId, first.activeKeyId);
  firstMaterial.key.fill(0);
  const second = await rotateLocalSecretKeyring({
    filePath: value.keyringPath,
    expectedActiveKeyId: first.activeKeyId,
  });
  assert.equal(second.keyIds.length, 2);
  assert.notEqual(second.activeKeyId, first.activeKeyId);
  const activeMaterial = await provider.active();
  assert.equal(activeMaterial.keyId, second.activeKeyId);
  activeMaterial.key.fill(0);
  const historicalMaterial = await provider.resolve(first.activeKeyId);
  assert.equal(historicalMaterial.key.length, 32);
  historicalMaterial.key.fill(0);
  await assert.rejects(
    rotateLocalSecretKeyring({
      filePath: value.keyringPath,
      expectedActiveKeyId: first.activeKeyId,
    }),
    LocalSecretKeyringConflictError,
  );

  fs.chmodSync(value.keyringPath, 0o644);
  await assert.rejects(provider.active(), LocalSecretUnavailableError);
});

test('rejects keyring symlinks and preserves an existing rotation lock', async (t) => {
  const value = fixture(t);
  const first = await provisionLocalSecretKeyring(value.keyringPath);
  const symlinkPath = path.join(value.directory, 'secret-keyring-link.json');
  fs.symlinkSync(value.keyringPath, symlinkPath);
  const symlinkProvider = new LocalSecretKeyringFileProvider(symlinkPath);
  await assert.rejects(symlinkProvider.active(), LocalSecretUnavailableError);
  await assert.rejects(
    rotateLocalSecretKeyring({
      filePath: symlinkPath,
      expectedActiveKeyId: first.activeKeyId,
    }),
    LocalSecretUnavailableError,
  );

  const lockPath = `${value.keyringPath}.lock`;
  fs.writeFileSync(lockPath, 'external-manager\n', { mode: 0o600, flag: 'wx' });
  await assert.rejects(
    rotateLocalSecretKeyring({
      filePath: value.keyringPath,
      expectedActiveKeyId: first.activeKeyId,
    }),
    LocalSecretUnavailableError,
  );
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'external-manager\n');
  assert.equal(
    (await new LocalSecretKeyringFileProvider(value.keyringPath).inspect())
      .activeKeyId,
    first.activeKeyId,
  );
});

test('creates and rotates append-only ciphertext through the Node 24 SQLite authority', async (t) => {
  const value = await store(t);
  const firstPlaintext = 'first-plaintext-never-persisted';
  const secondPlaintext = 'second-plaintext-never-persisted';
  const first = await value.service.put({
    projectId: 'default',
    name: 'TOKEN',
    plaintext: firstPlaintext,
    mutationId: 'create-token',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  });
  const rotatedKeyring = await rotateLocalSecretKeyring({
    filePath: value.keyringPath,
    expectedActiveKeyId: (await value.keys.inspect()).activeKeyId,
  });
  const second = await value.service.put({
    projectId: 'default',
    name: 'TOKEN',
    plaintext: secondPlaintext,
    mutationId: 'rotate-token',
    expectedCurrentVersion: 1,
    createdAtMs: 200,
  });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(
    (await value.keys.inspect()).activeKeyId,
    rotatedKeyring.activeKeyId,
  );

  assert.deepEqual(
    await value.service.resolveLocalSecretEnvironment({
      candidate: candidate(),
      secretRefs: [
        createLocalSecretRef({ projectId: 'default', name: 'TOKEN' }),
        first.secretRef,
        second.secretRef,
      ],
    }),
    [secondPlaintext, firstPlaintext, secondPlaintext],
  );
  const material = await value.service.resolveProjectSecretMaterial({
    projectId: 'default',
    secretRef: createLocalSecretRef({
      projectId: 'default',
      name: 'TOKEN',
    }),
  });
  assert.ok(material);
  assert.equal(material.secretRef.includes(secondPlaintext), false);
  assert.equal(Buffer.from(material.bytes).toString('utf8'), secondPlaintext);
  const ownedBytes = material.bytes;
  await material.dispose();
  assert.deepEqual([...ownedBytes], new Array(ownedBytes.length).fill(0));
  await material.dispose();

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT ciphertext, key_id FROM "QingLong3LocalSecretEnvelopes"
         ORDER BY version`,
      )
      .all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].key_id, rows[1].key_id);
    assert.equal(JSON.stringify(rows).includes(firstPlaintext), false);
    assert.equal(JSON.stringify(rows).includes(secondPlaintext), false);
  } finally {
    database.close();
  }
});

test('replays semantic mutations, fences stale versions and checks Project before storage', async (t) => {
  const value = await store(t, 'standalone');
  const command = {
    projectId: 'default',
    name: 'TOKEN',
    plaintext: 'same-value',
    mutationId: 'create-token',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  };
  assert.equal((await value.service.put(command)).status, 'inserted');
  assert.equal(
    (await value.service.put({ ...command, createdAtMs: 999 })).status,
    'existing',
  );
  await assert.rejects(
    value.service.put({ ...command, plaintext: 'different-value' }),
    LocalSecretMutationConflictError,
  );
  await assert.rejects(
    value.service.put({ ...command, mutationId: 'stale-create' }),
    LocalSecretVersionConflictError,
  );
  await assert.rejects(
    value.service.resolveLocalSecretEnvironment({
      candidate: candidate('default'),
      secretRefs: [
        createLocalSecretRef({ projectId: 'another', name: 'TOKEN' }),
      ],
    }),
    LocalSecretUnavailableError,
  );
  await assert.rejects(
    value.service.resolveProjectSecretMaterial({
      projectId: 'default',
      secretRef: createLocalSecretRef({
        projectId: 'another',
        name: 'TOKEN',
      }),
    }),
    LocalSecretUnavailableError,
  );
});

test('two SQLite authorities allow exactly one rotation for one expected version', async (t) => {
  const value = fixture(t, 'standalone');
  await migrateLocalSqlitePath(value);
  await provisionLocalSecretKeyring(value.keyringPath);
  const firstRuntime = await openLocalSqliteRuntimeDatabase(value);
  const secondRuntime = await openLocalSqliteRuntimeDatabase(value);
  t.after(() => Promise.all([firstRuntime.close(), secondRuntime.close()]));
  const keys = new LocalSecretKeyringFileProvider(value.keyringPath);
  const first = new EncryptedLocalSecretService(
    firstRuntime.localSecrets,
    keys,
  );
  const second = new EncryptedLocalSecretService(
    secondRuntime.localSecrets,
    keys,
  );
  await first.put({
    projectId: 'default',
    name: 'TOKEN',
    plaintext: 'initial',
    mutationId: 'initial',
    expectedCurrentVersion: 0,
    createdAtMs: 1,
  });
  const results = await Promise.allSettled([
    first.put({
      projectId: 'default',
      name: 'TOKEN',
      plaintext: 'winner-a',
      mutationId: 'rotate-a',
      expectedCurrentVersion: 1,
      createdAtMs: 2,
    }),
    second.put({
      projectId: 'default',
      name: 'TOKEN',
      plaintext: 'winner-b',
      mutationId: 'rotate-b',
      expectedCurrentVersion: 1,
      createdAtMs: 2,
    }),
  ]);
  assert.equal(
    results.filter(({ status }) => status === 'fulfilled').length,
    1,
  );
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(
    results.find(({ status }) => status === 'rejected').reason.constructor,
    LocalSecretVersionConflictError,
  );
});
