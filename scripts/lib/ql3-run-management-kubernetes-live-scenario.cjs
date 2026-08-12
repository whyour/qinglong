#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function eventId(ordinal) {
  assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal < 1e12);
  return '41000000-0000-4000-8000-' + String(ordinal).padStart(12, '0');
}

function retryCommand(projectId, sourceRunId, requestId, mutationId, ordinal) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'run.retry',
    request: Object.freeze({
      projectId,
      sourceRunId,
      requestId,
      auditEventId: eventId(ordinal),
      failureAuditEventId: eventId(ordinal + 500_000),
      body: Object.freeze({
        schema: 'qinglong/run-manual-retry@v1',
        mutationId,
        expectedRunVersion: 3,
        expectedRunStatus: 'failed',
      }),
    }),
  });
}

function stopCommand(projectId, runId, requestId, mutationId, ordinal) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'run.stop',
    request: Object.freeze({
      projectId,
      runId,
      requestId,
      auditEventId: eventId(ordinal),
      failureAuditEventId: eventId(ordinal + 500_000),
      body: Object.freeze({
        schema: 'qinglong/run-cancellation@v1',
        mutationId,
      }),
    }),
  });
}

function sqlString(value) {
  assert.equal(typeof value, 'string');
  return "'" + value.replaceAll("'", "''") + "'";
}

function seedRunManagement(fixture, podName, values, psql) {
  const nowMs = Date.now();
  const sourceDigest = 'a'.repeat(64);
  const taskRevision = `qltd:v1:1:${sourceDigest}`;
  const taskDigest = 'b'.repeat(64);
  const planDigest = 'c'.repeat(64);
  psql(
    fixture,
    podName,
    [
      'BEGIN;',
      'INSERT INTO "ql3"."projects" (id, name, slug, status, version, created_at_ms, updated_at_ms)',
      `VALUES (${sqlString(
        values.projectId,
      )}, 'Run Management Live', ${sqlString(
        values.projectId,
      )}, 'active', 1, ${nowMs}, ${nowMs});`,
      'INSERT INTO "ql3"."project_role_bindings" (project_id, subject_type, subject_id, version, state, role, mutation_id, changed_by_type, changed_by_id, created_at_ms)',
      `VALUES (${sqlString(values.projectId)}, 'user', ${sqlString(
        values.operatorId,
      )}, 1, 'active', 'operator', ${sqlString(
        'binding-' + values.suffix,
      )}, 'system', 'run-management-live', ${nowMs});`,
      'INSERT INTO "ql3"."task_definitions" (project_id, task_id, current_revision, created_at_ms, updated_at_ms)',
      `VALUES (${sqlString(values.projectId)}, ${sqlString(
        values.taskId,
      )}, 1, ${nowMs}, ${nowMs});`,
      'INSERT INTO "ql3"."task_definition_revisions" (project_id, task_id, revision, mutation_id, name, kind, spec_json, labels_json, enabled, content_digest, created_at_ms)',
      `VALUES (${sqlString(values.projectId)}, ${sqlString(
        values.taskId,
      )}, 1, ${sqlString(
        crypto.randomUUID(),
      )}::uuid, 'Run Management Live Task', 'command', '{"schema":"qinglong/command@v1","config":{"command":{"kind":"argv","file":"/bin/echo","args":["run-management-live"]}}}'::jsonb, '{}'::jsonb, true, ${sqlString(
        taskDigest,
      )}, ${nowMs});`,
      'INSERT INTO "ql3"."task_execution_revisions" (project_id, task_id, source_revision, task_revision, source_content_digest, executor_type, plan_schema, plan_json, content_digest, created_at_ms)',
      `VALUES (${sqlString(values.projectId)}, ${sqlString(
        values.taskId,
      )}, 1, ${sqlString(taskRevision)}, ${sqlString(
        sourceDigest,
      )}, 'remote_worker', 'qinglong/command-execution@v1', '{"file":"/bin/echo","args":["run-management-live"]}'::jsonb, ${sqlString(
        planDigest,
      )}, ${nowMs});`,
      'INSERT INTO "ql3"."runs" (id, project_id, task_id, task_revision, task_name, task_snapshot_ref, trigger_type, execution_origin, execution_owner, status, version, event_sequence, priority, created_at_ms, queued_at_ms, finished_at_ms, error_code, error_summary)',
      `VALUES (${sqlString(values.sourceRunId)}, ${sqlString(
        values.projectId,
      )}, ${sqlString(values.taskId)}, ${sqlString(
        taskRevision,
      )}, 'Run Management Live Task', ${sqlString(
        taskRevision,
      )}, 'manual', 'manual', 'runtime', 'failed', 3, 3, 0, ${nowMs}, ${nowMs}, ${nowMs}, 'LIVE_SOURCE_FAILURE', 'terminal source for Run management live');`,
      'INSERT INTO "ql3"."run_attempts" (id, run_id, attempt, status, executor_type, callback_sequence, created_at_ms, finished_at_ms, error_code, error_summary)',
      `VALUES (${sqlString(values.sourceAttemptId)}, ${sqlString(
        values.sourceRunId,
      )}, 1, 'failed', 'remote_worker', 0, ${nowMs}, ${nowMs}, 'LIVE_SOURCE_FAILURE', 'terminal source for Run management live');`,
      'INSERT INTO "ql3"."run_events" (id, run_id, sequence, type, dedupe_key, actor_type, actor_id, attempt_id, payload, created_at_ms)',
      `VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(
        values.sourceRunId,
      )}, 1, 'run.created', ${sqlString(
        'run-management-live-created-' + values.suffix,
      )}, 'user', ${sqlString(values.operatorId)}, ${sqlString(
        values.sourceAttemptId,
      )}, '{"status":"created","version":1}'::jsonb, ${nowMs}),`,
      `(${sqlString(crypto.randomUUID())}, ${sqlString(
        values.sourceRunId,
      )}, 2, 'run.queued', ${sqlString(
        'run-management-live-queued-' + values.suffix,
      )}, 'user', ${sqlString(values.operatorId)}, ${sqlString(
        values.sourceAttemptId,
      )}, '{"from_status":"created","to_status":"queued","version":2}'::jsonb, ${nowMs}),`,
      `(${sqlString(crypto.randomUUID())}, ${sqlString(
        values.sourceRunId,
      )}, 3, 'run.failed', ${sqlString(
        'run-management-live-failed-' + values.suffix,
      )}, 'executor', 'run-management-live', ${sqlString(
        values.sourceAttemptId,
      )}, '{"from_status":"queued","to_status":"failed","version":3,"error_code":"LIVE_SOURCE_FAILURE"}'::jsonb, ${nowMs});`,
      'COMMIT;',
    ].join('\n'),
  );
  return Object.freeze({ taskRevision, taskDigest, planDigest });
}

