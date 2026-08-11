'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  FIXTURE,
  GATE_KEYS,
  LIMITATIONS,
  validateWorkerKubernetesRolloutLiveReport,
} = require('../../scripts/ql3-worker-kubernetes-rollout-live-audit.cjs');
const {
  writePrivateReport,
} = require('../../scripts/ql3-worker-kubernetes-rollout-live-contract.cjs');

function digest(value) {
  return value.toString(16).padStart(64, '0');
}

function report() {
  const gates = Object.fromEntries(GATE_KEYS.map((key) => [key, true]));
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt: '2026-08-11T01:00:00.000Z',
    sourceRevision: 'a'.repeat(40),
    kubernetes: {
      distribution: 'k3s',
      image: 'rancher/k3s:v1.34.3-k3s1',
      imageDigest: `sha256:${digest(1)}`,
      architecture: 'arm64',
      serverVersion: 'v1.34.3+k3s1',
    },
    postgresql: {
      image: 'postgres:18.4-bookworm',
      imageDigest:
        'sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296',
      imageId: `sha256:${digest(2)}`,
      architecture: 'arm64',
      contractVersion: 53,
      migrationId: 'pg-0053-worker-session',
      managerRole: 'ql3_worker_credential_manager',
      executorRole: 'ql3_worker_credential_executor',
    },
    approvalExecution: {
      plans: 4,
      consumedApprovals: 4,
      dispatches: 4,
      succeededExecutions: 4,
      credentials: 4,
      publishedDeliveries: 4,
      auditEvents: 16,
      planDigests: [digest(3), digest(4), digest(5), digest(6)],
      approvalRequestIds: ['approval-1', 'approval-2', 'approval-3', 'approval-4'],
      dispatchIds: ['dispatch-1', 'dispatch-2', 'dispatch-3', 'dispatch-4'],
      hostAuthorizationRechecks: 9,
      tokenRequestAfterApprovalConsumption: true,
      executionReplayWithoutTokenRequest: true,
      tokenOrSecretPersistedInPlan: false,
    },
    credentialRollout: {
      secretSeparatedFromTlsIdentity: true,
      generations: ['generation-1', 'generation-2', 'generation-3', 'generation-4'],
      publicationDigests: [digest(7), digest(8), digest(9), digest(10)],
      recreateStoppedOldBeforeStartingNew: true,
      executorJobStoppedOldBeforeStartingNew: true,
    },
    callerDrivenExecutorJob: {
      image: 'ql3-worker-credential-executor-live:test',
      firstJobName: 'ql3-worker-credential-executor-live-3',
      firstPodUid: '10000000-0000-4000-8000-000000000001',
      firstOutput: {
        schemaVersion: 1,
        component: 'qinglong3-worker-credential-executor',
        event: 'execution_completed',
        actionRef: 'worker-credential:ql3-worker-live:generation-3',
        dispatchId: 'dispatch-3',
        executionStatus: 'succeeded',
        deliveryStatus: 'published',
        tokenRequestUsed: true,
      },
      replayJobName: 'ql3-worker-credential-executor-live-3-replay',
      replayPodUid: '10000000-0000-4000-8000-000000000002',
      replayOutput: {
        schemaVersion: 1,
        component: 'qinglong3-worker-credential-executor',
        event: 'execution_completed',
        actionRef: 'worker-credential:ql3-worker-live:generation-3',
        dispatchId: 'dispatch-3',
        executionStatus: 'succeeded',
        deliveryStatus: 'existing',
        tokenRequestUsed: false,
      },
      backoffLimit: 0,
      projectedIssuerTokenSeconds: 600,
      apiServerEgressCidr: '10.43.0.1/32',
      apiServerBackendEgressCidr: '172.17.0.2/32',
      apiServerBackendPort: 6443,
      postgresEgressCidr: '172.17.0.3/32',
    },
    rbac: {
      tokenIssuerImpersonatedUser: 'ql3-worker-credential-operator-live',
      tokenIssuerExactServiceAccountBound: true,
      hostTokenRequestSessions: 3,
      executorJobTokenRequestSessions: 1,
      shortLivedTokenRequestSeconds: 600,
      issuerAllowedChecks: 1,
      issuerDeniedChecks: 5,
      serviceAccountAutomount: false,
      workerPodServiceAccountTokenProjected: false,
      separateStageNamespace: true,
      allowedChecks: 4,
      deniedChecks: 8,
      tokenNeverReturnedBySession: true,
      restrictedClientDisposedAfterEachOperation: true,
      adapterUsedRestrictedToken: true,
    },
    recovery: {
      pvcPhase: 'Bound',
      sameClaimAfterCredentialRollout: true,
      sameClaimAfterForcedPodLoss: true,
      oldPodUid: '20000000-0000-4000-8000-000000000001',
      rotatedPodUid: '20000000-0000-4000-8000-000000000002',
      crashReplacementPodUid: '20000000-0000-4000-8000-000000000003',
      executorJobReplacementPodUid: '20000000-0000-4000-8000-000000000004',
      identityReplacementPodUid: '20000000-0000-4000-8000-000000000005',
      durableJournalRecords: 9,
    },
    identityRollout: {
      generation: 'product-identity-b',
      caDigest: digest(11),
      observedByReplacement: true,
    },
    productionWorker: {
      workerImageId: `sha256:${digest(12)}`,
      controlImageId: `sha256:${digest(13)}`,
      podUids: [
        '30000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000003',
      ],
      nodeNames: ['ql3-k3s-node', 'ql3-k3s-node', 'ql3-k3s-node'],
      sessionIds: [
        '40000000-0000-7000-8000-000000000001',
        '40000000-0000-7000-8000-000000000002',
        '40000000-0000-7000-8000-000000000003',
      ],
      generations: [1, 2, 3],
      observationCount: 12,
      gracefulDrainElapsedMs: 750,
      terminationGracePeriodSeconds: 360,
      startupReconciliationBeforeOnline: true,
      everySessionObservedOnlineDrainingOffline: true,
      credentialRolloutCreatedFreshSession: true,
      identityRolloutCreatedFreshSession: true,
      pvcReusedAcrossProductSessions: true,
      serviceAccountTokenMounted: false,
      registerAudits: 3,
      transitionAudits: 6,
      heartbeatAudits: 3,
      credentialSecretsAbsent: true,
      fourthCredentialId: 'live_generation_4',
    },
    gates,
    limitations: [...LIMITATIONS],
  };
}

