// Remote Worker Secret delivery authority persistence is owned by this domain.
import {
  RemoteWorkerSecretDeliveryFenceRejectedError,
  RemoteWorkerSecretDeliveryUnavailableError,
  normalizeRemoteWorkerSecretDeliveryCommand,
  type RemoteWorkerSecretDeliveryAuthority,
  type RemoteWorkerSecretDeliveryAuthorityRepository,
  type RemoteWorkerSecretDeliveryCommand,
} from '@qinglong/runtime-core/remote-secret-delivery';
import {
  normalizeClusterTaskExecutionRevision,
  type ClusterTaskExecutionRevision,
} from '@qinglong/runtime-core/cluster-execution-revision';
import { digestRunDispatchLeaseToken } from '@qinglong/runtime-core/run-dispatch-lease';
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new RemoteWorkerSecretDeliveryUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value =
    typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RemoteWorkerSecretDeliveryUnavailableError();
  }
  return value;
}

function executionRevision(row: Row): ClusterTaskExecutionRevision {
  const plan = row.planJson;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new RemoteWorkerSecretDeliveryUnavailableError();
  }
  const value = plan as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    !keys.includes('command') ||
    !keys.includes('environment') ||
    keys.some(
      (key) =>
        ![
          'command',
          'environment',
          'environmentBundleRef',
          'placement',
          'timeoutMs',
          'workingDirectory',
        ].includes(key),
    )
  )
    throw new RemoteWorkerSecretDeliveryUnavailableError();
  return normalizeClusterTaskExecutionRevision({
    projectId: text(row, 'revisionProjectId'),
    taskId: text(row, 'revisionTaskId'),
    sourceRevision: integer(row, 'sourceRevision'),
    taskRevision: text(row, 'revisionTaskRevision'),
    sourceContentDigest: text(row, 'sourceContentDigest'),
    executorType: text(row, 'revisionExecutorType') as 'remote_worker',
    planSchema: text(row, 'planSchema') as 'qinglong/command-execution@v1',
    command: value.command as ClusterTaskExecutionRevision['command'],
    environment:
      value.environment as ClusterTaskExecutionRevision['environment'],
    ...(value.environmentBundleRef === undefined
      ? {}
      : { environmentBundleRef: value.environmentBundleRef as string }),
    ...(value.workingDirectory === undefined
      ? {}
      : { workingDirectory: value.workingDirectory as string }),
    ...(value.timeoutMs === undefined
      ? {}
      : { timeoutMs: value.timeoutMs as number }),
    ...(value.placement === undefined
      ? {}
      : {
          placement: value.placement as NonNullable<
            ClusterTaskExecutionRevision['placement']
          >,
        }),
    contentDigest: text(row, 'revisionContentDigest'),
    createdAtMs: integer(row, 'revisionCreatedAtMs'),
  });
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
}

