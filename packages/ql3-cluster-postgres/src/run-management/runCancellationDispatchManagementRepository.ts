import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  RUN_STATUSES,
  type RunStatus,
  type SecurityPolicyFence,
  type SecurityPrincipal,
} from '@qinglong/runtime-core';
import {
  CANCELLATION_DISPATCH_BLOCKING_RESULTS,
  CANCELLATION_DISPATCH_RESULTS,
  CANCELLATION_DISPATCH_STATUSES,
  MAX_CANCELLATION_DISPATCH_RETRY_DELAY_MS,
  type CancellationDispatchResult,
  type CancellationDispatchStatus,
} from '@qinglong/runtime-core/cancellation-dispatch';
import { normalizeSecurityPrincipal } from '@qinglong/runtime-core/security';

type Row = Record<string, unknown>;

export type BlockingCancellationDispatchResult =
  (typeof CANCELLATION_DISPATCH_BLOCKING_RESULTS)[number];

export type RunCancellationDispatchDiagnostic = Readonly<{
  projectId: string;
  runId: string;
  runStatus: RunStatus;
  runVersion: number;
  eventSequence: number;
  cancelRequestedAtMs?: number;
  cancelReason?: 'user' | 'policy' | 'shutdown' | 'reconcile' | 'timeout';
  operatorAction: 'none' | 'wait' | 'rearm';
  dispatch: Readonly<{
    attemptId: string;
    status: CancellationDispatchStatus;
    version: number;
    dispatchCount: number;
    nextAttemptAtMs?: number;
    leaseExpiresAtMs?: number;
    lastResult?: CancellationDispatchResult;
    lastDispatchedAtMs?: number;
    createdAtMs: number;
    updatedAtMs: number;
  }> | null;
}>;

export type RunCancellationDispatchRearmReceipt = Readonly<{
  status: 'rearmed';
  projectId: string;
  runId: string;
  attemptId: string;
  previousDispatchVersion: number;
  dispatchVersion: number;
  previousResult: BlockingCancellationDispatchResult;
  retryDelayMs: number;
  nextAttemptAtMs: number;
  runVersion: number;
  eventSequence: number;
}>;

interface ManagementAuthority {
  readonly projectId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
}

export interface PostgresRunCancellationDispatchInspectCommand
  extends ManagementAuthority {}

export interface PostgresRunCancellationDispatchRearmCommand
  extends ManagementAuthority {
  readonly mutationId: string;
  readonly eventId: string;
  readonly expectedDispatchVersion: number;
  readonly expectedLastResult: BlockingCancellationDispatchResult;
  readonly retryDelayMs: number;
}

export class InvalidRunCancellationDispatchManagementError extends TypeError {
  readonly code = 'RUN_CANCELLATION_DISPATCH_MANAGEMENT_INVALID';
  constructor() {
    super('Run cancellation dispatch management input is invalid');
    this.name = 'InvalidRunCancellationDispatchManagementError';
  }
}

export class RunCancellationDispatchManagementNotFoundError extends Error {
  readonly code = 'RUN_CANCELLATION_DISPATCH_MANAGEMENT_NOT_FOUND';
  constructor() {
    super('Run cancellation dispatch management target is unavailable');
    this.name = 'RunCancellationDispatchManagementNotFoundError';
  }
}

export class RunCancellationDispatchManagementConflictError extends Error {
  readonly code = 'RUN_CANCELLATION_DISPATCH_MANAGEMENT_CONFLICT';
  constructor(
    readonly reason:
      | 'authorization_changed'
      | 'run_terminal'
      | 'cancellation_missing'
      | 'dispatch_missing'
      | 'dispatch_not_blocked'
      | 'dispatch_version_changed'
      | 'dispatch_result_changed'
      | 'attempt_not_active'
      | 'mutation_conflict',
  ) {
    super(`Run cancellation dispatch management conflict: ${reason}`);
    this.name = 'RunCancellationDispatchManagementConflictError';
  }
}