test('accepts the exact secret-free Worker Kubernetes rollout report', () => {
  assert.deepEqual(
    validateWorkerKubernetesRolloutLiveReport(report()).findings,
    [],
  );
});

test('rejects a false gate and incomplete Session evidence', () => {
  const candidate = report();
  candidate.gates.productionGracefulDrainToOffline = false;
  candidate.productionWorker.sessionIds[2] = candidate.productionWorker.sessionIds[1];
  const codes = validateWorkerKubernetesRolloutLiveReport(candidate)
    .findings.map((entry) => entry.code);
  assert.ok(codes.includes('QL3_WORKER_KUBERNETES_LIVE_GATES'));
  assert.ok(codes.includes('QL3_WORKER_KUBERNETES_LIVE_PRODUCT_WORKER'));
});

test('rejects secret material and limitation drift', () => {
  const candidate = report();
  candidate.callerDrivenExecutorJob.firstOutput.token =
    'ql3w_private_worker_credential';
  candidate.limitations.pop();
  const codes = validateWorkerKubernetesRolloutLiveReport(candidate)
    .findings.map((entry) => entry.code);
  assert.ok(codes.includes('QL3_WORKER_KUBERNETES_LIVE_SECRET_EXPOSURE'));
  assert.ok(codes.includes('QL3_WORKER_KUBERNETES_LIVE_LIMITATIONS'));
});

test('live producer rejects missing report and missing explicit opt-in before Docker', (t) => {
  const producer = path.resolve(
    __dirname,
    '../../scripts/ql3-worker-kubernetes-rollout-live-contract.cjs',
  );
  const missingReport = spawnSync(process.execPath, [producer], {
    encoding: 'utf8',
  });
  assert.equal(missingReport.status, 1);
  assert.match(missingReport.stderr, /--report=\/absolute\/private-report\.json/);

  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'ql3-worker-kubernetes-audit-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { ...process.env };
  delete environment.QL3_WORKER_KUBERNETES_ROLLOUT_LIVE;
  const missingOptIn = spawnSync(
    process.execPath,
    [producer, `--report=${path.join(directory, 'report.json')}`],
    { encoding: 'utf8', env: environment },
  );
  assert.equal(missingOptIn.status, 1);
  assert.match(
    missingOptIn.stderr,
    /QL3_WORKER_KUBERNETES_ROLLOUT_LIVE=1/,
  );
});

test('live producer refuses to overwrite an existing report before Docker', (t) => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'ql3-worker-kubernetes-audit-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportFile = path.join(directory, 'report.json');
  writeFileSync(reportFile, '{}\n', { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    path.resolve(
      __dirname,
      '../../scripts/ql3-worker-kubernetes-rollout-live-contract.cjs',
    ),
    `--report=${reportFile}`,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QL3_WORKER_KUBERNETES_ROLLOUT_LIVE: '1',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to overwrite/);
});

test('private report publication is atomic, mode 0600 and no-replace', (t) => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'ql3-worker-kubernetes-report-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportFile = path.join(directory, 'report.json');
  writePrivateReport(reportFile, { fixture: FIXTURE, passed: true });
  const fs = require('node:fs');
  assert.equal(fs.lstatSync(reportFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')), {
    fixture: FIXTURE,
    passed: true,
  });
  assert.throws(
    () => writePrivateReport(reportFile, { fixture: FIXTURE, passed: false }),
    { code: 'EEXIST' },
  );
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  assert.equal(JSON.parse(fs.readFileSync(reportFile, 'utf8')).passed, true);
});
