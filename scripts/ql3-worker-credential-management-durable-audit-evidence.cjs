#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const {
  ceremonyCommands,
  validateWorkerCredentialManagementLiveCeremony,
} = require('./ql3-worker-credential-management-live-ceremony.cjs');

const FIXTURE =
  'qinglong/worker-credential-management-durable-audit-evidence@v1';
const MAX_FILE_BYTES = 1024 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MINIMUM_POSTGRES_VERSION_NUMBER = 180004;
const NEXT_POSTGRES_MAJOR_VERSION_NUMBER = 190000;
const TARGET_TABLES = Object.freeze([
  'approval_requests',
  'security_audit_events',
  'worker_credential_management_plans',
]);
const PRIVILEGED_ROLES = Object.freeze([
  'ql3_admin',
  'ql3_migration',
  'ql3_package_executor',
  'ql3_package_manager',
  'ql3_runtime',
  'ql3_worker_credential_executor',
  'ql3_worker_credential_manager',
  'ql3_worker_ingress',
]);
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'connectionstring',
  'dsn',
  'password',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);

class WorkerCredentialManagementDurableAuditEvidenceError extends Error {
  constructor(message) {
    super(
      `Worker credential management durable audit evidence failed: ${message}`,
    );
    this.name = 'WorkerCredentialManagementDurableAuditEvidenceError';
  }
}

function fail(message) {
  throw new WorkerCredentialManagementDurableAuditEvidenceError(message);
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function canonicalFile(filePath, label, privateFile = true) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.length > 4096 ||
    CONTROL_PATTERN.test(filePath)
  ) {
    fail(`${label} path is invalid`);
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is unavailable`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_FILE_BYTES ||
    fs.realpathSync(filePath) !== filePath ||
    (privateFile && (uid === null || stat.uid !== uid)) ||
    (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0
  ) {
    fail(`${label} must be one canonical bounded private regular file`);
  }
  return stat;
}

function readPrivateBuffer(filePath, label) {
  const before = canonicalFile(filePath, label);
  let descriptor = -1;
  let bytes;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (fs.constants.O_CLOEXEC ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode ||
      opened.size !== before.size
    ) {
      fail(`${label} changed before it was opened`);
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail(`${label} could not be read completely`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.uid !== opened.uid ||
      after.mode !== opened.mode ||
      after.size !== opened.size
    ) {
      fail(`${label} changed while it was read`);
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof WorkerCredentialManagementDurableAuditEvidenceError) {
      throw error;
    }
    fail(`${label} could not be read safely`);
  } finally {
    bytes?.fill(0);
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function jsonFromBytes(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} must contain UTF-8 JSON`);
  }
}

function rawDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digest(domain, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')}`;
}

function sqlLiteral(value, label) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    fail(`${label} is invalid`);
  }
  return `'${value}'`;
}

function validateCeremony(value) {
  const commands = ceremonyCommands(value, (command) => command);
  const auditIds = [
    value.approvalAuditEventId,
    value.requesterDecisionAuditEventId,
    value.reviewerDecisionAuditEventId,
  ];
  if (
    !auditIds.every((entry) => UUID_V4_PATTERN.test(entry)) ||
    new Set(auditIds).size !== auditIds.length
  ) {
    fail('ceremony audit event identities must be distinct UUIDv4 values');
  }
  return Object.freeze({ value, commands });
}