export class RunCancellationDispatchManagementUnavailableError extends Error {
  readonly code = 'RUN_CANCELLATION_DISPATCH_MANAGEMENT_UNAVAILABLE';
  constructor(options?: ErrorOptions) {
    super('Run cancellation dispatch management is unavailable', options);
    this.name = 'RunCancellationDispatchManagementUnavailableError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STRONG_ASSURANCES = new Set(['multi_factor', 'hardware']);
const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  'created',
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'retry_wait',
  'lost',
]);
const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const CANCEL_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);
const MAX_AUTHENTICATION_AGE_MS = 5 * 60_000;
const MIN_MANUAL_RETRY_DELAY_MS = 1_000;
const REARM_SCHEMA = 'qinglong/run-cancellation-dispatch-rearm@v1';

function invalid(): never {
  throw new InvalidRunCancellationDispatchManagementError();
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL cancellation management ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value =
    typeof raw === 'string' && /^(0|[1-9]\d*)$/u.test(raw)
      ? Number(raw)
      : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`PostgreSQL cancellation management ${key} is invalid`);
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

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid();
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid();
  }
  return value;
}

function storedInteger(
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`PostgreSQL cancellation management ${name} is invalid`);
  }
  return value;
}

function normalizeAuthority(
  value: unknown,
  extraKeys: readonly string[],
): Readonly<ManagementAuthority> & Record<string, unknown> {
  const input = exact(value, [
    'projectId',
    'runId',
    'requestId',
    'auditEventId',
    'principal',
    'policyFence',
    ...extraKeys,
  ]);
  const principal = exact(input.principal, [
    'subject',
    'authenticationId',
    'authenticatedAtMs',
    'expiresAtMs',
    'assurance',
  ]) as unknown as SecurityPrincipal;
  const fence = exact(input.policyFence, [
    'projectVersion',
    'bindingVersion',
  ]);
  return Object.freeze({
    ...input,
    projectId: identifier(input.projectId),
    runId: identifier(input.runId),
    requestId: identifier(input.requestId),
    auditEventId: uuid(input.auditEventId),
    principal,
    policyFence: Object.freeze({
      projectVersion: boundedInteger(fence.projectVersion, 1, 2_147_483_647),
      bindingVersion: boundedInteger(fence.bindingVersion, 1, 2_147_483_647),
    }),
  });
}

function normalizeInspectCommand(
  value: Readonly<PostgresRunCancellationDispatchInspectCommand>,
): Readonly<PostgresRunCancellationDispatchInspectCommand> {
  return normalizeAuthority(value, []);
}

