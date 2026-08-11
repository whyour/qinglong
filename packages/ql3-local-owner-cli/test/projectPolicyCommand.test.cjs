const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  runLocalProjectPolicyCommandFile,
} = require('@qinglong/local-owner-cli/project-policy-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const {
  createLocalProjectPolicyAdministrationService,
} = require('@qinglong/local-admin/project-policy-administration');
const {
  openLocalSqliteProjectPolicyAdministrationDatabase,
} = require('@qinglong/local-sqlite/project-policy-administration');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalProjectPolicyAuthorizationFenceConflictError,
  LocalProjectPolicyLastOwnerError,
} = require('@qinglong/runtime-core/local-project-policy-administration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');

const CREDENTIAL_ID = 'policy-owner';
const PEPPER_KEY_ID = 'policy-owner-v1';
const PEPPER = Buffer.alloc(32, 111).toString('base64url');
const CREDENTIAL_SECRET = Buffer.alloc(32, 112).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, CREDENTIAL_SECRET);
const SECONDARY_TOKEN = formatApiCredentialToken(
  'policy-secondary',
  CREDENTIAL_SECRET,
);

function writeCredentialPresentation(filePath, token) {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token,
    })}\n`,
    { mode: 0o600 },
  );
}

async function fixture(t, { role = 'owner', secondaryCredential = true } = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-policy-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const ownerPepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const pepperSummary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 111),
  });
  const now = Date.now();
  const secretDigest = apiCredentialSecretDigest(
    PEPPER,
    CREDENTIAL_ID,
    CREDENTIAL_SECRET,
  );
  const secondarySecretDigest = apiCredentialSecretDigest(
    PEPPER,
    'policy-secondary',
    CREDENTIAL_SECRET,
  );
  const notBeforeAtMs = now - 1_000;
  const expiresAtMs = now + 10 * 60 * 1_000;
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
        pepperSummary.digest,
        'e'.repeat(64),
        '71000000-0000-4000-8000-000000000001',
        '71000000-0000-4000-8000-000000000002',
        now - 2_000,
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '71000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'e'.repeat(64),
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'owner-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'secondary-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'owner-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        secretDigest,
        now - 1_000,
        notBeforeAtMs,
        expiresAtMs,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    if (secondaryCredential) {
      database
        .prepare(
          `INSERT INTO "QingLong3ApiCredentials" (
             "credential_id", "version", "state", "subject_type",
             "subject_id", "secret_digest", "created_at_ms",
             "not_before_at_ms", "expires_at_ms"
           ) VALUES (
             'policy-secondary', 1, 'active', 'user', 'secondary-user',
             ?, ?, ?, ?
           )`,
        )
        .run(secondarySecretDigest, now - 1_000, notBeforeAtMs, expiresAtMs);
      database
        .prepare(
          `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
             "credential_id", "credential_version", "pepper_key_id"
           ) VALUES ('policy-secondary', 1, ?)`,
        )
        .run(PEPPER_KEY_ID);
    }
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'owner-user', 1, 'active', ?,
           'policy-owner-binding', 'user', 'owner-user', ?
         )`,
      )
      .run(role, now - 500);
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
  writeCredentialPresentation(credentialFilePath, TOKEN);
  return {
    deploymentRoot,
    commandsDirectory,
    databasePath,
    credentialFilePath,
    ownerPepperKeyringDirectory,
    now,
    fence: {
      credentialId: CREDENTIAL_ID,
      credentialVersion: 1,
      pepperKeyId: PEPPER_KEY_ID,
      materialDigest: pepperSummary.digest,
      subjectType: 'user',
      subjectId: 'owner-user',
      secretDigest,
      notBeforeAtMs,
      expiresAtMs,
    },
    options: {
      deploymentRoot,
      databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory,
      credentialFilePath,
    },
  };
}

