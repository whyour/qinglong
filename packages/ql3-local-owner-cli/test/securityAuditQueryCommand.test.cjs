const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createLocalSecurityAuditQueryCommandRunner,
} = require('@qinglong/local-owner-cli/security-audit-query-command');
const {
  LocalSqliteAuthenticatedManagementFenceError,
} = require('@qinglong/local-sqlite/authenticated-management');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-user' }),
  authenticationId: 'local_security_audit:test',
  authenticatedAtMs: 1_000,
  expiresAtMs: 61_000,
  assurance: 'local_console',
});

function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-audit-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandPath = path.join(deploymentRoot, 'command.json');
  const value = {
    schemaVersion: 1,
    operation: 'security.audit.list',
    options: {
      deploymentRoot,
      databasePath: path.join(deploymentRoot, 'qinglong3.sqlite'),
      profile: 'edge',
      ownerPepperKeyringDirectory: path.join(deploymentRoot, 'owner-keys'),
      credentialFilePath: path.join(deploymentRoot, 'credential.json'),
    },
    request: {
      authorityProjectId: 'default',
      query: { limit: 1, filter: {} },
      requestId: 'audit-query-cli',
      auditEventId: '94000000-0000-4000-8000-000000000001',
    },
  };
  fs.writeFileSync(commandPath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  return { commandPath, value };
}

function compactionFixture(t, requestOverrides = {}) {
  const value = fixture(t);
  value.value.operation = 'security.audit.compact';
  value.value.request = {
    authorityProjectId: 'default',
    retentionMs: 2_592_000_000,
    eligibleBeforeMs: 1_000,
    limit: 64,
    mutationId: '94100000-0000-4000-8000-000000000001',
    requestId: 'audit-compact-cli',
    failureAuditEventId: '94100000-0000-4000-8000-000000000002',
    ...requestOverrides,
  };
  fs.writeFileSync(value.commandPath, `${JSON.stringify(value.value)}\n`, {
    mode: 0o600,
  });
  return value;
}

function authenticated() {
  return {
    principal: PRINCIPAL,
    databaseFence: {
      credentialId: 'owner',
      credentialVersion: 1,
      pepperKeyId: 'owner-v1',
      materialDigest: 'a'.repeat(64),
      subjectType: 'user',
      subjectId: 'owner-user',
      secretDigest: 'b'.repeat(64),
      notBeforeAtMs: 0,
      expiresAtMs: 60_000,
    },
    async confirm() {},
  };
}

test('returns bounded audit rows without authentication identifiers', async (t) => {
  const value = fixture(t);
  let closed = false;
  const runner = createLocalSecurityAuditQueryCommandRunner({
    async openDatabase() {
      return {
        projectPolicy: {},
        securityAuditQuery: {},
        securityAuditRetention: {},
        securityAudit: {
          async record() {
            throw new Error('not used');
          },
        },
        activateUserCredentialFence() {},
        async close() {
          closed = true;
        },
      };
    },
    async authenticate() {
      return authenticated();
    },
    createService() {
      return {
        async list() {
          return {
            records: [
              {
                eventId: '95000000-0000-4000-8000-000000000001',
                requestId: 'denied-operation',
                operationId: 'tool.invoke',
                projectId: 'project-alpha',
                subject: { type: 'agent', id: 'planner' },
                authenticationId: 'must-never-be-returned',
                outcome: 'denied',
                reasons: ['permission_missing'],
                fence: { projectVersion: 2, bindingVersion: 3 },
                occurredAtMs: 1_500,
              },
            ],
            nextCursor: null,
            audit: {},
          };
        },
      };
    },
    createRetentionService() {
      throw new Error('must not run');
    },
    now: () => 2_000,
  });
  const result = await runner.run(value.commandPath);
  assert.equal(closed, true);
  assert.equal(result.records.length, 1);
  assert.equal(Object.hasOwn(result.records[0], 'authenticationId'), false);
  assert.equal(
    JSON.stringify(result).includes('must-never-be-returned'),
    false,
  );
});