function normalizeRearmCommand(
  value: Readonly<PostgresRunCancellationDispatchRearmCommand>,
): Readonly<PostgresRunCancellationDispatchRearmCommand> {
  const input = normalizeAuthority(value, [
    'mutationId',
    'eventId',
    'expectedDispatchVersion',
    'expectedLastResult',
    'retryDelayMs',
  ]);
  if (
    !CANCELLATION_DISPATCH_BLOCKING_RESULTS.includes(
      input.expectedLastResult as BlockingCancellationDispatchResult,
    )
  ) {
    invalid();
  }
  const eventId = uuid(input.eventId);
  if (eventId === input.auditEventId) invalid();
  return Object.freeze({
    projectId: input.projectId,
    runId: input.runId,
    requestId: input.requestId,
    auditEventId: input.auditEventId,
    principal: input.principal,
    policyFence: input.policyFence,
    mutationId: uuid(input.mutationId),
    eventId,
    expectedDispatchVersion: boundedInteger(
      input.expectedDispatchVersion,
      1,
      2_147_483_646,
    ),
    expectedLastResult:
      input.expectedLastResult as BlockingCancellationDispatchResult,
    retryDelayMs: boundedInteger(
      input.retryDelayMs,
      MIN_MANUAL_RETRY_DELAY_MS,
      MAX_CANCELLATION_DISPATCH_RETRY_DELAY_MS,
    ),
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

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the transaction failure.
  }
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
      AS "nowMs"
  `);
  if (result.rows.length !== 1) {
    throw new TypeError('PostgreSQL cancellation management clock is invalid');
  }
  return integer(result.rows[0]!, 'nowMs');
}

function strongPrincipal(
  value: Readonly<SecurityPrincipal>,
  observedAtMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, observedAtMs);
  } catch {
    throw new RunCancellationDispatchManagementConflictError(
      'authorization_changed',
    );
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_ASSURANCES.has(principal.assurance) ||
    principal.authenticatedAtMs > observedAtMs ||
    observedAtMs - principal.authenticatedAtMs > MAX_AUTHENTICATION_AGE_MS
  ) {
    throw new RunCancellationDispatchManagementConflictError(
      'authorization_changed',
    );
  }
  return principal;
}

async function confirmAuthorization(
  client: PostgresClient,
  command: Readonly<ManagementAuthority>,
): Promise<void> {
  const result = await client.query<Row>(
    `SELECT "ql3"."lock_run_management_policy_fence"(
       $1::varchar, $2::varchar, $3::varchar, $4::integer, $5::integer
     ) AS "matches"`,
    [
      command.projectId,
      command.principal.subject.type,
      command.principal.subject.id,
      command.policyFence.projectVersion,
      command.policyFence.bindingVersion,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.matches !== true) {
    throw new RunCancellationDispatchManagementConflictError(
      'authorization_changed',
    );
  }
}

async function recordAllowedAudit(
  client: PostgresClient,
  command: Readonly<ManagementAuthority>,
  operationId: 'run.cancellation.inspect' | 'run.cancellation.rearm',
  observedAtMs: number,
): Promise<void> {
  const inserted = await client.query<Row>(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id,
       subject_type, subject_id, authentication_id, outcome, reasons,
       project_version, binding_version, occurred_at_ms
     ) VALUES ($1, $2, $3, $4, 'user', $5, $6, 'allowed', $7::jsonb,
               $8, $9, $10)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id AS "eventId"`,
    [
      command.auditEventId,
      command.requestId,
      operationId,
      command.projectId,
      command.principal.subject.id,
      command.principal.authenticationId,
      JSON.stringify(['role_grant', 'strong_authentication']),
      command.policyFence.projectVersion,
      command.policyFence.bindingVersion,
      observedAtMs,
    ],
  );
  if (inserted.rows.length === 1) return;
  const replay = await client.query<Row>(
    `SELECT request_id AS "requestId", operation_id AS "operationId",
            project_id AS "projectId", subject_type AS "subjectType",
            subject_id AS "subjectId", authentication_id AS "authenticationId",
            outcome, reasons, project_version AS "projectVersion",
            binding_version AS "bindingVersion"
       FROM "ql3"."security_audit_events" WHERE event_id = $1`,
    [command.auditEventId],
  );
  const row = replay.rows[0];
  if (
    replay.rows.length !== 1 ||
    !row ||
    row.requestId !== command.requestId ||
    row.operationId !== operationId ||
    row.projectId !== command.projectId ||
    row.subjectType !== 'user' ||
    row.subjectId !== command.principal.subject.id ||
    row.authenticationId !== command.principal.authenticationId ||
    row.outcome !== 'allowed' ||
    !Array.isArray(row.reasons) ||
    row.reasons.join('\0') !== 'role_grant\0strong_authentication' ||
    integer(row, 'projectVersion') !== command.policyFence.projectVersion ||
    integer(row, 'bindingVersion') !== command.policyFence.bindingVersion
  ) {
    throw new RunCancellationDispatchManagementConflictError(
      'mutation_conflict',
    );
  }
}

