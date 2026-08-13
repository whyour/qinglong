'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  createPostgresDatabaseOpener,
  PostgresPluginPackageSecretBindingApprovalPlanReader,
  PostgresPluginPackageSecretBindingRepository,
  PostgresPluginPackageSecretBindingTransitionApprovalPlanReader,
} = require('@qinglong/cluster-postgres/package-executor');
const {
  PostgresApprovedActionExecutionRepository,
} = require('@qinglong/cluster-postgres/approved-action-execution');
const {
  runPostgresMigrations,
} = require('@qinglong/cluster-postgres/migration');
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
  pluginPackageInstallCommit,
  pluginPackageActivationIntentDigest,
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
  createClusterPluginPackageManagementTransport,
} = require('@qinglong/cluster-admin/plugin-package-management-transport');
const {
  createClusterPluginPackageApprovedActionDispatcher,
} = require('@qinglong/cluster-admin/plugin-package-approved-action');
const {
  createClusterPluginPackageSecretBindingManagementService,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-management');
const {
  consumeClusterPluginPackageSecretBindingApprovals,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-approval-consumer');
const {
  ProjectedPluginPackageSecretExistenceInspector,
} = require('@qinglong/cluster-admin/plugin-package-secret-existence-inspector');
const {
  ClusterPluginPackageSecretBindingApprovedActionHandler,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-approved-action');
const {
  createClusterPluginPackageSecretBindingTransitionManagementService,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-transition-management');
const {
  consumeClusterPluginPackageSecretBindingTransitionApprovals,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-transition-approval-consumer');

const MIGRATION_URL =
  process.env.QL3_TEST_POSTGRES_MIGRATION_URL ??
  process.env.QL3_TEST_POSTGRES_URL;
const MANAGER_URL = process.env.QL3_TEST_POSTGRES_PACKAGE_MANAGER_URL;
const EXECUTOR_URL = process.env.QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL;

function opener(role, connectionString, applicationName) {
  return createPostgresDatabaseOpener({
    role,
    connection: { connectionString, tls: { mode: 'disable' } },
    pool: { maxConnections: 2, applicationName },
    onPoolError(error) {
      throw error;
    },
  });
}

function principal(subject, authenticationId, now) {
  return Object.freeze({
    subject,
    authenticationId,
    authenticatedAtMs: now - 1,
    expiresAtMs: now + 120_000,
    assurance: 'multi_factor',
  });
}

function audit(eventId, requestId, operationId, projectId, subject, now, fence) {
  return Object.freeze({
    eventId,
    requestId,
    operationId,
    projectId,
    subject,
    authenticationId: 'cluster-secret-binding-integration',
    outcome: 'allowed',
    reasons: Object.freeze(['package_review']),
    fence,
    occurredAtMs: now,
  });
}

if (!MIGRATION_URL || !MANAGER_URL || !EXECUTOR_URL) {
  test('Cluster Secret binding PostgreSQL integration requires three role URLs', {
    skip: true,
  });
} else {
  test('plans, approves, consumes and publishes one Secret binding through real PostgreSQL roles', async () => {
    const suffix = randomBytes(4).toString('hex');
    const projectId = `secret-binding-${suffix}`;
    const packageName = `secret-binding-${suffix}`;
    const requesterSubject = Object.freeze({ type: 'user', id: `owner-${suffix}` });
    const reviewerSubject = Object.freeze({ type: 'user', id: `reviewer-${suffix}` });
    const fence = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
    let now = Date.now();
    const migration = await opener('migration', MIGRATION_URL, `ql3-secret-migrate-${suffix}`)();
    const manager = await opener('package-manager', MANAGER_URL, `ql3-secret-manager-${suffix}`)();
    const executor = await opener('package-executor', EXECUTOR_URL, `ql3-secret-executor-${suffix}`)();
    const projectionRoot = join(tmpdir(), `ql3-secret-projection-${suffix}`);
    mkdirSync(projectionRoot, { mode: 0o700 });
    try {
      await runPostgresMigrations({ pool: migration.pool });
      await migration.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES ($1, $1, $1, 'active', 1, $2, $2)`,
        [projectId, now],
      );
      await migration.pool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES
           ($1, 'user', $2, 1, 'active', 'owner', $4, 'system', 'integration', $5),
           ($1, 'user', $3, 1, 'active', 'admin', $6, 'system', 'integration', $5)`,
        [
          projectId,
          requesterSubject.id,
          reviewerSubject.id,
          `grant-owner-${suffix}`,
          now,
          `grant-reviewer-${suffix}`,
        ],
      );

      const manifest = Object.freeze({
        apiVersion: PLUGIN_PACKAGE_API_VERSION,
        kind: PLUGIN_PACKAGE_KIND,
        metadata: {
          name: packageName,
          displayName: 'Secret binding PostgreSQL integration',
          version: '1.0.0',
          description: 'One bounded content-free Secret binding fixture',
          license: 'Apache-2.0',
        },
        spec: {
          compatibility: {
            qinglong: '>=3.0.0-0 <4.0.0',
            architectures: ['arm64'],
            deploymentProfiles: ['cluster-control'],
          },
          runtimes: [],
          resources: {
            memory: { recommended: '16Mi' },
            disk: { install: '4Mi', working: '8Mi' },
          },
          permissions: {
            network: { allowedHosts: [] },
            secrets: [{ name: 'TOKEN', required: false }],
            tools: ['secret.use'],
          },
          contents: { tasks: [], workflows: [], prompts: [], tools: [] },
        },
      });
      const environment = Object.freeze({
        qinglongVersion: '3.0.0-alpha.0',
        architecture: 'arm64',
        deploymentProfile: 'cluster-control',
        runtimes: [],
        availableMemoryBytes: 128 * 1024 * 1024,
        availableDiskBytes: 256 * 1024 * 1024,
      });
      const installPlan = planPluginPackageInstall(manifest, environment);
      const actionInput = Object.freeze({
        lockId: `lock-${suffix}`,
        projectId,
        manifest,
        plan: installPlan,
        environment,
        source: {
          kind: 'offline',
          locator: `offline:sha256:${'a'.repeat(64)}`,
          artifactDigest: 'a'.repeat(64),
          artifactBytes: 2048,
          contentDigest: 'b'.repeat(64),
        },
        architecture: 'arm64',
        deploymentProfile: 'cluster-control',
        targetGeneration: 1,
      });
      const installActionRef = `install:${packageName}:v1`;
      const installApprovalId = `install-approval-${suffix}`;
      const installManagement = createClusterPluginPackageManagementService({
        pool: manager.pool,
        now: () => now,
        approvalLifetimeMs: 60_000,
      });
      const proposed = await installManagement.propose({
        actionRef: installActionRef,
        approvalRequestId: installApprovalId,
        proposalAuditEventId: randomUUID(),
        approvalAuditEventId: randomUUID(),
        requestedAtMs: now,
        actionInput,
        principal: principal(requesterSubject, `install-owner-${suffix}`, now),
      });
      now += 10;
      const installDecision = await installManagement.decide({
        approvalRequestId: installApprovalId,
        expectedVersion: proposed.approvalRequest.version,
        decisionId: `install-decision-${suffix}`,
        auditEventId: randomUUID(),
        decision: 'approved',
        reasonCode: 'reviewed',
        decidedAtMs: now,
        principal: principal(reviewerSubject, `install-reviewer-${suffix}`, now),
      });
      assert.equal(installDecision.status, 'decided');
      now += 10;
      const installConsumed = await new PostgresApprovalRequestRepository(
        executor.pool,
      ).consume({
        requestId: installApprovalId,
        expectedVersion: installDecision.request.version,
        consumptionId: `install-consume-${suffix}`,
        dispatchId: `install-dispatch-${suffix}`,
        action: installDecision.request.action,
        requestedBy: requesterSubject,
        consumedBy: { type: 'system', id: 'cluster_package_executor' },
        consumedAtMs: now,
        authorizationFence: fence,
        audit: audit(
          randomUUID(),
          installApprovalId,
          'approval.consume',
          projectId,
          { type: 'system', id: 'cluster_package_executor' },
          now,
          fence,
        ),
      });
      assert.equal(installConsumed.status, 'consumed');
      let id = 0;
      now += 10;
      const installDispatch = await createClusterPluginPackageApprovedActionDispatcher({
        pool: executor.pool,
        owner: `install-executor-${suffix}`,
        clock: () => now,
        createId: () => `install-executor-id-${suffix}-${++id}`,
        secretExistenceInspector: { async assertExists() {} },
      }).dispatchBatch({ limit: 4 });
      assert.equal(installDispatch.succeeded, 1);

      const installs = new PostgresPluginPackageInstallRepository(executor.pool);
      const queued = await installs.find(projectId, packageName);
      assert.ok(queued);
      const lock = await installs.findLock(queued.lockDigest);
      assert.ok(lock);
      now += 10;
      const staged = transitionPluginPackageInstall(lock, queued, {
        type: 'stage_completed',
        mutationId: `stage-${suffix}`,
        occurredAtMs: now,
        stageRef: `stage:${lock.lockDigest}`,
        artifactDigest: lock.source.artifactDigest,
        manifestDigest: lock.manifestDigest,
        contentDigest: lock.source.contentDigest,
        evidenceDigest: 'c'.repeat(64),
      });
      const provenance = createPluginPackagePublisherProvenance({
        projectId,
        packageName,
        installationId: queued.installationId,
        lockDigest: lock.lockDigest,
        artifactDigest: staged.stageReceipt.artifactDigest,
        manifestDigest: staged.stageReceipt.manifestDigest,
        contentDigest: staged.stageReceipt.contentDigest,
        stageEvidenceDigest: staged.stageReceipt.evidenceDigest,
        signature: {
          publisher: 'integration.qinglong.dev',
          keyId: 'integration-key-1',
          signatureDigest: 'd'.repeat(64),
          keyNotBeforeMs: now - 1,
          keyNotAfterMs: now + 60_000,
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
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16::jsonb
         )`,
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
        mutationId: `activate-${suffix}`,
        occurredAtMs: now,
      });
      await installs.commit(pluginPackageInstallCommit(staged, activating));
      now += 10;
      const active = transitionPluginPackageInstall(lock, activating, {
        type: 'activation_committed',
        mutationId: `commit-${suffix}`,
        occurredAtMs: now,
        activationRef: `active:${lock.lockDigest}`,
        intentDigest: pluginPackageActivationIntentDigest(lock, activating),
        generation: 1,
        contentDigest: lock.source.contentDigest,
      });
      await installs.commit(pluginPackageInstallCommit(activating, active));

      const secretRef = createSecretRef({
        projectId,
        name: 'runtime-token',
        version: 1,
      });
      writeFileSync(join(projectionRoot, secretProjectionFileName(secretRef)), '', {
        mode: 0o440,
      });
      const secretActionRef = `secret-binding:${packageName}:v1`;
      const secretApprovalId = `secret-approval-${suffix}`;
      const secretManagement = createClusterPluginPackageSecretBindingManagementService({
        pool: manager.pool,
        now: () => now,
        planLifetimeMs: 60_000,
        approvalLifetimeMs: 60_000,
      });
      const secretTransport = createClusterPluginPackageManagementTransport({
        service: installManagement,
        secretBinding: secretManagement,
        now: () => now,
      });
      const requesterAuthentication = {
        async authenticate() {
          return principal(requesterSubject, `secret-owner-${suffix}`, now);
        },
      };
      const plannedPublic = await secretTransport.execute(
        {
          schemaVersion: 1,
          operation: 'plugin-package.secret-binding.plan',
          request: {
            actionRef: secretActionRef,
            projectId,
            packageName,
            assignments: [{ name: 'TOKEN', secretRef }],
          },
        },
        requesterAuthentication,
      );
      assert.equal(plannedPublic.status, 'created');
      assert.equal(plannedPublic.plan.actionRef, secretActionRef);
      assert.deepEqual(plannedPublic.plan.entries, [
        { name: 'TOKEN', required: false, secretRef },
      ]);
      assert.equal(Object.hasOwn(plannedPublic.plan, 'authenticationId'), false);
      now = Math.max(now, plannedPublic.plan.plannedAtMs);
      const replay = await secretTransport.execute(
        {
          schemaVersion: 1,
          operation: 'plugin-package.secret-binding.plan',
          request: {
            actionRef: secretActionRef,
            projectId,
            packageName,
            assignments: [{ name: 'TOKEN', secretRef }],
          },
        },
        requesterAuthentication,
      );
      assert.equal(replay.status, 'existing');
      now += 10;
      const secretProposed = await secretTransport.execute(
        {
          schemaVersion: 1,
          operation: 'plugin-package.secret-binding.propose',
          request: {
            actionRef: secretActionRef,
            approvalRequestId: secretApprovalId,
            approvalAuditEventId: randomUUID(),
          },
        },
        requesterAuthentication,
      );
      now += 10;
      const secretDecision = await secretTransport.execute(
        {
          schemaVersion: 1,
          operation: 'plugin-package.secret-binding.decide',
          request: {
            actionRef: secretActionRef,
            approvalRequestId: secretApprovalId,
            expectedVersion: secretProposed.approval.version,
            decisionId: `secret-decision-${suffix}`,
            auditEventId: randomUUID(),
            decision: 'approved',
            reasonCode: 'reviewed',
          },
        },
        {
          async authenticate() {
            return principal(
              reviewerSubject,
              `secret-reviewer-${suffix}`,
              now,
            );
          },
        },
      );
      assert.equal(secretDecision.status, 'decided');
      const inspected = await secretTransport.execute(
        {
          schemaVersion: 1,
          operation: 'plugin-package.secret-binding.inspect',
          request: {
            actionRef: secretActionRef,
            approvalRequestId: secretApprovalId,
            inspectionId: `secret-inspection-${suffix}`,
          },
        },
        requesterAuthentication,
      );
      assert.deepEqual(inspected.plan, plannedPublic.plan);
      assert.equal(inspected.approval?.state, 'approved');
      assert.equal(inspected.approval?.decision, 'approved');
      assert.equal(inspected.stale, false);
      now += 10;
      assert.deepEqual(
        await consumeClusterPluginPackageSecretBindingApprovals({
          pool: executor.pool,
          now: () => now,
          limit: 4,
        }),
        { scanned: 1, consumed: 1, existing: 0, expired: 0, blocked: 0 },
      );
      const inspector = new ProjectedPluginPackageSecretExistenceInspector({
        rootDirectory: projectionRoot,
      });
      await inspector.assertExists([secretRef]);
      const consumedSecretApproval =
        await new PostgresApprovalRequestRepository(executor.pool).findById(
          secretApprovalId,
        );
      assert.ok(consumedSecretApproval?.dispatchId);
      const pendingSecretExecution =
        await new PostgresApprovedActionExecutionRepository(
          executor.pool,
        ).findExecutionByDispatchId(consumedSecretApproval.dispatchId);
      assert.ok(pendingSecretExecution);
      assert.deepEqual(
        await new ClusterPluginPackageSecretBindingApprovedActionHandler(
          new PostgresPluginPackageSecretBindingApprovalPlanReader(
            executor.pool,
          ),
          new PostgresPluginPackageSecretBindingRepository(executor.pool),
          inspector,
        ).inspect(pendingSecretExecution.dispatch),
        {
          status: 'ready',
          actionDigest: plannedPublic.plan.approvalPlanDigest,
        },
      );
      id = 0;
      now += 10;
      const secretDispatcher = createClusterPluginPackageApprovedActionDispatcher({
        pool: executor.pool,
        owner: `secret-executor-${suffix}`,
        clock: () => now,
        createId: () => `secret-executor-id-${suffix}-${++id}`,
        secretExistenceInspector: inspector,
      });
      const secretDispatch = await secretDispatcher.dispatchBatch({ limit: 4 });
      assert.equal(secretDispatch.succeeded, 1);
      const bindings = new PostgresPluginPackageSecretBindingRepository(executor.pool);
      const binding = await bindings.find(
        plannedPublic.plan.generationDigest,
      );
      assert.ok(binding);
      assert.equal(binding.authority.kind, 'approved-action-execution');
      assert.equal(
        binding.authority.evidenceDigest,
        plannedPublic.plan.approvalPlanDigest,
      );
      assert.deepEqual(binding.entries, plannedPublic.plan.entries);
      assert.doesNotMatch(JSON.stringify(binding), /secret-value/);
      assert.equal((await secretDispatcher.dispatchBatch({ limit: 4 })).scanned, 0);

      const manifestV2 = Object.freeze({
        ...manifest,
        metadata: Object.freeze({ ...manifest.metadata, version: '2.0.0' }),
      });
      const actionInputV2 = Object.freeze({
        lockId: `lock-v2-${suffix}`,
        projectId,
        manifest: manifestV2,
        previousManifest: manifest,
        plan: planPluginPackageInstall(manifestV2, environment, manifest),
        environment,
        source: {
          kind: 'offline',
          locator: `offline:sha256:${'e'.repeat(64)}`,
          artifactDigest: 'e'.repeat(64),
          artifactBytes: 2048,
          contentDigest: 'f'.repeat(64),
        },
        architecture: 'arm64',
        deploymentProfile: 'cluster-control',
        targetGeneration: 2,
        previousLockDigest: lock.lockDigest,
      });
      const upgradeApprovalId = `upgrade-approval-${suffix}`;
      now += 10;
      const upgradeProposed = await installManagement.propose({
        actionRef: `install:${packageName}:v2`,
        approvalRequestId: upgradeApprovalId,
        proposalAuditEventId: randomUUID(),
        approvalAuditEventId: randomUUID(),
        requestedAtMs: now,
        actionInput: actionInputV2,
        principal: principal(requesterSubject, `upgrade-owner-${suffix}`, now),
      });
      now += 10;
      const upgradeDecision = await installManagement.decide({
        approvalRequestId: upgradeApprovalId,
        expectedVersion: upgradeProposed.approvalRequest.version,
        decisionId: `upgrade-decision-${suffix}`,
        auditEventId: randomUUID(),
        decision: 'approved',
        reasonCode: 'reviewed',
        decidedAtMs: now,
        principal: principal(reviewerSubject, `upgrade-reviewer-${suffix}`, now),
      });
      now += 10;
      const upgradeConsumed = await new PostgresApprovalRequestRepository(
        executor.pool,
      ).consume({
        requestId: upgradeApprovalId,
        expectedVersion: upgradeDecision.request.version,
        consumptionId: `upgrade-consume-${suffix}`,
        dispatchId: `upgrade-dispatch-${suffix}`,
        action: upgradeDecision.request.action,
        requestedBy: requesterSubject,
        consumedBy: { type: 'system', id: 'cluster_package_executor' },
        consumedAtMs: now,
        authorizationFence: fence,
        audit: audit(
          randomUUID(),
          upgradeApprovalId,
          'approval.consume',
          projectId,
          { type: 'system', id: 'cluster_package_executor' },
          now,
          fence,
        ),
      });
      assert.equal(upgradeConsumed.status, 'consumed');
      id = 0;
      now += 10;
      const upgradeDispatch =
        await createClusterPluginPackageApprovedActionDispatcher({
          pool: executor.pool,
          owner: `upgrade-executor-${suffix}`,
          clock: () => now,
          createId: () => `upgrade-executor-id-${suffix}-${++id}`,
          secretExistenceInspector: inspector,
        }).dispatchBatch({ limit: 4 });
      assert.equal(upgradeDispatch.succeeded, 1);
      const queuedV2 = await installs.find(projectId, packageName);
      assert.ok(queuedV2);
      assert.equal(queuedV2.targetGeneration, 2);
      const lockV2 = await installs.findLock(queuedV2.lockDigest);
      assert.ok(lockV2);
      now += 10;
      const stagedV2 = transitionPluginPackageInstall(lockV2, queuedV2, {
        type: 'stage_completed',
        mutationId: `stage-v2-${suffix}`,
        occurredAtMs: now,
        stageRef: `stage:${lockV2.lockDigest}`,
        artifactDigest: lockV2.source.artifactDigest,
        manifestDigest: lockV2.manifestDigest,
        contentDigest: lockV2.source.contentDigest,
        evidenceDigest: '8'.repeat(64),
      });
      const provenanceV2 = createPluginPackagePublisherProvenance({
        projectId,
        packageName,
        installationId: queuedV2.installationId,
        lockDigest: lockV2.lockDigest,
        artifactDigest: stagedV2.stageReceipt.artifactDigest,
        manifestDigest: stagedV2.stageReceipt.manifestDigest,
        contentDigest: stagedV2.stageReceipt.contentDigest,
        stageEvidenceDigest: stagedV2.stageReceipt.evidenceDigest,
        signature: {
          publisher: 'integration.qinglong.dev',
          keyId: 'integration-key-1',
          signatureDigest: '9'.repeat(64),
          keyNotBeforeMs: now - 1,
          keyNotAfterMs: now + 60_000,
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
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16::jsonb
         )`,
        [
          provenanceV2.installationId,
          provenanceV2.projectId,
          provenanceV2.packageName,
          provenanceV2.lockDigest,
          provenanceV2.artifactDigest,
          provenanceV2.manifestDigest,
          provenanceV2.contentDigest,
          provenanceV2.stageEvidenceDigest,
          provenanceV2.publisher,
          provenanceV2.keyId,
          provenanceV2.signatureDigest,
          provenanceV2.keyNotBeforeMs,
          provenanceV2.keyNotAfterMs,
          provenanceV2.verifiedAtMs,
          provenanceV2.provenanceDigest,
          JSON.stringify(provenanceV2),
        ],
      );
      await installs.commit(pluginPackageInstallCommit(queuedV2, stagedV2));

      const secretRefV2 = createSecretRef({
        projectId,
        name: 'runtime-token',
        version: 2,
      });
      writeFileSync(
        join(projectionRoot, secretProjectionFileName(secretRefV2)),
        '',
        { mode: 0o440 },
      );
      const transitionActionRef = `secret-transition:${packageName}:v2`;
      const transitionApprovalId = `secret-transition-approval-${suffix}`;
      const transitionManagement =
        createClusterPluginPackageSecretBindingTransitionManagementService({
          pool: manager.pool,
          now: () => now,
          planLifetimeMs: 60_000,
          approvalLifetimeMs: 60_000,
        });
      const transitionTransport = createClusterPluginPackageManagementTransport({
        service: installManagement,
        secretBindingTransition: transitionManagement,
        now: () => now,
      });
      const transitionPlan = await transitionTransport.execute({
        schemaVersion: 1,
        operation: 'plugin-package.secret-binding.transition.plan',
        request: {
          actionRef: transitionActionRef,
          projectId,
          packageName,
          assignments: [{ name: 'TOKEN', secretRef: secretRefV2 }],
        },
      }, requesterAuthentication);
      assert.equal(transitionPlan.status, 'created');
      assert.equal(transitionPlan.plan.kind, 'rotate');
      assert.equal(transitionPlan.plan.previousGeneration, 1);
      assert.equal(transitionPlan.plan.nextGeneration, 2);
      assert.equal(
        transitionPlan.plan.previousActiveLockDigest,
        lock.lockDigest,
      );
      now = Math.max(now, transitionPlan.plan.plannedAtMs) + 10;
      const transitionProposed = await transitionTransport.execute({
        schemaVersion: 1,
        operation: 'plugin-package.secret-binding.transition.propose',
        request: {
          actionRef: transitionActionRef,
          approvalRequestId: transitionApprovalId,
          approvalAuditEventId: randomUUID(),
        },
      }, requesterAuthentication);
      now += 10;
      const transitionDecision = await transitionTransport.execute({
        schemaVersion: 1,
        operation: 'plugin-package.secret-binding.transition.decide',
        request: {
          actionRef: transitionActionRef,
          approvalRequestId: transitionApprovalId,
          expectedVersion: transitionProposed.approval.version,
          decisionId: `secret-transition-decision-${suffix}`,
          auditEventId: randomUUID(),
          decision: 'approved',
          reasonCode: 'reviewed',
        },
      }, {
        async authenticate() {
          return principal(
            reviewerSubject,
            `secret-transition-reviewer-${suffix}`,
            now,
          );
        },
      });
      assert.equal(transitionDecision.status, 'decided');
      now += 10;
      assert.deepEqual(
        await consumeClusterPluginPackageSecretBindingTransitionApprovals({
          pool: executor.pool,
          now: () => now,
          limit: 4,
        }),
        { scanned: 1, consumed: 1, existing: 0, expired: 0, blocked: 0 },
      );
      const transitionApproval =
        await new PostgresApprovalRequestRepository(executor.pool).findById(
          transitionApprovalId,
        );
      assert.ok(transitionApproval?.dispatchId);
      const transitionExecution =
        await new PostgresApprovedActionExecutionRepository(
          executor.pool,
        ).findExecutionByDispatchId(transitionApproval.dispatchId);
      assert.ok(transitionExecution);
      const storedTransitionPlan =
        await new PostgresPluginPackageSecretBindingTransitionApprovalPlanReader(
          executor.pool,
        ).findByActionRef(transitionActionRef);
      assert.equal(
        storedTransitionPlan?.approvalPlanDigest,
        transitionPlan.plan.approvalPlanDigest,
      );
      id = 0;
      now += 10;
      const transitionDispatch =
        await createClusterPluginPackageApprovedActionDispatcher({
          pool: executor.pool,
          owner: `transition-executor-${suffix}`,
          clock: () => now,
          createId: () => `transition-executor-id-${suffix}-${++id}`,
          secretExistenceInspector: inspector,
        }).dispatchBatch({ limit: 4 });
      assert.equal(transitionDispatch.succeeded, 1);
      const transitionReceipt = await executor.pool.query(
        `SELECT receipt_json AS "receiptJson"
           FROM "ql3"."plugin_package_secret_binding_transition_receipts"
          WHERE generation_digest = $1`,
        [transitionPlan.plan.nextGenerationDigest],
      );
      assert.equal(transitionReceipt.rows.length, 1);
      assert.equal(
        transitionReceipt.rows[0].receiptJson.authority.evidenceDigest,
        transitionPlan.plan.approvalPlanDigest,
      );
      const bindingV2 = await bindings.find(
        transitionPlan.plan.nextGenerationDigest,
      );
      assert.ok(bindingV2);
      assert.deepEqual(bindingV2.entries, [
        { name: 'TOKEN', required: false, secretRef: secretRefV2 },
      ]);
      await assert.rejects(
        manager.pool.query(
          `SELECT * FROM "ql3"."plugin_package_secret_bindings" WHERE generation_digest = $1`,
          [binding.target.generationDigest],
        ),
        (error) => error?.code === '42501',
      );
    } finally {
      await Promise.all([migration.close(), manager.close(), executor.close()]);
      rmSync(projectionRoot, { recursive: true, force: true });
    }
  });
}
