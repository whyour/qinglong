'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

const {
  ClusterConsoleEvidenceBundleError,
  createClusterConsoleEvidenceBundle,
  limits,
  measureClusterConsoleEvidenceRecord,
  schema,
  serializeClusterConsoleEvidenceBundle,
  verifyClusterConsoleEvidenceBundle,
} = require('../assets/copilot-console/evidence-bundle.js');

const requestSchema = 'qinglong/cluster-copilot-console-read-request@v1';

function runRecord(overrides = {}) {
  return {
    operation: 'run_read',
    observedAtMs: 1_700_000_000_000,
    request: {
      schema: requestSchema,
      operation: 'run_read',
      projectId: 'project-customer-production',
      requestId: 'console-request-sensitive',
      runId: 'run-customer-production',
    },
    fact: {
      schema: 'qinglong/bounded-run-projection@v1',
      schemaVersion: 1,
      status: 'succeeded',
      projectId: 'project-customer-production',
      runId: 'run-customer-production',
      createdAtMs: 1_700_000_000_000,
      finalizedAtMs: 1_700_000_001_000,
      outputAvailable: true,
      name: 'customer-production-nightly',
      message: 'ql3c_console_do_not_export',
      path: '/private/customer/run.log',
      unknownField: '<img src=x onerror=alert(1)>',
    },
    ...overrides,
  };
}

function outputRecord() {
  return {
    operation: 'output',
    observedAtMs: 1_700_000_002_000,
    request: {
      schema: requestSchema,
      operation: 'output',
      projectId: 'project-customer-production',
      requestId: 'diagnosis-request-sensitive',
      sourceRunId: 'run-customer-production',
    },
    fact: {
      schema:
        'qinglong/cluster-copilot-failure-diagnosis-output-read-response@v1',
      schemaVersion: 1,
      status: 'available',
      projectId: 'project-customer-production',
      sourceRunId: 'run-customer-production',
      diagnosisRunId: 'diagnosis-run-sensitive',
      reference: {
        artifactId: 'artifact-sensitive',
        artifactDigest: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        outputBytes: 71,
        sealedAtMs: 1_700_000_001_000,
      },
      result: {
        text: '<script>steal(credential)</script>',
        command: 'curl https://attacker.invalid',
        token: 'ql3c_console_do_not_export',
        finishReason: 'stop',
      },
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        costMicros: 42,
      },
    },
  };
}

test('creates one self-verifiable redacted bundle with per-bundle correlated aliases', async () => {
  const records = [runRecord(), outputRecord()];
  assert.ok(measureClusterConsoleEvidenceRecord(records[0]) > 1);

  const bundle = await createClusterConsoleEvidenceBundle(
    records,
    1_700_000_003_000,
    webcrypto,
  );
  const encoded = serializeClusterConsoleEvidenceBundle(bundle);
  const parsed = JSON.parse(encoded);

  assert.equal(bundle.schema, schema);
  assert.equal(bundle.generatedBy, 'browser_local');
  assert.equal(bundle.actionAuthority, 'none');
  assert.equal(bundle.attestation, 'none');
  assert.equal(bundle.source.entryCount, 2);
  assert.equal(bundle.redaction.freeTextIncluded, false);
  assert.equal(bundle.redaction.copilotOutputIncluded, false);
  assert.equal(bundle.entries[0].target.projectId, 'project-001');
  assert.equal(bundle.entries[1].target.projectId, 'project-001');
  assert.equal(bundle.entries[0].target.runId, 'run-001');
  assert.equal(bundle.entries[1].target.sourceRunId, 'run-001');
  assert.equal(bundle.entries[0].fact.runId, 'run-001');
  assert.equal(bundle.entries[1].fact.sourceRunId, 'run-001');
  assert.equal(bundle.entries[1].fact.result, undefined);
  assert.equal(bundle.entries[1].fact.reference.artifactId, 'artifact-001');
  assert.match(bundle.entries[1].rawFact.sha256, /^[0-9a-f]{64}$/);
  assert.match(bundle.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    await verifyClusterConsoleEvidenceBundle(parsed, webcrypto),
    true,
  );

  for (const forbidden of [
    'project-customer-production',
    'run-customer-production',
    'diagnosis-run-sensitive',
    'artifact-sensitive',
    'customer-production-nightly',
    'ql3c_console_do_not_export',
    '/private/customer/run.log',
    '<img src=x onerror=alert(1)>',
    '<script>steal(credential)</script>',
    'attacker.invalid',
  ]) {
    assert.doesNotMatch(encoded, new RegExp(forbidden.replaceAll('/', '\\/')));
  }

  parsed.entries[0].fact.status = 'failed';
  assert.equal(
    await verifyClusterConsoleEvidenceBundle(parsed, webcrypto),
    false,
  );
});