function commandFile(value, operation, request, name) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation,
      options: value.options,
      request,
    })}\n`,
    { mode: 0o600 },
  );
  return commandPath;
}

function request(suffix, expectedCurrentVersion, overrides = {}) {
  return {
    projectId: 'default',
    target: { type: 'user', id: 'secondary-user' },
    expectedCurrentVersion,
    mutationId: `72000000-0000-4000-8000-00000000000${suffix}`,
    requestId: `policy-command-${suffix}`,
    failureAuditEventId: `73000000-0000-4000-8000-00000000000${suffix}`,
    ...overrides,
  };
}

function projectRequest(suffix, expectedCurrentVersion, overrides = {}) {
  const identity = suffix.padStart(12, '0');
  return {
    authorityProjectId: 'default',
    projectId: 'project-alpha',
    expectedCurrentVersion,
    mutationId: `74000000-0000-4000-8000-${identity}`,
    requestId: `project-command-${suffix}`,
    failureAuditEventId: `75000000-0000-4000-8000-${identity}`,
    ...overrides,
  };
}

function projectQueryRequest(suffix, overrides = {}) {
  const identity = suffix.padStart(12, '0');
  return {
    authorityProjectId: 'default',
    requestId: `project-query-${suffix}`,
    auditEventId: `76000000-0000-4000-8000-${identity}`,
    ...overrides,
  };
}

function roleBindingQueryRequest(suffix, overrides = {}) {
  const identity = suffix.padStart(12, '0');
  return {
    projectId: 'default',
    requestId: `role-binding-query-${suffix}`,
    auditEventId: `77000000-0000-4000-8000-${identity}`,
    ...overrides,
  };
}

test('grants, replays, changes and revokes one role binding without credential disclosure', async (t) => {
  const value = await fixture(t);
  const grantFile = commandFile(
    value,
    'policy.role-binding.put',
    request('1', 0, { role: 'viewer' }),
    'grant-viewer',
  );
  const granted = await runLocalProjectPolicyCommandFile(grantFile);
  assert.deepEqual(granted, {
    schemaVersion: 1,
    operation: 'policy.role-binding.put',
    status: 'inserted',
    projectId: 'default',
    target: { type: 'user', id: 'secondary-user' },
    version: 1,
    state: 'active',
    role: 'viewer',
  });
  assert.equal(
    (await runLocalProjectPolicyCommandFile(grantFile)).status,
    'existing',
  );
  const adminFile = commandFile(
    value,
    'policy.role-binding.put',
    request('2', 1, { role: 'admin' }),
    'grant-admin',
  );
  assert.equal(
    (await runLocalProjectPolicyCommandFile(adminFile)).role,
    'admin',
  );
  const revokeFile = commandFile(
    value,
    'policy.role-binding.revoke',
    request('3', 2),
    'revoke',
  );
  const revoked = await runLocalProjectPolicyCommandFile(revokeFile);
  assert.equal(revoked.state, 'revoked');
  assert.equal(Object.hasOwn(revoked, 'role'), false);

  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/security-management/projectPolicyCli.js'),
      'run',
      '--command-file',
      revokeFile,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, 'existing');
  assert.equal(child.stdout.includes(TOKEN), false);
  assert.equal(child.stderr.includes(TOKEN), false);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare(
          `SELECT version, state, role
             FROM "QingLong3ProjectRoleBindings"
            WHERE project_id = 'default'
              AND subject_type = 'user'
              AND subject_id = 'secondary-user'
            ORDER BY version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { version: 1, state: 'active', role: 'viewer' },
        { version: 2, state: 'active', role: 'admin' },
        { version: 3, state: 'revoked', role: null },
      ],
    );
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3SecurityAuditEvents"
            WHERE operation_id LIKE 'policy.role_binding.%'
              AND outcome = 'allowed'`,
        )
        .get().count,
      3,
    );
  } finally {
    database.close();
  }
});

test('inspects only the current RoleBinding and lists latest subjects with bounded keyset pagination', async (t) => {
  const value = await fixture(t);
  for (const [suffix, target, role] of [
    ['e1', { type: 'user', id: 'secondary-user' }, 'viewer'],
    ['e2', { type: 'user', id: 'secondary-user' }, 'admin'],
    ['e3', { type: 'agent', id: 'agent-alpha' }, 'operator'],
    ['e4', { type: 'api_app', id: 'app-alpha' }, 'viewer'],
  ]) {
    const expectedCurrentVersion =
      target.type === 'user' ? (suffix === 'e1' ? 0 : 1) : 0;
    await runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.role-binding.put',
        request(suffix.at(-1), expectedCurrentVersion, { target, role }),
        `put-${target.type}-${target.id}-${suffix}`,
      ),
    );
  }
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.revoke',
      request('5', 2),
      'revoke-secondary-current',
    ),
  );

  const inspected = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.inspect',
      roleBindingQueryRequest('1', {
        target: { type: 'user', id: 'secondary-user' },
      }),
      'inspect-secondary-current-binding',
    ),
  );
  assert.deepEqual(
    {
      found: inspected.found,
      version: inspected.version,
      state: inspected.state,
      hasRole: Object.hasOwn(inspected, 'role'),
    },
    { found: true, version: 3, state: 'revoked', hasRole: false },
  );

  assert.deepEqual(
    await runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.role-binding.inspect',
        roleBindingQueryRequest('2', {
          target: { type: 'mcp_client', id: 'missing-client' },
        }),
        'inspect-missing-binding',
      ),
    ),
    {
      schemaVersion: 1,
      operation: 'policy.role-binding.inspect',
      projectId: 'default',
      target: { type: 'mcp_client', id: 'missing-client' },
      found: false,
    },
  );

  const first = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.list',
      roleBindingQueryRequest('3', {
        limit: 2,
        state: 'all',
        role: 'all',
      }),
      'list-bindings-first',
    ),
  );
  assert.deepEqual(
    first.bindings.map((binding) => binding.target),
    [
      { type: 'agent', id: 'agent-alpha' },
      { type: 'api_app', id: 'app-alpha' },
    ],
  );
  assert.deepEqual(first.nextCursor, {
    subjectType: 'api_app',
    subjectId: 'app-alpha',
  });

  const second = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.list',
      roleBindingQueryRequest('4', {
        limit: 2,
        state: 'all',
        role: 'all',
        after: first.nextCursor,
      }),
      'list-bindings-second',
    ),
  );
  assert.deepEqual(
    second.bindings.map((binding) => [
      binding.target,
      binding.state,
      binding.version,
    ]),
    [
      [{ type: 'user', id: 'owner-user' }, 'active', 1],
      [{ type: 'user', id: 'secondary-user' }, 'revoked', 3],
    ],
  );
  assert.equal(second.nextCursor, null);

  const viewers = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.list',
      roleBindingQueryRequest('5', {
        limit: 64,
        state: 'active',
        role: 'viewer',
      }),
      'list-active-viewers',
    ),
  );
  assert.deepEqual(
    viewers.bindings.map((binding) => binding.target),
    [{ type: 'api_app', id: 'app-alpha' }],
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3SecurityAuditEvents"
            WHERE operation_id IN (
              'policy.role_binding.inspect',
              'policy.role_binding.list'
            )
              AND outcome = 'allowed'`,
        )
        .get().count,
      5,
    );
  } finally {
    database.close();
  }
});