function runStatus(row: Row): RunStatus {
  const value = text(row, 'runStatus') as RunStatus;
  if (!RUN_STATUSES.includes(value)) {
    throw new TypeError('PostgreSQL cancellation management Run status is invalid');
  }
  return value;
}

function dispatchProjection(row: Row): NonNullable<RunCancellationDispatchDiagnostic['dispatch']> {
  const status = text(row, 'dispatchStatus') as CancellationDispatchStatus;
  const lastResult = optionalText(row, 'lastResult') as
    | CancellationDispatchResult
    | undefined;
  if (
    !CANCELLATION_DISPATCH_STATUSES.includes(status) ||
    (lastResult !== undefined &&
      !CANCELLATION_DISPATCH_RESULTS.includes(lastResult))
  ) {
    throw new TypeError('PostgreSQL cancellation management dispatch is invalid');
  }
  const nextAttemptAtMs = optionalInteger(row, 'nextAttemptAtMs');
  const leaseExpiresAtMs = optionalInteger(row, 'leaseExpiresAtMs');
  const lastDispatchedAtMs = optionalInteger(row, 'lastDispatchedAtMs');
  return Object.freeze({
    attemptId: text(row, 'attemptId'),
    status,
    version: integer(row, 'dispatchVersion'),
    dispatchCount: integer(row, 'dispatchCount'),
    ...(nextAttemptAtMs === undefined ? {} : { nextAttemptAtMs }),
    ...(leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs }),
    ...(lastResult === undefined ? {} : { lastResult }),
    ...(lastDispatchedAtMs === undefined ? {} : { lastDispatchedAtMs }),
    createdAtMs: integer(row, 'dispatchCreatedAtMs'),
    updatedAtMs: integer(row, 'dispatchUpdatedAtMs'),
  });
}

function diagnostic(
  command: Readonly<ManagementAuthority>,
  run: Row,
  dispatchRow?: Row,
): Readonly<RunCancellationDispatchDiagnostic> {
  const cancelRequestedAtMs = optionalInteger(run, 'cancelRequestedAtMs');
  const cancelReason = optionalText(run, 'cancelReason');
  if (
    (cancelRequestedAtMs === undefined) !== (cancelReason === undefined) ||
    (cancelReason !== undefined && !CANCEL_REASONS.has(cancelReason))
  ) {
    throw new TypeError('PostgreSQL cancellation management intent is invalid');
  }
  const dispatch = dispatchRow ? dispatchProjection(dispatchRow) : null;
  return Object.freeze({
    projectId: command.projectId,
    runId: command.runId,
    runStatus: runStatus(run),
    runVersion: integer(run, 'runVersion'),
    eventSequence: integer(run, 'eventSequence'),
    ...(cancelRequestedAtMs === undefined
      ? {}
      : {
          cancelRequestedAtMs,
          cancelReason: cancelReason as NonNullable<
            RunCancellationDispatchDiagnostic['cancelReason']
          >,
        }),
    operatorAction:
      dispatch?.status === 'blocked'
        ? 'rearm'
        : dispatch && dispatch.status !== 'dispatched'
          ? 'wait'
          : cancelRequestedAtMs !== undefined && !dispatch
            ? 'wait'
            : 'none',
    dispatch,
  });
}