test('audits a final credential fence rejection and closes the database', async (t) => {
  const value = fixture(t);
  const audits = [];
  let closed = false;
  const runner = createLocalSecurityAuditQueryCommandRunner({
    async openDatabase() {
      return {
        projectPolicy: {},
        securityAuditQuery: {},
        securityAuditRetention: {},
        securityAudit: {
          async record(audit) {
            audits.push(audit);
          },
        },
        activateUserCredentialFence() {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        },
        async close() {
          closed = true;
        },
      };
    },
    async authenticate() {
      return authenticated();
    },
    createService() {
      throw new Error('must not run');
    },
    createRetentionService() {
      throw new Error('must not run');
    },
    now: () => 2_000,
  });
  await assert.rejects(
    runner.run(value.commandPath),
    LocalSqliteAuthenticatedManagementFenceError,
  );
  assert.equal(closed, true);
  assert.equal(audits.length, 1);
  assert.deepEqual(
    {
      eventId: audits[0].eventId,
      outcome: audits[0].outcome,
      reasons: audits[0].reasons,
    },
    {
      eventId: value.value.request.auditEventId,
      outcome: 'denied',
      reasons: ['credential_or_policy_fence_rejected'],
    },
  );
});

test('returns a redacted bounded compaction receipt through the existing audit CLI', async (t) => {
  const value = compactionFixture(t);
  const runner = createLocalSecurityAuditQueryCommandRunner({
    async openDatabase() {
      return {
        projectPolicy: {},
        securityAuditQuery: {},
        securityAuditRetention: {},
        securityAudit: {
          async record() {
            throw new Error('not used');
          },
        },
        activateUserCredentialFence() {},
        async close() {},
      };
    },
    async authenticate() {
      return authenticated();
    },
    createService() {
      throw new Error('must not run');
    },
    createRetentionService() {
      return {
        async compact(request) {
          assert.equal(
            request.failureAuditEventId,
            value.value.request.failureAuditEventId,
          );
          return {
            status: 'inserted',
            record: {
              mutationId: request.mutationId,
              requestId: request.requestId,
              authorityProjectId: request.authorityProjectId,
              retentionMs: request.retentionMs,
              eligibleBeforeMs: request.eligibleBeforeMs,
              batchLimit: request.limit,
              deletedCount: 3,
              deletedPayloadBytes: 400,
              first: {
                occurredAtMs: 10,
                eventId: '94200000-0000-4000-8000-000000000001',
              },
              last: {
                occurredAtMs: 20,
                eventId: '94200000-0000-4000-8000-000000000003',
              },
              recordsDigest: 'a'.repeat(64),
              createdAtMs: 2_592_002_000,
            },
            audit: {
              authenticationId: 'must-never-be-returned',
            },
          };
        },
      };
    },
    now: () => 2_592_002_000,
  });
  const result = await runner.run(value.commandPath);
  assert.deepEqual(
    {
      operation: result.operation,
      status: result.status,
      deletedCount: result.deletedCount,
      batchLimit: result.batchLimit,
    },
    {
      operation: 'security.audit.compact',
      status: 'inserted',
      deletedCount: 3,
      batchLimit: 64,
    },
  );
  assert.equal(JSON.stringify(result).includes('authenticationId'), false);
  assert.equal(JSON.stringify(result).includes('authorityProjectId'), false);
  assert.equal(JSON.stringify(result).includes('requestId'), false);
});

test('rejects an Edge compaction batch above 64 before opening SQLite', async (t) => {
  const value = compactionFixture(t, { limit: 65 });
  let opened = false;
  const runner = createLocalSecurityAuditQueryCommandRunner({
    async openDatabase() {
      opened = true;
      throw new Error('must not run');
    },
    async authenticate() {
      throw new Error('must not run');
    },
    createService() {
      throw new Error('must not run');
    },
    createRetentionService() {
      throw new Error('must not run');
    },
    now: () => 2_592_002_000,
  });
  await assert.rejects(
    runner.run(value.commandPath),
    /compaction identity, retention fence, or limit is invalid/,
  );
  assert.equal(opened, false);
});

test('uses the separate failure event for a compaction credential fence rejection', async (t) => {
  const value = compactionFixture(t);
  const audits = [];
  const runner = createLocalSecurityAuditQueryCommandRunner({
    async openDatabase() {
      return {
        projectPolicy: {},
        securityAuditQuery: {},
        securityAuditRetention: {},
        securityAudit: {
          async record(record) {
            audits.push(record);
          },
        },
        activateUserCredentialFence() {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        },
        async close() {},
      };
    },
    async authenticate() {
      return authenticated();
    },
    createService() {
      throw new Error('must not run');
    },
    createRetentionService() {
      throw new Error('must not run');
    },
    now: () => 2_592_002_000,
  });
  await assert.rejects(
    runner.run(value.commandPath),
    LocalSqliteAuthenticatedManagementFenceError,
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventId, value.value.request.failureAuditEventId);
  assert.equal(audits[0].outcome, 'denied');
});
