'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCloudNativePgReceipt,
  createWorkerReceipt,
  inspectPrivateReleaseEvidenceReceipt,
  parseArguments,
  runCli,
} = require('../../scripts/ql3-private-release-evidence-receipt-contract.cjs');
const {
  privateReleaseEvidenceReceipt,
  privateReleaseEvidenceReceipts,
} = require('./ql3ReleaseEvidenceFixture.cjs');

const RELEASE = Object.freeze({
  version: '3.0.0-alpha.0',
  sourceRevision: 'a'.repeat(40),
  sourceRef: 'refs/tags/v3.0.0-alpha.0',
  scope: 'cluster',
});

function options(evidenceKind) {
  return Object.freeze({
    version: RELEASE.version,
    sourceRevision: RELEASE.sourceRevision,
    sourceRef: RELEASE.sourceRef,
    releaseScope: RELEASE.scope,
    evidenceKind,
  });
}

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-private-release-receipt-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('accepts only the exact Worker and disaster-recovery receipt projections', () => {
  const receipts = privateReleaseEvidenceReceipts(RELEASE);
  assert.deepEqual(
    receipts.map((receipt) => receipt.evidenceKind),
    ['worker-management', 'cloudnativepg-disaster-recovery'],
  );
  for (const receipt of receipts) {
    const result = inspectPrivateReleaseEvidenceReceipt(
      receipt,
      options(receipt.evidenceKind),
    );
    assert.equal(result.compatible, true);
    assert.equal(result.receiptDigest, receipt.receiptDigest);
    assert.equal(
      result.publicConsumerReplay,
      'not_possible_without_private_reports',
    );
    assert.equal(JSON.stringify(receipt).includes('/run/qinglong3'), false);
    assert.equal(JSON.stringify(receipt).includes('token'), false);
  }
});

test('rejects source, scope, freshness, digest and static-lock drift', () => {
  const mutations = [
    (receipt) => {
      receipt.release.sourceRevision = 'b'.repeat(40);
    },
    (receipt) => {
      receipt.release.scope = 'all';
    },
    (receipt) => {
      receipt.evidence.observedAt = '2026-08-16T00:00:00.000Z';
    },
    (receipt) => {
      receipt.evidence.reportDigest = `sha256:${'0'.repeat(64)}`;
    },
    (receipt) => {
      receipt.staticAudits.pop();
    },
  ];
  for (const mutate of mutations) {
    const receipt = JSON.parse(
      JSON.stringify(
        privateReleaseEvidenceReceipt(
          RELEASE,
          'cloudnativepg-disaster-recovery',
        ),
      ),
    );
    mutate(receipt);
    assert.throws(
      () =>
        inspectPrivateReleaseEvidenceReceipt(
          receipt,
          options('cloudnativepg-disaster-recovery'),
        ),
      /receipt|freshness/,
    );
  }
});

test('rejects publishing private material in an otherwise re-digested receipt', () => {
  const receipt = JSON.parse(
    JSON.stringify(privateReleaseEvidenceReceipt(RELEASE, 'worker-management')),
  );
  receipt.evidence.privateReport = { credential: 'must-not-publish' };
  assert.throws(
    () =>
      inspectPrivateReleaseEvidenceReceipt(
        receipt,
        options('worker-management'),
      ),
    /receipt shape/,
  );
});

test('audit CLI accepts a canonical receipt and rejects open argument shapes', (t) => {
  const directory = temporaryDirectory(t);
  const receiptPath = path.join(directory, 'worker-management.json');
  const receipt = privateReleaseEvidenceReceipt(RELEASE, 'worker-management');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
    mode: 0o600,
  });
  const args = [
    '--mode=audit',
    `--version=${RELEASE.version}`,
    `--source-revision=${RELEASE.sourceRevision}`,
    `--source-ref=${RELEASE.sourceRef}`,
    `--release-scope=${RELEASE.scope}`,
    '--evidence-kind=worker-management',
    `--receipt=${receiptPath}`,
  ];
  const writes = [];
  assert.equal(
    runCli(args, path.resolve(__dirname, '../..'), {
      write(value) {
        writes.push(value);
      },
    }).compatible,
    true,
  );
  assert.equal(
    JSON.parse(writes.join('')).receiptDigest,
    receipt.receiptDigest,
  );
  assert.throws(
    () => parseArguments([...args, '--extra=true']),
    /arguments are invalid/,
  );
  assert.throws(
    () =>
      runCli(
        args.map((entry) =>
          entry === `--release-scope=${RELEASE.scope}`
            ? '--release-scope=local'
            : entry,
        ),
        path.resolve(__dirname, '../..'),
        { write() {} },
      ),
    /Cluster-capable/,
  );
});

