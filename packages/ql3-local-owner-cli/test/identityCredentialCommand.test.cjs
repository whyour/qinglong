const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createLocalIdentityCredentialCommandRunner,
  runLocalIdentityCredentialCommandFile,
} = require('@qinglong/local-owner-cli/identity-credential-command');
const {
  LocalIdentityCredentialAdministrationAuthorizationError,
  createLocalIdentityCredentialAdministrationService,
} = require('@qinglong/local-admin/identity-credential-administration');
const {
  establishAuthenticatedLocalCommand,
} = require('@qinglong/local-owner-console/authenticated-command');
const {
  FileLocalCredentialAdministrationDelivery,
} = require('@qinglong/local-owner-console/credential-administration-delivery');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteIdentityCredentialAdministrationDatabase,
} = require('@qinglong/local-sqlite/identity-credential-administration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  LocalCredentialOwnerContinuityError,
  LocalIdentityCredentialAuthorizationFenceConflictError,
  LocalIdentityOwnerBindingConflictError,
} = require('@qinglong/runtime-core/local-identity-credential-administration');

const ISSUE_MUTATION_ID = '83000000-0000-4000-8000-000000000001';
const ACK_MUTATION_ID = '83000000-0000-4000-8000-000000000003';
const PEPPER = Buffer.alloc(32, 83).toString('base64url');
const MATERIAL_DIGEST = 'c'.repeat(64);

function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'ql3-identity-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commands = path.join(deploymentRoot, 'commands');
  const delivery = path.join(deploymentRoot, 'managed-credentials');
  const keyring = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(commands, { mode: 0o700 });
  fs.mkdirSync(delivery, { mode: 0o700 });
  fs.mkdirSync(keyring, { mode: 0o700 });
  return {
    deploymentRoot,
    commands,
    delivery,
    keyring,
    databasePath: path.join(deploymentRoot, 'qinglong3.sqlite'),
    credentialFilePath: path.join(deploymentRoot, 'owner-credential.json'),
  };
}

function writeCommand(directory, name, value) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return filePath;
}

function baseOptions(state) {
  return {
    deploymentRoot: state.deploymentRoot,
    databasePath: state.databasePath,
    profile: 'edge',
    ownerPepperKeyringDirectory: state.keyring,
    credentialFilePath: state.credentialFilePath,
  };
}

function options(state) {
  return {
    ...baseOptions(state),
    credentialDeliveryDirectory: state.delivery,
  };
}

