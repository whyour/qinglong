const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LocalSecretAuthorizationFenceConflictError,
} = require('@qinglong/runtime-core/local-secret-administration');
const {
  LocalSecretMutationConflictError,
} = require('@qinglong/runtime-core/local-secret');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  LocalSecretKeyringFileProvider,
  provisionLocalSecretKeyring,
} = require('@qinglong/local-secret');
const {
  LocalSecretAdministrationAuthenticationError,
  LocalSecretAdministrationAuthorizationError,
  LocalSecretAdministrationUnavailableError,
  createLocalSecretAdministrationService,
} = require('@qinglong/local-admin/secret-administration');

const NOW = 1_760_000_000_000;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-secret-admin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    profile: 'edge',
    databasePath: path.join(directory, 'qinglong3.sqlite'),
    keyringPath: path.join(directory, 'secret-keyring.json'),
  };
}

function principal(overrides = {}) {
  return {
    subject: { type: 'user', id: 'user-owner' },
    authenticationId: 'local-console-1',
    authenticatedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    assurance: 'local_console',
    ...overrides,
  };
}

function request(mutationId, overrides = {}) {
  return {
    projectId: 'default',
    name: 'TOKEN',
    plaintext: 'never-persist-this-plaintext',
    mutationId,
    requestId: `request-${mutationId.slice(-4)}`,
    expectedCurrentVersion: 0,
    principal: principal(),
    ...overrides,
  };
}

async function openStore(t) {
  const value = fixture(t);
  await migrateLocalSqlitePath(value);
  await provisionLocalSecretKeyring(value.keyringPath);
  const runtime = await openLocalSqliteRuntimeDatabase(value);
  t.after(() => runtime.close());
  const keys = new LocalSecretKeyringFileProvider(value.keyringPath);
  return { ...value, runtime, keys };
}

async function bind(runtime, role, version = 1, state = 'active') {
  return runtime.projectPolicy.append({
    expectedCurrentVersion: version - 1,
    binding: {
      projectId: 'default',
      subject: { type: 'user', id: 'user-owner' },
      version,
      state,
      ...(state === 'active' ? { role } : {}),
      mutationId: `binding-${version}`,
      changedBy: { type: 'system', id: 'owner-bootstrap' },
      createdAtMs: NOW + version,
    },
  });
}

function service(value, overrides = {}) {
  return createLocalSecretAdministrationService(
    overrides.projectPolicy ?? value.runtime.projectPolicy,
    overrides.mutations ?? value.runtime.localSecretAdministration,
    overrides.audit ?? value.runtime.securityAudit,
    overrides.keys ?? value.keys,
    { now: () => NOW, nonceFactory: () => Buffer.alloc(12, 7) },
  );
}

test('owner writes one encrypted envelope and allowed audit atomically', async (t) => {
  const value = await openStore(t);
  assert.equal(
    (await value.runtime.projectPolicy.resolve('default', principal().subject))
      .binding,
    undefined,
  );
  await bind(value.runtime, 'owner');
  const mutationId = '00000000-0000-4000-8000-000000000001';
  const result = await service(value).put(request(mutationId));
  assert.equal(result.status, 'inserted');
  assert.equal(result.version, 1);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    const secret = database
      .prepare(
        `SELECT version, ciphertext FROM "QingLong3LocalSecretEnvelopes"
         WHERE mutation_id = ?`,
      )
      .get(mutationId);
    const audit = database
      .prepare(
        `SELECT operation_id, outcome, subject_id, fence_project_version,
                fence_binding_version
         FROM "QingLong3SecurityAuditEvents" WHERE event_id = ?`,
      )
      .get(mutationId);
    assert.equal(secret.version, 1);
    assert.equal(
      Buffer.from(secret.ciphertext).includes(
        Buffer.from('never-persist-this-plaintext'),
      ),
      false,
    );
    assert.deepEqual(
      { ...audit },
      {
        operation_id: 'secret.create',
        outcome: 'allowed',
        subject_id: 'user-owner',
        fence_project_version: 1,
        fence_binding_version: 1,
      },
    );
  } finally {
    database.close();
  }
});

