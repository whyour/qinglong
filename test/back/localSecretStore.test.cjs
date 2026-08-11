require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  LOCAL_SECRET_ENVELOPE_TABLE,
  localSecretEnvelopeMigration,
} = require('../../back/migrations/0014-local-secret-envelopes');
const { runMigrations } = require('../../back/migrations/runner');
const {
  decryptLocalSecretEnvelopeToBuffer,
  encryptLocalSecretEnvelope,
} = require('../../back/runtime/adapters/crypto/aes256GcmLocalSecret');
const {
  LocalSecretKeyringFileProvider,
} = require('../../back/runtime/adapters/fs/localSecretKeyringFileProvider');
const {
  LegacySequelizeLocalSecretEnvelopeRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/localSecretEnvelopeRepository');
const {
  EncryptedLocalSecretService,
  LocalSecretMutationConflictError,
  LocalSecretVersionConflictError,
} = require('../../back/runtime/application/encryptedLocalSecretService');
const {
  LOCAL_SECRET_ALGORITHM,
  LocalSecretUnavailableError,
  createLocalSecretRef,
  parseLocalSecretRef,
} = require('../../back/runtime/domain/localSecret');

const KEY = Buffer.alloc(32, 0x11);

function keyProvider(key = KEY) {
  return {
    async active() {
      return { keyId: 'edge-key-1', key: Uint8Array.from(key) };
    },
    async resolve(keyId) {
      return keyId === 'edge-key-1'
        ? { keyId, key: Uint8Array.from(key) }
        : null;
    },
  };
}

function candidate(projectId = 'default') {
  return {
    runId: 'run-secret',
    attemptId: 'attempt-secret',
    projectId,
    taskId: 'task-secret',
    taskRevision: 'revision-secret',
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: 1_760_000_000_000,
    attemptCreatedAtMs: 1_760_000_000_000,
  };
}

async function createStore(t, storage = ':memory:') {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [localSecretEnvelopeMigration],
    logger: { info() {} },
  });
  let nonce = 0;
  const repository = new LegacySequelizeLocalSecretEnvelopeRepository(database);
  const service = new EncryptedLocalSecretService(
    repository,
    keyProvider(),
    () => Buffer.alloc(12, nonce++),
  );
  return { database, repository, service };
}