function durableRunManagementFacts(fixture, podName, values, psql) {
  return JSON.parse(
    psql(
      fixture,
      podName,
      [
        'SELECT json_build_object(',
        '  \'sourceRunStatus\', (SELECT status FROM "ql3"."runs" WHERE id = ' +
          sqlString(values.sourceRunId) +
          '),',
        '  \'retryRunCount\', (SELECT count(*)::integer FROM "ql3"."runs" WHERE project_id = ' +
          sqlString(values.projectId) +
          " AND trigger_type = 'run_manual_retry'),",
        '  \'retryAttemptCount\', (SELECT count(*)::integer FROM "ql3"."run_attempts" AS attempt JOIN "ql3"."runs" AS run ON run.id = attempt.run_id WHERE run.project_id = ' +
          sqlString(values.projectId) +
          " AND run.trigger_type = 'run_manual_retry'),",
        '  \'retryEventCount\', (SELECT count(*)::integer FROM "ql3"."run_events" AS event JOIN "ql3"."runs" AS run ON run.id = event.run_id WHERE run.project_id = ' +
          sqlString(values.projectId) +
          " AND run.trigger_type = 'run_manual_retry' AND event.type IN ('run.created', 'run.queued')),",
        '  \'stoppedRunCount\', (SELECT count(*)::integer FROM "ql3"."runs" WHERE project_id = ' +
          sqlString(values.projectId) +
          " AND trigger_type = 'run_manual_retry' AND cancel_requested_at_ms IS NOT NULL AND cancel_reason = 'user'),",
        '  \'stopEventCount\', (SELECT count(*)::integer FROM "ql3"."run_events" AS event JOIN "ql3"."runs" AS run ON run.id = event.run_id WHERE run.project_id = ' +
          sqlString(values.projectId) +
          " AND event.type = 'run.cancel_requested'),",
        '  \'allowedAuditCount\', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE project_id = ' +
          sqlString(values.projectId) +
          " AND operation_id IN ('run.retry', 'run.stop') AND outcome = 'allowed'),",
        '  \'deniedAuditCount\', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE project_id = ' +
          sqlString(values.projectId) +
          " AND operation_id IN ('run.retry', 'run.stop') AND outcome = 'denied'),",
        '  \'weakAuthenticationAuditCount\', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE project_id = ' +
          sqlString(values.projectId) +
          " AND request_id = 'run-live-weak'),",
        '  \'duplicateMutationCount\', greatest(0, (SELECT count(*)::integer FROM "ql3"."runs" WHERE project_id = ' +
          sqlString(values.projectId) +
          ' AND trigger_type = \'run_manual_retry\') - 1) + greatest(0, (SELECT count(*)::integer FROM "ql3"."run_events" AS event JOIN "ql3"."runs" AS run ON run.id = event.run_id WHERE run.project_id = ' +
          sqlString(values.projectId) +
          " AND event.type = 'run.cancel_requested') - 1),",
        '  \'identityGeneration\', (SELECT generation::integer FROM "ql3"."plugin_package_identity_keyset_ledger" WHERE authority = \'run-management\'),',
        '  \'migrationCount\', (SELECT count(*)::integer FROM "ql3"."schema_migrations"),',
        '  \'controlCoreCapability\', (SELECT contract_version::integer FROM "ql3"."schema_capabilities" WHERE contract_name = \'control-core\'),',
        "  'postgresVersionNumber', current_setting('server_version_num')::integer)",
      ].join('\n'),
    ),
  );
}

module.exports = {
  durableRunManagementFacts,
  eventId,
  retryCommand,
  seedRunManagement,
  sqlString,
  stopCommand,
};