function databaseSql(ceremony) {
  const value = ceremony.value;
  const actionRef = sqlLiteral(value.planRequest.actionRef, 'actionRef');
  const projectId = sqlLiteral(
    value.planRequest.authorityProjectId,
    'authorityProjectId',
  );
  const approvalId = sqlLiteral(value.approvalRequestId, 'approvalRequestId');
  const approvalAudit = sqlLiteral(
    value.approvalAuditEventId,
    'approvalAuditEventId',
  );
  const requesterAudit = sqlLiteral(
    value.requesterDecisionAuditEventId,
    'requesterDecisionAuditEventId',
  );
  const reviewerAudit = sqlLiteral(
    value.reviewerDecisionAuditEventId,
    'reviewerDecisionAuditEventId',
  );
  const roles = PRIVILEGED_ROLES.map((role) => `'${role}'`).join(', ');
  return `
BEGIN TRANSACTION READ ONLY;
WITH expected_audit(event_id, kind) AS (
  VALUES
    (${approvalAudit}::uuid, 'proposal'::text),
    (${reviewerAudit}::uuid, 'reviewer_decision'::text)
), role_facts AS (
  SELECT
    roles.rolname,
    roles.rolcanlogin,
    roles.rolsuper,
    roles.rolcreatedb,
    roles.rolcreaterole,
    roles.rolreplication,
    roles.rolbypassrls
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = current_user
), selectable AS (
  SELECT coalesce(json_agg(tables.tablename ORDER BY tables.tablename), '[]'::json) AS names
  FROM pg_catalog.pg_tables AS tables
  WHERE tables.schemaname = 'ql3'
    AND has_table_privilege(
      current_user,
      format('%I.%I', tables.schemaname, tables.tablename),
      'SELECT'
    )
), writable AS (
  SELECT coalesce(json_agg(tables.tablename ORDER BY tables.tablename), '[]'::json) AS names
  FROM pg_catalog.pg_tables AS tables
  WHERE tables.schemaname = 'ql3'
    AND (
      has_table_privilege(current_user, format('%I.%I', tables.schemaname, tables.tablename), 'INSERT') OR
      has_table_privilege(current_user, format('%I.%I', tables.schemaname, tables.tablename), 'UPDATE') OR
      has_table_privilege(current_user, format('%I.%I', tables.schemaname, tables.tablename), 'DELETE') OR
      has_table_privilege(current_user, format('%I.%I', tables.schemaname, tables.tablename), 'TRUNCATE') OR
      has_table_privilege(current_user, format('%I.%I', tables.schemaname, tables.tablename), 'REFERENCES') OR
      has_table_privilege(current_user, format('%I.%I', tables.schemaname, tables.tablename), 'TRIGGER')
    )
), privileged_memberships AS (
  SELECT coalesce(json_agg(role_name ORDER BY role_name), '[]'::json) AS names
  FROM unnest(ARRAY[${roles}]::text[]) AS role_name
  WHERE pg_has_role(current_user, role_name, 'MEMBER')
     OR pg_has_role(current_user, role_name, 'SET')
), plan_row AS (
  SELECT
    plan.action_ref,
    plan.authority_project_id,
    plan.action,
    plan.plan_digest,
    plan.preview_digest,
    plan.requested_by_type,
    plan.requested_by_id,
    plan.planned_at_ms
  FROM ql3.worker_credential_management_plans AS plan
  WHERE plan.action_ref = ${actionRef}
    AND plan.authority_project_id = ${projectId}
), approval_row AS (
  SELECT
    approval.request_id,
    approval.project_id,
    approval.version,
    approval.state,
    approval.action_type,
    approval.action_ref,
    approval.action_digest,
    approval.preview_digest,
    approval.requested_by_type,
    approval.requested_by_id,
    approval.decision_id,
    approval.consumption_id,
    approval.dispatch_id,
    approval.request_json -> 'decidedBy' ->> 'type' AS decided_by_type,
    approval.request_json -> 'decidedBy' ->> 'id' AS decided_by_id,
    approval.request_json ->> 'decisionReasonCode' AS decision_reason_code,
    approval.request_json ->> 'decisionAuthenticationId' AS decision_authentication_id
  FROM ql3.approval_requests AS approval
  WHERE approval.request_id = ${approvalId}
), audit_rows AS (
  SELECT
    expected.kind,
    audit.event_id,
    audit.request_id,
    audit.operation_id,
    audit.project_id,
    audit.subject_type,
    audit.subject_id,
    audit.authentication_id,
    audit.outcome,
    audit.reasons,
    audit.project_version,
    audit.binding_version,
    audit.occurred_at_ms
  FROM expected_audit AS expected
  JOIN ql3.security_audit_events AS audit
    ON audit.event_id = expected.event_id
)
SELECT json_build_object(
  'serverVersionNumber', current_setting('server_version_num')::integer,
  'transactionReadOnly', current_setting('transaction_read_only')::boolean,
  'role', (
    SELECT json_build_object(
      'name', role_facts.rolname,
      'canLogin', role_facts.rolcanlogin,
      'superuser', role_facts.rolsuper,
      'createDatabase', role_facts.rolcreatedb,
      'createRole', role_facts.rolcreaterole,
      'replication', role_facts.rolreplication,
      'bypassRls', role_facts.rolbypassrls,
      'schemaUsage', has_schema_privilege(current_user, 'ql3', 'USAGE'),
      'selectableTables', selectable.names,
      'writableTables', writable.names,
      'privilegedMemberships', privileged_memberships.names
    )
    FROM role_facts, selectable, writable, privileged_memberships
  ),
  'plan', (
    SELECT row_to_json(plan_row) FROM plan_row
  ),
  'approval', (
    SELECT row_to_json(approval_row) FROM approval_row
  ),
  'audits', (
    SELECT coalesce(json_agg(row_to_json(audit_rows) ORDER BY audit_rows.occurred_at_ms, audit_rows.kind), '[]'::json)
    FROM audit_rows
  ),
  'requesterDecisionAuditRows', (
    SELECT count(*)::integer
    FROM ql3.security_audit_events
    WHERE event_id = ${requesterAudit}::uuid
  )
)::text;
COMMIT;
`.trim();
}

