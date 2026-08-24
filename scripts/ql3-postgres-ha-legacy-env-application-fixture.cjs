const assert = require('node:assert/strict');

const {
  PostgresTaskDefinitionRepository,
  PostgresTriggerRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/admin.js');
const {
  PostgresClusterLegacyEnvMigrationPlanRepository,
} = require('../packages/ql3-cluster-postgres/dist/reconciliation/clusterLegacyEnvMigrationPlanRepository.js');
const {
  PostgresClusterLegacyEnvMigrationApplicationRepository,
} = require('../packages/ql3-cluster-postgres/dist/reconciliation/clusterLegacyEnvMigrationApplicationRepository.js');
const {
  createClusterLegacyEnvMigrationTaskMutationSetDigester,
  createClusterLegacyEnvMigrationTriggerMutationSetDigester,
} = require('../packages/ql3-runtime-core/dist/migration/clusterLegacyEnvMigrationApplication.js');
const {
  createSecretRef,
} = require('../packages/ql3-runtime-core/dist/secret/secretReference.js');

const FIXTURE = Object.freeze({
  projectId: 'ha-legacy-env-application',
  taskId: 'ha legacy env task',
  triggerId: 'ha legacy env trigger',
  planId: 'ha-legacy-env-plan',
  planMutationId: '819f7900-0000-4000-8000-000000000001',
  applicationId: 'ha-legacy-env-application-receipt',
  applicationMutationId: '819f7900-0000-4000-8000-000000000002',
  taskCreateMutationId: '819f7900-0000-4000-8000-000000000003',
  triggerCreateMutationId: '819f7900-0000-4000-8000-000000000004',
  taskAdvanceMutationId: '819f7900-0000-4000-8000-000000000005',
  taskApplicationMutationId: '819f7900-0000-4000-8000-000000000006',
  triggerApplicationMutationId: '819f7900-0000-4000-8000-000000000007',
  privateBundleName: 'ha-legacy-env-bundle-private',
});

async function clusterLegacyEnvMigrationApplicationFacts(pool, fixture) {
  const result = await pool.query(
    `SELECT
       receipt.receipt_digest AS "receiptDigest",
       receipt.task_count AS "taskCount",
       receipt.trigger_count AS "triggerCount",
       task_item.revision AS "taskRevision",
       task_item.content_digest AS "taskContentDigest",
       task_item.execution_content_digest AS "executionContentDigest",
       trigger_item.revision AS "triggerRevision",
       trigger_item.content_digest AS "triggerContentDigest",
       trigger_item.task_revision AS "triggerTaskRevision",
       trigger_item.task_content_digest AS "triggerTaskContentDigest",
       schedule.trigger_revision AS "scheduleRevision",
       schedule.state_version AS "scheduleStateVersion",
       schedule.claim_version AS "scheduleClaimVersion",
       (SELECT count(*)::integer
          FROM "ql3"."cluster_legacy_env_migration_plans" AS plan
         WHERE plan.plan_id = receipt.plan_id) AS "planRows",
       (SELECT count(*)::integer
          FROM "ql3"."cluster_legacy_env_migration_application_receipts" AS stored
         WHERE stored.application_id = receipt.application_id) AS "receiptRows",
       (SELECT count(*)::integer
          FROM "ql3"."cluster_legacy_env_migration_application_tasks" AS item
         WHERE item.application_id = receipt.application_id) AS "taskItemRows",
       (SELECT count(*)::integer
          FROM "ql3"."cluster_legacy_env_migration_application_triggers" AS item
         WHERE item.application_id = receipt.application_id) AS "triggerItemRows"
     FROM "ql3"."cluster_legacy_env_migration_application_receipts" AS receipt
     JOIN "ql3"."cluster_legacy_env_migration_application_tasks" AS task_item
       ON task_item.application_id = receipt.application_id
      AND task_item.ordinal = 0
     JOIN "ql3"."cluster_legacy_env_migration_application_triggers" AS trigger_item
       ON trigger_item.application_id = receipt.application_id
      AND trigger_item.ordinal = 0
     JOIN "ql3"."trigger_schedules" AS schedule
       ON schedule.project_id = trigger_item.project_id
      AND schedule.trigger_id = trigger_item.trigger_id
    WHERE receipt.application_id = $1`,
    [fixture.applicationId],
  );
  assert.equal(result.rowCount, 1);
  return Object.freeze({ ...result.rows[0] });
}

function assertExpectedFacts(facts) {
  assert.equal(facts.planRows, 1);
  assert.equal(facts.receiptRows, 1);
  assert.equal(facts.taskItemRows, 1);
  assert.equal(facts.triggerItemRows, 1);
  assert.equal(facts.taskCount, 1);
  assert.equal(facts.triggerCount, 1);
  assert.equal(facts.taskRevision, 3);
  assert.equal(facts.triggerRevision, 2);
  assert.equal(facts.triggerTaskRevision, 3);
  assert.equal(facts.scheduleRevision, 2);
  assert.equal(facts.scheduleStateVersion, 1);
  assert.equal(facts.scheduleClaimVersion, 1);
  for (const digest of [
    facts.receiptDigest,
    facts.taskContentDigest,
    facts.executionContentDigest,
    facts.triggerContentDigest,
    facts.triggerTaskContentDigest,
  ]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
}

async function persistClusterLegacyEnvMigrationApplicationBeforePromotion(
  options,
) {
  const { migrationPool, automationPool } = options;
  const observed = await migrationPool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            AS "observedAtMs"`,
  );
  const occurredAtMs = Number(observed.rows[0].observedAtMs) - 1_000;
  await migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, 'HA Legacy Env application', $1, 'active', 1, $2, $2)`,
    [FIXTURE.projectId, occurredAtMs],
  );

  const tasks = new PostgresTaskDefinitionRepository(migrationPool);
  const triggers = new PostgresTriggerRepository(migrationPool);
  const initialTask = (
    await tasks.appendTaskDefinitionRevision({
      projectId: FIXTURE.projectId,
      taskId: FIXTURE.taskId,
      expectedRevision: null,
      mutationId: FIXTURE.taskCreateMutationId,
      name: 'HA Legacy Env command',
      description: 'promotion replay fixture',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: {
          command: { kind: 'argv', file: '/bin/echo', args: ['ha'] },
          timeoutMs: 30_000,
        },
      },
      labels: { 'qinglong.io/source': 'ha-contract' },
      enabled: true,
      occurredAtMs,
    })
  ).definition;
  const initialTrigger = (
    await triggers.appendTriggerRevision({
      projectId: FIXTURE.projectId,
      triggerId: FIXTURE.triggerId,
      expectedRevision: null,
      mutationId: FIXTURE.triggerCreateMutationId,
      taskId: FIXTURE.taskId,
      taskRevision: initialTask.revision,
      taskContentDigest: initialTask.contentDigest,
      spec: {
        schema: 'qinglong/cron@v1',
        config: {
          expression: '* * * * *',
          timezone: 'UTC',
          misfirePolicy: 'skip',
        },
      },
      enabled: false,
      occurredAtMs: occurredAtMs + 1,
    })
  ).trigger;
  const currentTask = (
    await tasks.appendTaskDefinitionRevision({
      projectId: FIXTURE.projectId,
      taskId: FIXTURE.taskId,
      expectedRevision: initialTask.revision,
      mutationId: FIXTURE.taskAdvanceMutationId,
      name: initialTask.name,
      description: initialTask.description,
      kind: initialTask.kind,
      spec: initialTask.spec,
      labels: initialTask.labels,
      enabled: initialTask.enabled,
      occurredAtMs: occurredAtMs + 2,
    })
  ).definition;

  const taskMutations = Object.freeze([
    Object.freeze({
      ordinal: 0,
      taskId: FIXTURE.taskId,
      previousRevision: currentTask.revision,
      previousContentDigest: currentTask.contentDigest,
      mutationId: FIXTURE.taskApplicationMutationId,
    }),
  ]);
  const triggerMutations = Object.freeze([
    Object.freeze({
      ordinal: 0,
      triggerId: FIXTURE.triggerId,
      taskId: FIXTURE.taskId,
      previousRevision: initialTrigger.revision,
      previousContentDigest: initialTrigger.contentDigest,
      previousTaskRevision: initialTask.revision,
      previousTaskContentDigest: initialTask.contentDigest,
      mutationId: FIXTURE.triggerApplicationMutationId,
    }),
  ]);
  const taskDigester = createClusterLegacyEnvMigrationTaskMutationSetDigester();
  taskDigester.update(taskMutations[0]);
  const taskSet = taskDigester.finish();
  const triggerDigester =
    createClusterLegacyEnvMigrationTriggerMutationSetDigester();
  triggerDigester.update(triggerMutations[0]);
  const triggerSet = triggerDigester.finish();
  const secretRef = createSecretRef({
    projectId: FIXTURE.projectId,
    name: FIXTURE.privateBundleName,
    version: 1,
  });
  const plan = (
    await new PostgresClusterLegacyEnvMigrationPlanRepository(
      automationPool,
    ).publish({
      planId: FIXTURE.planId,
      mutationId: FIXTURE.planMutationId,
      projectId: FIXTURE.projectId,
      source: {
        reconciliationBundleDigest: '1'.repeat(64),
        decisionDigest: '2'.repeat(64),
        candidateSetDigest: '3'.repeat(64),
        sourceRowCount: 1,
        activeRowCount: 1,
        disabledRowCount: 0,
        effectiveBindingCount: 1,
      },
      target: {
        secretRef,
        taskRevisionSetDigest: taskSet.revisionSetDigest,
        triggerRevisionSetDigest: triggerSet.revisionSetDigest,
        taskCount: taskSet.count,
        triggerCount: triggerSet.count,
        totalEffectiveBytes: 128,
      },
    })
  ).plan;
  const intent = Object.freeze({
    applicationId: FIXTURE.applicationId,
    mutationId: FIXTURE.applicationMutationId,
    projectId: FIXTURE.projectId,
    planId: FIXTURE.planId,
    planDigest: plan.planDigest,
    taskMutationSetDigest: taskSet.mutationSetDigest,
    triggerMutationSetDigest: triggerSet.mutationSetDigest,
  });
  let taskStreamOpenCount = 0;
  let triggerStreamOpenCount = 0;
  const applications =
    new PostgresClusterLegacyEnvMigrationApplicationRepository(automationPool);
  const applied = await applications.apply(intent, {
    taskMutations() {
      taskStreamOpenCount += 1;
      return taskMutations;
    },
    triggerMutations() {
      triggerStreamOpenCount += 1;
      return triggerMutations;
    },
  });
  assert.equal(applied.status, 'applied');
  assert.equal(taskStreamOpenCount, 1);
  assert.equal(triggerStreamOpenCount, 1);
  const primaryBeforePromotion =
    await clusterLegacyEnvMigrationApplicationFacts(migrationPool, FIXTURE);
  assertExpectedFacts(primaryBeforePromotion);
  return {
    fixture: Object.freeze({
      ...FIXTURE,
      intent,
      receipt: applied.receipt,
    }),
    report: {
      primaryBeforePromotion,
      standbyBeforePromotion: null,
      promotedAfterReplay: null,
      replicatedBeforePromotion: false,
      exactReplayAfterPromotion: false,
      replayStatus: null,
      mutationStreamsOpenedAfterPromotion: null,
      durableRowsAddedByReplay: null,
      contentFree: true,
    },
  };
}