test('resets the undisclosed alias table for every bundle', async () => {
  const first = await createClusterConsoleEvidenceBundle(
    [runRecord()],
    1_700_000_003_000,
    webcrypto,
  );
  const second = await createClusterConsoleEvidenceBundle(
    [
      runRecord({
        request: {
          schema: requestSchema,
          operation: 'run_read',
          projectId: 'another-project',
          requestId: 'another-request',
          runId: 'another-run',
        },
      }),
    ],
    1_700_000_004_000,
    webcrypto,
  );

  assert.equal(first.entries[0].target.runId, 'run-001');
  assert.equal(second.entries[0].target.runId, 'run-001');
  assert.notEqual(first.contentDigest, second.contentDigest);
  assert.equal(JSON.stringify(first).includes('another-run'), false);
  assert.equal(
    JSON.stringify(second).includes('run-customer-production'),
    false,
  );
});

test('fails closed on widened records, unsafe JSON and every capacity ceiling', async () => {
  const error = { code: 'QL3_CLUSTER_CONSOLE_EVIDENCE_BUNDLE_INVALID' };
  assert.throws(() => measureClusterConsoleEvidenceRecord(null), error);
  assert.throws(
    () => measureClusterConsoleEvidenceRecord({ ...runRecord(), session: 'x' }),
    error,
  );
  assert.throws(
    () =>
      measureClusterConsoleEvidenceRecord({
        ...runRecord(),
        operation: 'cancel',
      }),
    error,
  );
  assert.throws(
    () =>
      measureClusterConsoleEvidenceRecord({
        ...runRecord(),
        request: { ...runRecord().request, endpoint: 'https://example.test' },
      }),
    error,
  );
  assert.throws(
    () =>
      measureClusterConsoleEvidenceRecord({
        ...runRecord(),
        fact: { items: Array.from({ length: 65 }, () => ({})) },
      }),
    error,
  );
  const cyclic = runRecord();
  cyclic.fact.loop = cyclic.fact;
  assert.throws(() => measureClusterConsoleEvidenceRecord(cyclic), error);
  assert.throws(
    () =>
      measureClusterConsoleEvidenceRecord({
        ...runRecord(),
        fact: { message: 'x'.repeat(limits.maximumEntryFactBytes + 1) },
      }),
    error,
  );

  await assert.rejects(
    createClusterConsoleEvidenceBundle([], 1_700_000_003_000, webcrypto),
    ClusterConsoleEvidenceBundleError,
  );
  await assert.rejects(
    createClusterConsoleEvidenceBundle(
      Array.from({ length: limits.maximumRecords + 1 }, () => runRecord()),
      1_700_000_003_000,
      webcrypto,
    ),
    ClusterConsoleEvidenceBundleError,
  );
  const largeRecords = Array.from({ length: 5 }, (_, index) =>
    runRecord({
      observedAtMs: 1_700_000_000_000 + index,
      fact: { message: String(index) + 'x'.repeat(2 * 1024 * 1024 - 64) },
    }),
  );
  await assert.rejects(
    createClusterConsoleEvidenceBundle(
      largeRecords,
      1_700_000_003_000,
      webcrypto,
    ),
    ClusterConsoleEvidenceBundleError,
  );
  assert.throws(
    () =>
      serializeClusterConsoleEvidenceBundle({
        schema,
        contentDigest: 'a'.repeat(64),
        padding: 'x'.repeat(limits.maximumBundleBytes),
      }),
    error,
  );
});