function jsonOutput(result) {
  if (!result || result.status !== 0) {
    fail(
      `PostgreSQL evidence query failed with status ${String(result?.status)}`,
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    fail('PostgreSQL evidence query did not return one JSON value');
  }
}

function defaultRunPsql(serviceFile, args, sql) {
  return spawnSync('psql', args, {
    encoding: 'utf8',
    input: sql,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
      PGSERVICEFILE: serviceFile,
      PGAPPNAME: 'ql3-worker-management-evidence',
      PGOPTIONS:
        '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000',
    },
  });
}

function collectDatabaseSnapshot(ceremony, options, runPsql = defaultRunPsql) {
  const result = runPsql(
    options.pgServiceFile,
    [
      '--no-psqlrc',
      '--quiet',
      '--no-align',
      '--tuples-only',
      '--set=ON_ERROR_STOP=1',
      `--dbname=service=${options.pgService}`,
      '--file=-',
    ],
    databaseSql(ceremony),
  );
  return jsonOutput(result);
}

function hashSubject(value) {
  return digest('qinglong3.worker-management.subject.v1', value);
}

function auditEvidence(row, expected) {
  if (
    !row ||
    row.kind !== expected.kind ||
    row.event_id !== expected.eventId ||
    row.request_id !== expected.approvalId ||
    row.operation_id !== expected.operationId ||
    row.project_id !== expected.projectId ||
    row.subject_type !== 'user' ||
    row.subject_id !== expected.subjectId ||
    typeof row.authentication_id !== 'string' ||
    !TOKEN_PATTERN.test(row.authentication_id) ||
    row.outcome !== expected.outcome ||
    JSON.stringify(row.reasons) !==
      JSON.stringify(['worker_credential_review']) ||
    !Number.isSafeInteger(row.project_version) ||
    row.project_version < 1 ||
    (row.binding_version !== null &&
      (!Number.isSafeInteger(row.binding_version) ||
        row.binding_version < 1)) ||
    !Number.isSafeInteger(Number(row.occurred_at_ms)) ||
    Number(row.occurred_at_ms) < 0
  ) {
    fail(`${expected.kind} durable audit row is invalid`);
  }
  return Object.freeze({
    kind: row.kind,
    eventIdSha256: digest(
      'qinglong3.worker-management.audit-event.v1',
      row.event_id,
    ),
    operationId: row.operation_id,
    outcome: row.outcome,
    subjectSha256: hashSubject(row.subject_id),
    authenticationIdSha256: digest(
      'qinglong3.worker-management.authentication-id.v1',
      row.authentication_id,
    ),
    reasonCode: row.reasons[0],
    policyFencePresent: true,
  });
}

