const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  TaskDefinitionAdministrationAuthorizationFenceConflictError,
} = require('@qinglong/runtime-core/task-definition-administration');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

const MATERIAL_DIGEST = 'a'.repeat(64);
const PEPPER_KEY_ID = 'request-fence-pepper-v1';

function command(index, subjectId, policyFence) {
  const suffix = String(index).padStart(12, '0');
  const eventId = `019fa000-0000-4000-8000-${suffix}`;
  const occurredAtMs = Date.now();
  return Object.freeze({
    command: {
      projectId: 'default',
      taskId: `request-fence-task-${index}`,
      expectedRevision: null,
      mutationId: eventId,
      name: `Request fence task ${index}`,
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: {
          command: {
            kind: 'argv',
            file: '/bin/echo',
            args: [subjectId],
          },
        },
      },
      labels: { subject: subjectId },
      enabled: true,
      occurredAtMs,
    },
    actor: { type: 'user', id: subjectId },
    fence: policyFence,
    audit: {
      eventId,
      requestId: `request-fence:${index}`,
      operationId: 'task.create',
      projectId: 'default',
      subject: { type: 'user', id: subjectId },
      authenticationId: `local_presence:request-fence-${index}`,
      outcome: 'allowed',
      reasons: ['role_grant', 'strong_authentication'],
      fence: policyFence,
      occurredAtMs,
    },
  });
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-request-fence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const now = Date.now();
  const notBeforeAtMs = now - 60_000;
  const expiresAtMs = now + 10 * 60_000;
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        PEPPER_KEY_ID,
        MATERIAL_DIGEST,
        'b'.repeat(64),
        '019fa000-0000-4000-8000-000000000001',
        '019fa000-0000-4000-8000-000000000002',
        now - 120_000,
        now - 90_000,
      );
    for (const [index, subjectId] of [
      'request-user-a',
      'request-user-b',
    ].entries()) {
      const credentialId = `request-credential-${index + 1}`;
      const secretDigest = String(index + 1).repeat(64);
      database
        .prepare(
          `INSERT INTO "QingLong3IdentitySubjects" (
             "subject_type", "subject_id", "status", "version",
             "created_at_ms", "updated_at_ms"
           ) VALUES ('user', ?, 'active', 1, ?, ?)`,
        )
        .run(subjectId, now - 60_000, now - 60_000);
      database
        .prepare(
          `INSERT INTO "QingLong3ApiCredentials" (
             "credential_id", "version", "state", "subject_type",
             "subject_id", "secret_digest", "created_at_ms",
             "not_before_at_ms", "expires_at_ms"
           ) VALUES (?, 1, 'active', 'user', ?, ?, ?, ?, ?)`,
        )
        .run(
          credentialId,
          subjectId,
          secretDigest,
          now - 60_000,
          notBeforeAtMs,
          expiresAtMs,
        );
      database
        .prepare(
          `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
             "credential_id", "credential_version", "pepper_key_id"
           ) VALUES (?, 1, ?)`,
        )
        .run(credentialId, PEPPER_KEY_ID);
      database
        .prepare(
          `INSERT INTO "QingLong3ProjectRoleBindings" (
             "project_id", "subject_type", "subject_id", "version", "state",
             "role", "mutation_id", "changed_by_type", "changed_by_id",
             "created_at_ms"
           ) VALUES (
             'default', 'user', ?, 1, 'active', 'operator', ?, 'user', ?, ?
           )`,
        )
        .run(
          subjectId,
          `request-binding-${index + 1}`,
          subjectId,
          now - 30_000,
        );
    }
  } finally {
    database.close();
  }
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  function credentialFence(index, subjectId) {
    return Object.freeze({
      credentialId: `request-credential-${index}`,
      credentialVersion: 1,
      pepperKeyId: PEPPER_KEY_ID,
      materialDigest: MATERIAL_DIGEST,
      subjectType: 'user',
      subjectId,
      secretDigest: String(index).repeat(64),
      notBeforeAtMs,
      expiresAtMs,
    });
  }
  return {
    runtime,
    databasePath,
    fenceA: credentialFence(1, 'request-user-a'),
    fenceB: credentialFence(2, 'request-user-b'),
  };
}

test('keeps simultaneous Task mutation credentials request-scoped and rechecks both fences in-transaction', async (t) => {
  const value = await fixture(t);
  const repositoryA =
    await value.runtime.taskDefinitionAdministrationForCredential(value.fenceA);
  const repositoryB =
    await value.runtime.taskDefinitionAdministrationForCredential(value.fenceB);
  const policyA = await value.runtime.projectPolicy.resolve('default', {
    type: 'user',
    id: 'request-user-a',
  });
  const policyB = await value.runtime.projectPolicy.resolve('default', {
    type: 'user',
    id: 'request-user-b',
  });
  const fenceA = {
    projectVersion: policyA.project.version,
    bindingVersion: policyA.binding.version,
  };
  const fenceB = {
    projectVersion: policyB.project.version,
    bindingVersion: policyB.binding.version,
  };

  const [createdA, createdB] = await Promise.all([
    repositoryA.appendAuthorizedTaskDefinitionRevision(
      command(101, 'request-user-a', fenceA),
    ),
    repositoryB.appendAuthorizedTaskDefinitionRevision(
      command(102, 'request-user-b', fenceB),
    ),
  ]);
  assert.equal(createdA.status, 'created');
  assert.equal(createdB.status, 'created');

  const competing = new DatabaseSync(value.databasePath);
  try {
    competing
      .prepare(
        `UPDATE "QingLong3ApiCredentials"
         SET "state" = 'revoked'
         WHERE "credential_id" = ? AND "version" = 1`,
      )
      .run(value.fenceA.credentialId);
  } finally {
    competing.close();
  }
  await assert.rejects(
    repositoryA.appendAuthorizedTaskDefinitionRevision(
      command(103, 'request-user-a', fenceA),
    ),
    { code: 'LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_FENCE_REJECTED' },
  );
  assert.equal(
    (
      await repositoryB.appendAuthorizedTaskDefinitionRevision(
        command(104, 'request-user-b', fenceB),
      )
    ).status,
    'created',
  );

  const roleDrift = new DatabaseSync(value.databasePath);
  try {
    roleDrift
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'request-user-b', 2, 'revoked', NULL,
           'request-binding-revoked', 'user', 'request-user-b', ?
         )`,
      )
      .run(Date.now());
  } finally {
    roleDrift.close();
  }
  await assert.rejects(
    repositoryB.appendAuthorizedTaskDefinitionRevision(
      command(105, 'request-user-b', fenceB),
    ),
    TaskDefinitionAdministrationAuthorizationFenceConflictError,
  );

  const readOnly = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      readOnly
        .prepare(
          `SELECT COUNT(*) AS count
           FROM "QingLong3TaskDefinitionRevisions"`,
        )
        .get().count,
      3,
    );
    assert.equal(
      readOnly
        .prepare(
          `SELECT COUNT(*) AS count
           FROM "QingLong3SecurityAuditEvents"
           WHERE "operation_id" = 'task.create' AND "outcome" = 'allowed'`,
        )
        .get().count,
      3,
    );
  } finally {
    readOnly.close();
  }
});