test('allows a secondary Project Owner to inspect its own bindings but not another Project', async (t) => {
  const value = await fixture(t);
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.create',
      projectRequest('f1', 0, {
        projectId: 'project-secondary',
        name: 'Project Secondary',
        slug: 'project-secondary',
      }),
      'create-secondary-binding-query-project',
    ),
  );
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.put',
      request('f', 0, {
        projectId: 'project-secondary',
        role: 'owner',
      }),
      'grant-secondary-binding-query-owner',
    ),
  );
  writeCredentialPresentation(value.credentialFilePath, SECONDARY_TOKEN);

  const own = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.list',
      roleBindingQueryRequest('6', {
        projectId: 'project-secondary',
        limit: 64,
        state: 'active',
        role: 'owner',
      }),
      'secondary-owner-list-own-bindings',
    ),
  );
  assert.deepEqual(
    own.bindings.map((binding) => binding.target.id),
    ['owner-user', 'secondary-user'],
  );

  const denied = roleBindingQueryRequest('7', {
    target: { type: 'user', id: 'owner-user' },
  });
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.role-binding.inspect',
        denied,
        'secondary-owner-inspect-foreign-binding',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_ADMINISTRATION_FORBIDDEN' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT project_id, outcome
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get(denied.auditEventId),
      },
      { project_id: 'default', outcome: 'denied' },
    );
  } finally {
    database.close();
  }
});

