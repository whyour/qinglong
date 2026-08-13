#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');

const {
  createPostgresDatabaseOpener,
} = require('@qinglong/cluster-postgres/package-executor');
const {
  PostgresApprovalRequestRepository,
} = require('@qinglong/cluster-postgres/approved-action');
const {
  PostgresPluginPackageInstallRepository,
} = require('@qinglong/cluster-postgres/plugin-package-install');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  pluginPackageActivationIntentDigest,
  pluginPackageInstallCommit,
  transitionPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  createPluginPackagePublisherProvenance,
} = require('@qinglong/runtime-core/plugin-package-publisher-provenance');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  secretProjectionFileName,
} = require('@qinglong/runtime-core/secret-projection');
const {
  createClusterPluginPackageManagementService,
} = require('@qinglong/cluster-admin/plugin-package-management');
const {
  createClusterPluginPackageApprovedActionDispatcher,
} = require('@qinglong/cluster-admin/plugin-package-approved-action');

const PROJECT_ID = 'secret-binding-kubernetes-live';
const PACKAGE_NAME = 'secret-binding-live';
const REQUESTER_ID = 'secret-binding-requester';
const REVIEWER_ID = 'secret-binding-reviewer';
const MIGRATION_URL = process.env.QL3_TEST_POSTGRES_MIGRATION_URL;
const MANAGER_URL = process.env.QL3_TEST_POSTGRES_PACKAGE_MANAGER_URL;
const EXECUTOR_URL = process.env.QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL;

function opener(role, connectionString) {
  assert.ok(connectionString, `${role} URL is required`);
  return createPostgresDatabaseOpener({
    role,
    connection: { connectionString, tls: { mode: 'disable' } },
    pool: { maxConnections: 2, applicationName: `ql3-live-${role}` },
    onPoolError(error) {
      throw error;
    },
  });
}

function principal(id, authenticationId, now) {
  return Object.freeze({
    subject: Object.freeze({ type: 'user', id }),
    authenticationId,
    authenticatedAtMs: now - 1,
    expiresAtMs: now + 120_000,
    assurance: 'multi_factor',
  });
}

function audit(eventId, requestId, projectId, now, fence) {
  return Object.freeze({
    eventId,
    requestId,
    operationId: 'approval.consume',
    projectId,
    subject: Object.freeze({ type: 'system', id: 'cluster_package_executor' }),
    authenticationId: 'secret-binding-kubernetes-live-bootstrap',
    outcome: 'allowed',
    reasons: Object.freeze(['package_review']),
    fence,
    occurredAtMs: now,
  });
}