async function verifyPromotedClusterLegacyEnvMigrationApplication(options) {
  const { automationPool, promotedPool, evidence } = options;
  let mutationStreamsOpened = 0;
  const applications =
    new PostgresClusterLegacyEnvMigrationApplicationRepository(automationPool);
  const beforeReplay = await clusterLegacyEnvMigrationApplicationFacts(
    promotedPool,
    evidence.fixture,
  );
  assert.deepEqual(beforeReplay, evidence.report.primaryBeforePromotion);
  const replay = await applications.apply(evidence.fixture.intent, {
    taskMutations() {
      mutationStreamsOpened += 1;
      throw new Error('exact replay must not reopen Task mutations');
    },
    triggerMutations() {
      mutationStreamsOpened += 1;
      throw new Error('exact replay must not reopen Trigger mutations');
    },
  });
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.receipt, evidence.fixture.receipt);
  const promotedAfterReplay = await clusterLegacyEnvMigrationApplicationFacts(
    promotedPool,
    evidence.fixture,
  );
  assertExpectedFacts(promotedAfterReplay);
  assert.deepEqual(promotedAfterReplay, beforeReplay);
  evidence.report.promotedAfterReplay = promotedAfterReplay;
  evidence.report.exactReplayAfterPromotion = true;
  evidence.report.replayStatus = replay.status;
  evidence.report.mutationStreamsOpenedAfterPromotion = mutationStreamsOpened;
  evidence.report.durableRowsAddedByReplay =
    promotedAfterReplay.receiptRows - beforeReplay.receiptRows;
  return evidence.report;
}

module.exports = {
  clusterLegacyEnvMigrationApplicationFacts,
  persistClusterLegacyEnvMigrationApplicationBeforePromotion,
  verifyPromotedClusterLegacyEnvMigrationApplication,
};
