#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = 'qinglong/postgresql-ha-contract@v1';
const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const EXPECTED_LIMITATIONS = Object.freeze([
  'test-only TCP endpoint is not a production operator or proxy',
  'Docker replication-link partition plus a test-only promotion guard is not production operator or infrastructure STONITH evidence',
  'single-standby remote_apply prioritizes acknowledged-write durability and blocks mutation availability until synchronous redundancy is restored',
  'domain COMMIT-response-loss faults are injected at the PostgresClient boundary, not by dropping raw PostgreSQL protocol packets',
]);
const REQUIRED_TIMELINE_STATES = Object.freeze([
  'primary_ready',
  'standby_streaming',
  'synchronous_remote_apply_ready',
  'cluster_legacy_env_application_replicated',
  'replication_partition_and_promotion_guard_verified',
  'old_primary_fenced_and_admission_withdrawn',
  'cluster_legacy_env_application_replayed_after_promotion',
  'standby_promoted_old_primary_rejoined_endpoint_switched',
  'two_fresh_control_replicas_ready',
]);
const LEGACY_ENV_APPLICATION_FACT_KEYS = Object.freeze(
  [
    'executionContentDigest',
    'planRows',
    'receiptDigest',
    'receiptRows',
    'scheduleClaimVersion',
    'scheduleRevision',
    'scheduleStateVersion',
    'taskContentDigest',
    'taskCount',
    'taskItemRows',
    'taskRevision',
    'triggerContentDigest',
    'triggerCount',
    'triggerItemRows',
    'triggerRevision',
    'triggerTaskContentDigest',
    'triggerTaskRevision',
  ].sort(),
);
const LEGACY_ENV_APPLICATION_KEYS = Object.freeze(
  [
    'contentFree',
    'durableRowsAddedByReplay',
    'exactReplayAfterPromotion',
    'mutationStreamsOpenedAfterPromotion',
    'primaryBeforePromotion',
    'promotedAfterReplay',
    'replayStatus',
    'replicatedBeforePromotion',
    'standbyBeforePromotion',
  ].sort(),
);
const FORBIDDEN_MATERIAL = Object.freeze([
  'postgresql://',
  'ql3_migration_test',
  'ql3_runtime_test',
  'ql3_ai_maintenance_test',
  'ql3_ai_credential_manager_test',
  'ql3_ai_credential_tester_test',
  'ql3_admin_test',
  'ql3_automation_manager_test',
  'ql3_approval_manager_test',
  'ql3_package_manager_test',
  'ql3_package_executor_test',
  'ql3_worker_credential_manager_test',
  'ql3_worker_credential_executor_test',
  'ql3_worker_ingress_test',
  'ql3w_',
  'qlsecret:v1:',
  'ha-legacy-env-bundle-private',
]);

function isObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function reportPath(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (
    args.length !== 1 ||
    !args[0].startsWith('--report=') ||
    !path.isAbsolute(args[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-postgres-ha-evidence-audit --report=/absolute/private-report.json',
    );
  }
  const filePath = args[0].slice('--report='.length);
  if (
    path.normalize(filePath) !== filePath ||
    path.parse(filePath).root === filePath
  ) {
    throw new Error('PostgreSQL HA report path must be normalized');
  }
  return filePath;
}

function readPrivateReport(filePath) {
  const stat = fs.lstatSync(filePath);
  const uid = process.geteuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(filePath) !== filePath ||
    (stat.uid !== 0 && stat.uid !== uid) ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size < 2 ||
    stat.size > 4 * 1024 * 1024
  ) {
    throw new Error(
      'PostgreSQL HA report must be a canonical private regular file',
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function auditPostgresHaEvidence(report) {
  const findings = [];
  const add = (condition, code) => {
    if (!condition) findings.push(code);
  };
  add(isObject(report), 'REPORT_SHAPE_INVALID');
  if (!isObject(report)) return Object.freeze({ compatible: false, findings });

  add(report.schemaVersion === 1, 'SCHEMA_VERSION_INVALID');
  add(report.fixture === FIXTURE, 'FIXTURE_INVALID');
  const postgres = report.postgres;
  add(isObject(postgres), 'POSTGRES_EVIDENCE_MISSING');
  if (isObject(postgres)) {
    add(
      typeof postgres.image === 'string' &&
        /^postgres:18(?:[.@][A-Za-z0-9_:+./-]+)?$/.test(postgres.image),
      'POSTGRES_IMAGE_INVALID',
    );
    add(
      typeof postgres.imageId === 'string' &&
        SHA256_PATTERN.test(postgres.imageId),
      'POSTGRES_IMAGE_ID_INVALID',
    );
    add(
      Array.isArray(postgres.repoDigests) && postgres.repoDigests.length > 0,
      'POSTGRES_REPO_DIGESTS_MISSING',
    );
    add(
      postgres.architecture === 'amd64' || postgres.architecture === 'arm64',
      'POSTGRES_ARCHITECTURE_INVALID',
    );
    add(
      Number.isSafeInteger(postgres.versionNumber) &&
        postgres.versionNumber >= 180000 &&
        postgres.versionNumber < 190000,
      'POSTGRES_VERSION_INVALID',
    );
  }

  const replication = report.replication;
  add(isObject(replication), 'REPLICATION_EVIDENCE_MISSING');
  if (isObject(replication)) {
    add(replication.mode === 'physical-streaming', 'REPLICATION_MODE_INVALID');
    add(
      replication.synchronousCommit === 'remote_apply',
      'SYNCHRONOUS_COMMIT_INVALID',
    );
    add(
      replication.synchronousStandbyBeforePartition?.state === 'streaming',
      'SYNCHRONOUS_STANDBY_NOT_STREAMING',
    );
    add(
      replication.synchronousStandbyBeforePartition?.syncState === 'sync',
      'SYNCHRONOUS_STANDBY_NOT_SYNC',
    );
    add(
      Number.isSafeInteger(replication.initialPrimaryTimeline) &&
        replication.initialPrimaryTimeline >= 1,
      'INITIAL_TIMELINE_INVALID',
    );
    add(
      Number.isSafeInteger(replication.promotedPrimaryTimeline) &&
        replication.promotedPrimaryTimeline >
          replication.initialPrimaryTimeline,
      'PROMOTION_TIMELINE_INVALID',
    );
    add(replication.oldPrimaryFenced === true, 'OLD_PRIMARY_NOT_FENCED');
    add(replication.promotedWritable === true, 'PROMOTED_PRIMARY_NOT_WRITABLE');
  }

  const controls = report.controlReplicas;
  add(isObject(controls), 'CONTROL_REPLICA_EVIDENCE_MISSING');
  if (isObject(controls)) {
    add(
      Array.isArray(controls.beforePromotion) &&
        controls.beforePromotion.length === 2,
      'OLD_CONTROL_REPLICA_COUNT_INVALID',
    );
    add(
      Array.isArray(controls.afterPromotion) &&
        controls.afterPromotion.length === 2,
      'FRESH_CONTROL_REPLICA_COUNT_INVALID',
    );
    add(
      Array.isArray(controls.oldAvailabilityAfterFailure) &&
        controls.oldAvailabilityAfterFailure.length === 2 &&
        controls.oldAvailabilityAfterFailure.every(
          (entry) => entry?.availability === 'unavailable',
        ),
      'OLD_CONTROL_REPLICAS_NOT_FENCED',
    );
    add(
      controls.oldActivationsRecoveredInPlace === false,
      'OLD_ACTIVATION_RECOVERED_IN_PLACE',
    );
    add(controls.freshActivationsReady === 2, 'FRESH_ACTIVATIONS_NOT_READY');
  }

  const partition = report.networkPartition;
  add(isObject(partition), 'PARTITION_EVIDENCE_MISSING');
  if (isObject(partition)) {
    add(
      partition.promotionRejectedWhileOldPrimaryWritable === true,
      'PROMOTION_GUARD_NOT_PROVEN',
    );
    add(
      partition.commitClientObservedFailure === true,
      'PARTITIONED_COMMIT_WAS_NOT_REJECTED',
    );
    add(partition.acknowledgedWriteLost === false, 'ACKNOWLEDGED_WRITE_LOSS');
    add(
      partition.replicatedToPromotionCandidate === 0 &&
        partition.promotedPrimaryRows === 0,
      'PARTITIONED_WRITE_REACHED_PROMOTED_PRIMARY',
    );
    add(
      partition.unacknowledgedLocalCommitDiscarded === true,
      'UNACKNOWLEDGED_WRITE_NOT_DISCARDED',
    );
  }

  const rejoin = report.oldPrimaryRejoin;
  add(isObject(rejoin), 'OLD_PRIMARY_REJOIN_EVIDENCE_MISSING');
  if (isObject(rejoin)) {
    add(
      rejoin.method === 'pg_rewind --write-recovery-conf',
      'REJOIN_METHOD_INVALID',
    );
    add(
      rejoin.rewindExitStatus === 0 && rejoin.inRecovery === true,
      'OLD_PRIMARY_NOT_REWOUND',
    );
    add(
      rejoin.streaming === true && rejoin.synchronousState === 'sync',
      'REJOIN_NOT_SYNCHRONOUS',
    );
    add(
      rejoin.rejoinedAsWritablePrimary === false,
      'REJOINED_PRIMARY_WRITABLE',
    );
  }

  add(
    report.durability?.unexpectedDomainSideEffects === 0,
    'UNEXPECTED_DOMAIN_SIDE_EFFECTS',
  );
  add(
    report.transactionWindows?.ambiguousCommit?.transparentReplayAllowed ===
      false,
    'AMBIGUOUS_COMMIT_TRANSPARENT_REPLAY_ALLOWED',
  );
  add(
    report.transactionWindows?.ambiguousCommit?.durableRowsAfterPromotion === 1,
    'AMBIGUOUS_COMMIT_NOT_DURABLE',
  );
  add(
    report.transactionWindows?.writeBeforeCommit?.durableRowsAfterPromotion ===
      0,
    'UNCOMMITTED_WRITE_SURVIVED',
  );

  const legacyEnvApplication = report.clusterLegacyEnvMigrationApplication;
  add(
    isObject(legacyEnvApplication),
    'CLUSTER_LEGACY_ENV_APPLICATION_EVIDENCE_MISSING',
  );
  if (isObject(legacyEnvApplication)) {
    add(
      JSON.stringify(Object.keys(legacyEnvApplication).sort()) ===
        JSON.stringify(LEGACY_ENV_APPLICATION_KEYS),
      'CLUSTER_LEGACY_ENV_APPLICATION_EVIDENCE_WIDENED',
    );
    add(
      legacyEnvApplication.replicatedBeforePromotion === true,
      'CLUSTER_LEGACY_ENV_APPLICATION_NOT_REPLICATED',
    );
    add(
      legacyEnvApplication.exactReplayAfterPromotion === true &&
        legacyEnvApplication.replayStatus === 'existing',
      'CLUSTER_LEGACY_ENV_APPLICATION_REPLAY_INVALID',
    );
    add(
      legacyEnvApplication.mutationStreamsOpenedAfterPromotion === 0 &&
        legacyEnvApplication.durableRowsAddedByReplay === 0,
      'CLUSTER_LEGACY_ENV_APPLICATION_REPLAY_SIDE_EFFECT',
    );
    add(
      legacyEnvApplication.contentFree === true,
      'CLUSTER_LEGACY_ENV_APPLICATION_EVIDENCE_NOT_CONTENT_FREE',
    );
    const factSets = [
      legacyEnvApplication.primaryBeforePromotion,
      legacyEnvApplication.standbyBeforePromotion,
      legacyEnvApplication.promotedAfterReplay,
    ];
    for (const facts of factSets) {
      add(isObject(facts), 'CLUSTER_LEGACY_ENV_APPLICATION_FACTS_INVALID');
      if (!isObject(facts)) continue;
      add(
        JSON.stringify(Object.keys(facts).sort()) ===
          JSON.stringify(LEGACY_ENV_APPLICATION_FACT_KEYS),
        'CLUSTER_LEGACY_ENV_APPLICATION_FACTS_WIDENED',
      );
      add(
        facts.planRows === 1 &&
          facts.receiptRows === 1 &&
          facts.taskItemRows === 1 &&
          facts.triggerItemRows === 1 &&
          facts.taskCount === 1 &&
          facts.triggerCount === 1 &&
          facts.taskRevision === 3 &&
          facts.triggerRevision === 2 &&
          facts.triggerTaskRevision === 3 &&
          facts.scheduleRevision === 2 &&
          facts.scheduleStateVersion === 1 &&
          facts.scheduleClaimVersion === 1,
        'CLUSTER_LEGACY_ENV_APPLICATION_FACTS_DRIFTED',
      );
      for (const key of [
        'receiptDigest',
        'taskContentDigest',
        'executionContentDigest',
        'triggerContentDigest',
        'triggerTaskContentDigest',
      ]) {
        add(
          typeof facts[key] === 'string' && SHA256_PATTERN.test(facts[key]),
          'CLUSTER_LEGACY_ENV_APPLICATION_DIGEST_INVALID',
        );
      }
    }
    add(
      factSets.every(
        (facts) =>
          isObject(facts) &&
          JSON.stringify(facts) === JSON.stringify(factSets[0]),
      ),
      'CLUSTER_LEGACY_ENV_APPLICATION_FACTS_NOT_EXACT',
    );
  }

  const gates = report.gates;
  add(isObject(gates), 'GATES_MISSING');
  if (isObject(gates)) {
    const values = Object.values(gates);
    add(values.length >= 100, 'GATE_SET_TOO_SMALL');
    add(
      values.length > 0 && values.every((value) => value === true),
      'GATE_FAILED',
    );
    add(gates.passed === true, 'FINAL_GATE_FAILED');
  }

  add(
    Array.isArray(report.limitations) &&
      JSON.stringify(report.limitations) ===
        JSON.stringify(EXPECTED_LIMITATIONS),
    'LIMITATIONS_DRIFTED',
  );
  const timeline = Array.isArray(report.timeline) ? report.timeline : [];
  add(timeline.length > 0, 'TIMELINE_MISSING');
  let lastIndex = -1;
  for (const state of REQUIRED_TIMELINE_STATES) {
    const index = timeline.findIndex((entry) => entry?.state === state);
    add(
      index > lastIndex,
      `TIMELINE_${state.toUpperCase()}_MISSING_OR_OUT_OF_ORDER`,
    );
    if (index >= 0) lastIndex = index;
  }

  const serialized = JSON.stringify(report);
  for (const forbidden of FORBIDDEN_MATERIAL) {
    add(!serialized.includes(forbidden), 'PRIVATE_MATERIAL_PRESENT');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function main(argv = process.argv.slice(2)) {
  const filePath = reportPath(argv);
  const result = auditPostgresHaEvidence(readPrivateReport(filePath));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `ql3 PostgreSQL HA evidence audit failed: ${error.stack || error}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_LIMITATIONS, auditPostgresHaEvidence };