test('uses a stable AES-256-GCM envelope vector bound to metadata AAD', () => {
  const envelope = encryptLocalSecretEnvelope(
    {
      projectId: 'default',
      name: 'TOKEN',
      version: 1,
      mutationId: 'mutation-1',
      keyId: 'edge-key-1',
      algorithm: LOCAL_SECRET_ALGORITHM,
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
      authTag: 'tsA93yEy5RJCD5Q6wngfgA',
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

test('SecretRef is canonical, project-bound and optionally pins an integer version', () => {
  const current = createLocalSecretRef({ projectId: 'default', name: 'TOKEN' });
  const exact = createLocalSecretRef({
    projectId: 'default',
    name: 'TOKEN',
    version: 2,
  });
  assert.deepEqual(parseLocalSecretRef(current), {
    projectId: 'default',
    name: 'TOKEN',
  });
  assert.deepEqual(parseLocalSecretRef(exact), {
    projectId: 'default',
    name: 'TOKEN',
    version: 2,
  });
  const unknownField = Buffer.from(
    JSON.stringify({ projectId: 'default', name: 'TOKEN', extra: true }),
  ).toString('base64url');
  assert.throws(() => parseLocalSecretRef(`qlsecret:v1:${unknownField}`));
  assert.throws(() =>
    createLocalSecretRef({ projectId: 'default', name: 'TOKEN', version: 0 }),
  );
});

test('creates and rotates append-only versions without storing plaintext', async (t) => {
  const { database, service } = await createStore(t);
  const firstPlaintext = 'first-plaintext-never-persisted';
  const secondPlaintext = 'second-plaintext-never-persisted';
  const first = await service.put({
    projectId: 'default',
    name: 'TOKEN',
    plaintext: firstPlaintext,
    mutationId: 'create-token',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  });
  const second = await service.put({
    projectId: 'default',
    name: 'TOKEN',
    plaintext: secondPlaintext,
    mutationId: 'rotate-token',
    expectedCurrentVersion: 1,
    createdAtMs: 200,
  });
  assert.deepEqual(
    { status: first.status, version: first.version },
    { status: 'inserted', version: 1 },
  );
  assert.deepEqual(
    { status: second.status, version: second.version },
    { status: 'inserted', version: 2 },
  );

  const resolved = await service.resolve({
    candidate: candidate(),
    secretRefs: [
      createLocalSecretRef({ projectId: 'default', name: 'TOKEN' }),
      first.secretRef,
      second.secretRef,
    ],
  });
  assert.deepEqual(resolved, [
    secondPlaintext,
    firstPlaintext,
    secondPlaintext,
  ]);

  const rows = await database.query(
    `SELECT * FROM "${LOCAL_SECRET_ENVELOPE_TABLE}" ORDER BY version`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(Buffer.isBuffer(row.ciphertext));
    assert.equal(row.ciphertext.includes(Buffer.from(firstPlaintext)), false);
    assert.equal(row.ciphertext.includes(Buffer.from(secondPlaintext)), false);
    assert.equal(JSON.stringify(row).includes(firstPlaintext), false);
    assert.equal(JSON.stringify(row).includes(secondPlaintext), false);
  }
});

test('replays mutations idempotently and fences stale rotations', async (t) => {
  const { service } = await createStore(t);
  const command = {
    projectId: 'default',
    name: 'TOKEN',
    plaintext: 'same-value',
    mutationId: 'create-token',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  };
  assert.equal((await service.put(command)).status, 'inserted');
  assert.equal(
    (await service.put({ ...command, createdAtMs: 999 })).status,
    'existing',
  );
  await assert.rejects(
    service.put({ ...command, plaintext: 'different-value' }),
    LocalSecretMutationConflictError,
  );
  await assert.rejects(
    service.put({
      ...command,
      mutationId: 'stale-create',
      plaintext: 'stale-value',
    }),
    LocalSecretVersionConflictError,
  );
});

test('batch resolution preserves position, supports missing, and checks Project first', async (t) => {
  const { repository, service } = await createStore(t);
  await service.put({
    projectId: 'default',
    name: 'A',
    plaintext: 'value-a',
    mutationId: 'create-a',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  });
  await service.put({
    projectId: 'default',
    name: 'B',
    plaintext: 'value-b',
    mutationId: 'create-b',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  });
  const refs = [
    { projectId: 'default', name: 'B' },
    { projectId: 'default', name: 'missing' },
    { projectId: 'default', name: 'A', version: 1 },
  ];
  const envelopes = await repository.resolveMany(refs);
  assert.deepEqual(
    envelopes.map((item) => item && item.name),
    ['B', null, 'A'],
  );
  assert.equal(
    await service.resolve({
      candidate: candidate(),
      secretRefs: refs.map(createLocalSecretRef),
    }),
    null,
  );

  let databaseCalls = 0;
  const isolated = new EncryptedLocalSecretService(
    {
      async append() {
        throw new Error('not used');
      },
      async findByMutation() {
        throw new Error('not used');
      },
      async resolveMany() {
        databaseCalls += 1;
        return [];
      },
    },
    keyProvider(),
  );
  await assert.rejects(
    isolated.resolve({
      candidate: candidate('default'),
      secretRefs: [
        createLocalSecretRef({ projectId: 'another', name: 'TOKEN' }),
      ],
    }),
    LocalSecretUnavailableError,
  );
  assert.equal(databaseCalls, 0);
});

test('corrupt ciphertext and wrong keys fail with a generic non-secret error', async (t) => {
  const { database, repository, service } = await createStore(t);
  const plaintext = 'must-not-appear-in-errors';
  await service.put({
    projectId: 'default',
    name: 'TOKEN',
    plaintext,
    mutationId: 'create-token',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  });
  await database
    .getQueryInterface()
    .bulkUpdate(
      LOCAL_SECRET_ENVELOPE_TABLE,
      { auth_tag: Buffer.alloc(16) },
      { project_id: 'default', secret_name: 'TOKEN', version: 1 },
    );
  const request = {
    candidate: candidate(),
    secretRefs: [createLocalSecretRef({ projectId: 'default', name: 'TOKEN' })],
  };
  await assert.rejects(service.resolve(request), (error) => {
    assert.equal(error.constructor, LocalSecretUnavailableError);
    assert.equal(error.message, 'Local Secret is unavailable');
    assert.equal(error.message.includes(plaintext), false);
    assert.equal(error.message.includes('TOKEN'), false);
    return true;
  });

  const wrongKeyService = new EncryptedLocalSecretService(
    repository,
    keyProvider(Buffer.alloc(32, 0x33)),
  );
  await assert.rejects(
    wrongKeyService.resolve(request),
    LocalSecretUnavailableError,
  );
});

test('private keyring reloads rotation and rejects broad modes and symlinks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-secret-keyring-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keyringPath = path.join(root, 'keyring.json');
  const manifest = (activeKeyId, keys) =>
    JSON.stringify({ version: 1, activeKeyId, keys });
  const first = Buffer.alloc(32, 0x11).toString('base64url');
  const second = Buffer.alloc(32, 0x22).toString('base64url');
  await fs.writeFile(keyringPath, manifest('key-1', { 'key-1': first }), {
    mode: 0o600,
  });
  const provider = new LocalSecretKeyringFileProvider(keyringPath);
  assert.equal((await provider.active()).keyId, 'key-1');
  await fs.writeFile(
    keyringPath,
    manifest('key-2', { 'key-1': first, 'key-2': second }),
  );
  await fs.chmod(keyringPath, 0o600);
  assert.equal((await provider.active()).keyId, 'key-2');
  assert.equal(
    Buffer.from((await provider.resolve('key-1')).key).equals(KEY),
    true,
  );

  await fs.chmod(keyringPath, 0o644);
  await assert.rejects(provider.active(), LocalSecretUnavailableError);
  await fs.chmod(keyringPath, 0o600);
  const symlinkPath = path.join(root, 'keyring-link.json');
  await fs.symlink(keyringPath, symlinkPath);
  await assert.rejects(
    new LocalSecretKeyringFileProvider(symlinkPath).active(),
    LocalSecretUnavailableError,
  );
  await fs.writeFile(
    keyringPath,
    JSON.stringify({ version: 1, activeKeyId: 'key-1', keys: {}, extra: true }),
  );
  await fs.chmod(keyringPath, 0o600);
  await assert.rejects(provider.active(), LocalSecretUnavailableError);
});

test('concurrent rotations serialize so exactly one expected version wins', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-secret-db-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'database.sqlite');
  const firstStore = await createStore(t, storage);
  await firstStore.service.put({
    projectId: 'default',
    name: 'TOKEN',
    plaintext: 'version-one',
    mutationId: 'create-token',
    expectedCurrentVersion: 0,
    createdAtMs: 100,
  });
  const secondDatabase = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => secondDatabase.close());
  const secondService = new EncryptedLocalSecretService(
    new LegacySequelizeLocalSecretEnvelopeRepository(secondDatabase),
    keyProvider(),
  );
  const rotations = await Promise.allSettled([
    firstStore.service.put({
      projectId: 'default',
      name: 'TOKEN',
      plaintext: 'rotation-a',
      mutationId: 'rotate-a',
      expectedCurrentVersion: 1,
      createdAtMs: 200,
    }),
    secondService.put({
      projectId: 'default',
      name: 'TOKEN',
      plaintext: 'rotation-b',
      mutationId: 'rotate-b',
      expectedCurrentVersion: 1,
      createdAtMs: 201,
    }),
  ]);
  assert.equal(
    rotations.filter((item) => item.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    rotations.filter((item) => item.status === 'rejected').length,
    1,
  );
  assert.equal(
    rotations.find((item) => item.status === 'rejected').reason.constructor,
    LocalSecretVersionConflictError,
  );
});
