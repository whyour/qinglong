const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  WorkerCredentialManagementDurableAuditEvidenceError,
  databaseSql,
  parseArguments,
  runWorkerCredentialManagementDurableAuditEvidence,
  validateWorkerCredentialManagementDurableAuditEvidence,
} = require('../../scripts/ql3-worker-credential-management-durable-audit-evidence.cjs');

const NOW_MS = 1_700_000_000_000;
const temporaryDirectories = [];

function digest(domain, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')}`;
}

function ceremony() {
  return {
    schemaVersion: 1,
    planRequest: {
      actionRef: 'worker-credential:worker-a:generation-2',
      authorityProjectId: 'cluster-authority',
      action: 'rotate',
      deliveryId: '123e4567-e89b-42d3-a456-426614174901',
      workerId: 'worker-a',
      credentialId: 'credential-generation-2',
      previousCredentialId: 'credential-generation-1',
      credentialNotBeforeAtMs: NOW_MS + 1_000,
      credentialExpiresAtMs: NOW_MS + 10 * 60_000,
      deploymentTargetDigest: 'd'.repeat(64),
      deploymentGeneration: 'generation-2',
    },
    approvalRequestId: 'approval-worker-a-generation-2',
    approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174902',
    requesterDecisionId: 'requester-self-decision',
    requesterDecisionAuditEventId: '123e4567-e89b-42d3-a456-426614174903',
    reviewerDecisionId: 'reviewer-decision',
    reviewerDecisionAuditEventId: '123e4567-e89b-42d3-a456-426614174904',
    decisionReasonCode: 'reviewed',
    inspectionId: 'inspection-worker-a-generation-2',
  };
}

function ceremonyReport() {
  const value = ceremony();
  return {
    schemaVersion: 1,
    fixture: 'qinglong/worker-credential-management-live-ceremony@v1',
    observedAt: new Date(NOW_MS).toISOString(),
    identity: {
      providerKind: 'external_oidc',
      issuer: 'https://identity.production.example.org/',
      discoveryDocumentSha256: `sha256:${'c'.repeat(64)}`,
      jwksSha256: `sha256:${'d'.repeat(64)}`,
      audience: 'qinglong3-worker-credential-management',
      type: 'ql3-worker-credential-management+jwt',
      purpose: 'worker-credential-management',
      requesterSubjectSha256: digest(
        'qinglong3.worker-management.subject.v1',
        'operator-a',
      ),
      reviewerSubjectSha256: digest(
        'qinglong3.worker-management.subject.v1',
        'reviewer-b',
      ),
      requesterKeyIdSha256: `sha256:${'1'.repeat(64)}`,
      reviewerKeyIdSha256: `sha256:${'2'.repeat(64)}`,
    },
    ceremony: {
      actionRefSha256: digest(
        'qinglong3.worker-management.action-ref.v1',
        value.planRequest.actionRef,
      ),
      authorityProjectIdSha256: digest(
        'qinglong3.worker-management.project.v1',
        value.planRequest.authorityProjectId,
      ),
      planStatus: 'created',
      approvalStatus: 'created',
      requesterSelfDecisionStatus: 403,
      requesterSelfDecisionCode: 'forbidden',
      reviewerDecisionStatus: 'decided',
      approvalState: 'approved',
      inspectionStale: false,
      dispatchCreated: false,
      approvalConsumed: false,
      planDigest: 'a'.repeat(64),
      previewDigest: 'b'.repeat(64),
      requestIdSha256: [1, 2, 3, 4, 5].map(
        (value) => `sha256:${String(value).repeat(64)}`,
      ),
    },
    gates: {
      externalIdentity: true,
      workerPurposeBound: true,
      requesterAndReviewerDistinct: true,
      requesterSelfDecisionRejected: true,
      reviewerDecisionAccepted: true,
      inspectionAuthorized: true,
      noExecutionOrConsumption: true,
      passed: true,
    },
  };
}