test('rejects unbounded RoleBinding lists before opening the database', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.role-binding.list',
        roleBindingQueryRequest('8', {
          limit: 65,
          state: 'all',
          role: 'all',
        }),
        'list-bindings-unbounded',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_COMMAND_CONFIGURATION_INVALID' },
  );
});

test('does not let a Project admin inspect RoleBindings', async (t) => {
  const value = await fixture(t, { role: 'admin' });
  const query = roleBindingQueryRequest('a', {
    target: { type: 'user', id: 'owner-user' },
  });
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.role-binding.inspect',
        query,
        'admin-inspect-role-binding',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_ADMINISTRATION_FORBIDDEN' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT outcome, reasons_json
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get(query.auditEventId),
      },
      { outcome: 'denied', reasons_json: '["permission_missing"]' },
    );
  } finally {
    database.close();
  }
});

test('inspects archived Projects and lists all Projects with bounded stable pagination', async (t) => {
  const value = await fixture(t);
  for (const [suffix, projectId, name, slug] of [
    ['d1', 'project-alpha', 'Project Alpha', 'alpha'],
    ['d2', 'project-beta', 'Project Beta', 'beta'],
    ['d3', 'project-gamma', 'Project Gamma', 'gamma'],
  ]) {
    await runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.create',
        projectRequest(suffix, 0, { projectId, name, slug }),
        `create-${projectId}`,
      ),
    );
  }
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.archive',
      projectRequest('d4', 1, { projectId: 'project-beta' }),
      'archive-project-beta',
    ),
  );

  const inspected = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.inspect',
      projectQueryRequest('1', { projectId: 'project-beta' }),
      'inspect-project-beta',
    ),
  );
  assert.equal(inspected.found, true);
  assert.equal(inspected.projectStatus, 'archived');
  assert.equal(inspected.version, 2);
  assert.equal(inspected.name, 'Project Beta');
  assert.equal(inspected.slug, 'beta');

  assert.deepEqual(
    await runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.inspect',
        projectQueryRequest('2', { projectId: 'project-missing' }),
        'inspect-project-missing',
      ),
    ),
    {
      schemaVersion: 1,
      operation: 'policy.project.inspect',
      authorityProjectId: 'default',
      projectId: 'project-missing',
      found: false,
    },
  );

  const first = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.list',
      projectQueryRequest('3', { limit: 2, status: 'all' }),
      'list-projects-first',
    ),
  );
  assert.deepEqual(
    first.projects.map((project) => [project.projectId, project.projectStatus]),
    [
      ['project-alpha', 'active'],
      ['project-beta', 'archived'],
    ],
  );
  assert.deepEqual(first.nextCursor, {
    slug: 'beta',
    projectId: 'project-beta',
  });

  const second = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.list',
      projectQueryRequest('4', {
        limit: 2,
        status: 'all',
        after: first.nextCursor,
      }),
      'list-projects-second',
    ),
  );
  assert.deepEqual(
    second.projects.map((project) => project.projectId),
    ['default', 'project-gamma'],
  );
  assert.equal(second.nextCursor, null);

  const archived = await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.list',
      projectQueryRequest('5', { limit: 64, status: 'archived' }),
      'list-archived-projects',
    ),
  );
  assert.deepEqual(
    archived.projects.map((project) => project.projectId),
    ['project-beta'],
  );
  assert.equal(archived.nextCursor, null);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare(
          `SELECT operation_id, count(*) AS count
             FROM "QingLong3SecurityAuditEvents"
            WHERE operation_id IN (
              'policy.project.inspect', 'policy.project.list'
            )
              AND outcome = 'allowed'
            GROUP BY operation_id
            ORDER BY operation_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { operation_id: 'policy.project.inspect', count: 2 },
        { operation_id: 'policy.project.list', count: 3 },
      ],
    );
  } finally {
    database.close();
  }
});

test('rejects unbounded Project lists and secondary authority Project queries', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.list',
        projectQueryRequest('6', { limit: 65, status: 'all' }),
        'list-projects-unbounded',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_COMMAND_CONFIGURATION_INVALID' },
  );

  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.create',
      projectRequest('d5', 0, {
        projectId: 'project-secondary',
        name: 'Project Secondary',
        slug: 'project-secondary',
      }),
      'create-secondary-query-project',
    ),
  );
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.put',
      request('d', 0, {
        projectId: 'project-secondary',
        role: 'owner',
      }),
      'grant-secondary-query-owner',
    ),
  );
  writeCredentialPresentation(value.credentialFilePath, SECONDARY_TOKEN);
  const denied = projectQueryRequest('7', {
    authorityProjectId: 'project-secondary',
    limit: 1,
    status: 'all',
  });
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.list',
        denied,
        'secondary-owner-list-projects',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_AUTHORIZATION_FENCE_CONFLICT' },
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT project_id, outcome, reasons_json
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get(denied.auditEventId),
      },
      {
        project_id: 'project-secondary',
        outcome: 'denied',
        reasons_json: '["credential_or_policy_fence_rejected"]',
      },
    );
  } finally {
    database.close();
  }
});

test('creates, replays, archives and restores a Project with an atomic initial owner', async (t) => {
  const value = await fixture(t);
  const createFile = commandFile(
    value,
    'policy.project.create',
    projectRequest('a1', 0, {
      name: 'Project Alpha',
      slug: 'project-alpha',
    }),
    'create-project-alpha',
  );
  assert.deepEqual(await runLocalProjectPolicyCommandFile(createFile), {
    schemaVersion: 1,
    operation: 'policy.project.create',
    status: 'inserted',
    projectId: 'project-alpha',
    name: 'Project Alpha',
    slug: 'project-alpha',
    projectStatus: 'active',
    version: 1,
  });
  assert.equal(
    (await runLocalProjectPolicyCommandFile(createFile)).status,
    'existing',
  );

  const archiveFile = commandFile(
    value,
    'policy.project.archive',
    projectRequest('a2', 1),
    'archive-project-alpha',
  );
  assert.deepEqual(await runLocalProjectPolicyCommandFile(archiveFile), {
    schemaVersion: 1,
    operation: 'policy.project.archive',
    status: 'inserted',
    projectId: 'project-alpha',
    name: 'Project Alpha',
    slug: 'project-alpha',
    projectStatus: 'archived',
    version: 2,
  });
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.role-binding.put',
        request('a', 0, {
          projectId: 'project-alpha',
          role: 'viewer',
        }),
        'archived-project-policy-denied',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_ADMINISTRATION_FORBIDDEN' },
  );

  const restoreFile = commandFile(
    value,
    'policy.project.restore',
    projectRequest('a3', 2),
    'restore-project-alpha',
  );
  const restored = await runLocalProjectPolicyCommandFile(restoreFile);
  assert.equal(restored.projectStatus, 'active');
  assert.equal(restored.version, 3);
  assert.equal(
    (
      await runLocalProjectPolicyCommandFile(
        commandFile(
          value,
          'policy.role-binding.put',
          request('b', 0, {
            projectId: 'project-alpha',
            role: 'viewer',
          }),
          'restored-project-policy-allowed',
        ),
      )
    ).role,
    'viewer',
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT status, version
               FROM "QingLong3Projects"
              WHERE id = 'project-alpha'`,
          )
          .get(),
      },
      { status: 'active', version: 3 },
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT state, role, version, changed_by_id
               FROM "QingLong3ProjectRoleBindings"
              WHERE project_id = 'project-alpha'
                AND subject_type = 'user'
                AND subject_id = 'owner-user'
              ORDER BY version DESC LIMIT 1`,
          )
          .get(),
      },
      {
        state: 'active',
        role: 'owner',
        version: 1,
        changed_by_id: 'owner-user',
      },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT operation, project_status, project_version
             FROM "QingLong3ProjectAdministrationMutations"
            WHERE project_id = 'project-alpha'
            ORDER BY project_version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          operation: 'create',
          project_status: 'active',
          project_version: 1,
        },
        {
          operation: 'archive',
          project_status: 'archived',
          project_version: 2,
        },
        {
          operation: 'restore',
          project_status: 'active',
          project_version: 3,
        },
      ],
    );
  } finally {
    database.close();
  }
});

test('rejects Project mutation drift, identity reuse and authority Project archival', async (t) => {
  const value = await fixture(t);
  const createRequest = projectRequest('b1', 0, {
    projectId: 'project-beta',
    name: 'Project Beta',
    slug: 'project-beta',
  });
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.create',
      createRequest,
      'create-project-beta',
    ),
  );
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.create',
        { ...createRequest, name: 'Project Beta Drift' },
        'drift-project-beta',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_PROJECT_MUTATION_CONFLICT' },
  );
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.create',
        projectRequest('b2', 0, {
          projectId: 'project-beta',
          name: 'Project Beta Duplicate',
          slug: 'project-beta-duplicate',
        }),
        'duplicate-project-id',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_PROJECT_IDENTITY_CONFLICT' },
  );
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.create',
        projectRequest('b3', 0, {
          projectId: 'project-gamma',
          name: 'Project Gamma',
          slug: 'project-beta',
        }),
        'duplicate-project-slug',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_PROJECT_IDENTITY_CONFLICT' },
  );
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.archive',
        projectRequest('b4', 1, { projectId: 'default' }),
        'archive-authority-project',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_AUTHORITY_PROJECT_PROTECTED' },
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare(
          `SELECT reasons_json
             FROM "QingLong3SecurityAuditEvents"
            WHERE event_id IN (?, ?, ?, ?)
            ORDER BY event_id`,
        )
        .all(
          projectRequest('b1', 0).failureAuditEventId,
          projectRequest('b2', 0).failureAuditEventId,
          projectRequest('b3', 0).failureAuditEventId,
          projectRequest('b4', 1).failureAuditEventId,
        )
        .map((row) => row.reasons_json),
      [
        '["mutation_conflict"]',
        '["project_identity_conflict"]',
        '["project_identity_conflict"]',
        '["authority_project_protected"]',
      ],
    );
  } finally {
    database.close();
  }
});

test('does not let a secondary Project owner become the instance authority', async (t) => {
  const value = await fixture(t);
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.project.create',
      projectRequest('c1', 0, {
        projectId: 'project-secondary',
        name: 'Project Secondary',
        slug: 'project-secondary',
      }),
      'create-secondary-project',
    ),
  );
  await runLocalProjectPolicyCommandFile(
    commandFile(
      value,
      'policy.role-binding.put',
      request('c', 0, {
        projectId: 'project-secondary',
        role: 'owner',
      }),
      'grant-secondary-project-owner',
    ),
  );
  writeCredentialPresentation(value.credentialFilePath, SECONDARY_TOKEN);
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.create',
        projectRequest('c2', 0, {
          authorityProjectId: 'project-secondary',
          projectId: 'project-illicit',
          name: 'Project Illicit',
          slug: 'project-illicit',
        }),
        'secondary-owner-create-project',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_AUTHORIZATION_FENCE_CONFLICT' },
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3Projects"
            WHERE id = 'project-illicit'`,
        )
        .get().count,
      0,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT project_id, outcome, reasons_json
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get(projectRequest('c2', 0).failureAuditEventId),
      },
      {
        project_id: 'project-secondary',
        outcome: 'denied',
        reasons_json: '["credential_or_policy_fence_rejected"]',
      },
    );
  } finally {
    database.close();
  }
});

