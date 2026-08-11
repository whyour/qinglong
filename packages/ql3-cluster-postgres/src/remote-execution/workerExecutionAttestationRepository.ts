// PostgreSQL Worker execution attestations are owned by this domain.
import {
  WorkerExecutionAttestationFenceRejectedError,
  WorkerExecutionAttestationUnavailableError,
  normalizeSubmitWorkerExecutionAttestationCommand,
  normalizeWorkerExecutionAttestation,
  type SubmitWorkerExecutionAttestationCommand,
  type SubmitWorkerExecutionAttestationResult,
  type WorkerExecutionAttestationRecord,
  type WorkerExecutionAttestationRepository,
} from '@qinglong/runtime-core/worker-attestation';
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';

type Row = Record<string, unknown>;

const COLUMNS = `
  attestation_id AS "attestationId", run_id AS "runId",
  attempt_id AS "attemptId", sequence, state, worker_id AS "workerId",
  worker_session_id AS "workerSessionId",
  worker_generation AS "workerGeneration",
  lease_token_digest AS "leaseTokenDigest",
  lease_generation AS "leaseGeneration", lease_version AS "leaseVersion",
  offer_id AS "offerId", callback_sequence AS "callbackSequence",
  executor_handle AS "executorHandle", journal_revision AS "journalRevision",
  received_at_ms AS "receivedAtMs"
`.trim();

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL Worker attestation ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`PostgreSQL Worker attestation ${key} is invalid`);
  }
  return value;
}

function record(row: Row): Readonly<WorkerExecutionAttestationRecord> {
  return normalizeWorkerExecutionAttestation({
    attestationId: text(row, 'attestationId'),
    runId: text(row, 'runId'),
    attemptId: text(row, 'attemptId'),
    sequence: integer(row, 'sequence'),
    state: text(row, 'state') as WorkerExecutionAttestationRecord['state'],
    workerId: text(row, 'workerId'),
    workerSessionId: text(row, 'workerSessionId'),
    workerGeneration: integer(row, 'workerGeneration'),
    leaseTokenDigest: text(row, 'leaseTokenDigest'),
    leaseGeneration: integer(row, 'leaseGeneration'),
    leaseVersion: integer(row, 'leaseVersion'),
    offerId: text(row, 'offerId'),
    callbackSequence: integer(row, 'callbackSequence'),
    executorHandle: text(row, 'executorHandle'),
    journalRevision: integer(row, 'journalRevision'),
    receivedAtMs: integer(row, 'receivedAtMs'),
  });
}

function sameCommand(
  current: Readonly<WorkerExecutionAttestationRecord>,
  command: Readonly<SubmitWorkerExecutionAttestationCommand>,
): boolean {
  const { receivedAtMs: _receivedAtMs, ...semantic } = current;
  return JSON.stringify(semantic) === JSON.stringify(command);
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
}