function snapshot(overrides = {}) {
  const value = ceremony();
  const base = {
    serverVersionNumber: 180004,
    transactionReadOnly: true,
    role: {
      name: 'ql3_worker_management_evidence',
      canLogin: true,
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      schemaUsage: true,
      selectableTables: [
        'approval_requests',
        'security_audit_events',
        'worker_credential_management_plans',
      ],
      writableTables: [],
      privilegedMemberships: [],
    },
    plan: {
      action_ref: value.planRequest.actionRef,
      authority_project_id: value.planRequest.authorityProjectId,
      action: value.planRequest.action,
      plan_digest: 'a'.repeat(64),
      preview_digest: 'b'.repeat(64),
      requested_by_type: 'user',
      requested_by_id: 'operator-a',
      planned_at_ms: NOW_MS,
    },
    approval: {
      request_id: value.approvalRequestId,
      project_id: value.planRequest.authorityProjectId,
      version: 2,
      state: 'approved',
      action_type: 'worker_credential.delivery.rotate',
      action_ref: value.planRequest.actionRef,
      action_digest: 'a'.repeat(64),
      preview_digest: 'b'.repeat(64),
      requested_by_type: 'user',
      requested_by_id: 'operator-a',
      decision_id: value.reviewerDecisionId,
      consumption_id: null,
      dispatch_id: null,
      decided_by_type: 'user',
      decided_by_id: 'reviewer-b',
      decision_reason_code: 'reviewed',
      decision_authentication_id: 'authentication-reviewer',
    },
    audits: [
      {
        kind: 'proposal',
        event_id: value.approvalAuditEventId,
        request_id: value.approvalRequestId,
        operation_id: 'approval.request',
        project_id: value.planRequest.authorityProjectId,
        subject_type: 'user',
        subject_id: 'operator-a',
        authentication_id: 'authentication-requester',
        outcome: 'approval_required',
        reasons: ['worker_credential_review'],
        project_version: 1,
        binding_version: 1,
        occurred_at_ms: NOW_MS + 10,
      },
      {
        kind: 'reviewer_decision',
        event_id: value.reviewerDecisionAuditEventId,
        request_id: value.approvalRequestId,
        operation_id: 'approval.decide',
        project_id: value.planRequest.authorityProjectId,
        subject_type: 'user',
        subject_id: 'reviewer-b',
        authentication_id: 'authentication-reviewer',
        outcome: 'allowed',
        reasons: ['worker_credential_review'],
        project_version: 1,
        binding_version: 2,
        occurred_at_ms: NOW_MS + 20,
      },
    ],
    requesterDecisionAuditRows: 0,
  };
  return { ...base, ...overrides };
}

function writePrivate(directory, name, value) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return filePath;
}

function fixture() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-worker-audit-evidence-test-')),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return {
    ceremonyReportFile: writePrivate(
      directory,
      'ceremony-report.json',
      ceremonyReport(),
    ),
    ceremonyFile: writePrivate(directory, 'ceremony.json', ceremony()),
    pgServiceFile: writePrivate(directory, 'pg_service.conf', {
      placeholder: true,
    }),
    pgService: 'ql3_worker_management_evidence',
    outputFile: path.join(directory, 'durable-evidence.json'),
  };
}