test('denial is audited before key access and ownerless default stays closed', async (t) => {
  const value = await openStore(t);
  let keyReads = 0;
  const keys = {
    async active() {
      keyReads += 1;
      throw new Error('must not run');
    },
    async resolve() {
      keyReads += 1;
      throw new Error('must not run');
    },
  };
  const mutationId = '00000000-0000-4000-8000-000000000002';
  await assert.rejects(
    service(value, { keys }).put(request(mutationId)),
    LocalSecretAdministrationAuthorizationError,
  );
  assert.equal(keyReads, 0);
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT outcome FROM "QingLong3SecurityAuditEvents"
           WHERE event_id = ?`,
        )
        .get(mutationId).outcome,
      'denied',
    );
    assert.equal(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3LocalSecretEnvelopes"',
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('weak authentication is audited without Policy or key access', async (t) => {
  const value = await openStore(t);
  let policyReads = 0;
  let keyReads = 0;
  const projectPolicy = {
    async resolve() {
      policyReads += 1;
      throw new Error('must not run');
    },
    append: value.runtime.projectPolicy.append,
  };
  const keys = {
    async active() {
      keyReads += 1;
      throw new Error('must not run');
    },
    async resolve() {
      keyReads += 1;
      throw new Error('must not run');
    },
  };
  const mutationId = '00000000-0000-4000-8000-000000000003';
  await assert.rejects(
    service(value, { projectPolicy, keys }).put(
      request(mutationId, {
        principal: principal({ assurance: 'single_factor' }),
      }),
    ),
    LocalSecretAdministrationAuthenticationError,
  );
  assert.equal(policyReads, 0);
  assert.equal(keyReads, 0);
});

test('revocation after Policy decision is fenced inside the write transaction', async (t) => {
  const value = await openStore(t);
  await bind(value.runtime, 'admin');
  let revoked = false;
  const projectPolicy = {
    async resolve(projectId, subject) {
      const snapshot = await value.runtime.projectPolicy.resolve(
        projectId,
        subject,
      );
      if (!revoked) {
        revoked = true;
        await bind(value.runtime, undefined, 2, 'revoked');
      }
      return snapshot;
    },
    append: (...args) => value.runtime.projectPolicy.append(...args),
  };
  const mutationId = '00000000-0000-4000-8000-000000000004';
  await assert.rejects(
    service(value, { projectPolicy }).put(request(mutationId)),
    LocalSecretAuthorizationFenceConflictError,
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3LocalSecretEnvelopes"',
        )
        .get().count,
      0,
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM "QingLong3SecurityAuditEvents"
           WHERE event_id = ?`,
        )
        .get(mutationId).count,
      0,
    );
  } finally {
    database.close();
  }
});

test('audit insertion failure rolls the encrypted envelope back', async (t) => {
  const value = await openStore(t);
  await bind(value.runtime, 'owner');
  const database = new DatabaseSync(value.databasePath);
  database.exec(`
    CREATE TRIGGER reject_secret_audit
    BEFORE INSERT ON "QingLong3SecurityAuditEvents"
    WHEN NEW.operation_id IN ('secret.create', 'secret.rotate')
    BEGIN
      SELECT RAISE(ABORT, 'audit unavailable');
    END
  `);
  database.close();

  await assert.rejects(
    service(value).put(request('00000000-0000-4000-8000-000000000005')),
    LocalSecretAdministrationUnavailableError,
  );
  const check = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      check
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3LocalSecretEnvelopes"',
        )
        .get().count,
      0,
    );
    assert.equal(
      check
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3SecurityAuditEvents"')
        .get().count,
      0,
    );
  } finally {
    check.close();
  }
});

test('semantic replay returns no plaintext and conflicting replay fails closed', async (t) => {
  const value = await openStore(t);
  await bind(value.runtime, 'owner');
  const mutationId = '00000000-0000-4000-8000-000000000006';
  const admin = service(value);
  assert.equal((await admin.put(request(mutationId))).status, 'inserted');
  assert.equal((await admin.put(request(mutationId))).status, 'existing');
  await assert.rejects(
    admin.put(request(mutationId, { plaintext: 'different' })),
    LocalSecretMutationConflictError,
  );
});
