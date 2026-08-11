import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../migration/modelInvocationMigration';
import {
  InvalidPluginPackagePromptExecutionInspectionError,
  PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
  PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError,
  PluginPackagePromptExecutionInspectionUnavailableError,
  normalizeAuthorizedPluginPackagePromptExecutionInspection,
  normalizePluginPackagePromptExecutionInspectionResult,
  type AuthorizedPluginPackagePromptExecutionInspection,
  type PluginPackagePromptExecutionInspectionRepository,
  type PluginPackagePromptExecutionInspectionResult,
} from './pluginPackagePromptExecutionInspection';

type Row = Record<string, unknown>;

const API_CREDENTIAL_AUTHENTICATION =
  /^api_credential:([A-Za-z0-9][A-Za-z0-9._:-]{0,63}):([1-9]\d*)$/;

function integerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function integer(row: Row, key: string): number {
  const value = integerValue(row[key]);
  if (value === null || value < 0) throw unavailable();
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptExecutionInspectionUnavailableError {
  return new PluginPackagePromptExecutionInspectionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function fenceConflict(): never {
  throw new PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError();
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original inspection failure.
  }
}

async function confirmAuthorization(
  client: PostgresClient,
  inspection: Readonly<AuthorizedPluginPackagePromptExecutionInspection>,
): Promise<void> {
  const match = API_CREDENTIAL_AUTHENTICATION.exec(
    inspection.audit.authenticationId ?? '',
  );
  const credentialVersion = integerValue(match?.[2]);
  if (!match || credentialVersion === null || credentialVersion < 1) {
    return fenceConflict();
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `ql3-api-credential:${match[1]}`,
  ]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `ql3-identity:${inspection.actor.type}:${inspection.actor.id}`,
  ]);
  const credential = await client.query<Row>(
    `SELECT credential.version,
            credential.state,
            credential.subject_type AS "subjectType",
            credential.subject_id AS "subjectId",
            credential.not_before_at_ms AS "notBeforeAtMs",
            credential.expires_at_ms AS "expiresAtMs",
            subject.status AS "subjectStatus",
            floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AS "nowMs"
       FROM "ql3"."api_credentials" AS credential
       JOIN "ql3"."identity_subjects" AS subject
         ON subject.subject_type = credential.subject_type
        AND subject.subject_id = credential.subject_id
      WHERE credential.credential_id = $1
      ORDER BY credential.version DESC
      LIMIT 1`,
    [match[1]],
  );
  const credentialRow =
    credential.rows.length === 1 ? credential.rows[0]! : null;
  const nowMs = integerValue(credentialRow?.nowMs);
  if (
    !credentialRow ||
    integerValue(credentialRow.version) !== credentialVersion ||
    credentialRow.state !== 'active' ||
    credentialRow.subjectStatus !== 'active' ||
    credentialRow.subjectType !== inspection.actor.type ||
    credentialRow.subjectId !== inspection.actor.id ||
    nowMs === null ||
    (integerValue(credentialRow.notBeforeAtMs) ?? Number.MAX_SAFE_INTEGER) >
      nowMs ||
    (integerValue(credentialRow.expiresAtMs) ?? -1) <= nowMs
  ) {
    return fenceConflict();
  }
  const project = await client.query<Row>(
    `SELECT status, version
       FROM "ql3"."projects"
      WHERE id = $1
      LIMIT 1
      FOR SHARE`,
    [inspection.projectId],
  );
  const projectRow = project.rows.length === 1 ? project.rows[0]! : null;
  if (
    !projectRow ||
    projectRow.status !== 'active' ||
    integerValue(projectRow.version) !== inspection.fence.projectVersion
  ) {
    return fenceConflict();
  }
  const binding = await client.query<Row>(
    `SELECT version, state
       FROM "ql3"."project_role_bindings"
      WHERE project_id = $1
        AND subject_type = $2
        AND subject_id = $3
      ORDER BY version DESC
      LIMIT 1`,
    [inspection.projectId, inspection.actor.type, inspection.actor.id],
  );
  const bindingRow = binding.rows.length === 1 ? binding.rows[0]! : null;
  if (
    !bindingRow ||
    bindingRow.state !== 'active' ||
    integerValue(bindingRow.version) !== inspection.fence.bindingVersion
  ) {
    return fenceConflict();
  }
}