export class PostgresRemoteWorkerSecretDeliveryAuthorityRepository
  implements RemoteWorkerSecretDeliveryAuthorityRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL remote Secret delivery pool is invalid');
    }
  }

  async authorize(
    input: RemoteWorkerSecretDeliveryCommand,
  ): Promise<Readonly<RemoteWorkerSecretDeliveryAuthority>> {
    const command = normalizeRemoteWorkerSecretDeliveryCommand(input);
    const client = await this.pool.connect();
    try {
      await begin(client);
      await lockAttemptAuthority(client, command.attemptId);
      const result = await client.query<Row>(
        `WITH observation AS MATERIALIZED (
           SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
             AS observed_at_ms
         )
         SELECT observation.observed_at_ms AS "observedAtMs",
                run.id AS "runId", run.project_id AS "runProjectId",
                run.task_id AS "runTaskId", run.task_revision AS "runTaskRevision",
                run.status AS "runStatus", run.execution_owner AS "executionOwner",
                run.cancel_requested_at_ms AS "cancelRequestedAtMs",
                attempt.status AS "attemptStatus",
                attempt.executor_type AS "attemptExecutorType",
                attempt.worker_id AS "attemptWorkerId",
                attempt.worker_session_id AS "attemptWorkerSessionId",
                attempt.worker_generation AS "attemptWorkerGeneration",
                attempt.lease_token_digest AS "attemptLeaseTokenDigest",
                attempt.lease_generation AS "attemptLeaseGeneration",
                attempt.lease_version AS "attemptLeaseVersion",
                attempt.offer_id AS "attemptOfferId",
                session.session_id AS "sessionId",
                session.generation AS "sessionGeneration",
                session.status AS "sessionStatus",
                session.lease_expires_at_ms AS "sessionExpiresAtMs",
                lease.run_id AS "leaseRunId", lease.status AS "leaseStatus",
                lease.version AS "leaseVersion",
                lease.lease_generation AS "leaseGeneration",
                lease.worker_id AS "leaseWorkerId",
                lease.worker_session_id AS "leaseWorkerSessionId",
                lease.worker_generation AS "leaseWorkerGeneration",
                lease.lease_token_digest AS "leaseTokenDigest",
                lease.offer_id AS "leaseOfferId",
                lease.expires_at_ms AS "leaseExpiresAtMs",
                revision.project_id AS "revisionProjectId",
                revision.task_id AS "revisionTaskId",
                revision.source_revision AS "sourceRevision",
                revision.task_revision AS "revisionTaskRevision",
                revision.source_content_digest AS "sourceContentDigest",
                revision.executor_type AS "revisionExecutorType",
                revision.plan_schema AS "planSchema",
                revision.plan_json AS "planJson",
                revision.content_digest AS "revisionContentDigest",
                revision.created_at_ms AS "revisionCreatedAtMs"
         FROM observation
         JOIN "ql3"."run_attempts" AS attempt ON attempt.id = $1
         JOIN "ql3"."runs" AS run ON run.id = attempt.run_id
         JOIN "ql3"."run_dispatch_leases" AS lease
           ON lease.attempt_id = attempt.id
         JOIN "ql3"."worker_sessions" AS session
           ON session.worker_id = lease.worker_id
         JOIN "ql3"."task_execution_revisions" AS revision
           ON revision.project_id = run.project_id
          AND revision.task_id = run.task_id
          AND revision.task_revision = run.task_revision
          AND revision.executor_type = 'remote_worker'`,
        [command.attemptId],
      );
      if (result.rows.length > 1) {
        throw new RemoteWorkerSecretDeliveryUnavailableError();
      }
      const row = result.rows[0];
      if (!row) {
        throw new RemoteWorkerSecretDeliveryFenceRejectedError(
          'authority_mismatch',
        );
      }
      const observedAtMs = integer(row, 'observedAtMs');
      const tokenDigest = digestRunDispatchLeaseToken(command.leaseToken);
      const matches =
        row.runId === command.runId &&
        row.runProjectId === command.projectId &&
        row.runTaskId === command.taskId &&
        row.runTaskRevision === command.taskRevision &&
        row.runStatus === 'dispatching' &&
        row.executionOwner === 'runtime' &&
        row.cancelRequestedAtMs === null &&
        row.attemptStatus === 'starting' &&
        row.attemptExecutorType === 'remote_worker' &&
        row.attemptWorkerId === command.workerId &&
        row.attemptWorkerSessionId === command.workerSessionId &&
        integer(row, 'attemptWorkerGeneration') === command.workerGeneration &&
        row.attemptLeaseTokenDigest === tokenDigest &&
        integer(row, 'attemptLeaseGeneration') === command.leaseGeneration &&
        integer(row, 'attemptLeaseVersion') === command.expectedLeaseVersion &&
        row.attemptOfferId === command.offerId &&
        row.sessionId === command.workerSessionId &&
        integer(row, 'sessionGeneration') === command.workerGeneration &&
        (row.sessionStatus === 'online' || row.sessionStatus === 'draining') &&
        integer(row, 'sessionExpiresAtMs') > observedAtMs &&
        row.leaseRunId === command.runId &&
        row.leaseStatus === 'leased' &&
        integer(row, 'leaseVersion') === command.expectedLeaseVersion &&
        integer(row, 'leaseGeneration') === command.leaseGeneration &&
        row.leaseWorkerId === command.workerId &&
        row.leaseWorkerSessionId === command.workerSessionId &&
        integer(row, 'leaseWorkerGeneration') === command.workerGeneration &&
        row.leaseTokenDigest === tokenDigest &&
        row.leaseOfferId === command.offerId &&
        integer(row, 'leaseExpiresAtMs') > observedAtMs;
      if (!matches) {
        throw new RemoteWorkerSecretDeliveryFenceRejectedError(
          'authority_mismatch',
        );
      }
      let revision: ClusterTaskExecutionRevision;
      try {
        revision = executionRevision(row);
      } catch (error) {
        if (error instanceof RemoteWorkerSecretDeliveryUnavailableError)
          throw error;
        throw new RemoteWorkerSecretDeliveryUnavailableError();
      }
      const expectedRefs = Object.freeze([
        ...new Set(
          revision.environment.flatMap((binding) =>
            binding.kind === 'secret' ? [binding.secretRef] : [],
          ),
        ),
      ]);
      const expectedEnvironmentBundleRefs = Object.freeze(
        revision.environmentBundleRef === undefined
          ? []
          : [revision.environmentBundleRef],
      );
      if (
        revision.projectId !== command.projectId ||
        revision.taskId !== command.taskId ||
        revision.taskRevision !== command.taskRevision ||
        revision.contentDigest !== command.executionDigest ||
        JSON.stringify(expectedRefs) !== JSON.stringify(command.secretRefs) ||
        JSON.stringify(expectedEnvironmentBundleRefs) !==
          JSON.stringify(command.environmentBundleRefs)
      ) {
        throw new RemoteWorkerSecretDeliveryFenceRejectedError(
          'secret_scope_mismatch',
        );
      }
      const authority = Object.freeze({
        workerId: command.workerId,
        workerSessionId: command.workerSessionId,
        workerGeneration: command.workerGeneration,
        runId: command.runId,
        attemptId: command.attemptId,
        projectId: command.projectId,
        taskId: command.taskId,
        taskRevision: command.taskRevision,
        executionDigest: command.executionDigest,
        offerId: command.offerId,
        leaseGeneration: command.leaseGeneration,
        leaseVersion: command.expectedLeaseVersion,
        secretRefs: expectedRefs,
        environmentBundleRefs: expectedEnvironmentBundleRefs,
      });
      await client.query('COMMIT');
      return authority;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve root */
      }
      if (
        error instanceof RemoteWorkerSecretDeliveryFenceRejectedError ||
        error instanceof RemoteWorkerSecretDeliveryUnavailableError
      )
        throw error;
      throw new RemoteWorkerSecretDeliveryUnavailableError();
    } finally {
      client.release();
    }
  }
}