test('enforces the Edge Project capacity before any partial mutation', async (t) => {
  const value = await fixture(t);
  const database = new DatabaseSync(value.databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO "QingLong3Projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'active', 1, ?, ?)`,
    );
    for (let index = 1; index <= 15; index += 1) {
      insert.run(
        `capacity-${index}`,
        `Capacity ${index}`,
        `capacity-${index}`,
        value.now,
        value.now,
      );
    }
  } finally {
    database.close();
  }
  const mutation = projectRequest('c3', 0, {
    projectId: 'capacity-overflow',
    name: 'Capacity Overflow',
    slug: 'capacity-overflow',
  });
  await assert.rejects(
    runLocalProjectPolicyCommandFile(
      commandFile(
        value,
        'policy.project.create',
        mutation,
        'edge-project-capacity',
      ),
    ),
    { code: 'LOCAL_PROJECT_POLICY_PROJECT_CAPACITY_EXCEEDED' },
  );
  const read = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3Projects"
            WHERE id = 'capacity-overflow'`,
        )
        .get().count,
      0,
    );
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3ProjectAdministrationMutations"
            WHERE mutation_id = ?`,
        )
        .get(mutation.mutationId).count,
      0,
    );
  } finally {
    read.close();
  }
});

test('does not let an admin self-escalate through policy management', async (t) => {
  const value = await fixture(t, { role: 'admin' });
  const command = commandFile(
    value,
    'policy.role-binding.put',
    request('4', 0, { role: 'owner' }),
    'admin-escalation',
  );
  await assert.rejects(runLocalProjectPolicyCommandFile(command), {
    code: 'LOCAL_PROJECT_POLICY_ADMINISTRATION_FORBIDDEN',
  });
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT outcome FROM "QingLong3SecurityAuditEvents"
            WHERE event_id = ?`,
        )
        .get('72000000-0000-4000-8000-000000000004').outcome,
      'denied',
    );
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3ProjectRoleBindings"
            WHERE subject_id = 'secondary-user'`,
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('refuses to revoke the last active User owner', async (t) => {
  const value = await fixture(t);
  const command = commandFile(
    value,
    'policy.role-binding.revoke',
    request('5', 1, {
      target: { type: 'user', id: 'owner-user' },
    }),
    'last-owner',
  );
  await assert.rejects(
    runLocalProjectPolicyCommandFile(command),
    LocalProjectPolicyLastOwnerError,
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3ProjectRoleBindings"
            WHERE subject_id = 'owner-user'`,
        )
        .get().count,
      1,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT outcome, reasons_json
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get('73000000-0000-4000-8000-000000000005'),
      },
      { outcome: 'denied', reasons_json: '["last_owner_required"]' },
    );
  } finally {
    database.close();
  }
});

test('rejects an owner handover target without an active credential', async (t) => {
  const value = await fixture(t, { secondaryCredential: false });
  const command = commandFile(
    value,
    'policy.role-binding.put',
    request('9', 0, { role: 'owner' }),
    'owner-without-credential',
  );
  await assert.rejects(runLocalProjectPolicyCommandFile(command), {
    code: 'LOCAL_PROJECT_POLICY_OWNER_CREDENTIAL_REQUIRED',
  });
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3ProjectRoleBindings"
            WHERE subject_id = 'secondary-user'`,
        )
        .get().count,
      0,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT outcome, reasons_json
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get('73000000-0000-4000-8000-000000000009'),
      },
      {
        outcome: 'denied',
        reasons_json: '["owner_credential_required"]',
      },
    );
  } finally {
    database.close();
  }
});

