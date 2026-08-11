import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../model-invocation/localModelInvocationRepository';
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

export interface LocalPluginPackagePromptExecutionInspectionGuard {
  confirm(
    inspection: Readonly<AuthorizedPluginPackagePromptExecutionInspection>,
    auditReplay: boolean,
  ): void;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptExecutionInspectionUnavailableError {
  return new PluginPackagePromptExecutionInspectionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function rollback(client: DatabaseSync): void {
  if (!client.isTransaction) return;
  try {
    client.exec('ROLLBACK');
  } catch {
    // Preserve the original inspection failure.
  }
}

/**
 * Reads one exact, content-free Prompt execution from the caller-known
 * idempotency request identity. The authorization fence, audit replay and
 * projection are committed in one BEGIN IMMEDIATE transaction.
 */
export class LocalPluginPackagePromptExecutionInspectionRepository
  implements PluginPackagePromptExecutionInspectionRepository
{
  constructor(
    private readonly authority: LocalModelInvocationOperationAuthority,
    private readonly guard: LocalPluginPackagePromptExecutionInspectionGuard,
  ) {
    if (
      !authority ||
      typeof authority !== 'object' ||
      !authority.client ||
      typeof authority.enqueue !== 'function' ||
      !guard ||
      typeof guard.confirm !== 'function'
    ) {
      throw unavailable();
    }
  }

  inspectAuthorized(
    input: AuthorizedPluginPackagePromptExecutionInspection,
  ): Promise<Readonly<PluginPackagePromptExecutionInspectionResult>> {
    const inspection =
      normalizeAuthorizedPluginPackagePromptExecutionInspection(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          const audit = client
            .prepare(
              `SELECT 1 AS present
                 FROM "QingLong3SecurityAuditEvents"
                WHERE event_id = ?
                LIMIT 1`,
            )
            .get(inspection.audit.eventId) as Row | undefined;
          this.guard.confirm(inspection, audit !== undefined);

          const rows = client
            .prepare(
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
                 FROM "ModelInvocationPromptAdmissions" AS admission
                 JOIN "Runs" AS run
                   ON run.id = admission.run_id
                  AND run.project_id = admission.project_id
                 JOIN "StepRuns" AS step
                   ON step.run_id = admission.run_id
                  AND step.id = admission.step_run_id
                 LEFT JOIN "ModelInvocationPromptFinalizations" AS finalization
                   ON finalization.request_id = admission.request_id
                WHERE admission.request_id = ?
                  AND admission.project_id = ?
                  AND admission.package_name = ?
                  AND admission.prompt_id = ?
                LIMIT 2`,
            )
            .all(
              inspection.executionRequestId,
              inspection.projectId,
              inspection.packageName,
              inspection.promptId,
            ) as Row[];
          const result =
            rows.length === 0
              ? normalizePluginPackagePromptExecutionInspectionResult({
                  schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
                  found: false,
                  projectId: inspection.projectId,
                  packageName: inspection.packageName,
                  promptId: inspection.promptId,
                  executionRequestId: inspection.executionRequestId,
                  execution: null,
                })
              : rows.length === 1
              ? normalizePluginPackagePromptExecutionInspectionResult({
                  schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
                  found: true,
                  projectId: inspection.projectId,
                  packageName: inspection.packageName,
                  promptId: inspection.promptId,
                  executionRequestId: inspection.executionRequestId,
                  execution: {
                    invocationId: text(rows[0]!, 'invocationId'),
                    runId: text(rows[0]!, 'runId'),
                    stepRunId: text(rows[0]!, 'stepRunId'),
                    runStatus: text(rows[0]!, 'runStatus') as never,
                    runVersion: integer(rows[0]!, 'runVersion'),
                    eventSequence: integer(rows[0]!, 'eventSequence'),
                    stepStatus: text(rows[0]!, 'stepStatus') as never,
                    stepVersion: integer(rows[0]!, 'stepVersion'),
                    admittedAtMs: integer(rows[0]!, 'admittedAtMs'),
                    startedAtMs: integer(rows[0]!, 'startedAtMs'),
                    finishedAtMs: nullableInteger(rows[0]!, 'finishedAtMs'),
                    finalizedAtMs: nullableInteger(rows[0]!, 'finalizedAtMs'),
                  },
                })
              : (() => {
                  throw unavailable();
                })();
          client.exec('COMMIT');
          began = false;
          return result;
        } catch (cause) {
          if (began) rollback(client);
          if (
            cause instanceof
              InvalidPluginPackagePromptExecutionInspectionError ||
            cause instanceof
              PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError ||
            cause instanceof
              PluginPackagePromptExecutionInspectionUnavailableError
          ) {
            throw cause;
          }
          throw unavailable(cause);
        }
      },
      () => unavailable(),
    );
  }
}