test('issues, exactly replays and acknowledges a credential without returning secret material', async (t) => {
  const state = fixture(t);
  let nowMs = 1_000;
  let credentialCalls = 0;
  let acknowledgementCalls = 0;
  let committed;
  const audits = [];
  const database = {
    apiCredentials: {
      async resolve() {
        return null;
      },
    },
    ownerPepper: {
      async resolveActive() {
        return {
          generation: 1,
          mutationId: 'pepper-active',
          expectedGeneration: 0,
          activePepperKeyId: 'owner-v1',
          materialDigest: MATERIAL_DIGEST,
          backupDigest: 'd'.repeat(64),
          activatedAtMs: 0,
        };
      },
      async resolveKey() {
        return {
          pepperKeyId: 'owner-v1',
          materialDigest: MATERIAL_DIGEST,
          state: 'active',
          version: 2,
          registeredAtMs: 0,
          activatedAtMs: 0,
        };
      },
    },
    projectPolicy: {},
    identityCredentialAdministration: {
      async record(audit) {
        audits.push(audit);
      },
    },
    activateUserCredentialFence() {},
    async close() {},
  };
  const service = {
    async changeIdentity() {
      throw new Error('not used');
    },
    async changeCredential(request) {
      credentialCalls += 1;
      if (!committed) {
        committed = {
          secretDigest: request.secretDigest,
          deliveryDigest: request.deliveryDigest,
          notBeforeAtMs: request.notBeforeAtMs,
          expiresAtMs: request.expiresAtMs,
        };
      } else {
        assert.equal(request.secretDigest, committed.secretDigest);
        assert.equal(request.deliveryDigest, committed.deliveryDigest);
        assert.equal(request.notBeforeAtMs, committed.notBeforeAtMs);
        assert.equal(request.expiresAtMs, committed.expiresAtMs);
      }
      return {
        status: credentialCalls === 1 ? 'inserted' : 'existing',
        credential: {
          credentialId: request.credentialId,
          version: 1,
          pepperKeyId: request.pepperKeyId,
          state: 'active',
          subject: request.target,
          subjectStatus: 'active',
          secretDigest: request.secretDigest,
          createdAtMs: committed.notBeforeAtMs,
          notBeforeAtMs: committed.notBeforeAtMs,
          expiresAtMs: committed.expiresAtMs,
        },
        mutation: {
          mutationId: request.mutationId,
          operation: request.operation,
          credentialId: request.credentialId,
          credentialVersion: 1,
          expectedPreviousVersion: 0,
          changedBy: request.principal.subject,
          createdAtMs: committed.notBeforeAtMs,
        },
        delivery: { digest: committed.deliveryDigest },
        audit: {},
      };
    },
    async acknowledgeCredentialDelivery(request) {
      acknowledgementCalls += 1;
      return {
        status: acknowledgementCalls === 1 ? 'inserted' : 'existing',
        acknowledgement: {
          credentialMutationId: request.credentialMutationId,
          acknowledgementMutationId: request.mutationId,
          projectId: request.projectId,
          deliveryDigest: request.expectedDeliveryDigest,
          acknowledgedBy: request.principal.subject,
          acknowledgedAtMs: nowMs,
        },
        audit: {},
      };
    },
  };
  const runner = createLocalIdentityCredentialCommandRunner({
    async openDatabase() {
      return database;
    },
    async authenticate() {
      return {
        principal: {
          subject: { type: 'user', id: 'owner-user' },
          authenticationId: 'local_identity_admin:test',
          authenticatedAtMs: 0,
          expiresAtMs: 120_000,
          assurance: 'local_console',
        },
        databaseFence: {
          credentialId: 'owner-primary',
          credentialVersion: 1,
          pepperKeyId: 'owner-v1',
          materialDigest: MATERIAL_DIGEST,
          subjectType: 'user',
          subjectId: 'owner-user',
          secretDigest: 'e'.repeat(64),
          notBeforeAtMs: 0,
          expiresAtMs: 120_000,
        },
        async confirm() {},
      };
    },
    createService() {
      return service;
    },
    createDelivery(directory) {
      return new FileLocalCredentialAdministrationDelivery(directory);
    },
    createPepperProvider() {
      return {
        resolve() {
          return {
            pepperKeyId: 'owner-v1',
            pepper: PEPPER,
            summary: { digest: MATERIAL_DIGEST },
          };
        },
      };
    },
    randomBytes() {
      return Buffer.alloc(32, credentialCalls === 0 ? 84 : 85);
    },
    now() {
      return nowMs;
    },
  });
  const issueCommand = writeCommand(state.commands, 'issue.json', {
    schemaVersion: 1,
    operation: 'credential.issue',
    options: options(state),
    request: {
      projectId: 'default',
      target: { type: 'agent', id: 'agent-planner' },
      credentialId: 'agent-planner-primary',
      expectedCurrentVersion: 0,
      lifetimeMs: 60_000,
      mutationId: ISSUE_MUTATION_ID,
      requestId: 'managed-credential-issue',
      failureAuditEventId: '83000000-0000-4000-8000-000000000002',
    },
  });

  const first = await runner.run(issueCommand);
  nowMs = 30_000;
  const replay = await runner.run(issueCommand);
  assert.equal(first.status, 'inserted');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.delivery, first.delivery);
  const publicResult = JSON.stringify(replay);
  assert.equal(publicResult.includes(PEPPER), false);
  assert.equal(publicResult.includes('ql3c_'), false);
  assert.equal(publicResult.includes(state.delivery), false);
  assert.equal(publicResult.includes('secret'), false);
  const readyPath = path.join(state.delivery, first.delivery.fileName);
  assert.equal(fs.statSync(readyPath).mode & 0o777, 0o600);

  const acknowledgeCommand = writeCommand(state.commands, 'ack.json', {
    schemaVersion: 1,
    operation: 'credential.delivery.acknowledge',
    options: options(state),
    request: {
      projectId: 'default',
      credentialMutationId: ISSUE_MUTATION_ID,
      expectedDeliveryDigest: first.delivery.digest,
      mutationId: ACK_MUTATION_ID,
      requestId: 'managed-credential-acknowledge',
      failureAuditEventId: '83000000-0000-4000-8000-000000000004',
    },
  });
  const acknowledged = await runner.run(acknowledgeCommand);
  const acknowledgedReplay = await runner.run(acknowledgeCommand);
  assert.equal(acknowledged.cleanup, 'removed');
  assert.equal(acknowledgedReplay.cleanup, 'absent');
  assert.equal(fs.existsSync(readyPath), false);
  assert.deepEqual(audits, []);
});