test('allows explicit owner handover before the original owner is revoked', async (t) => {
  const value = await fixture(t);
  const handover = commandFile(
    value,
    'policy.role-binding.put',
    request('6', 0, { role: 'owner' }),
    'handover',
  );
  await runLocalProjectPolicyCommandFile(handover);
  const revoke = commandFile(
    value,
    'policy.role-binding.revoke',
    request('7', 1, {
      target: { type: 'user', id: 'owner-user' },
    }),
    'revoke-original',
  );
  assert.equal(
    (await runLocalProjectPolicyCommandFile(revoke)).state,
    'revoked',
  );
});

test('rechecks the credential fence inside the role mutation transaction', async (t) => {
  const value = await fixture(t);
  const database = await openLocalSqliteProjectPolicyAdministrationDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
  });
  t.after(() => database.close());
  database.activateUserCredentialFence(value.fence);
  const mutator = new DatabaseSync(value.databasePath);
  try {
    mutator
      .prepare(
        `UPDATE "QingLong3ApiCredentials"
            SET state = 'revoked'
          WHERE credential_id = ? AND version = 1`,
      )
      .run(CREDENTIAL_ID);
  } finally {
    mutator.close();
  }
  const service = createLocalProjectPolicyAdministrationService(
    database.projectPolicy,
    database.projectPolicyAdministration,
  );
  await assert.rejects(
    service.changeRoleBinding({
      projectId: 'default',
      target: { type: 'user', id: 'secondary-user' },
      expectedCurrentVersion: 0,
      mutationId: '72000000-0000-4000-8000-000000000008',
      requestId: 'policy-command-atomic-fence',
      state: 'active',
      role: 'viewer',
      principal: {
        subject: { type: 'user', id: 'owner-user' },
        authenticationId: 'local_policy:atomic-fence',
        authenticatedAtMs: value.now - 1_000,
        expiresAtMs: value.now + 60_000,
        assurance: 'local_console',
      },
    }),
    LocalProjectPolicyAuthorizationFenceConflictError,
  );
  const read = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3ProjectRoleBindings"
            WHERE subject_id = 'secondary-user'`,
        )
        .get().count,
      0,
    );
  } finally {
    read.close();
  }
});

test('rechecks the credential fence inside the Project inspection transaction', async (t) => {
  const value = await fixture(t);
  const database = await openLocalSqliteProjectPolicyAdministrationDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
  });
  t.after(() => database.close());
  database.activateUserCredentialFence(value.fence);
  const mutator = new DatabaseSync(value.databasePath);
  try {
    mutator
      .prepare(
        `UPDATE "QingLong3ApiCredentials"
            SET state = 'revoked'
          WHERE credential_id = ? AND version = 1`,
      )
      .run(CREDENTIAL_ID);
  } finally {
    mutator.close();
  }
  const service = createLocalProjectPolicyAdministrationService(
    database.projectPolicy,
    database.projectPolicyAdministration,
  );
  const auditEventId = '76000000-0000-4000-8000-000000000008';
  await assert.rejects(
    service.inspectProject({
      authorityProjectId: 'default',
      projectId: 'default',
      auditEventId,
      requestId: 'project-inspect-atomic-fence',
      principal: {
        subject: { type: 'user', id: 'owner-user' },
        authenticationId: 'local_policy:inspect-atomic-fence',
        authenticatedAtMs: value.now - 1_000,
        expiresAtMs: value.now + 60_000,
        assurance: 'local_console',
      },
    }),
    LocalProjectPolicyAuthorizationFenceConflictError,
  );
  const read = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3SecurityAuditEvents"
            WHERE event_id = ?`,
        )
        .get(auditEventId).count,
      0,
    );
  } finally {
    read.close();
  }
});