function dependencies(value = snapshot()) {
  return {
    now: () => NOW_MS + 30,
    runPsql(serviceFile, args, sql) {
      assert.match(serviceFile, /pg_service\.conf$/);
      assert.deepEqual(args, [
        '--no-psqlrc',
        '--quiet',
        '--no-align',
        '--tuples-only',
        '--set=ON_ERROR_STOP=1',
        '--dbname=service=ql3_worker_management_evidence',
        '--file=-',
      ]);
      assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/);
      assert.match(sql, /current_setting\('transaction_read_only'\)/);
      assert.match(sql, /requesterDecisionAuditRows/);
      assert.doesNotMatch(sql, /worker-credential\.execute/);
      return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('collects two durable audit rows through an exact read-only role', () => {
  const paths = fixture();
  const report = runWorkerCredentialManagementDurableAuditEvidence(
    paths,
    dependencies(),
  );

  assert.equal(report.gates.passed, true);
  assert.equal(report.database.transactionReadOnly, true);
  assert.equal(report.durableState.auditRows.length, 2);
  assert.equal(report.durableState.requesterSelfDecisionAuditAbsent, true);
  assert.equal(report.durableState.dispatchCreated, false);
  assert.equal(report.durableState.approvalConsumed, false);
  assert.equal(
    validateWorkerCredentialManagementDurableAuditEvidence(report).compatible,
    true,
  );
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(
    serialized,
    /operator-a|reviewer-b|cluster-authority|approval-worker|authentication-|postgresql:\/\//,
  );
  assert.equal(fs.statSync(paths.outputFile).mode & 0o777, 0o600);

  const audit = spawnSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../../scripts/ql3-worker-credential-management-durable-audit-evidence-audit.cjs',
      ),
      `--report=${paths.outputFile}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).compatible, true);
});

test('fails closed for write authority, privileged membership and extra table reads', () => {
  for (const role of [
    { writableTables: ['approval_requests'] },
    { privilegedMemberships: ['ql3_worker_credential_manager'] },
    {
      selectableTables: [
        'approval_requests',
        'security_audit_events',
        'worker_credential_management_plans',
        'worker_credentials',
      ],
    },
  ]) {
    const paths = fixture();
    assert.throws(
      () =>
        runWorkerCredentialManagementDurableAuditEvidence(
          paths,
          dependencies(snapshot({ role: { ...snapshot().role, ...role } })),
        ),
      /exact read-only authority/,
    );
    assert.equal(fs.existsSync(paths.outputFile), false);
  }
});

test('requires PostgreSQL 18.4 or later within the reviewed major', () => {
  for (const serverVersionNumber of [180003, 190000]) {
    const paths = fixture();
    assert.throws(
      () =>
        runWorkerCredentialManagementDurableAuditEvidence(
          paths,
          dependencies(snapshot({ serverVersionNumber })),
        ),
      WorkerCredentialManagementDurableAuditEvidenceError,
    );
    assert.equal(fs.existsSync(paths.outputFile), false);
  }
});

test('fails closed when self-decision has an audit row or reviewed state drifts', () => {
  for (const changed of [
    { requesterDecisionAuditRows: 1 },
    {
      approval: { ...snapshot().approval, dispatch_id: 'unexpected-dispatch' },
    },
    { approval: { ...snapshot().approval, decided_by_id: 'operator-a' } },
    { audits: snapshot().audits.slice(0, 1) },
  ]) {
    const paths = fixture();
    assert.throws(
      () =>
        runWorkerCredentialManagementDurableAuditEvidence(
          paths,
          dependencies(snapshot(changed)),
        ),
      WorkerCredentialManagementDurableAuditEvidenceError,
    );
    assert.equal(fs.existsSync(paths.outputFile), false);
  }
});

test('binds private ceremony to the low-sensitive ceremony report', () => {
  const paths = fixture();
  const changed = ceremony();
  changed.planRequest.actionRef = 'worker-credential:other:generation-2';
  fs.writeFileSync(paths.ceremonyFile, `${JSON.stringify(changed)}\n`, {
    mode: 0o600,
  });
  assert.throws(
    () =>
      runWorkerCredentialManagementDurableAuditEvidence(paths, dependencies()),
    WorkerCredentialManagementDurableAuditEvidenceError,
  );
  assert.equal(fs.existsSync(paths.outputFile), false);
});

test('offline audit rejects widened, false-gate and sensitive reports', () => {
  const paths = fixture();
  const report = runWorkerCredentialManagementDurableAuditEvidence(
    paths,
    dependencies(),
  );
  for (const candidate of [
    { ...report, debug: true },
    { ...report, gates: { ...report.gates, passed: false } },
    { ...report, database: { ...report.database, password: 'forbidden' } },
  ]) {
    assert.equal(
      validateWorkerCredentialManagementDurableAuditEvidence(candidate)
        .compatible,
      false,
    );
  }
});

test('uses path-only CLI arguments and SQL contains no domain mutation', () => {
  assert.deepEqual(
    parseArguments([
      '--ceremony-report=/private/ceremony-report.json',
      '--ceremony=/private/ceremony.json',
      '--pg-service-file=/private/pg_service.conf',
      '--pg-service=ql3_worker_management_evidence',
      '--output=/private/durable-evidence.json',
    ]),
    {
      ceremonyReportFile: '/private/ceremony-report.json',
      ceremonyFile: '/private/ceremony.json',
      pgServiceFile: '/private/pg_service.conf',
      pgService: 'ql3_worker_management_evidence',
      outputFile: '/private/durable-evidence.json',
    },
  );
  assert.throws(
    () => parseArguments(['--pg-service=host=attacker']),
    WorkerCredentialManagementDurableAuditEvidenceError,
  );
  const sql = databaseSql({ value: ceremony() });
  assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/);
  assert.doesNotMatch(
    sql,
    /\b(?:INSERT\s+INTO|UPDATE\s+"?ql3|DELETE\s+FROM|TRUNCATE\s+TABLE|CALL\s|DO\s+\$)/i,
  );
});
