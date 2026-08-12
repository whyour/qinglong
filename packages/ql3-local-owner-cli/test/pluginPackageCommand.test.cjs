const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createLocalPluginPackageCommandRunner,
  runLocalPluginPackageCommandFile,
} = require('@qinglong/local-owner-cli/package-command');
const {
  LOCAL_PLUGIN_PACKAGE_RECOVERY_PUBLICATION_SCHEMA,
  runLocalPluginPackageCatalogCommandFile,
} = require('@qinglong/local-owner-cli/package-catalog-command');
const {
  createLocalPluginPackagePublisherTrustCommandRunner,
  runLocalPluginPackagePublisherTrustCommandFile,
} = require('@qinglong/local-owner-cli/package-publisher-trust-command');
const {
  analyzeLocalPluginPackageRecoveryCatalogPublisherKey,
  analyzeLocalPluginPackageRecoveryCatalogPublisherKeyImpact,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
} = require('@qinglong/local-admin/package-recovery-catalog');
const {
  confirmLocalPluginPackagePublisherKeyRevocation,
  inspectLocalPluginPackagePublisherTrust,
  publishLocalPluginPackagePublisherTrust,
  proposeLocalPluginPackagePublisherKeyRevocation,
  retireLocalPluginPackagePublisherKey,
} = require('@qinglong/local-admin/package-publisher-trust');
const {
  establishAuthenticatedLocalCommand,
} = require('@qinglong/local-owner-console/authenticated-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('@qinglong/local-sqlite/plugin-package-automation-publication');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('@qinglong/local-sqlite/plugin-package-materialized-revision');
const {
  LocalSqliteOperationAuthority,
} = require('@qinglong/local-sqlite/operation-authority');
const {
  openLocalSqliteAuthenticatedManagementDatabase,
} = require('@qinglong/local-sqlite/authenticated-management');
const {
  openLocalSqlitePluginPackageManagementDatabase,
} = require('@qinglong/local-sqlite/package-management');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
  pluginPackageContentTreeDigest,
  pluginPackagePublisherSignaturePayload,
} = require('@qinglong/runtime-core/plugin-package-bundle');
const {
  serializePluginPackageManifest,
  pluginPackageActivationIntentDigest,
  pluginPackageInstallCommit,
  transitionPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  materializePluginPackageResources,
} = require('@qinglong/runtime-core/plugin-package-resource-materialization');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('@qinglong/runtime-core/task-spec-semantic');

const CREDENTIAL_ID = 'package-owner';
const PEPPER_KEY_ID = 'package-owner-v1';
const PEPPER = Buffer.alloc(32, 75).toString('base64url');
const SECRET = Buffer.alloc(32, 76).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function octal(value, bytes) {
  return Buffer.from(`${value.toString(8).padStart(bytes - 1, '0')}\0`);
}

function tarHeader(entryPath, bytes) {
  const header = Buffer.alloc(512);
  Buffer.from(entryPath).copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);
  octal(bytes, 12).copy(header, 124);
  Buffer.from('00000000000\0').copy(header, 136);
  header.fill(0x20, 148, 156);
  Buffer.from('0').copy(header, 156);
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
  return header;
}

function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.path, entry.body.byteLength), entry.body);
    const padding = (512 - (entry.body.byteLength % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const CLI_PACKAGE_RESOURCES = Object.freeze([
  Object.freeze({
    reference: Object.freeze({ kind: 'task', path: 'tasks/collect.json' }),
    body: Buffer.from(
      JSON.stringify({
        schema: 'qinglong/plugin-package-task-resource@v1',
        id: 'collect',
        name: 'Collect',
        labels: { 'plugin.qinglong.io/source': 'owner-cli-contract' },
        enabled: true,
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/usr/bin/printf',
              args: ['collect'],
            },
          },
        },
      }),
    ),
  }),
  Object.freeze({
    reference: Object.freeze({
      kind: 'workflow',
      path: 'workflows/daily.json',
    }),
    body: Buffer.from(
      JSON.stringify({
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily collection',
        enabled: true,
        steps: [{ id: 'collect', task: 'collect', needs: [] }],
      }),
    ),
  }),
  Object.freeze({
    reference: Object.freeze({
      kind: 'prompt',
      path: 'prompts/summary.json',
    }),
    body: Buffer.from(
      JSON.stringify({
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'summary',
        name: 'Summary',
        template: 'Summarize {{result}}',
        parameters: [{ name: 'result', required: true }],
      }),
    ),
  }),
]);

function packageArtifact(manifest) {
  return tar([
    {
      path: 'package.json',
      body: Buffer.from(serializePluginPackageManifest(manifest)),
    },
    ...CLI_PACKAGE_RESOURCES.map(({ reference, body }) => ({
      path: reference.path,
      body,
    })).sort((left, right) => left.path.localeCompare(right.path)),
  ]);
}