test('rechecks the credential fence inside the RoleBinding inspection transaction', async (t) => {
  const value = await fixture(t);
  const database = await openLocalSqliteProjectPolicyAdministrationDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
  });
  t.after(() => database.close());
  database.activateUserCredentialFence(value.fence);
  const mutator = new DatabaseSync(value.databasePath);
  try {
    mutator
      .prepare(
        `UPDATE "QingLong3ApiCredentials"
            SET state = 'revoked'
          WHERE credential_id = ? AND version = 1`,
      )
      .run(CREDENTIAL_ID);
  } finally {
    mutator.close();
  }
  const service = createLocalProjectPolicyAdministrationService(
    database.projectPolicy,
    database.projectPolicyAdministration,
  );
  const auditEventId = '77000000-0000-4000-8000-000000000009';
  await assert.rejects(
    service.inspectRoleBinding({
      projectId: 'default',
      target: { type: 'user', id: 'owner-user' },
      auditEventId,
      requestId: 'role-binding-inspect-atomic-fence',
      principal: {
        subject: { type: 'user', id: 'owner-user' },
        authenticationId: 'local_policy:binding-inspect-atomic-fence',
        authenticatedAtMs: value.now - 1_000,
        expiresAtMs: value.now + 60_000,
        assurance: 'local_console',
      },
    }),
    LocalProjectPolicyAuthorizationFenceConflictError,
  );
  const read = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      read
        .prepare(
          `SELECT count(*) AS count
             FROM "QingLong3SecurityAuditEvents"
            WHERE event_id = ?`,
        )
        .get(auditEventId).count,
      0,
    );
  } finally {
    read.close();
  }
});