export class PostgresWorkerExecutionAttestationRepository
  implements WorkerExecutionAttestationRepository
{
  constructor(private readonly pool: PostgresPool) {}

  async submit(
    input: SubmitWorkerExecutionAttestationCommand,
  ): Promise<SubmitWorkerExecutionAttestationResult> {
    const command = normalizeSubmitWorkerExecutionAttestationCommand(input);
    const client = await this.pool.connect();
    try {
      await begin(client);
      await lockAttemptAuthority(client, command.attemptId);
      const replayResult = await client.query<Row>(
        `SELECT ${COLUMNS} FROM "ql3"."worker_execution_attestations" WHERE attestation_id = $1`,
        [command.attestationId],
      );
      if (replayResult.rows.length > 1) {
        throw new WorkerExecutionAttestationUnavailableError();
      }
      if (replayResult.rows[0]) {
        const current = record(replayResult.rows[0]);
        if (!sameCommand(current, command)) {
          throw new WorkerExecutionAttestationFenceRejectedError('attestation_id_conflict');
        }
        await client.query('COMMIT');
        return Object.freeze({ status: 'existing', attestation: current });
      }

      const authority = await client.query<Row>(
        `
          SELECT attempt.run_id AS "attemptRunId", attempt.status AS "attemptStatus",
                 attempt.worker_id AS "attemptWorkerId",
                 attempt.worker_session_id AS "attemptWorkerSessionId",
                 attempt.worker_generation AS "attemptWorkerGeneration",
                 attempt.lease_token_digest AS "attemptLeaseTokenDigest",
                 attempt.lease_generation AS "attemptLeaseGeneration",
                 attempt.lease_version AS "attemptLeaseVersion",
                 attempt.offer_id AS "attemptOfferId",
                 attempt.callback_sequence AS "attemptCallbackSequence",
                 attempt.executor_handle AS "attemptExecutorHandle",
                 session.session_id AS "sessionId",
                 session.generation AS "sessionGeneration",
                 lease.run_id AS "leaseRunId", lease.status AS "leaseStatus",
                 lease.worker_id AS "leaseWorkerId",
                 lease.worker_session_id AS "leaseWorkerSessionId",
                 lease.worker_generation AS "leaseWorkerGeneration",
                 lease.lease_token_digest AS "leaseTokenDigest",
                 lease.lease_generation AS "leaseGeneration",
                 lease.version AS "leaseVersion", lease.offer_id AS "leaseOfferId"
          FROM "ql3"."run_attempts" AS attempt
          JOIN "ql3"."run_dispatch_leases" AS lease ON lease.attempt_id = attempt.id
          JOIN "ql3"."worker_sessions" AS session ON session.worker_id = lease.worker_id
          WHERE attempt.id = $1
        `,
        [command.attemptId],
      );
      const row = authority.rows[0];
      const matches =
        row &&
        row.attemptRunId === command.runId &&
        (row.attemptStatus === 'starting' || row.attemptStatus === 'running') &&
        row.attemptWorkerId === command.workerId &&
        row.attemptWorkerSessionId === command.workerSessionId &&
        integer(row, 'attemptWorkerGeneration') === command.workerGeneration &&
        row.attemptLeaseTokenDigest === command.leaseTokenDigest &&
        integer(row, 'attemptLeaseGeneration') === command.leaseGeneration &&
        integer(row, 'attemptLeaseVersion') === command.leaseVersion &&
        row.attemptOfferId === command.offerId &&
        integer(row, 'attemptCallbackSequence') === command.callbackSequence &&
        row.attemptExecutorHandle === command.executorHandle &&
        row.sessionId === command.workerSessionId &&
        integer(row, 'sessionGeneration') === command.workerGeneration &&
        row.leaseRunId === command.runId &&
        row.leaseStatus === 'leased' &&
        row.leaseWorkerId === command.workerId &&
        row.leaseWorkerSessionId === command.workerSessionId &&
        integer(row, 'leaseWorkerGeneration') === command.workerGeneration &&
        row.leaseTokenDigest === command.leaseTokenDigest &&
        integer(row, 'leaseGeneration') === command.leaseGeneration &&
        integer(row, 'leaseVersion') === command.leaseVersion &&
        row.leaseOfferId === command.offerId;
      if (!matches) {
        throw new WorkerExecutionAttestationFenceRejectedError('authority_mismatch');
      }

      const previous = await client.query<Row>(
        `
          SELECT sequence, state, journal_revision AS "journalRevision"
          FROM "ql3"."worker_execution_attestations"
          WHERE attempt_id = $1 AND lease_generation = $2
          ORDER BY sequence DESC LIMIT 1
        `,
        [command.attemptId, command.leaseGeneration],
      );
      const last = previous.rows[0];
      if (
        command.sequence !== (last ? integer(last, 'sequence') + 1 : 1) ||
        (last && integer(last, 'journalRevision') >= command.journalRevision) ||
        (last?.state === 'stopped' && command.state !== 'stopped')
      ) {
        throw new WorkerExecutionAttestationFenceRejectedError('sequence_mismatch');
      }
      const nowResult = await client.query<Row>(
        `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "receivedAtMs"`,
      );
      const receivedAtMs = integer(nowResult.rows[0]!, 'receivedAtMs');
      const inserted = await client.query<Row>(
        `
          INSERT INTO "ql3"."worker_execution_attestations" (
            attestation_id, run_id, attempt_id, sequence, state, worker_id,
            worker_session_id, worker_generation, lease_token_digest,
            lease_generation, lease_version, offer_id, callback_sequence,
            executor_handle, journal_revision, received_at_ms
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
          ) RETURNING ${COLUMNS}
        `,
        [
          command.attestationId, command.runId, command.attemptId,
          command.sequence, command.state, command.workerId,
          command.workerSessionId, command.workerGeneration,
          command.leaseTokenDigest, command.leaseGeneration,
          command.leaseVersion, command.offerId, command.callbackSequence,
          command.executorHandle, command.journalRevision, receivedAtMs,
        ],
      );
      const attestation = record(inserted.rows[0]!);
      await client.query('COMMIT');
      return Object.freeze({ status: 'created', attestation });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve root */ }
      if (
        error instanceof WorkerExecutionAttestationFenceRejectedError ||
        error instanceof WorkerExecutionAttestationUnavailableError
      ) throw error;
      throw new WorkerExecutionAttestationUnavailableError();
    } finally {
      client.release();
    }
  }

  async findLatestExact(
    target: Parameters<WorkerExecutionAttestationRepository['findLatestExact']>[0],
  ): Promise<Readonly<WorkerExecutionAttestationRecord> | null> {
    const result = await this.pool.query<Row>(
      `
        SELECT ${COLUMNS}
        FROM "ql3"."worker_execution_attestations"
        WHERE run_id = $1 AND attempt_id = $2 AND worker_id = $3
          AND worker_session_id = $4 AND worker_generation = $5
          AND lease_token_digest = $6 AND lease_generation = $7
          AND lease_version = $8 AND offer_id = $9
          AND callback_sequence = $10 AND executor_handle = $11
        ORDER BY sequence DESC LIMIT 1
      `,
      [
        target.runId, target.attemptId, target.workerId,
        target.workerSessionId, target.workerGeneration,
        target.leaseTokenDigest, target.leaseGeneration, target.leaseVersion,
        target.offerId, target.callbackSequence, target.executorHandle,
      ],
    );
    try {
      return result.rows[0] ? record(result.rows[0]) : null;
    } catch {
      throw new WorkerExecutionAttestationUnavailableError();
    }
  }
}