async function insertAudit(
  client: PostgresClient,
  inspection: Readonly<AuthorizedPluginPackagePromptExecutionInspection>,
): Promise<void> {
  const audit = inspection.audit;
  await client.query(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id,
       subject_type, subject_id, authentication_id, outcome, reasons,
       project_version, binding_version, occurred_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
     )`,
    [
      audit.eventId,
      audit.requestId,
      audit.operationId,
      audit.projectId,
      audit.subject?.type ?? null,
      audit.subject?.id ?? null,
      audit.authenticationId,
      audit.outcome,
      JSON.stringify(audit.reasons),
      audit.fence?.projectVersion ?? null,
      audit.fence?.bindingVersion ?? null,
      audit.occurredAtMs,
    ],
  );
}

/**
 * Reads one exact Prompt execution and appends its allowed audit in the same
 * serializable authorization snapshot. No Prompt content or model facts are
 * projected.
 */
export class PostgresPluginPackagePromptExecutionInspectionRepository
  implements PluginPackagePromptExecutionInspectionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async inspectAuthorized(
    input: AuthorizedPluginPackagePromptExecutionInspection,
  ): Promise<Readonly<PluginPackagePromptExecutionInspectionResult>> {
    const inspection =
      normalizeAuthorizedPluginPackagePromptExecutionInspection(input);
    let client: PostgresClient | undefined;
    let began = false;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
      began = true;
      await client.query(
        `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
        ['5s'],
      );
      await confirmAuthorization(client, inspection);
      const page = await client.query<Row>(
        `SELECT admission.invocation_id AS "invocationId",
                admission.run_id AS "runId",
                admission.step_run_id AS "stepRunId",
                admission.admitted_at_ms AS "admittedAtMs",
                run.status AS "runStatus",
                run.version AS "runVersion",
                run.event_sequence AS "eventSequence",
                run.started_at_ms AS "startedAtMs",
                run.finished_at_ms AS "finishedAtMs",
                step.status AS "stepStatus",
                step.version AS "stepVersion",
                finalization.finalized_at_ms AS "finalizedAtMs"
           FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions" AS admission
           JOIN "ql3"."runs" AS run
             ON run.id = admission.run_id
            AND run.project_id = admission.project_id
           JOIN "ql3"."step_runs" AS step
             ON step.run_id = admission.run_id
            AND step.id = admission.step_run_id
           LEFT JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations" AS finalization
             ON finalization.request_id = admission.request_id
          WHERE admission.request_id = $1
            AND admission.project_id = $2
            AND admission.package_name = $3
            AND admission.prompt_id = $4
          LIMIT 2`,
        [
          inspection.executionRequestId,
          inspection.projectId,
          inspection.packageName,
          inspection.promptId,
        ],
      );
      const result =
        page.rows.length === 0
          ? normalizePluginPackagePromptExecutionInspectionResult({
              schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
              found: false,
              projectId: inspection.projectId,
              packageName: inspection.packageName,
              promptId: inspection.promptId,
              executionRequestId: inspection.executionRequestId,
              execution: null,
            })
          : page.rows.length === 1
          ? normalizePluginPackagePromptExecutionInspectionResult({
              schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
              found: true,
              projectId: inspection.projectId,
              packageName: inspection.packageName,
              promptId: inspection.promptId,
              executionRequestId: inspection.executionRequestId,
              execution: {
                invocationId: text(page.rows[0]!, 'invocationId'),
                runId: text(page.rows[0]!, 'runId'),
                stepRunId: text(page.rows[0]!, 'stepRunId'),
                runStatus: text(page.rows[0]!, 'runStatus') as never,
                runVersion: integer(page.rows[0]!, 'runVersion'),
                eventSequence: integer(page.rows[0]!, 'eventSequence'),
                stepStatus: text(page.rows[0]!, 'stepStatus') as never,
                stepVersion: integer(page.rows[0]!, 'stepVersion'),
                admittedAtMs: integer(page.rows[0]!, 'admittedAtMs'),
                startedAtMs: integer(page.rows[0]!, 'startedAtMs'),
                finishedAtMs: nullableInteger(page.rows[0]!, 'finishedAtMs'),
                finalizedAtMs: nullableInteger(page.rows[0]!, 'finalizedAtMs'),
              },
            })
          : (() => {
              throw unavailable();
            })();
      await insertAudit(client, inspection);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (cause) {
      if (client && began) await rollback(client);
      if (
        cause instanceof InvalidPluginPackagePromptExecutionInspectionError ||
        cause instanceof
          PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError ||
        cause instanceof PluginPackagePromptExecutionInspectionUnavailableError
      ) {
        throw cause;
      }
      throw unavailable(cause);
    } finally {
      client?.release();
    }
  }
}