function buildReport({
  ceremony,
  ceremonyBytes,
  ceremonyReport,
  reportBytes,
  snapshot,
  nowMs,
}) {
  const value = ceremony.value;
  const plan = snapshot?.plan;
  const approval = snapshot?.approval;
  const role = snapshot?.role;
  if (
    !Number.isSafeInteger(snapshot?.serverVersionNumber) ||
    snapshot.serverVersionNumber < MINIMUM_POSTGRES_VERSION_NUMBER ||
    snapshot.serverVersionNumber >= NEXT_POSTGRES_MAJOR_VERSION_NUMBER ||
    snapshot?.transactionReadOnly !== true ||
    !role ||
    typeof role.name !== 'string' ||
    !TOKEN_PATTERN.test(role.name) ||
    role.canLogin !== true ||
    role.superuser !== false ||
    role.createDatabase !== false ||
    role.createRole !== false ||
    role.replication !== false ||
    role.bypassRls !== false ||
    role.schemaUsage !== true ||
    JSON.stringify(role.selectableTables) !== JSON.stringify(TARGET_TABLES) ||
    !Array.isArray(role.writableTables) ||
    role.writableTables.length !== 0 ||
    !Array.isArray(role.privilegedMemberships) ||
    role.privilegedMemberships.length !== 0
  ) {
    fail('PostgreSQL evidence role is not an exact read-only authority');
  }
  if (
    !plan ||
    plan.action_ref !== value.planRequest.actionRef ||
    plan.authority_project_id !== value.planRequest.authorityProjectId ||
    plan.action !== value.planRequest.action ||
    plan.plan_digest !== ceremonyReport.ceremony.planDigest ||
    plan.preview_digest !== ceremonyReport.ceremony.previewDigest ||
    plan.requested_by_type !== 'user' ||
    hashSubject(plan.requested_by_id) !==
      ceremonyReport.identity.requesterSubjectSha256
  ) {
    fail('durable management plan does not match the ceremony');
  }
  if (
    !approval ||
    approval.request_id !== value.approvalRequestId ||
    approval.project_id !== value.planRequest.authorityProjectId ||
    approval.version !== 2 ||
    approval.state !== 'approved' ||
    approval.action_type !==
      `worker_credential.delivery.${value.planRequest.action}` ||
    approval.action_ref !== value.planRequest.actionRef ||
    approval.action_digest !== plan.plan_digest ||
    approval.preview_digest !== plan.preview_digest ||
    approval.requested_by_type !== 'user' ||
    hashSubject(approval.requested_by_id) !==
      ceremonyReport.identity.requesterSubjectSha256 ||
    approval.decision_id !== value.reviewerDecisionId ||
    approval.consumption_id !== null ||
    approval.dispatch_id !== null ||
    approval.decided_by_type !== 'user' ||
    hashSubject(approval.decided_by_id) !==
      ceremonyReport.identity.reviewerSubjectSha256 ||
    approval.decision_reason_code !== value.decisionReasonCode ||
    typeof approval.decision_authentication_id !== 'string' ||
    !TOKEN_PATTERN.test(approval.decision_authentication_id)
  ) {
    fail('durable approval does not match the reviewed ceremony');
  }
  if (
    snapshot.requesterDecisionAuditRows !== 0 ||
    !Array.isArray(snapshot.audits) ||
    snapshot.audits.length !== 2
  ) {
    fail('durable audit cardinality does not prove self-decision rejection');
  }
  const expected = new Map([
    [
      'proposal',
      {
        kind: 'proposal',
        eventId: value.approvalAuditEventId,
        approvalId: value.approvalRequestId,
        operationId: 'approval.request',
        projectId: value.planRequest.authorityProjectId,
        subjectId: plan.requested_by_id,
        outcome: 'approval_required',
      },
    ],
    [
      'reviewer_decision',
      {
        kind: 'reviewer_decision',
        eventId: value.reviewerDecisionAuditEventId,
        approvalId: value.approvalRequestId,
        operationId: 'approval.decide',
        projectId: value.planRequest.authorityProjectId,
        subjectId: approval.decided_by_id,
        outcome: 'allowed',
      },
    ],
  ]);
  const auditRows = snapshot.audits.map((row) => {
    const expectedRow = expected.get(row?.kind);
    if (!expectedRow) fail('durable audit kind is invalid');
    return auditEvidence(row, expectedRow);
  });
  if (
    new Set(snapshot.audits.map((row) => row.kind)).size !== 2 ||
    Number(snapshot.audits[0].occurred_at_ms) >
      Number(snapshot.audits[1].occurred_at_ms)
  ) {
    fail('durable audit ordering is invalid');
  }
  if (
    digest(
      'qinglong3.worker-management.action-ref.v1',
      value.planRequest.actionRef,
    ) !== ceremonyReport.ceremony.actionRefSha256 ||
    digest(
      'qinglong3.worker-management.project.v1',
      value.planRequest.authorityProjectId,
    ) !== ceremonyReport.ceremony.authorityProjectIdSha256
  ) {
    fail('private ceremony does not match the ceremony report');
  }
  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt: new Date(nowMs).toISOString(),
    source: Object.freeze({
      ceremonyReportSha256: rawDigest(reportBytes),
      ceremonyDefinitionSha256: rawDigest(ceremonyBytes),
      ceremonyFixture: ceremonyReport.fixture,
    }),
    database: Object.freeze({
      postgresVersionNumber: snapshot.serverVersionNumber,
      transactionReadOnly: true,
      roleNameSha256: digest(
        'qinglong3.worker-management.evidence-role.v1',
        role.name,
      ),
      roleCanLogin: true,
      privilegedAttributesDenied: true,
      privilegedMembershipDenied: true,
      exactTargetSelect: true,
      ql3TableMutationDenied: true,
    }),
    durableState: Object.freeze({
      actionRefSha256: ceremonyReport.ceremony.actionRefSha256,
      authorityProjectIdSha256:
        ceremonyReport.ceremony.authorityProjectIdSha256,
      approvalRequestIdSha256: digest(
        'qinglong3.worker-management.approval-request.v1',
        value.approvalRequestId,
      ),
      reviewerDecisionIdSha256: digest(
        'qinglong3.worker-management.decision.v1',
        value.reviewerDecisionId,
      ),
      planDigest: plan.plan_digest,
      previewDigest: plan.preview_digest,
      approvalVersion: approval.version,
      approvalState: approval.state,
      requesterSubjectSha256: hashSubject(plan.requested_by_id),
      reviewerSubjectSha256: hashSubject(approval.decided_by_id),
      dispatchCreated: false,
      approvalConsumed: false,
      requesterSelfDecisionAuditAbsent: true,
      auditRows: Object.freeze(auditRows),
    }),
    gates: Object.freeze({
      sourceBound: true,
      readOnlyEvidenceRole: true,
      immutablePlanObserved: true,
      reviewedApprovalObserved: true,
      requesterSelfDecisionLeftNoAudit: true,
      proposalAndDecisionAuditObserved: true,
      noExecutionOrConsumption: true,
      passed: true,
    }),
  });
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
      /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(
        value,
      )
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveMaterial(entry));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([childKey, child]) =>
      containsSensitiveMaterial(child, childKey),
    );
  }
  return false;
}

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateWorkerCredentialManagementDurableAuditEvidence(report) {
  const findings = [];
  const add = (code) => findings.push(Object.freeze({ code }));
  if (
    !exactKeys(report, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'source',
      'database',
      'durableState',
      'gates',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    add('QL3_WORKER_MANAGEMENT_DURABLE_EVIDENCE_SHAPE');
  }
  if (
    !exactKeys(report?.source, [
      'ceremonyReportSha256',
      'ceremonyDefinitionSha256',
      'ceremonyFixture',
    ]) ||
    !SHA256_PATTERN.test(report?.source?.ceremonyReportSha256) ||
    !SHA256_PATTERN.test(report?.source?.ceremonyDefinitionSha256) ||
    report?.source?.ceremonyFixture !==
      'qinglong/worker-credential-management-live-ceremony@v1'
  ) {
    add('QL3_WORKER_MANAGEMENT_DURABLE_EVIDENCE_SOURCE');
  }
  const database = report?.database;
  if (
    !exactKeys(database, [
      'postgresVersionNumber',
      'transactionReadOnly',
      'roleNameSha256',
      'roleCanLogin',
      'privilegedAttributesDenied',
      'privilegedMembershipDenied',
      'exactTargetSelect',
      'ql3TableMutationDenied',
    ]) ||
    !Number.isSafeInteger(database?.postgresVersionNumber) ||
    database.postgresVersionNumber < MINIMUM_POSTGRES_VERSION_NUMBER ||
    database.postgresVersionNumber >= NEXT_POSTGRES_MAJOR_VERSION_NUMBER ||
    !SHA256_PATTERN.test(database?.roleNameSha256) ||
    Object.entries(database ?? {}).some(
      ([key, value]) =>
        key !== 'postgresVersionNumber' &&
        key !== 'roleNameSha256' &&
        value !== true,
    )
  ) {
    add('QL3_WORKER_MANAGEMENT_DURABLE_EVIDENCE_DATABASE');
  }
  const state = report?.durableState;
  if (
    !exactKeys(state, [
      'actionRefSha256',
      'authorityProjectIdSha256',
      'approvalRequestIdSha256',
      'reviewerDecisionIdSha256',
      'planDigest',
      'previewDigest',
      'approvalVersion',
      'approvalState',
      'requesterSubjectSha256',
      'reviewerSubjectSha256',
      'dispatchCreated',
      'approvalConsumed',
      'requesterSelfDecisionAuditAbsent',
      'auditRows',
    ]) ||
    ![
      state?.actionRefSha256,
      state?.authorityProjectIdSha256,
      state?.approvalRequestIdSha256,
      state?.reviewerDecisionIdSha256,
      state?.requesterSubjectSha256,
      state?.reviewerSubjectSha256,
    ].every((value) => SHA256_PATTERN.test(value)) ||
    state?.requesterSubjectSha256 === state?.reviewerSubjectSha256 ||
    !HEX_DIGEST_PATTERN.test(state?.planDigest) ||
    !HEX_DIGEST_PATTERN.test(state?.previewDigest) ||
    state?.approvalVersion !== 2 ||
    state?.approvalState !== 'approved' ||
    state?.dispatchCreated !== false ||
    state?.approvalConsumed !== false ||
    state?.requesterSelfDecisionAuditAbsent !== true ||
    !Array.isArray(state?.auditRows) ||
    state.auditRows.length !== 2 ||
    JSON.stringify(state.auditRows.map((row) => row?.kind).sort()) !==
      JSON.stringify(['proposal', 'reviewer_decision']) ||
    state.auditRows.some(
      (row) =>
        !exactKeys(row, [
          'kind',
          'eventIdSha256',
          'operationId',
          'outcome',
          'subjectSha256',
          'authenticationIdSha256',
          'reasonCode',
          'policyFencePresent',
        ]) ||
        !SHA256_PATTERN.test(row?.eventIdSha256) ||
        !SHA256_PATTERN.test(row?.subjectSha256) ||
        !SHA256_PATTERN.test(row?.authenticationIdSha256) ||
        row?.reasonCode !== 'worker_credential_review' ||
        row?.policyFencePresent !== true ||
        (row.kind === 'proposal' &&
          (row.operationId !== 'approval.request' ||
            row.outcome !== 'approval_required' ||
            row.subjectSha256 !== state.requesterSubjectSha256)) ||
        (row.kind === 'reviewer_decision' &&
          (row.operationId !== 'approval.decide' ||
            row.outcome !== 'allowed' ||
            row.subjectSha256 !== state.reviewerSubjectSha256)),
    )
  ) {
    add('QL3_WORKER_MANAGEMENT_DURABLE_EVIDENCE_STATE');
  }
  if (
    !exactKeys(report?.gates, [
      'sourceBound',
      'readOnlyEvidenceRole',
      'immutablePlanObserved',
      'reviewedApprovalObserved',
      'requesterSelfDecisionLeftNoAudit',
      'proposalAndDecisionAuditObserved',
      'noExecutionOrConsumption',
      'passed',
    ]) ||
    Object.values(report?.gates ?? {}).some((value) => value !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_DURABLE_EVIDENCE_GATES');
  }
  if (containsSensitiveMaterial(report)) {
    add('QL3_WORKER_MANAGEMENT_DURABLE_EVIDENCE_SECRET_EXPOSURE');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function unusedOutput(filePath) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    fs.existsSync(filePath) ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    fail('output must be one unused canonical absolute path');
  }
  return filePath;
}

function writeNoReplace(filePath, report) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--') continue;
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  const keys = [
    'ceremony-report',
    'ceremony',
    'pg-service-file',
    'pg-service',
    'output',
  ];
  if (
    JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(keys.sort()) ||
    !SERVICE_PATTERN.test(values['pg-service'])
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    ceremonyReportFile: values['ceremony-report'],
    ceremonyFile: values.ceremony,
    pgServiceFile: values['pg-service-file'],
    pgService: values['pg-service'],
    outputFile: values.output,
  });
}