test('commits the real SQLite Identity and credential lifecycle behind the Owner fence', async (t) => {
  const state = fixture(t);
  const ownerCredentialId = 'owner-primary';
  const ownerSecret = Buffer.alloc(32, 86).toString('base64url');
  const ownerToken = formatApiCredentialToken(ownerCredentialId, ownerSecret);
  await migrateLocalSqlitePath({
    databasePath: state.databasePath,
    profile: 'edge',
  });
  const pepperSummary = provisionLocalOwnerPepperKey({
    keyringDirectory: state.keyring,
    pepperKeyId: 'owner-v1',
    randomBytes: () => Buffer.alloc(32, 83),
  });
  const nowMs = Date.now();
  const ownerDigest = apiCredentialSecretDigest(
    PEPPER,
    ownerCredentialId,
    ownerSecret,
  );
  const client = new DatabaseSync(state.databasePath);
  try {
    client
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        'owner-v1',
        pepperSummary.digest,
        'd'.repeat(64),
        '84000000-0000-4000-8000-000000000001',
        '84000000-0000-4000-8000-000000000002',
        nowMs - 2_000,
        nowMs - 1_500,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '84000000-0000-4000-8000-000000000002',
        'owner-v1',
        pepperSummary.digest,
        'd'.repeat(64),
        nowMs - 1_500,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'owner-user', 'active', 1, ?, ?)`,
      )
      .run(nowMs - 1_000, nowMs - 1_000);
    client
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'owner-user', ?, ?, ?, ?)`,
      )
      .run(
        ownerCredentialId,
        ownerDigest,
        nowMs - 1_000,
        nowMs - 1_000,
        nowMs + 10 * 60_000,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, 'owner-v1')`,
      )
      .run(ownerCredentialId);
    client
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'owner-user', 1, 'active', 'owner',
           'owner-binding', 'user', 'owner-user', ?
         )`,
      )
      .run(nowMs - 500);
    client
      .prepare(
        `INSERT INTO "QingLong3Projects" (
           "id", "name", "slug", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('secondary', 'Secondary', 'secondary', 'active', 1, ?, ?)`,
      )
      .run(nowMs - 500, nowMs - 500);
    client
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'secondary', 'user', 'owner-user', 1, 'active', 'owner',
           'secondary-owner-binding', 'user', 'owner-user', ?
         )`,
      )
      .run(nowMs - 400);
  } finally {
    client.close();
  }
  fs.chmodSync(state.databasePath, 0o600);
  fs.writeFileSync(
    state.credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: ownerToken,
    })}\n`,
    { mode: 0o600 },
  );

  const register = writeCommand(state.commands, 'register-agent.json', {
    schemaVersion: 1,
    operation: 'identity.register',
    options: {
      deploymentRoot: state.deploymentRoot,
      databasePath: state.databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory: state.keyring,
      credentialFilePath: state.credentialFilePath,
    },
    request: {
      projectId: 'default',
      target: { type: 'agent', id: 'agent-real' },
      expectedCurrentVersion: 0,
      mutationId: '84000000-0000-4000-8000-000000000003',
      requestId: 'identity-register-real',
      failureAuditEventId: '84000000-0000-4000-8000-000000000004',
    },
  });
  assert.equal(
    (await runLocalIdentityCredentialCommandFile(register)).identityStatus,
    'active',
  );
  assert.equal(
    (await runLocalIdentityCredentialCommandFile(register)).status,
    'existing',
  );

  const inspectIdentity = writeCommand(
    state.commands,
    'inspect-agent-identity.json',
    {
      schemaVersion: 1,
      operation: 'identity.inspect',
      options: baseOptions(state),
      request: {
        projectId: 'default',
        target: { type: 'agent', id: 'agent-real' },
        requestId: 'identity-inspect-real',
        auditEventId: '86000000-0000-4000-8000-000000000001',
      },
    },
  );
  const inspectedIdentity = await runLocalIdentityCredentialCommandFile(
    inspectIdentity,
  );
  assert.equal(inspectedIdentity.found, true);
  assert.equal(inspectedIdentity.version, 1);
  assert.equal(inspectedIdentity.identityStatus, 'active');
  assert.deepEqual(inspectedIdentity.target, {
    type: 'agent',
    id: 'agent-real',
  });
  assert.equal(
    Number.isSafeInteger(inspectedIdentity.createdAtMs) &&
      inspectedIdentity.createdAtMs === inspectedIdentity.updatedAtMs,
    true,
  );

  const issue = writeCommand(state.commands, 'issue-agent.json', {
    schemaVersion: 1,
    operation: 'credential.issue',
    options: options(state),
    request: {
      projectId: 'default',
      target: { type: 'agent', id: 'agent-real' },
      credentialId: 'agent-real-primary',
      expectedCurrentVersion: 0,
      lifetimeMs: 60_000,
      mutationId: '84000000-0000-4000-8000-000000000005',
      requestId: 'credential-issue-real',
      failureAuditEventId: '84000000-0000-4000-8000-000000000006',
    },
  });
  const issued = await runLocalIdentityCredentialCommandFile(issue);
  assert.equal(issued.status, 'inserted');
  assert.equal(issued.state, 'active');
  assert.equal(
    (await runLocalIdentityCredentialCommandFile(issue)).status,
    'existing',
  );
  assert.equal(JSON.stringify(issued).includes('ql3c_'), false);

  const inspectCredential = writeCommand(
    state.commands,
    'inspect-agent-credential.json',
    {
      schemaVersion: 1,
      operation: 'credential.inspect',
      options: baseOptions(state),
      request: {
        projectId: 'default',
        credentialId: 'agent-real-primary',
        requestId: 'credential-inspect-real',
        auditEventId: '86000000-0000-4000-8000-000000000002',
      },
    },
  );
  const inspectedCredential = await runLocalIdentityCredentialCommandFile(
    inspectCredential,
  );
  assert.equal(inspectedCredential.found, true);
  assert.equal(inspectedCredential.version, 1);
  assert.equal(inspectedCredential.state, 'active');
  assert.deepEqual(inspectedCredential.target, {
    type: 'agent',
    id: 'agent-real',
  });
  const inspectionOutput = JSON.stringify(inspectedCredential);
  for (const forbidden of [
    ownerDigest,
    PEPPER,
    'pepperKeyId',
    'secretDigest',
    'token',
    state.deploymentRoot,
  ]) {
    assert.equal(inspectionOutput.includes(forbidden), false);
  }

  const inspectFromSecondary = writeCommand(
    state.commands,
    'inspect-credential-from-secondary.json',
    {
      schemaVersion: 1,
      operation: 'credential.inspect',
      options: baseOptions(state),
      request: {
        projectId: 'secondary',
        credentialId: 'agent-real-primary',
        requestId: 'credential-inspect-secondary-owner',
        auditEventId: '86000000-0000-4000-8000-000000000005',
      },
    },
  );
  await assert.rejects(
    runLocalIdentityCredentialCommandFile(inspectFromSecondary),
    LocalIdentityCredentialAdministrationAuthorizationError,
  );

  const inspectMissing = writeCommand(
    state.commands,
    'inspect-missing-credential.json',
    {
      schemaVersion: 1,
      operation: 'credential.inspect',
      options: baseOptions(state),
      request: {
        projectId: 'default',
        credentialId: 'missing-primary',
        requestId: 'credential-inspect-missing',
        auditEventId: '86000000-0000-4000-8000-000000000003',
      },
    },
  );
  assert.deepEqual(
    await runLocalIdentityCredentialCommandFile(inspectMissing),
    {
      schemaVersion: 1,
      operation: 'credential.inspect',
      projectId: 'default',
      found: false,
    },
  );

  const acknowledge = writeCommand(state.commands, 'ack-agent.json', {
    schemaVersion: 1,
    operation: 'credential.delivery.acknowledge',
    options: options(state),
    request: {
      projectId: 'default',
      credentialMutationId: '84000000-0000-4000-8000-000000000005',
      expectedDeliveryDigest: issued.delivery.digest,
      mutationId: '84000000-0000-4000-8000-000000000007',
      requestId: 'credential-ack-real',
      failureAuditEventId: '84000000-0000-4000-8000-000000000008',
    },
  });
  assert.equal(
    (await runLocalIdentityCredentialCommandFile(acknowledge)).cleanup,
    'removed',
  );

  const revoke = writeCommand(state.commands, 'revoke-agent.json', {
    schemaVersion: 1,
    operation: 'credential.revoke',
    options: {
      deploymentRoot: state.deploymentRoot,
      databasePath: state.databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory: state.keyring,
      credentialFilePath: state.credentialFilePath,
    },
    request: {
      projectId: 'default',
      target: { type: 'agent', id: 'agent-real' },
      credentialId: 'agent-real-primary',
      expectedCurrentVersion: 1,
      mutationId: '84000000-0000-4000-8000-000000000009',
      requestId: 'credential-revoke-real',
      failureAuditEventId: '84000000-0000-4000-8000-00000000000a',
    },
  });
  assert.equal(
    (await runLocalIdentityCredentialCommandFile(revoke)).state,
    'revoked',
  );

  const disable = writeCommand(state.commands, 'disable-agent.json', {
    schemaVersion: 1,
    operation: 'identity.disable',
    options: {
      deploymentRoot: state.deploymentRoot,
      databasePath: state.databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory: state.keyring,
      credentialFilePath: state.credentialFilePath,
    },
    request: {
      projectId: 'default',
      target: { type: 'agent', id: 'agent-real' },
      expectedCurrentVersion: 1,
      mutationId: '84000000-0000-4000-8000-00000000000b',
      requestId: 'identity-disable-real',
      failureAuditEventId: '84000000-0000-4000-8000-00000000000c',
    },
  });
  assert.equal(
    (await runLocalIdentityCredentialCommandFile(disable)).identityStatus,
    'disabled',
  );

  const disableOwner = writeCommand(state.commands, 'disable-owner.json', {
    schemaVersion: 1,
    operation: 'identity.disable',
    options: {
      deploymentRoot: state.deploymentRoot,
      databasePath: state.databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory: state.keyring,
      credentialFilePath: state.credentialFilePath,
    },
    request: {
      projectId: 'default',
      target: { type: 'user', id: 'owner-user' },
      expectedCurrentVersion: 1,
      mutationId: '84000000-0000-4000-8000-00000000000d',
      requestId: 'identity-disable-owner-rejected',
      failureAuditEventId: '84000000-0000-4000-8000-00000000000e',
    },
  });
  await assert.rejects(
    runLocalIdentityCredentialCommandFile(disableOwner),
    LocalIdentityOwnerBindingConflictError,
  );

  const revokeOwner = writeCommand(state.commands, 'revoke-owner.json', {
    schemaVersion: 1,
    operation: 'credential.revoke',
    options: {
      deploymentRoot: state.deploymentRoot,
      databasePath: state.databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory: state.keyring,
      credentialFilePath: state.credentialFilePath,
    },
    request: {
      projectId: 'default',
      target: { type: 'user', id: 'owner-user' },
      credentialId: ownerCredentialId,
      expectedCurrentVersion: 1,
      mutationId: '84000000-0000-4000-8000-00000000000f',
      requestId: 'credential-revoke-owner-rejected',
      failureAuditEventId: '85000000-0000-4000-8000-000000000001',
    },
  });
  await assert.rejects(
    runLocalIdentityCredentialCommandFile(revokeOwner),
    LocalCredentialOwnerContinuityError,
  );

  const fenceDatabase =
    await openLocalSqliteIdentityCredentialAdministrationDatabase({
      databasePath: state.databasePath,
      profile: 'edge',
    });
  try {
    const authenticated = await establishAuthenticatedLocalCommand(
      fenceDatabase,
      {
        deploymentRoot: state.deploymentRoot,
        databasePath: state.databasePath,
        ownerPepperKeyringDirectory: state.keyring,
        credentialFilePath: state.credentialFilePath,
        authenticationNamespace: 'local_identity_admin',
      },
    );
    await authenticated.confirm();
    fenceDatabase.activateUserCredentialFence(authenticated.databaseFence);
    await assert.rejects(
      fenceDatabase.identityCredentialAdministration.inspectAuthorizedIdentity({
        target: { type: 'agent', id: 'agent-real' },
        authorization: {
          projectId: 'secondary',
          actor: authenticated.principal.subject,
          fence: { projectVersion: 1, bindingVersion: 1 },
        },
        audit: {
          eventId: '86000000-0000-4000-8000-000000000006',
          requestId: 'identity-inspect-repository-scope-bypass',
          operationId: 'identity.inspect',
          projectId: 'secondary',
          subject: authenticated.principal.subject,
          authenticationId: authenticated.principal.authenticationId,
          outcome: 'allowed',
          reasons: ['owner_identity_inspect'],
          fence: { projectVersion: 1, bindingVersion: 1 },
          occurredAtMs: Date.now(),
        },
      }),
      LocalIdentityCredentialAuthorizationFenceConflictError,
    );
    let changedFence = false;
    const repository = new Proxy(
      fenceDatabase.identityCredentialAdministration,
      {
        get(target, property) {
          if (property === 'inspectAuthorizedIdentity') {
            return async (command) => {
              if (!changedFence) {
                changedFence = true;
                const writer = new DatabaseSync(state.databasePath);
                try {
                  writer
                    .prepare(
                      `INSERT INTO "QingLong3ProjectRoleBindings" (
                         "project_id", "subject_type", "subject_id", "version",
                         "state", "role", "mutation_id", "changed_by_type",
                         "changed_by_id", "created_at_ms"
                       ) VALUES (
                         'default', 'user', 'owner-user', 2, 'active', 'admin',
                         'owner-binding-demoted', 'user', 'owner-user', ?
                       )`,
                    )
                    .run(Date.now());
                } finally {
                  writer.close();
                }
              }
              return target.inspectAuthorizedIdentity(command);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      },
    );
    const service = createLocalIdentityCredentialAdministrationService(
      fenceDatabase.projectPolicy,
      repository,
    );
    await assert.rejects(
      service.inspectIdentity({
        projectId: 'default',
        target: { type: 'agent', id: 'agent-real' },
        auditEventId: '86000000-0000-4000-8000-000000000004',
        requestId: 'identity-inspect-fence-changed',
        principal: authenticated.principal,
      }),
      LocalIdentityCredentialAuthorizationFenceConflictError,
    );
  } finally {
    await fenceDatabase.close();
  }

  const anchorWriter = new DatabaseSync(state.databasePath);
  try {
    for (const audit of [
      {
        eventId: '87000000-0000-4000-8000-000000000001',
        requestId: 'secondary-bootstrap-issue',
        operationId: 'owner.bootstrap.issue',
        occurredAtMs: nowMs - 900,
      },
      {
        eventId: '87000000-0000-4000-8000-000000000002',
        requestId: 'secondary-bootstrap-claim',
        operationId: 'owner.bootstrap.claim',
        occurredAtMs: nowMs - 800,
      },
    ]) {
      anchorWriter
        .prepare(
          `INSERT INTO "QingLong3SecurityAuditEvents" (
             "event_id", "request_id", "operation_id", "project_id",
             "subject_type", "subject_id", "authentication_id", "outcome",
             "reasons_json", "fence_project_version",
             "fence_binding_version", "occurred_at_ms"
           ) VALUES (?, ?, ?, 'secondary', 'user', 'owner-user',
                     'bootstrap-anchor-test', 'allowed', '["test_anchor"]',
                     1, NULL, ?)`,
        )
        .run(
          audit.eventId,
          audit.requestId,
          audit.operationId,
          audit.occurredAtMs,
        );
    }
    anchorWriter
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerBootstrapChallenges" (
           "project_id", "version", "issue_mutation_id", "issue_request_id",
           "challenge_id", "token_digest", "issuer_authentication_id",
           "issuer_authenticated_at_ms", "issuer_expires_at_ms",
           "issued_at_ms", "expires_at_ms", "issue_audit_event_id",
           "consumed_at_ms", "claim_mutation_id", "claim_request_id",
           "claimed_subject_type", "claimed_subject_id", "credential_id",
           "credential_version", "claim_authentication_id",
           "claim_authenticated_at_ms", "claim_expires_at_ms",
           "claim_assurance", "claim_audit_event_id"
         ) VALUES (
           'secondary', 1, ?, 'secondary-bootstrap-issue',
           'AAAAAAAAAAAAAAAAAAAAAA', ?, 'bootstrap-anchor-test',
           ?, ?, ?, ?, ?, ?, ?, 'secondary-bootstrap-claim',
           'user', 'owner-user', ?, 1, 'bootstrap-anchor-test',
           ?, ?, 'single_factor', ?
         )`,
      )
      .run(
        '87000000-0000-4000-8000-000000000001',
        'f'.repeat(64),
        nowMs - 1_000,
        nowMs + 60_000,
        nowMs - 900,
        nowMs + 60_000,
        '87000000-0000-4000-8000-000000000001',
        nowMs - 800,
        '87000000-0000-4000-8000-000000000002',
        ownerCredentialId,
        nowMs - 1_000,
        nowMs + 60_000,
        '87000000-0000-4000-8000-000000000002',
      );
  } finally {
    anchorWriter.close();
  }
  const anchoredDatabase =
    await openLocalSqliteIdentityCredentialAdministrationDatabase({
      databasePath: state.databasePath,
      profile: 'edge',
    });
  try {
    assert.equal(
      await anchoredDatabase.identityCredentialAdministration.resolveAuthorityProjectId(),
      'secondary',
    );
  } finally {
    await anchoredDatabase.close();
  }

  const read = new DatabaseSync(state.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...read
          .prepare(
            `SELECT "status", "version"
             FROM "QingLong3IdentitySubjects"
             WHERE "subject_type" = 'agent' AND "subject_id" = 'agent-real'`,
          )
          .get(),
      },
      { status: 'disabled', version: 2 },
    );
    assert.deepEqual(
      {
        ...read
          .prepare(
            `SELECT "state", "version"
             FROM "QingLong3ApiCredentials"
             WHERE "credential_id" = 'agent-real-primary'
             ORDER BY "version" DESC LIMIT 1`,
          )
          .get(),
      },
      { state: 'revoked', version: 2 },
    );
    assert.equal(
      read
        .prepare(
          `SELECT "state"
           FROM "QingLong3ApiCredentials"
           WHERE "credential_id" = ?
           ORDER BY "version" DESC LIMIT 1`,
        )
        .get(ownerCredentialId).state,
      'active',
    );
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS "count"
           FROM "QingLong3ApiCredentialAdministrationMutations"
           WHERE "credential_id" = 'agent-real-primary'`,
        )
        .get().count,
      2,
    );
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS "count"
           FROM "QingLong3ApiCredentialDeliveryAcknowledgements"
           WHERE "credential_mutation_id" =
             '84000000-0000-4000-8000-000000000005'`,
        )
        .get().count,
      1,
    );
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS "count"
           FROM "QingLong3SecurityAuditEvents"
           WHERE "operation_id" IN ('identity.inspect', 'credential.inspect')
             AND "outcome" = 'allowed'`,
        )
        .get().count,
      3,
    );
    assert.deepEqual(
      {
        ...read
          .prepare(
            `SELECT "outcome", "reasons_json" AS "reasonsJson"
             FROM "QingLong3SecurityAuditEvents"
             WHERE "event_id" = '86000000-0000-4000-8000-000000000005'`,
          )
          .get(),
      },
      {
        outcome: 'denied',
        reasonsJson: '["instance_authority_project_required"]',
      },
    );
    assert.deepEqual(read.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    read.close();
  }
});