function rearmReceiptFromEvent(
  command: Readonly<PostgresRunCancellationDispatchRearmCommand>,
  event: Row,
): Readonly<RunCancellationDispatchRearmReceipt> {
  const payload = exact(event.payload, [
    'schema',
    'mutation_id',
    'previous_dispatch_version',
    'dispatch_version',
    'previous_result',
    'retry_delay_ms',
    'next_attempt_at_ms',
    'run_version',
  ]);
  if (
    text(event, 'eventId') !== command.eventId ||
    text(event, 'eventType') !== 'run.cancel_dispatch_rearmed' ||
    text(event, 'actorType') !== 'user' ||
    text(event, 'actorId') !== command.principal.subject.id ||
    payload.schema !== REARM_SCHEMA ||
    payload.mutation_id !== command.mutationId ||
    payload.previous_dispatch_version !== command.expectedDispatchVersion ||
    payload.previous_result !== command.expectedLastResult ||
    payload.retry_delay_ms !== command.retryDelayMs
  ) {
    throw new RunCancellationDispatchManagementConflictError(
      'mutation_conflict',
    );
  }
  return Object.freeze({
    status: 'rearmed',
    projectId: command.projectId,
    runId: command.runId,
    attemptId: text(event, 'attemptId'),
    previousDispatchVersion: storedInteger(
      payload.previous_dispatch_version,
      'previousDispatchVersion',
      1,
    ),
    dispatchVersion: storedInteger(
      payload.dispatch_version,
      'dispatchVersion',
      2,
    ),
    previousResult:
      payload.previous_result as BlockingCancellationDispatchResult,
    retryDelayMs: storedInteger(
      payload.retry_delay_ms,
      'retryDelayMs',
      MIN_MANUAL_RETRY_DELAY_MS,
      MAX_CANCELLATION_DISPATCH_RETRY_DELAY_MS,
    ),
    nextAttemptAtMs: storedInteger(
      payload.next_attempt_at_ms,
      'nextAttemptAtMs',
    ),
    runVersion: storedInteger(payload.run_version, 'runVersion', 1),
    eventSequence: integer(event, 'eventSequence'),
  });
}