function runWorkerCredentialManagementDurableAuditEvidence(
  options,
  dependencies = {},
) {
  if (
    !exactKeys(options, [
      'ceremonyReportFile',
      'ceremonyFile',
      'pgServiceFile',
      'pgService',
      'outputFile',
    ]) ||
    !SERVICE_PATTERN.test(options.pgService)
  ) {
    fail('options shape is invalid');
  }
  unusedOutput(options.outputFile);
  canonicalFile(options.pgServiceFile, 'PostgreSQL service file');
  const reportBytes = readPrivateBuffer(
    options.ceremonyReportFile,
    'ceremony report',
  );
  const ceremonyBytes = readPrivateBuffer(options.ceremonyFile, 'ceremony');
  try {
    const ceremonyReport = jsonFromBytes(reportBytes, 'ceremony report');
    const sourceAudit =
      validateWorkerCredentialManagementLiveCeremony(ceremonyReport);
    if (!sourceAudit.compatible) fail('ceremony report is incompatible');
    const ceremony = validateCeremony(jsonFromBytes(ceremonyBytes, 'ceremony'));
    const snapshot = collectDatabaseSnapshot(
      ceremony,
      options,
      dependencies.runPsql,
    );
    const report = buildReport({
      ceremony,
      ceremonyBytes,
      ceremonyReport,
      reportBytes,
      snapshot,
      nowMs: (dependencies.now ?? Date.now)(),
    });
    const audit =
      validateWorkerCredentialManagementDurableAuditEvidence(report);
    if (!audit.compatible) {
      fail(
        `assembled report failed audit: ${audit.findings
          .map(({ code }) => code)
          .join(',')}`,
      );
    }
    writeNoReplace(options.outputFile, report);
    return report;
  } finally {
    reportBytes.fill(0);
    ceremonyBytes.fill(0);
  }
}

function runCli(argv) {
  if (
    process.env.QL3_WORKER_CREDENTIAL_MANAGEMENT_DURABLE_AUDIT_EVIDENCE !== '1'
  ) {
    fail('explicit durable evidence opt-in is required');
  }
  const report = runWorkerCredentialManagementDurableAuditEvidence(
    parseArguments(argv),
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: report.fixture,
      compatible: true,
    })}\n`,
  );
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'Worker management durable audit evidence failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  FIXTURE,
  WorkerCredentialManagementDurableAuditEvidenceError,
  buildReport,
  collectDatabaseSnapshot,
  databaseSql,
  parseArguments,
  runWorkerCredentialManagementDurableAuditEvidence,
  validateWorkerCredentialManagementDurableAuditEvidence,
};