test('create wrappers publish only no-replace digest projections after their source-aware gates', (t) => {
  const directory = temporaryDirectory(t);
  const reportPath = path.join(directory, 'private-report.json');
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ observedAt: '2026-08-18T00:00:00.000Z' })}\n`,
    { mode: 0o600 },
  );
  const common = {
    root: path.resolve(__dirname, '../..'),
    version: RELEASE.version,
    sourceRevision: RELEASE.sourceRevision,
    sourceRef: RELEASE.sourceRef,
    releaseScope: RELEASE.scope,
    reportFile: reportPath,
  };
  const now = () => Date.parse('2026-08-18T00:05:00.000Z');
  const workerPath = path.join(directory, 'worker.json');
  const worker = createWorkerReceipt(
    {
      ...common,
      ceremonyReportFile: path.join(directory, 'private-ceremony.json'),
      durableAuditReportFile: path.join(directory, 'private-durable.json'),
      pkiRotationReportFile: path.join(directory, 'private-pki.json'),
      caRolloverReportFile: path.join(directory, 'private-ca.json'),
      outputFile: workerPath,
    },
    {
      now,
      auditGate(options) {
        assert.equal(options.sourceCommit, RELEASE.sourceRevision);
        return {
          fixture: 'qinglong/worker-credential-management-release-gate@v1',
          evidenceReportSha256: `sha256:${'5'.repeat(64)}`,
        };
      },
    },
  );
  assert.equal(worker.staticAudits.length, 0);
  assert.equal(fs.statSync(workerPath).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(worker).includes('private-report'), false);

  const drPath = path.join(directory, 'dr.json');
  const dr = createCloudNativePgReceipt(
    { ...common, outputFile: drPath },
    {
      now,
      validateEvidence(_report, options) {
        assert.equal(options.sourceCommit, RELEASE.sourceRevision);
        return {
          fixture: 'qinglong/cloudnativepg-disaster-recovery@v1',
          compatible: true,
        };
      },
    },
  );
  assert.deepEqual(
    dr.staticAudits.map((entry) => entry.name),
    [
      'cloudnativepg-backup',
      'barman-cloud-supply-chain',
      'cert-manager-selection',
    ],
  );
  assert.equal(fs.statSync(drPath).mode & 0o777, 0o600);
  assert.throws(
    () =>
      createCloudNativePgReceipt(
        { ...common, outputFile: drPath },
        {
          now,
          validateEvidence() {
            return {
              fixture: 'qinglong/cloudnativepg-disaster-recovery@v1',
              compatible: true,
            };
          },
        },
      ),
    /output must not already exist/,
  );
  fs.chmodSync(reportPath, 0o640);
  assert.throws(
    () =>
      createWorkerReceipt(
        {
          ...common,
          ceremonyReportFile: path.join(directory, 'private-ceremony.json'),
          durableAuditReportFile: path.join(directory, 'private-durable.json'),
          pkiRotationReportFile: path.join(directory, 'private-pki.json'),
          caRolloverReportFile: path.join(directory, 'private-ca.json'),
          outputFile: path.join(directory, 'untrusted-worker.json'),
        },
        {
          now,
          auditGate() {
            return {
              fixture: 'qinglong/worker-credential-management-release-gate@v1',
              evidenceReportSha256: `sha256:${'5'.repeat(64)}`,
            };
          },
        },
      ),
    /bounded canonical regular file/,
  );
});
