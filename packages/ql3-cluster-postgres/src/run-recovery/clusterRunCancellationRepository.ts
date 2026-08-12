// PostgreSQL authority adapter for cluster run cancellation requests.
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  ClusterRunCancellationFenceRejectedError,
  ClusterRunCancellationNotFoundError,
  ClusterRunCancellationUnavailableError,
  InvalidClusterRunCancellationError,
  normalizeClusterRunCancellationCommand,
  normalizeClusterRunCancellationResult,
  type ClusterRunCancellationCommand,
  type ClusterRunCancellationRepository,
  type ClusterRunCancellationResult,
} from '@qinglong/runtime-core/cluster-run-cancellation';
import {
  RUN_STATUSES,
  type RunStatus,
  type SecurityPolicyFence,
  type SecurityPrincipal,
} from '@qinglong/runtime-core';
import { normalizeSecurityPrincipal } from '@qinglong/runtime-core/security';

type Row = Record<string, unknown>;

const STRONG_ASSURANCES = new Set(['multi_factor', 'hardware']);
const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const CANCEL_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

export interface PostgresRunManagementCancellationCommand {
  readonly projectId: string;
  readonly runId: string;
  readonly mutationId: string;
  readonly eventId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
}

interface CancellationAudit {
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL Run cancellation ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value =
    typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`PostgreSQL Run cancellation ${key} is invalid`);
  }
  return value;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : text(row, key);
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterRunCancellationError(
      'management command is invalid',
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new InvalidClusterRunCancellationError(
      'management command shape is invalid',
    );
  }
  return value as Record<string, unknown>;
}

function managementIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidClusterRunCancellationError(`${name} is invalid`);
  }
  return value;
}

function managementUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidClusterRunCancellationError(`${name} is invalid`);
  }
  return value;
}

function normalizeManagementCommand(
  value: Readonly<PostgresRunManagementCancellationCommand>,
): Readonly<{
  command: Readonly<ClusterRunCancellationCommand>;
  audit: Readonly<CancellationAudit>;
}> {
  const input = exact(value, [
    'projectId',
    'runId',
    'mutationId',
    'eventId',
    'requestId',
    'auditEventId',
    'principal',
    'policyFence',
  ]);
  const principalInput = exact(input.principal, [
    'subject',
    'authenticationId',
    'authenticatedAtMs',
    'expiresAtMs',
    'assurance',
  ]) as unknown as SecurityPrincipal;
  const projectId = managementIdentifier(input.projectId, 'projectId');
  const runId = managementIdentifier(input.runId, 'runId');
  const mutationId = managementUuid(input.mutationId, 'mutationId');
  const eventId = managementUuid(input.eventId, 'eventId');
  const requestId = managementIdentifier(input.requestId, 'requestId');
  const auditEventId = managementUuid(input.auditEventId, 'auditEventId');
  if (eventId === auditEventId) {
    throw new InvalidClusterRunCancellationError(
      'event and audit identity must differ',
    );
  }
  const command = normalizeClusterRunCancellationCommand({
    projectId,
    runId,
    mutationId,
    eventId,
    subject: principalInput.subject,
    policyFence: input.policyFence as SecurityPolicyFence,
  });
  return Object.freeze({
    command,
    audit: Object.freeze({
      requestId,
      auditEventId,
      principal: principalInput,
    }),
  });
}

function runStatus(row: Row): RunStatus {
  const value = text(row, 'runStatus') as RunStatus;
  if (!RUN_STATUSES.includes(value)) {
    throw new TypeError('PostgreSQL Run cancellation status is invalid');
  }
  return value;
}

