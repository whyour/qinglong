const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  EXPECTED_LIMITATIONS,
  auditPostgresHaEvidence,
} = require('../../scripts/ql3-postgres-ha-evidence-audit.cjs');

function fixture(architecture = 'arm64') {
  const gates = { passed: true };
  for (let index = 0; index < 100; index += 1) gates[`gate${index}`] = true;
  return {
    schemaVersion: 1,
    fixture: 'qinglong/postgresql-ha-contract@v1',
    postgres: {
      image: 'postgres:18',
      imageId: `sha256:${'a'.repeat(64)}`,
      repoDigests: [`postgres@sha256:${'b'.repeat(64)}`],
      architecture,
      version: '18.4',
      versionNumber: 180004,
    },
    replication: {
      mode: 'physical-streaming',
      synchronousCommit: 'remote_apply',
      synchronousStandbyBeforePartition: {
        state: 'streaming',
        syncState: 'sync',
      },
      initialPrimaryTimeline: 1,
      promotedPrimaryTimeline: 2,
      oldPrimaryFenced: true,
      promotedWritable: true,
    },
    controlReplicas: {
      beforePromotion: [{}, {}],
      afterPromotion: [{}, {}],
      oldAvailabilityAfterFailure: [
        { availability: 'unavailable' },
        { availability: 'unavailable' },
      ],
      oldActivationsRecoveredInPlace: false,
      freshActivationsReady: 2,
    },
    durability: { unexpectedDomainSideEffects: 0 },
    transactionWindows: {
      ambiguousCommit: {
        transparentReplayAllowed: false,
        durableRowsAfterPromotion: 1,
      },
      writeBeforeCommit: { durableRowsAfterPromotion: 0 },
    },
    networkPartition: {
      promotionRejectedWhileOldPrimaryWritable: true,
      commitClientObservedFailure: true,
      acknowledgedWriteLost: false,
      replicatedToPromotionCandidate: 0,
      promotedPrimaryRows: 0,
      unacknowledgedLocalCommitDiscarded: true,
    },
    oldPrimaryRejoin: {
      method: 'pg_rewind --write-recovery-conf',
      rewindExitStatus: 0,
      inRecovery: true,
      streaming: true,
      synchronousState: 'sync',
      rejoinedAsWritablePrimary: false,
    },
    timeline: [
      'primary_ready',
      'standby_streaming',
      'synchronous_remote_apply_ready',
      'replication_partition_and_promotion_guard_verified',
      'old_primary_fenced_and_admission_withdrawn',
      'standby_promoted_old_primary_rejoined_endpoint_switched',
      'two_fresh_control_replicas_ready',
    ].map((state, atMs) => ({ state, atMs })),
    gates,
    limitations: [...EXPECTED_LIMITATIONS],
  };
}

test('accepts complete PostgreSQL HA evidence', () => {
  assert.deepEqual(auditPostgresHaEvidence(fixture()), {
    compatible: true,
    findings: [],
  });
  assert.equal(auditPostgresHaEvidence(fixture('amd64')).compatible, true);
});

test('rejects false gates, promotion drift and hidden private material', () => {
  const report = fixture();
  report.gates.oldPrimaryFencedBeforePromotion = false;
  report.replication.promotedPrimaryTimeline = 1;
  report.privateValue = 'postgresql://private-credential';
  const result = auditPostgresHaEvidence(report);
  assert.equal(result.compatible, false);
  assert.ok(result.findings.includes('GATE_FAILED'));
  assert.ok(result.findings.includes('PROMOTION_TIMELINE_INVALID'));
  assert.ok(result.findings.includes('PRIVATE_MATERIAL_PRESENT'));
});

test('rejects reordered timeline and limitations drift', () => {
  const report = fixture();
  report.timeline.reverse();
  report.limitations.pop();
  const result = auditPostgresHaEvidence(report);
  assert.equal(result.compatible, false);
  assert.ok(result.findings.includes('LIMITATIONS_DRIFTED'));
  assert.ok(result.findings.some((finding) => finding.startsWith('TIMELINE_')));
});
