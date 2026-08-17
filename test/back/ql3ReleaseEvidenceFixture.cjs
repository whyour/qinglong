'use strict';

const crypto = require('node:crypto');

const RECEIPT_SCHEMA = 'qinglong/private-release-evidence-receipt@v2';
const FIXTURES = Object.freeze({
  'worker-management': 'qinglong/worker-credential-management-release-gate@v1',
  'cloudnativepg-disaster-recovery':
    'qinglong/cloudnativepg-disaster-recovery@v1',
});
const STATIC_AUDITS = Object.freeze([
  'cloudnativepg-backup',
  'barman-cloud-supply-chain',
  'cert-manager-selection',
]);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function privateReleaseEvidenceReceipt(release, evidenceKind) {
  const staticAudits =
    evidenceKind === 'cloudnativepg-disaster-recovery'
      ? STATIC_AUDITS.map((name, index) => ({
          name,
          auditDigest: `sha256:${String(index + 7).repeat(64)}`,
          compatible: true,
        }))
      : [];
  const unsigned = {
    schemaVersion: 2,
    schema: RECEIPT_SCHEMA,
    release: { ...release },
    evidenceKind,
    evidence: {
      fixture: FIXTURES[evidenceKind],
      observedAt: '2026-08-18T00:00:00.000Z',
      maximumAgeSeconds: 86_400,
      reportDigest: `sha256:${
        evidenceKind === 'worker-management' ? '5' : '6'
      }`.padEnd(71, evidenceKind === 'worker-management' ? '5' : '6'),
      sourceReportsUploaded: false,
    },
    staticAudits,
    verification: {
      sourceAwareAudit: true,
      privateEvidenceReplayed: true,
      freshnessValidatedAtCreation: true,
      durableValidationClockPublished: false,
      publicConsumerReplay: 'not_possible_without_private_reports',
      privateReportContentPublished: false,
      compatible: true,
    },
  };
  return Object.freeze({
    ...unsigned,
    receiptDigest: sha256(JSON.stringify(unsigned)),
  });
}

function privateReleaseEvidenceReceipts(release) {
  return release.scope === 'local'
    ? []
    : [
        privateReleaseEvidenceReceipt(release, 'worker-management'),
        privateReleaseEvidenceReceipt(
          release,
          'cloudnativepg-disaster-recovery',
        ),
      ];
}

module.exports = Object.freeze({
  privateReleaseEvidenceReceipt,
  privateReleaseEvidenceReceipts,
});