export class PostgresRunCancellationDispatchManagementRepository {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new InvalidRunCancellationDispatchManagementError();
    }
  }

  inspect(
    value: Readonly<PostgresRunCancellationDispatchInspectCommand>,
  ): Promise<Readonly<RunCancellationDispatchDiagnostic>> {
    const command = normalizeInspectCommand(value);
    return this.transaction(async (client) => {
      const observedAtMs = await databaseNow(client);
      const authorized = Object.freeze({
        ...command,
        principal: strongPrincipal(command.principal, observedAtMs),
      });
      await confirmAuthorization(client, authorized);
      const run = await client.query<Row>(
        `SELECT project_id AS "projectId", status AS "runStatus",
                version AS "runVersion", event_sequence AS "eventSequence",
                cancel_requested_at_ms AS "cancelRequestedAtMs",
                cancel_reason AS "cancelReason"
           FROM "ql3"."runs" WHERE id = $1`,
        [command.runId],
      );
      if (
        run.rows.length !== 1 ||
        run.rows[0]?.projectId !== command.projectId
      ) {
        throw new RunCancellationDispatchManagementNotFoundError();
      }
      const dispatch = await client.query<Row>(
        `SELECT attempt_id AS "attemptId", status AS "dispatchStatus",
                version AS "dispatchVersion", dispatch_count AS "dispatchCount",
                next_attempt_at_ms AS "nextAttemptAtMs",
                lease_expires_at_ms AS "leaseExpiresAtMs",
                last_result AS "lastResult",
                last_dispatched_at_ms AS "lastDispatchedAtMs",
                created_at_ms AS "dispatchCreatedAtMs",
                updated_at_ms AS "dispatchUpdatedAtMs"
           FROM "ql3"."run_cancellation_dispatches" WHERE run_id = $1`,
        [command.runId],
      );
      if (dispatch.rows.length > 1) {
        throw new TypeError('PostgreSQL cancellation management dispatch duplicated');
      }
      await recordAllowedAudit(
        client,
        authorized,
        'run.cancellation.inspect',
        observedAtMs,
      );
      return diagnostic(authorized, run.rows[0]!, dispatch.rows[0]);
    });
  }

  rearm(
    value: Readonly<PostgresRunCancellationDispatchRearmCommand>,
  ): Promise<Readonly<RunCancellationDispatchRearmReceipt>> {
    const command = normalizeRearmCommand(value);
    return this.transaction(async (client) => {
      const observedAtMs = await databaseNow(client);
      const authorized = Object.freeze({
        ...command,
        principal: strongPrincipal(command.principal, observedAtMs),
      });
      await confirmAuthorization(client, authorized);
      const run = await client.query<Row>(
        `SELECT project_id AS "projectId", status AS "runStatus",
                version AS "runVersion", event_sequence AS "eventSequence",
                cancel_requested_at_ms AS "cancelRequestedAtMs"
           FROM "ql3"."runs" WHERE id = $1 FOR UPDATE`,
        [command.runId],
      );
      if (
        run.rows.length !== 1 ||
        run.rows[0]?.projectId !== command.projectId
      ) {
        throw new RunCancellationDispatchManagementNotFoundError();
      }
      const dedupeKey = `cancel-dispatch-rearm:${command.mutationId}`;
      const replay = await client.query<Row>(
        `SELECT id AS "eventId", sequence AS "eventSequence",
                type AS "eventType", actor_type AS "actorType",
                actor_id AS "actorId", attempt_id AS "attemptId", payload
           FROM "ql3"."run_events"
          WHERE run_id = $1 AND dedupe_key = $2`,
        [command.runId, dedupeKey],
      );
      if (replay.rows.length === 1) {
        const receipt = rearmReceiptFromEvent(authorized, replay.rows[0]!);
        await recordAllowedAudit(
          client,
          authorized,
          'run.cancellation.rearm',
          observedAtMs,
        );
        return receipt;
      }
      if (replay.rows.length !== 0) {
        throw new RunCancellationDispatchManagementConflictError(
          'mutation_conflict',
        );
      }
      if (!ACTIVE_RUN_STATUSES.has(runStatus(run.rows[0]!))) {
        throw new RunCancellationDispatchManagementConflictError('run_terminal');
      }
      if (optionalInteger(run.rows[0]!, 'cancelRequestedAtMs') === undefined) {
        throw new RunCancellationDispatchManagementConflictError(
          'cancellation_missing',
        );
      }
      const candidate = await client.query<Row>(
        `SELECT attempt_id AS "attemptId"
           FROM "ql3"."run_cancellation_dispatches" WHERE run_id = $1`,
        [command.runId],
      );
      if (candidate.rows.length !== 1) {
        throw new RunCancellationDispatchManagementConflictError(
          'dispatch_missing',
        );
      }
      const attemptId = text(candidate.rows[0]!, 'attemptId');
      const attempt = await client.query<Row>(
        `SELECT status AS "attemptStatus" FROM "ql3"."run_attempts"
          WHERE run_id = $1 AND id = $2`,
        [command.runId, attemptId],
      );
      if (
        attempt.rows.length !== 1 ||
        !ACTIVE_ATTEMPT_STATUSES.has(text(attempt.rows[0]!, 'attemptStatus'))
      ) {
        throw new RunCancellationDispatchManagementConflictError(
          'attempt_not_active',
        );
      }
      const dispatch = await client.query<Row>(
        `SELECT attempt_id AS "attemptId", status AS "dispatchStatus",
                version AS "dispatchVersion", last_result AS "lastResult"
           FROM "ql3"."run_cancellation_dispatches"
          WHERE run_id = $1 FOR UPDATE`,
        [command.runId],
      );
      if (dispatch.rows.length !== 1) {
        throw new RunCancellationDispatchManagementConflictError(
          'dispatch_missing',
        );
      }
      const current = dispatch.rows[0]!;
      if (
        text(current, 'attemptId') !== attemptId ||
        text(current, 'dispatchStatus') !== 'blocked'
      ) {
        throw new RunCancellationDispatchManagementConflictError(
          'dispatch_not_blocked',
        );
      }
      if (integer(current, 'dispatchVersion') !== command.expectedDispatchVersion) {
        throw new RunCancellationDispatchManagementConflictError(
          'dispatch_version_changed',
        );
      }
      if (text(current, 'lastResult') !== command.expectedLastResult) {
        throw new RunCancellationDispatchManagementConflictError(
          'dispatch_result_changed',
        );
      }
      const nextAttemptAtMs = observedAtMs + command.retryDelayMs;
      const runVersion = integer(run.rows[0]!, 'runVersion');
      const eventSequence = integer(run.rows[0]!, 'eventSequence');
      if (
        !Number.isSafeInteger(nextAttemptAtMs) ||
        runVersion >= 2_147_483_647 ||
        eventSequence >= 2_147_483_647
      ) {
        throw new TypeError('PostgreSQL cancellation management counter overflowed');
      }
      const dispatchVersion = command.expectedDispatchVersion + 1;
      const nextRunVersion = runVersion + 1;
      const nextEventSequence = eventSequence + 1;
      const runUpdated = await client.query(
        `UPDATE "ql3"."runs"
            SET version = $2, event_sequence = $3
          WHERE id = $1 AND version = $4`,
        [command.runId, nextRunVersion, nextEventSequence, runVersion],
      );
      if (runUpdated.rowCount !== 1) {
        throw new RunCancellationDispatchManagementConflictError(
          'dispatch_version_changed',
        );
      }
      const dispatchUpdated = await client.query(
        `UPDATE "ql3"."run_cancellation_dispatches"
            SET status = 'retry_wait', version = $2,
                next_attempt_at_ms = $3, updated_at_ms = $4
          WHERE run_id = $1 AND attempt_id = $5 AND status = 'blocked'
            AND version = $6 AND last_result = $7`,
        [
          command.runId,
          dispatchVersion,
          nextAttemptAtMs,
          observedAtMs,
          attemptId,
          command.expectedDispatchVersion,
          command.expectedLastResult,
        ],
      );
      if (dispatchUpdated.rowCount !== 1) {
        throw new RunCancellationDispatchManagementConflictError(
          'dispatch_version_changed',
        );
      }
      const payload = Object.freeze({
        schema: REARM_SCHEMA,
        mutation_id: command.mutationId,
        previous_dispatch_version: command.expectedDispatchVersion,
        dispatch_version: dispatchVersion,
        previous_result: command.expectedLastResult,
        retry_delay_ms: command.retryDelayMs,
        next_attempt_at_ms: nextAttemptAtMs,
        run_version: nextRunVersion,
      });
      await client.query(
        `INSERT INTO "ql3"."run_events" (
           id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
           attempt_id, step_run_id, payload, created_at_ms
         ) VALUES ($1, $2, $3, 'run.cancel_dispatch_rearmed', $4,
                   'user', $5, $6, NULL, $7::jsonb, $8)`,
        [
          command.eventId,
          command.runId,
          nextEventSequence,
          dedupeKey,
          authorized.principal.subject.id,
          attemptId,
          JSON.stringify(payload),
          observedAtMs,
        ],
      );
      await recordAllowedAudit(
        client,
        authorized,
        'run.cancellation.rearm',
        observedAtMs,
      );
      return Object.freeze({
        status: 'rearmed',
        projectId: command.projectId,
        runId: command.runId,
        attemptId,
        previousDispatchVersion: command.expectedDispatchVersion,
        dispatchVersion,
        previousResult: command.expectedLastResult,
        retryDelayMs: command.retryDelayMs,
        nextAttemptAtMs,
        runVersion: nextRunVersion,
        eventSequence: nextEventSequence,
      });
    });
  }

  private async transaction<T>(
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.pool.connect();
      await begin(client);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await rollback(client);
      if (
        error instanceof InvalidRunCancellationDispatchManagementError ||
        error instanceof RunCancellationDispatchManagementNotFoundError ||
        error instanceof RunCancellationDispatchManagementConflictError
      ) {
        throw error;
      }
      throw new RunCancellationDispatchManagementUnavailableError({
        cause: error,
      });
    } finally {
      client?.release();
    }
  }
}