function actionInput() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'cli-monitor',
      displayName: 'CLI Monitor',
      version: '1.0.0',
      description: 'One bounded package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '16Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: ['system.command'],
      },
      contents: {
        tasks: ['tasks/collect.json'],
        workflows: ['workflows/daily.json'],
        prompts: ['prompts/summary.json'],
        tools: [],
      },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 64 * 1024 * 1024,
    availableDiskBytes: 128 * 1024 * 1024,
  };
  const artifact = packageArtifact(manifest);
  const artifactDigest = digest(artifact);
  return {
    lockId: 'cli-monitor-v1',
    projectId: 'default',
    manifest,
    plan: planPluginPackageInstall(manifest, environment),
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${artifactDigest}`,
      artifactDigest,
      artifactBytes: artifact.byteLength,
      contentDigest: pluginPackageContentTreeDigest(
        CLI_PACKAGE_RESOURCES.map(({ reference, body }) => ({
          path: reference.path,
          bytes: body.byteLength,
          digest: digest(body),
        })).sort((left, right) => left.path.localeCompare(right.path)),
      ),
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
}

async function fixture(t, owner = true) {
  const deploymentRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-package-command-')),
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
  const summary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 75),
  });
  const now = Date.now();
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
        summary.digest,
        'b'.repeat(64),
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002',
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
        '10000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        summary.digest,
        'b'.repeat(64),
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
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'owner-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
        now - 1_000,
        now - 1_000,
        now + 10 * 60 * 1_000,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    if (owner) {
      database
        .prepare(
          `INSERT INTO "QingLong3ProjectRoleBindings" (
             "project_id", "subject_type", "subject_id", "version", "state",
             "role", "mutation_id", "changed_by_type", "changed_by_id",
             "created_at_ms"
           ) VALUES (
             'default', 'user', 'owner-user', 1, 'active', 'owner',
             'package-cli-owner-binding', 'user', 'owner-user', ?
           )`,
        )
        .run(now - 500);
    }
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    deploymentRoot,
    commandsDirectory,
    databasePath,
    credentialFilePath,
    ownerPepperKeyringDirectory,
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

function assertNoSensitiveMaterial(result) {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.doesNotMatch(serialized, /offline:sha256:/);
  assert.doesNotMatch(serialized, /authenticationId/);
}

async function activatePackageAutomation(databasePath, lock, manifest) {
  const client = new DatabaseSync(databasePath);
  const authority = new LocalSqliteOperationAuthority(client);
  try {
    const installs = new LocalSqlitePluginPackageInstallRepository(authority);
    const queued = await installs.find(lock.projectId, lock.packageName);
    assert.ok(queued);
    const staged = transitionPluginPackageInstall(lock, queued, {
      type: 'stage_completed',
      mutationId: 'owner-cli-stage-active-package',
      occurredAtMs: queued.updatedAtMs + 1,
      stageRef: `stage:${lock.lockDigest}`,
      artifactDigest: lock.source.artifactDigest,
      manifestDigest: lock.manifestDigest,
      contentDigest: lock.source.contentDigest,
      evidenceDigest: 'e'.repeat(64),
    });
    await installs.commit(pluginPackageInstallCommit(queued, staged));
    const activating = transitionPluginPackageInstall(lock, staged, {
      type: 'activation_started',
      mutationId: 'owner-cli-start-active-package',
      occurredAtMs: staged.updatedAtMs + 1,
    });
    await installs.commit(pluginPackageInstallCommit(staged, activating));
    const active = transitionPluginPackageInstall(lock, activating, {
      type: 'activation_committed',
      mutationId: 'owner-cli-commit-active-package',
      occurredAtMs: activating.updatedAtMs + 1,
      activationRef: `activation:${lock.lockDigest}`,
      intentDigest: pluginPackageActivationIntentDigest(lock, activating),
      generation: lock.targetGeneration,
      contentDigest: lock.source.contentDigest,
    });
    await installs.commit(pluginPackageInstallCommit(activating, active));

    const generation = createPluginPackageResourceGeneration({
      installationId: active.installationId,
      projectId: active.projectId,
      packageName: active.packageName,
      lockDigest: active.lockDigest,
      generation: active.targetGeneration,
      previousActiveLockDigest: active.previousActiveLockDigest,
      contentDigest: lock.source.contentDigest,
      contents: manifest.spec.contents,
    });
    const bodies = new Map(
      CLI_PACKAGE_RESOURCES.map(({ reference, body }) => [
        `${reference.kind}\0${reference.path}`,
        body,
      ]),
    );
    const registry = createBuiltInTaskSpecSemanticRegistry();
    const revision = materializePluginPackageResources({
      generation,
      lock,
      manifestBytes: Buffer.from(serializePluginPackageManifest(manifest)),
      resources: generation.resources.map((reference) => ({
        reference,
        bytes: bodies.get(`${reference.kind}\0${reference.path}`),
      })),
      taskSpecSemanticRegistry: registry,
    });
    await new LocalSqlitePluginPackageMaterializedRevisionRepository(
      authority,
      registry,
    ).publish(revision);
    const publication = createInitialPluginPackageAutomationPublication(
      revision,
      registry,
      active.updatedAtMs + 1,
    );
    const automations =
      new LocalSqlitePluginPackageAutomationPublicationRepository(authority);
    await automations.publish(publication);
    assert.equal(
      await automations.isStartAllowed(
        active.projectId,
        active.packageName,
        publication.publicationDigest,
      ),
      true,
    );
    return { active, publication };
  } finally {
    await authority.close();
  }
}

function publisherTrustRunnerWithOneSnapshotFault() {
  let injectFault = true;
  return createLocalPluginPackagePublisherTrustCommandRunner({
    openDatabase: openLocalSqliteAuthenticatedManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    inspect: inspectLocalPluginPackagePublisherTrust,
    publish: publishLocalPluginPackagePublisherTrust,
    retire: retireLocalPluginPackagePublisherKey,
    analyzePublisherKey: analyzeLocalPluginPackageRecoveryCatalogPublisherKey,
    proposeRevocation: proposeLocalPluginPackagePublisherKeyRevocation,
    async confirmRevocation(options) {
      return confirmLocalPluginPackagePublisherKeyRevocation({
        ...options,
        afterSnapshotPublished() {
          if (!injectFault) return;
          injectFault = false;
          throw new Error(
            'simulated revocation crash after quarantine and snapshot',
          );
        },
      });
    },
    analyzePublisherKeyImpact:
      analyzeLocalPluginPackageRecoveryCatalogPublisherKeyImpact,
    now: Date.now,
  });
}

test('runs the private command-file package lifecycle with replay-safe IDs', async (t) => {
  const value = await fixture(t);
  const proposeFile = commandFile(
    value,
    'plugin-package.propose',
    {
      actionRef: 'proposal:cli-monitor-v1',
      approvalRequestId: 'approval-cli-monitor-v1',
      proposalAuditEventId: '20000000-0000-4000-8000-000000000001',
      approvalAuditEventId: '20000000-0000-4000-8000-000000000002',
      actionInput: actionInput(),
    },
    '01-propose',
  );
  const proposed = await runLocalPluginPackageCommandFile(proposeFile);
  assert.equal(proposed.proposalStatus, 'created');
  assert.equal(proposed.approval.state, 'pending');
  assert.equal(proposed.proposal.packageName, 'cli-monitor');
  assertNoSensitiveMaterial(proposed);

  const replayed = await runLocalPluginPackageCommandFile(proposeFile);
  assert.equal(replayed.proposalStatus, 'existing');
  assert.equal(replayed.approvalStatus, 'existing');

  const interrupted = new DatabaseSync(value.databasePath);
  try {
    interrupted
      .prepare('DELETE FROM "QingLong3ApprovalRequests" WHERE "request_id" = ?')
      .run('approval-cli-monitor-v1');
    interrupted
      .prepare(
        'DELETE FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?',
      )
      .run('20000000-0000-4000-8000-000000000002');
  } finally {
    interrupted.close();
  }
  const resumedProposal = await runLocalPluginPackageCommandFile(proposeFile);
  assert.equal(resumedProposal.proposalStatus, 'existing');
  assert.equal(resumedProposal.approvalStatus, 'created');
  assert.equal(
    resumedProposal.approval.requestedAtMs,
    resumedProposal.proposal.createdAtMs,
  );

  const decideFile = commandFile(
    value,
    'plugin-package.decide',
    {
      actionRef: 'proposal:cli-monitor-v1',
      approvalRequestId: 'approval-cli-monitor-v1',
      expectedVersion: 1,
      decisionId: 'decision-cli-monitor-v1',
      auditEventId: '20000000-0000-4000-8000-000000000003',
      decision: 'approved',
      reasonCode: 'reviewed',
    },
    '02-decide',
  );
  const decided = await runLocalPluginPackageCommandFile(decideFile);
  assert.equal(decided.approval.state, 'approved');
  const replayedDecision = await runLocalPluginPackageCommandFile(decideFile);
  assert.equal(replayedDecision.status, 'existing');

  const consumeFile = commandFile(
    value,
    'plugin-package.consume',
    {
      actionRef: 'proposal:cli-monitor-v1',
      approvalRequestId: 'approval-cli-monitor-v1',
      expectedVersion: 2,
      consumptionId: 'consume-cli-monitor-v1',
      dispatchId: 'dispatch-cli-monitor-v1',
      auditEventId: '20000000-0000-4000-8000-000000000004',
    },
    '03-consume',
  );
  const consumed = await runLocalPluginPackageCommandFile(consumeFile);
  assert.equal(consumed.approval.state, 'consumed');
  const replayedConsumption = await runLocalPluginPackageCommandFile(
    consumeFile,
  );
  assert.equal(replayedConsumption.status, 'existing');

  const dispatched = await runLocalPluginPackageCommandFile(
    commandFile(value, 'plugin-package.dispatch', { limit: 1 }, '04-dispatch'),
  );
  assert.equal(dispatched.summary.scanned, 1);
  assert.equal(dispatched.summary.succeeded, 1);

  const unresolvedCatalogRoot = path.join(
    value.deploymentRoot,
    'package-catalog',
  );
  const unresolvedBundleRoot = path.join(
    value.deploymentRoot,
    'package-bundles',
  );
  fs.mkdirSync(unresolvedCatalogRoot, { mode: 0o700 });
  fs.mkdirSync(unresolvedBundleRoot, { mode: 0o700 });
  const catalogRoot = fs.realpathSync(unresolvedCatalogRoot);
  const bundleRoot = fs.realpathSync(unresolvedBundleRoot);
  const publicationInput = actionInput();
  const sourceBundlePath = path.join(
    value.deploymentRoot,
    'incoming-package.bundle',
  );
  fs.writeFileSync(
    sourceBundlePath,
    packageArtifact(publicationInput.manifest),
    { mode: 0o600 },
  );
  const lockDatabase = new DatabaseSync(value.databasePath);
  let lock;
  try {
    const repository = new LocalSqlitePluginPackageInstallRepository(
      lockDatabase,
    );
    const head = await repository.find('default', 'cli-monitor');
    lock = await repository.findLock(head.lockDigest);
  } finally {
    lockDatabase.close();
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publisher = 'packages.example.com';
  const keyId = 'release-2026';
  const unresolvedTrustRoot = path.join(
    value.deploymentRoot,
    'publisher-trust',
  );
  fs.mkdirSync(unresolvedTrustRoot, { mode: 0o700 });
  const trustRoot = fs.realpathSync(unresolvedTrustRoot);
  const trustCandidatePath = path.join(
    value.deploymentRoot,
    'publisher-trust-v1.json',
  );
  const descriptorFilePath = path.join(
    value.deploymentRoot,
    'publication.json',
  );
  const publisherKey = {
    publisher,
    keyId,
    publicKeyPem: publicKey.export({
      format: 'pem',
      type: 'spki',
    }),
    notBeforeMs: Date.now() - 60_000,
    notAfterMs: Date.now() + 10 * 60_000,
  };
  fs.writeFileSync(
    trustCandidatePath,
    `${JSON.stringify({
      schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
      keys: [publisherKey],
    })}\n`,
    { mode: 0o600 },
  );
  const trustOptions = {
    ...value.options,
    trustRoot,
    catalogRoot,
    bundleRoot,
  };
  const trustProvisionPath = path.join(
    value.commandsDirectory,
    '07-publisher-trust-provision.json',
  );
  fs.writeFileSync(
    trustProvisionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.provision',
      options: trustOptions,
      request: {
        requestId: 'publisher-trust-provision-v1',
        auditEventId: '20000000-0000-4000-8000-000000000011',
        failureAuditEventId: '20000000-0000-4000-8000-000000000012',
        mutationId: 'publisher-trust-provision-v1',
        expectedGeneration: 0,
        trustFilePath: trustCandidatePath,
      },
    })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(
    await runLocalPluginPackagePublisherTrustCommandFile(trustProvisionPath),
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.provision',
      status: 'published',
      generation: 1,
      keyCount: 1,
    },
  );
  const trustSnapshot = JSON.parse(
    fs.readFileSync(path.join(trustRoot, '00000000000000000001.json'), 'utf8'),
  );
  const trustAuditDatabase = new DatabaseSync(value.databasePath, {
    readOnly: true,
  });
  try {
    assert.equal(
      trustSnapshot.occurredAtMs,
      trustAuditDatabase
        .prepare(
          `SELECT "occurred_at_ms" AS "occurredAtMs"
             FROM "QingLong3SecurityAuditEvents"
            WHERE "event_id" = ?`,
        )
        .get('20000000-0000-4000-8000-000000000011').occurredAtMs,
    );
  } finally {
    trustAuditDatabase.close();
  }
  assert.equal(
    (await runLocalPluginPackagePublisherTrustCommandFile(trustProvisionPath))
      .status,
    'existing',
  );
  fs.writeFileSync(
    descriptorFilePath,
    `${JSON.stringify({
      schema: LOCAL_PLUGIN_PACKAGE_RECOVERY_PUBLICATION_SCHEMA,
      bundlePath: sourceBundlePath,
      manifest: publicationInput.manifest,
      signature: {
        schema: PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
        publisher,
        keyId,
        signature: sign(
          null,
          pluginPackagePublisherSignaturePayload(lock, publisher, keyId),
          privateKey,
        ).toString('base64url'),
      },
    })}\n`,
    { mode: 0o600 },
  );
  const catalogOptions = {
    ...value.options,
    catalogRoot,
    bundleRoot,
    trustRoot,
  };
  const catalogCommandPath = path.join(
    value.commandsDirectory,
    '07-catalog-publish.json',
  );
  fs.writeFileSync(
    catalogCommandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.catalog.publish',
      options: catalogOptions,
      request: {
        requestId: 'publish-cli-monitor-v1',
        auditEventId: '20000000-0000-4000-8000-000000000007',
        failureAuditEventId: '20000000-0000-4000-8000-000000000008',
        projectId: 'default',
        packageName: 'cli-monitor',
        descriptorFilePath,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const published = await runLocalPluginPackageCatalogCommandFile(
    catalogCommandPath,
  );
  assert.equal(published.status, 'published');
  assert.equal(published.lockDigest, lock.lockDigest);
  const activeAutomation = await activatePackageAutomation(
    value.databasePath,
    lock,
    publicationInput.manifest,
  );
  assert.equal(
    (await runLocalPluginPackageCatalogCommandFile(catalogCommandPath)).status,
    'existing',
  );
  const catalogInspectPath = path.join(
    value.commandsDirectory,
    '08-catalog-inspect.json',
  );
  fs.writeFileSync(
    catalogInspectPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.catalog.inspect',
      options: catalogOptions,
      request: {},
    })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(
    await runLocalPluginPackageCatalogCommandFile(catalogInspectPath),
    {
      schemaVersion: 1,
      operation: 'plugin-package.catalog.inspect',
      entryCount: 1,
      bundleCount: 1,
      unresolvedTransactions: 0,
      currentEntries: 1,
      staleEntries: 0,
    },
  );
  const publishedEntryPath = path.join(catalogRoot, `${lock.lockDigest}.json`);
  const staleLockDigest = 'c'.repeat(64);
  const staleEntry = JSON.parse(fs.readFileSync(publishedEntryPath, 'utf8'));
  staleEntry.lockDigest = staleLockDigest;
  fs.writeFileSync(
    path.join(catalogRoot, `${staleLockDigest}.json`),
    `${JSON.stringify(staleEntry)}\n`,
    { mode: 0o600 },
  );
  const catalogCollectPath = path.join(
    value.commandsDirectory,
    '09-catalog-collect.json',
  );
  fs.writeFileSync(
    catalogCollectPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.catalog.collect',
      options: catalogOptions,
      request: {
        requestId: 'collect-cli-monitor-v1',
        auditEventId: '20000000-0000-4000-8000-000000000009',
        failureAuditEventId: '20000000-0000-4000-8000-000000000010',
        limit: 1,
      },
    })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(
    await runLocalPluginPackageCatalogCommandFile(catalogCollectPath),
    {
      schemaVersion: 1,
      operation: 'plugin-package.catalog.collect',
      removedEntries: 1,
      removedBundles: 0,
      removedTransactions: 0,
      remaining: false,
    },
  );
  assert.equal(fs.existsSync(publishedEntryPath), true);
  assert.equal(
    fs.existsSync(path.join(catalogRoot, `${staleLockDigest}.json`)),
    false,
  );
  const catalogHelp = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/plugin-package/pluginPackageCatalogCli.js'),
      '--help',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(catalogHelp.status, 0, catalogHelp.stderr);
  assert.match(catalogHelp.stdout, /ql3-package-catalog run/);
  assert.equal(catalogHelp.stdout.includes(TOKEN), false);

  const { publicKey: nextPublicKey } = generateKeyPairSync('ed25519');
  const nextTrustCandidatePath = path.join(
    value.deploymentRoot,
    'publisher-trust-v2.json',
  );
  fs.writeFileSync(
    nextTrustCandidatePath,
    `${JSON.stringify({
      schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
      keys: [
        publisherKey,
        {
          publisher,
          keyId: 'release-2027',
          publicKeyPem: nextPublicKey.export({
            format: 'pem',
            type: 'spki',
          }),
          notBeforeMs: Date.now() - 60_000,
          notAfterMs: Date.now() + 10 * 60_000,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const trustRotatePath = path.join(
    value.commandsDirectory,
    '10-publisher-trust-rotate.json',
  );
  fs.writeFileSync(
    trustRotatePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.rotate',
      options: trustOptions,
      request: {
        requestId: 'publisher-trust-rotate-v2',
        auditEventId: '20000000-0000-4000-8000-000000000013',
        failureAuditEventId: '20000000-0000-4000-8000-000000000014',
        mutationId: 'publisher-trust-rotate-v2',
        expectedGeneration: 1,
        trustFilePath: nextTrustCandidatePath,
      },
    })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(
    await runLocalPluginPackagePublisherTrustCommandFile(trustRotatePath),
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.rotate',
      status: 'published',
      generation: 2,
      keyCount: 2,
    },
  );
  const trustRetirePath = path.join(
    value.commandsDirectory,
    '11-publisher-trust-retire.json',
  );
  fs.writeFileSync(
    trustRetirePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.retire',
      options: trustOptions,
      request: {
        requestId: 'publisher-trust-retire-v3',
        auditEventId: '20000000-0000-4000-8000-000000000015',
        failureAuditEventId: '20000000-0000-4000-8000-000000000016',
        mutationId: 'publisher-trust-retire-v3',
        expectedGeneration: 2,
        publisher,
        keyId: 'release-2027',
      },
    })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(
    await runLocalPluginPackagePublisherTrustCommandFile(trustRetirePath),
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.retire',
      status: 'published',
      generation: 3,
      keyCount: 1,
    },
  );
  assert.equal(
    (await runLocalPluginPackagePublisherTrustCommandFile(trustRetirePath))
      .status,
    'existing',
  );
  const trustInspectPath = path.join(
    value.commandsDirectory,
    '11-publisher-trust-inspect.json',
  );
  fs.writeFileSync(
    trustInspectPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.inspect',
      options: trustOptions,
      request: {},
    })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(
    await runLocalPluginPackagePublisherTrustCommandFile(trustInspectPath),
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.inspect',
      generation: 3,
      keyCount: 1,
      activeKeyCount: 1,
      snapshotCount: 3,
      retirementCount: 1,
      pendingRetirementCount: 0,
      revocationCount: 0,
      pendingRevocationCount: 0,
      quarantinedLockCount: 0,
      recoveryRequired: false,
      pendingGeneration: null,
      unresolvedTransactions: 0,
    },
  );
  const trustHelp = spawnSync(
    process.execPath,
    [
      path.join(
        __dirname,
        '../dist/plugin-package/pluginPackagePublisherTrustCli.js',
      ),
      '--help',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(trustHelp.status, 0, trustHelp.stderr);
  assert.match(trustHelp.stdout, /ql3-package-trust run/);
  assert.equal(trustHelp.stdout.includes(TOKEN), false);

  const revokeProposalPath = path.join(
    value.commandsDirectory,
    '12-publisher-trust-revoke-propose.json',
  );
  fs.writeFileSync(
    revokeProposalPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.revoke.propose',
      options: trustOptions,
      request: {
        requestId: 'publisher-trust-revoke-v4-propose',
        auditEventId: '20000000-0000-4000-8000-000000000017',
        failureAuditEventId: '20000000-0000-4000-8000-000000000018',
        mutationId: 'publisher-trust-revoke-v4',
        expectedGeneration: 3,
        publisher,
        keyId,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const revokeProposal = await runLocalPluginPackagePublisherTrustCommandFile(
    revokeProposalPath,
  );
  assert.equal(revokeProposal.status, 'proposed');
  assert.equal(revokeProposal.generation, 3);
  assert.equal(revokeProposal.matchingEntryCount, 1);
  assert.equal(revokeProposal.runtimeAction, 'stop_required');
  await assert.rejects(
    runLocalPluginPackageCatalogCommandFile(catalogCommandPath),
    /catalog publication is unavailable/,
  );

  const revokeConfirmationPath = path.join(
    value.commandsDirectory,
    '13-publisher-trust-revoke-confirm.json',
  );
  const revokeDualControlPath = path.join(
    value.commandsDirectory,
    '13-publisher-trust-revoke-dual-control.json',
  );
  fs.writeFileSync(
    revokeDualControlPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.revoke.confirm',
      options: trustOptions,
      request: {
        requestId: 'publisher-trust-revoke-v4-dual-control',
        auditEventId: '20000000-0000-4000-8000-000000000019',
        failureAuditEventId: '20000000-0000-4000-8000-000000000020',
        mutationId: 'publisher-trust-revoke-v4',
        expectedGeneration: 3,
        publisher,
        keyId,
        proposerSubjectId: 'owner-user',
        authorizationMode: 'dual_control',
        reasonCode: 'confirmed_key_compromise',
        expectedImpactDigest: revokeProposal.impactDigest,
      },
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    runLocalPluginPackagePublisherTrustCommandFile(revokeDualControlPath),
    /distinct Owner/,
  );
  fs.writeFileSync(
    revokeConfirmationPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.revoke.confirm',
      options: trustOptions,
      request: {
        requestId: 'publisher-trust-revoke-v4-confirm',
        auditEventId: '20000000-0000-4000-8000-000000000021',
        failureAuditEventId: '20000000-0000-4000-8000-000000000022',
        mutationId: 'publisher-trust-revoke-v4',
        expectedGeneration: 3,
        publisher,
        keyId,
        proposerSubjectId: 'owner-user',
        authorizationMode: 'break_glass',
        reasonCode: 'confirmed_key_compromise',
        expectedImpactDigest: revokeProposal.impactDigest,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const faultRunner = publisherTrustRunnerWithOneSnapshotFault();
  await assert.rejects(
    faultRunner.run(revokeConfirmationPath),
    /simulated revocation crash after quarantine and snapshot/,
  );
  const interruptedInspection =
    await runLocalPluginPackagePublisherTrustCommandFile(trustInspectPath);
  assert.equal(interruptedInspection.generation, 3);
  assert.equal(interruptedInspection.pendingGeneration, 4);
  assert.equal(interruptedInspection.recoveryRequired, true);
  assert.equal(interruptedInspection.quarantinedLockCount, 1);
  const quarantineDatabase = new DatabaseSync(value.databasePath, {
    readOnly: true,
  });
  const quarantineAuthority = new LocalSqliteOperationAuthority(
    quarantineDatabase,
  );
  try {
    assert.deepEqual(
      {
        ...quarantineDatabase
          .prepare(
            `SELECT quarantine.lock_digest AS "lockDigest",
                    receipt.capability_status AS "capabilityStatus",
                    receipt.task_count AS "taskCount"
             FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
             JOIN "QingLong3PluginPackageWithdrawalReceipts" AS receipt
               ON receipt.event_digest = quarantine.event_digest`,
          )
          .get(),
      },
      {
        lockDigest: lock.lockDigest,
        capabilityStatus: 'withdrawn',
        taskCount: 0,
      },
    );
    const automationHead = quarantineDatabase
      .prepare(
        `SELECT publication_digest AS "publicationDigest", state
         FROM "QingLong3PluginPackageAutomationPublicationHeads"
         WHERE project_id = ? AND package_name = ?`,
      )
      .get(lock.projectId, lock.packageName);
    const automationRepository =
      new LocalSqlitePluginPackageAutomationPublicationRepository(
        quarantineAuthority,
      );
    const withdrawnAutomation = await automationRepository.findCurrent(
      lock.projectId,
      lock.packageName,
    );
    assert.ok(withdrawnAutomation);
    assert.equal(withdrawnAutomation.state, 'withdrawn');
    assert.equal(
      withdrawnAutomation.previousPublicationDigest,
      activeAutomation.publication.publicationDigest,
    );
    assert.deepEqual(
      { ...automationHead },
      {
        publicationDigest: withdrawnAutomation.publicationDigest,
        state: 'withdrawn',
      },
    );
    assert.equal(
      await automationRepository.isStartAllowed(
        lock.projectId,
        lock.packageName,
        activeAutomation.publication.publicationDigest,
      ),
      false,
    );
  } finally {
    await quarantineAuthority.close();
  }
  assert.deepEqual(await faultRunner.run(revokeConfirmationPath), {
    schemaVersion: 1,
    operation: 'plugin-package.publisher-trust.revoke.confirm',
    status: 'recovered',
    generation: 4,
    keyCount: 0,
    authorizationMode: 'break_glass',
    quarantinedLockCount: 1,
    runtimeAction: 'restart_required',
  });
  assert.equal(
    (
      await runLocalPluginPackagePublisherTrustCommandFile(
        revokeConfirmationPath,
      )
    ).status,
    'existing',
  );
  const replayDatabase = new DatabaseSync(value.databasePath, {
    readOnly: true,
  });
  try {
    assert.equal(
      replayDatabase
        .prepare(
          `SELECT COUNT(*) AS count
           FROM "QingLong3PluginPackageQuarantineEvents"`,
        )
        .get().count,
      1,
    );
  } finally {
    replayDatabase.close();
  }
  const revokedInspection =
    await runLocalPluginPackagePublisherTrustCommandFile(trustInspectPath);
  assert.equal(revokedInspection.generation, 4);
  assert.equal(revokedInspection.keyCount, 0);
  assert.equal(revokedInspection.revocationCount, 1);
  assert.equal(revokedInspection.pendingRevocationCount, 0);
  assert.equal(revokedInspection.quarantinedLockCount, 1);

  const inspectFile = commandFile(
    value,
    'plugin-package.inspect',
    {
      actionRef: 'proposal:cli-monitor-v1',
      approvalRequestId: 'approval-cli-monitor-v1',
    },
    '05-inspect',
  );
  let opened = 0;
  let closed = 0;
  const runner = createLocalPluginPackageCommandRunner({
    async openDatabase(options) {
      opened += 1;
      const database = await openLocalSqlitePluginPackageManagementDatabase(
        options,
      );
      return {
        ...database,
        async close() {
          closed += 1;
          return database.close();
        },
      };
    },
    authenticate: establishAuthenticatedLocalCommand,
  });
  const inspected = await runner.run(inspectFile);
  assert.equal(inspected.approval.state, 'consumed');
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assertNoSensitiveMaterial(inspected);

  const inspectCommand = commandFile(
    value,
    'plugin-package.inspect',
    {
      actionRef: 'proposal:cli-monitor-v1',
      approvalRequestId: 'approval-cli-monitor-v1',
    },
    '06-product-cli',
  );
  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/plugin-package/pluginPackageCli.js'),
      'run',
      '--command-file',
      inspectCommand,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes(TOKEN), false);
  assert.doesNotMatch(child.stdout, /offline:sha256:/);
  assert.equal(JSON.parse(child.stdout).operation, 'plugin-package.inspect');

  const installationInspection = await runLocalPluginPackageCommandFile(
    commandFile(
      value,
      'plugin-package.installation.inspect',
      {
        projectId: 'default',
        packageName: 'cli-monitor',
      },
      '07-installation-inspect',
    ),
  );
  assert.equal(installationInspection.installation.packageName, 'cli-monitor');
  assert.equal(installationInspection.installation.availability, 'quarantined');
  assert.equal(
    installationInspection.installation.quarantineReason,
    'confirmed_key_compromise',
  );
  assert.equal(
    installationInspection.installation.withdrawalStatus,
    'withdrawn',
  );
  assertNoSensitiveMaterial(installationInspection);

  const installationList = await runLocalPluginPackageCommandFile(
    commandFile(
      value,
      'plugin-package.installation.list',
      {
        projectId: 'default',
        limit: 1,
      },
      '08-installation-list',
    ),
  );
  assert.equal(installationList.installations.length, 1);
  assert.deepEqual(
    installationList.installations[0],
    installationInspection.installation,
  );
  assert.equal(installationList.truncated, false);
  assert.equal(installationList.next, null);
  assertNoSensitiveMaterial(installationList);
});

test('denies an authenticated non-owner before package proposal mutation', async (t) => {
  const value = await fixture(t, false);
  await assert.rejects(
    runLocalPluginPackageCommandFile(
      commandFile(
        value,
        'plugin-package.propose',
        {
          actionRef: 'proposal:forbidden-v1',
          approvalRequestId: 'approval-forbidden-v1',
          proposalAuditEventId: '30000000-0000-4000-8000-000000000001',
          approvalAuditEventId: '30000000-0000-4000-8000-000000000002',
          actionInput: actionInput(),
        },
        'forbidden',
      ),
    ),
    { code: 'PLUGIN_PACKAGE_MANAGEMENT_FORBIDDEN' },
  );
  const trustRoot = path.join(value.deploymentRoot, 'forbidden-trust');
  fs.mkdirSync(trustRoot, { mode: 0o700 });
  const { publicKey } = generateKeyPairSync('ed25519');
  const trustCandidatePath = path.join(
    value.deploymentRoot,
    'forbidden-trust.json',
  );
  fs.writeFileSync(
    trustCandidatePath,
    `${JSON.stringify({
      schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
      keys: [
        {
          publisher: 'packages.example.com',
          keyId: 'forbidden-release',
          publicKeyPem: publicKey.export({
            format: 'pem',
            type: 'spki',
          }),
          notBeforeMs: Date.now() - 60_000,
          notAfterMs: Date.now() + 60_000,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const trustCommandPath = path.join(
    value.commandsDirectory,
    'forbidden-trust-command.json',
  );
  fs.writeFileSync(
    trustCommandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.provision',
      options: {
        ...value.options,
        trustRoot,
        catalogRoot: path.join(value.deploymentRoot, 'forbidden-catalog'),
        bundleRoot: path.join(value.deploymentRoot, 'forbidden-bundles'),
      },
      request: {
        requestId: 'forbidden-publisher-trust-v1',
        auditEventId: '30000000-0000-4000-8000-000000000003',
        failureAuditEventId: '30000000-0000-4000-8000-000000000004',
        mutationId: 'forbidden-publisher-trust-v1',
        expectedGeneration: 0,
        trustFilePath: trustCandidatePath,
      },
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    runLocalPluginPackagePublisherTrustCommandFile(trustCommandPath),
    { code: 'LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_OWNER_REJECTED' },
  );
  const retireCommandPath = path.join(
    value.commandsDirectory,
    'forbidden-trust-retire-command.json',
  );
  fs.writeFileSync(
    retireCommandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.retire',
      options: {
        ...value.options,
        trustRoot,
        catalogRoot: path.join(value.deploymentRoot, 'forbidden-catalog'),
        bundleRoot: path.join(value.deploymentRoot, 'forbidden-bundles'),
      },
      request: {
        requestId: 'forbidden-publisher-trust-retire-v2',
        auditEventId: '30000000-0000-4000-8000-000000000005',
        failureAuditEventId: '30000000-0000-4000-8000-000000000006',
        mutationId: 'forbidden-publisher-trust-retire-v2',
        expectedGeneration: 1,
        publisher: 'packages.example.com',
        keyId: 'forbidden-release',
      },
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    runLocalPluginPackagePublisherTrustCommandFile(retireCommandPath),
    { code: 'LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_OWNER_REJECTED' },
  );
  const revokeCommandPath = path.join(
    value.commandsDirectory,
    'forbidden-trust-revoke-command.json',
  );
  fs.writeFileSync(
    revokeCommandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust.revoke.propose',
      options: {
        ...value.options,
        trustRoot,
        catalogRoot: path.join(value.deploymentRoot, 'forbidden-catalog'),
        bundleRoot: path.join(value.deploymentRoot, 'forbidden-bundles'),
      },
      request: {
        requestId: 'forbidden-publisher-trust-revoke-v2',
        auditEventId: '30000000-0000-4000-8000-000000000007',
        failureAuditEventId: '30000000-0000-4000-8000-000000000008',
        mutationId: 'forbidden-publisher-trust-revoke-v2',
        expectedGeneration: 1,
        publisher: 'packages.example.com',
        keyId: 'forbidden-release',
      },
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    runLocalPluginPackagePublisherTrustCommandFile(revokeCommandPath),
    { code: 'LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_OWNER_REJECTED' },
  );
  assert.equal(fs.existsSync(path.join(trustRoot, 'current.json')), false);
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
           FROM "QingLong3PluginPackageInstallProposals"`,
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});