async function main() {
  let now = Date.now();
  const migration = await opener('migration', MIGRATION_URL)();
  const manager = await opener('package-manager', MANAGER_URL)();
  const executor = await opener('package-executor', EXECUTOR_URL)();
  try {
    await migration.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES ($1, $1, $1, 'active', 1, $2, $2)`,
      [PROJECT_ID, now],
    );
    await migration.pool.query(
      `INSERT INTO "ql3"."project_role_bindings" (
         project_id, subject_type, subject_id, version, state, role,
         mutation_id, changed_by_type, changed_by_id, created_at_ms
       ) VALUES
         ($1, 'user', $2, 1, 'active', 'owner', $4, 'system', 'live', $6),
         ($1, 'user', $3, 1, 'active', 'admin', $5, 'system', 'live', $6)`,
      [
        PROJECT_ID,
        REQUESTER_ID,
        REVIEWER_ID,
        'secret-binding-live-owner',
        'secret-binding-live-reviewer',
        now,
      ],
    );

    const manifest = Object.freeze({
      apiVersion: PLUGIN_PACKAGE_API_VERSION,
      kind: PLUGIN_PACKAGE_KIND,
      metadata: {
        name: PACKAGE_NAME,
        displayName: 'Kubernetes Secret binding live fixture',
        version: '1.0.0',
        description: 'Content-free Secret binding Kubernetes evidence fixture',
        license: 'Apache-2.0',
      },
      spec: {
        compatibility: {
          qinglong: '>=3.0.0-0 <4.0.0',
          architectures: ['arm64', 'amd64'],
          deploymentProfiles: ['cluster-control'],
        },
        runtimes: [],
        resources: {
          memory: { recommended: '16Mi' },
          disk: { install: '4Mi', working: '8Mi' },
        },
        permissions: {
          network: { allowedHosts: [] },
          secrets: [{ name: 'TOKEN', required: true }],
          tools: ['secret.use'],
        },
        contents: { tasks: [], workflows: [], prompts: [], tools: [] },
      },
    });
    const environment = Object.freeze({
      qinglongVersion: '3.0.0-alpha.0',
      architecture: process.arch === 'x64' ? 'amd64' : 'arm64',
      deploymentProfile: 'cluster-control',
      runtimes: [],
      availableMemoryBytes: 128 * 1024 * 1024,
      availableDiskBytes: 256 * 1024 * 1024,
    });
    const plan = planPluginPackageInstall(manifest, environment);
    const actionInput = Object.freeze({
      lockId: 'secret-binding-live-lock',
      projectId: PROJECT_ID,
      manifest,
      plan,
      environment,
      source: {
        kind: 'offline',
        locator: `offline:sha256:${'a'.repeat(64)}`,
        artifactDigest: 'a'.repeat(64),
        artifactBytes: 2048,
        contentDigest: 'b'.repeat(64),
      },
      architecture: environment.architecture,
      deploymentProfile: 'cluster-control',
      targetGeneration: 1,
    });
    const actionRef = `install:${PACKAGE_NAME}:v1`;
    const approvalId = 'secret-binding-live-install-approval';
    const management = createClusterPluginPackageManagementService({
      pool: manager.pool,
      now: () => now,
      approvalLifetimeMs: 120_000,
    });
    const proposed = await management.propose({
      actionRef,
      approvalRequestId: approvalId,
      proposalAuditEventId: randomUUID(),
      approvalAuditEventId: randomUUID(),
      requestedAtMs: now,
      actionInput,
      principal: principal(REQUESTER_ID, 'bootstrap-requester', now),
    });
    now += 10;
    const decided = await management.decide({
      approvalRequestId: approvalId,
      expectedVersion: proposed.approvalRequest.version,
      decisionId: 'secret-binding-live-install-decision',
      auditEventId: randomUUID(),
      decision: 'approved',
      reasonCode: 'reviewed',
      decidedAtMs: now,
      principal: principal(REVIEWER_ID, 'bootstrap-reviewer', now),
    });
    const fence = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
    now += 10;
    const consumed = await new PostgresApprovalRequestRepository(
      executor.pool,
    ).consume({
      requestId: approvalId,
      expectedVersion: decided.request.version,
      consumptionId: 'secret-binding-live-install-consume',
      dispatchId: 'secret-binding-live-install-dispatch',
      action: decided.request.action,
      requestedBy: Object.freeze({ type: 'user', id: REQUESTER_ID }),
      consumedBy: Object.freeze({
        type: 'system',
        id: 'cluster_package_executor',
      }),
      consumedAtMs: now,
      authorizationFence: fence,
      audit: audit(randomUUID(), approvalId, PROJECT_ID, now, fence),
    });
    assert.equal(consumed.status, 'consumed');
    let id = 0;
    now += 10;
    const dispatched = await createClusterPluginPackageApprovedActionDispatcher(
      {
        pool: executor.pool,
        owner: 'secret-binding-live-bootstrap',
        clock: () => now,
        createId: () => `secret-binding-live-bootstrap-${++id}`,
        secretExistenceInspector: { async assertExists() {} },
      },
    ).dispatchBatch({ limit: 4 });
    assert.equal(dispatched.succeeded, 1);

    const installs = new PostgresPluginPackageInstallRepository(executor.pool);
    const queued = await installs.find(PROJECT_ID, PACKAGE_NAME);
    assert.ok(queued);
    const lock = await installs.findLock(queued.lockDigest);
    assert.ok(lock);
    now += 10;
    const staged = transitionPluginPackageInstall(lock, queued, {
      type: 'stage_completed',
      mutationId: 'secret-binding-live-stage',
      occurredAtMs: now,
      stageRef: `stage:${lock.lockDigest}`,
      artifactDigest: lock.source.artifactDigest,
      manifestDigest: lock.manifestDigest,
      contentDigest: lock.source.contentDigest,
      evidenceDigest: 'c'.repeat(64),
    });
    const provenance = createPluginPackagePublisherProvenance({
      projectId: PROJECT_ID,
      packageName: PACKAGE_NAME,
      installationId: queued.installationId,
      lockDigest: lock.lockDigest,
      artifactDigest: staged.stageReceipt.artifactDigest,
      manifestDigest: staged.stageReceipt.manifestDigest,
      contentDigest: staged.stageReceipt.contentDigest,
      stageEvidenceDigest: staged.stageReceipt.evidenceDigest,
      signature: {
        publisher: 'live.qinglong.test',
        keyId: 'live-key-1',
        signatureDigest: 'd'.repeat(64),
        keyNotBeforeMs: now - 1,
        keyNotAfterMs: now + 120_000,
        verifiedAtMs: now,
      },
    });
    await executor.pool.query(
      `INSERT INTO "ql3"."plugin_package_publisher_provenance" (
         installation_id, project_id, package_name, lock_digest,
         artifact_digest, manifest_digest, content_digest,
         stage_evidence_digest, publisher, key_id, signature_digest,
         key_not_before_ms, key_not_after_ms, verified_at_ms,
         provenance_digest, provenance_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
      [
        provenance.installationId,
        provenance.projectId,
        provenance.packageName,
        provenance.lockDigest,
        provenance.artifactDigest,
        provenance.manifestDigest,
        provenance.contentDigest,
        provenance.stageEvidenceDigest,
        provenance.publisher,
        provenance.keyId,
        provenance.signatureDigest,
        provenance.keyNotBeforeMs,
        provenance.keyNotAfterMs,
        provenance.verifiedAtMs,
        provenance.provenanceDigest,
        JSON.stringify(provenance),
      ],
    );
    await installs.commit(pluginPackageInstallCommit(queued, staged));
    now += 10;
    const activating = transitionPluginPackageInstall(lock, staged, {
      type: 'activation_started',
      mutationId: 'secret-binding-live-activate',
      occurredAtMs: now,
    });
    await installs.commit(pluginPackageInstallCommit(staged, activating));
    now += 10;
    const active = transitionPluginPackageInstall(lock, activating, {
      type: 'activation_committed',
      mutationId: 'secret-binding-live-commit',
      occurredAtMs: now,
      activationRef: `active:${lock.lockDigest}`,
      intentDigest: pluginPackageActivationIntentDigest(lock, activating),
      generation: 1,
      contentDigest: lock.source.contentDigest,
    });
    await installs.commit(pluginPackageInstallCommit(activating, active));

    const secretRef = createSecretRef({
      projectId: PROJECT_ID,
      name: 'runtime-token',
      version: 1,
    });
    const evidence = `${JSON.stringify({
      schemaVersion: 1,
      event: 'secret_binding_prerequisite_ready',
      projectId: PROJECT_ID,
      packageName: PACKAGE_NAME,
      requesterId: REQUESTER_ID,
      reviewerId: REVIEWER_ID,
      secretRef,
      projectionKey: secretProjectionFileName(secretRef),
      installationId: active.installationId,
      generation: active.targetGeneration,
    })}\n`;
    fs.writeFileSync('/dev/termination-log', evidence);
    process.stdout.write(evidence);
  } finally {
    await Promise.all([migration.close(), manager.close(), executor.close()]);
  }
}

main().catch((error) => {
  process.stderr.write(
    `QL3 Secret binding Kubernetes bootstrap failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