function cancellationResult(
  status: ClusterRunCancellationResult['status'],
  command: Readonly<ClusterRunCancellationCommand>,
  row: Row,
): Readonly<ClusterRunCancellationResult> {
  const cancelRequestedAtMs = optionalInteger(row, 'cancelRequestedAtMs');
  const cancelReason = optionalText(row, 'cancelReason');
  if (
    (cancelRequestedAtMs === undefined) !== (cancelReason === undefined) ||
    (cancelReason !== undefined && !CANCEL_REASONS.has(cancelReason))
  ) {
    throw new TypeError('PostgreSQL Run cancellation intent is invalid');
  }
  return normalizeClusterRunCancellationResult({
    status,
    projectId: command.projectId,
    runId: command.runId,
    runStatus: runStatus(row),
    runVersion: integer(row, 'runVersion'),
    eventSequence: integer(row, 'eventSequence'),
    ...(cancelRequestedAtMs === undefined
      ? {}
      : {
          cancelRequestedAtMs,
          cancelReason: cancelReason as NonNullable<
            ClusterRunCancellationResult['cancelReason']
          >,
        }),
  });
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5000ms',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['1000ms']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['10000ms'],
  );
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"
  `);
  if (result.rows.length !== 1) {
    throw new TypeError('PostgreSQL Run cancellation clock is invalid');
  }
  return integer(result.rows[0]!, 'nowMs');
}

function confirmStrongAuthentication(
  value: Readonly<SecurityPrincipal>,
  observedAtMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, observedAtMs);
  } catch {
    throw new ClusterRunCancellationFenceRejectedError('authorization_changed');
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_ASSURANCES.has(principal.assurance) ||
    principal.authenticatedAtMs > observedAtMs ||
    principal.expiresAtMs <= observedAtMs ||
    observedAtMs - principal.authenticatedAtMs > MAX_AUTHENTICATION_AGE_MS
  ) {
    throw new ClusterRunCancellationFenceRejectedError('authorization_changed');
  }
  return principal;
}

async function confirmAuthorization(
  client: PostgresClient,
  command: Readonly<ClusterRunCancellationCommand>,
): Promise<void> {
  const result = await client.query<Row>(
    `
    SELECT "ql3"."lock_run_management_policy_fence"(
      $1::varchar, $2::varchar, $3::varchar, $4::integer, $5::integer
    ) AS "matches"
  `,
    [
      command.projectId,
      command.subject.type,
      command.subject.id,
      command.policyFence.projectVersion,
      command.policyFence.bindingVersion,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.matches !== true) {
    throw new ClusterRunCancellationFenceRejectedError('authorization_changed');
  }
}

async function recordAllowedAudit(
  client: PostgresClient,
  command: Readonly<ClusterRunCancellationCommand>,
  audit: Readonly<CancellationAudit>,
  observedAtMs: number,
): Promise<void> {
  const inserted = await client.query<Row>(
    `
    INSERT INTO "ql3"."security_audit_events" (
      event_id, request_id, operation_id, project_id,
      subject_type, subject_id, authentication_id, outcome, reasons,
      project_version, binding_version, occurred_at_ms
    ) VALUES (
      $1, $2, 'run.stop', $3, $4, $5, $6, 'allowed', $7::jsonb,
      $8, $9, $10
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id AS "eventId"
  `,
    [
      audit.auditEventId,
      audit.requestId,
      command.projectId,
      audit.principal.subject.type,
      audit.principal.subject.id,
      audit.principal.authenticationId,
      JSON.stringify(['role_grant', 'strong_authentication']),
      command.policyFence.projectVersion,
      command.policyFence.bindingVersion,
      observedAtMs,
    ],
  );
  if (inserted.rows.length === 1) return;
  if (inserted.rows.length !== 0) {
    throw new TypeError('PostgreSQL Run cancellation audit is invalid');
  }
  const replay = await client.query<Row>(
    `
    SELECT request_id AS "requestId", operation_id AS "operationId",
           project_id AS "projectId", subject_type AS "subjectType",
           subject_id AS "subjectId", authentication_id AS "authenticationId",
           outcome, reasons, project_version AS "projectVersion",
           binding_version AS "bindingVersion"
    FROM "ql3"."security_audit_events"
    WHERE event_id = $1
  `,
    [audit.auditEventId],
  );
  const row = replay.rows[0];
  const reasons = row?.reasons;
  if (
    replay.rows.length !== 1 ||
    !row ||
    row.requestId !== audit.requestId ||
    row.operationId !== 'run.stop' ||
    row.projectId !== command.projectId ||
    row.subjectType !== audit.principal.subject.type ||
    row.subjectId !== audit.principal.subject.id ||
    row.authenticationId !== audit.principal.authenticationId ||
    row.outcome !== 'allowed' ||
    !Array.isArray(reasons) ||
    reasons.length !== 2 ||
    reasons[0] !== 'role_grant' ||
    reasons[1] !== 'strong_authentication' ||
    integer(row, 'projectVersion') !== command.policyFence.projectVersion ||
    integer(row, 'bindingVersion') !== command.policyFence.bindingVersion
  ) {
    throw new TypeError('PostgreSQL Run cancellation audit replay drifted');
  }
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the primary transaction failure.
  }
}

export class PostgresClusterRunCancellationRepository
  implements ClusterRunCancellationRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL Run cancellation pool is invalid');
    }
  }

  async requestUserCancellation(
    value: Readonly<ClusterRunCancellationCommand>,
  ): Promise<Readonly<ClusterRunCancellationResult>> {
    const command = normalizeClusterRunCancellationCommand(value);
    return this.requestCancellation(command);
  }

  async requestUserCancellationAudited(
    value: Readonly<PostgresRunManagementCancellationCommand>,
  ): Promise<Readonly<ClusterRunCancellationResult>> {
    const normalized = normalizeManagementCommand(value);
    return this.requestCancellation(normalized.command, normalized.audit);
  }

  private requestCancellation(
    command: Readonly<ClusterRunCancellationCommand>,
    audit?: Readonly<CancellationAudit>,
  ): Promise<Readonly<ClusterRunCancellationResult>> {
    return this.transaction(async (client) => {
      const observedAtMs = audit ? await databaseNow(client) : undefined;
      const confirmedAudit = audit
        ? Object.freeze({
            ...audit,
            principal: confirmStrongAuthentication(
              audit.principal,
              observedAtMs!,
            ),
          })
        : undefined;
      if (
        confirmedAudit &&
        (confirmedAudit.principal.subject.type !== command.subject.type ||
          confirmedAudit.principal.subject.id !== command.subject.id)
      ) {
        throw new ClusterRunCancellationFenceRejectedError(
          'authorization_changed',
        );
      }
      await confirmAuthorization(client, command);

      const run = await client.query<Row>(
        `
        SELECT project_id AS "projectId", status AS "runStatus",
               version AS "runVersion", event_sequence AS "eventSequence",
               cancel_requested_at_ms AS "cancelRequestedAtMs",
               cancel_reason AS "cancelReason"
        FROM "ql3"."runs" WHERE id = $1 FOR UPDATE
      `,
        [command.runId],
      );
      if (
        run.rows.length === 0 ||
        run.rows[0]?.projectId !== command.projectId
      ) {
        throw new ClusterRunCancellationNotFoundError();
      }
      if (run.rows.length !== 1) {
        throw new TypeError('PostgreSQL Run cancellation Run is invalid');
      }
      if (command.workflowTarget) {
        const admission = await client.query<Row>(
          `
          SELECT project_id AS "projectId", package_name AS "packageName",
                 workflow_id AS "workflowId"
          FROM "ql3"."plugin_package_workflow_admissions"
          WHERE run_id = $1
        `,
          [command.runId],
        );
        const target = admission.rows[0];
        if (
          admission.rows.length !== 1 ||
          !target ||
          text(target, 'projectId') !== command.projectId ||
          text(target, 'packageName') !== command.workflowTarget.packageName ||
          text(target, 'workflowId') !== command.workflowTarget.workflowId
        ) {
          throw new ClusterRunCancellationNotFoundError();
        }
      }
      const current = run.rows[0]!;
      const currentStatus = runStatus(current);
      let result: Readonly<ClusterRunCancellationResult>;
      if (TERMINAL.has(currentStatus)) {
        result = cancellationResult('already_terminal', command, current);
      } else if (
        optionalInteger(current, 'cancelRequestedAtMs') !== undefined
      ) {
        result = cancellationResult('already_requested', command, current);
      } else if (optionalText(current, 'cancelReason') !== undefined) {
        throw new TypeError('PostgreSQL Run cancellation intent is invalid');
      } else {
        const runVersion = integer(current, 'runVersion');
        const eventSequence = integer(current, 'eventSequence');
        if (runVersion >= 2_147_483_647 || eventSequence >= 2_147_483_647) {
          throw new TypeError('PostgreSQL Run cancellation counter overflowed');
        }
        const mutationObservedAtMs =
          observedAtMs ?? (await databaseNow(client));
        const updated = await client.query<Row>(
          `
          UPDATE "ql3"."runs"
          SET cancel_requested_at_ms = $2, cancel_reason = 'user',
              version = $3, event_sequence = $4
          WHERE id = $1 AND version = $5 AND cancel_requested_at_ms IS NULL
          RETURNING project_id AS "projectId", status AS "runStatus",
                    version AS "runVersion", event_sequence AS "eventSequence",
                    cancel_requested_at_ms AS "cancelRequestedAtMs",
                    cancel_reason AS "cancelReason"
        `,
          [
            command.runId,
            mutationObservedAtMs,
            runVersion + 1,
            eventSequence + 1,
            runVersion,
          ],
        );
        if (updated.rows.length !== 1) {
          throw new ClusterRunCancellationFenceRejectedError('state_mismatch');
        }
        await client.query(
          `
          INSERT INTO "ql3"."run_events" (
            id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
            attempt_id, step_run_id, payload, created_at_ms
          ) VALUES ($1, $2, $3, 'run.cancel_requested', $4, $5, $6,
            NULL, NULL, $7::jsonb, $8)
        `,
          [
            command.eventId,
            command.runId,
            eventSequence + 1,
            `user-cancel:${command.mutationId}`,
            command.subject.type,
            command.subject.id,
            JSON.stringify({
              reason: 'user',
              mutation_id: command.mutationId,
              policy_fence: {
                project_version: command.policyFence.projectVersion,
                binding_version: command.policyFence.bindingVersion,
              },
            }),
            mutationObservedAtMs,
          ],
        );
        result = cancellationResult('accepted', command, updated.rows[0]!);
      }
      if (confirmedAudit) {
        await recordAllowedAudit(
          client,
          command,
          confirmedAudit,
          observedAtMs!,
        );
      }
      return result;
    });
  }

  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ClusterRunCancellationUnavailableError({ cause: error });
    }
    try {
      await begin(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      if (
        error instanceof InvalidClusterRunCancellationError ||
        error instanceof ClusterRunCancellationNotFoundError ||
        error instanceof ClusterRunCancellationFenceRejectedError
      ) {
        throw error;
      }
      throw new ClusterRunCancellationUnavailableError({ cause: error });
    } finally {
      client.release();
    }
  }
}
