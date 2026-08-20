import type { PostgresPool } from '@qinglong/runtime-core';
import {
  WORKER_SESSION_STATUSES,
  assertWorkerCapabilitiesSnapshot,
  assertWorkerConcurrency,
  assertWorkerId,
  assertWorkerSessionId,
  type WorkerSessionRecord,
  type WorkerSessionStatus,
} from '@qinglong/runtime-core/worker-session';
import {
  MAX_WORKER_SESSION_OBSERVATION_PAGE_SIZE,
  projectWorkerSessionObservation,
  summarizeWorkerSessionObservation,
  type WorkerSessionInspection,
  type WorkerSessionObservationPage,
} from '@qinglong/runtime-core/worker-session-observation';

type Row = Record<string, unknown>;

const SELECT_COLUMNS = `
  worker_id AS "workerId",
  session_id AS "sessionId",
  generation AS "generation",
  status AS "status",
  version AS "version",
  capabilities_json AS "capabilitiesJson",
  capabilities_hash AS "capabilitiesHash",
  max_concurrent_runs AS "maxConcurrentRuns",
  available_slots AS "availableSlots",
  registered_at_ms AS "registeredAtMs",
  last_heartbeat_at_ms AS "lastHeartbeatAtMs",
  lease_expires_at_ms AS "leaseExpiresAtMs",
  updated_at_ms AS "updatedAtMs"
`.trim();

function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`PostgreSQL Worker observation ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const normalized =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new TypeError(`PostgreSQL Worker observation ${key} is invalid`);
  }
  return normalized as number;
}

function record(row: Row): Readonly<WorkerSessionRecord> {
  const status = string(row, 'status');
  if (!WORKER_SESSION_STATUSES.includes(status as WorkerSessionStatus)) {
    throw new TypeError('PostgreSQL Worker observation status is invalid');
  }
  const worker: WorkerSessionRecord = Object.freeze({
    workerId: string(row, 'workerId'),
    sessionId: string(row, 'sessionId'),
    generation: integer(row, 'generation'),
    status: status as WorkerSessionStatus,
    version: integer(row, 'version'),
    capabilitiesJson: string(row, 'capabilitiesJson'),
    capabilitiesHash: string(row, 'capabilitiesHash'),
    maxConcurrentRuns: integer(row, 'maxConcurrentRuns'),
    availableSlots: integer(row, 'availableSlots'),
    registeredAtMs: integer(row, 'registeredAtMs'),
    lastHeartbeatAtMs: integer(row, 'lastHeartbeatAtMs'),
    leaseExpiresAtMs: integer(row, 'leaseExpiresAtMs'),
    updatedAtMs: integer(row, 'updatedAtMs'),
  });
  assertWorkerId(worker.workerId);
  assertWorkerSessionId(worker.sessionId);
  assertWorkerCapabilitiesSnapshot(
    worker.capabilitiesJson,
    worker.capabilitiesHash,
  );
  assertWorkerConcurrency(worker.maxConcurrentRuns, worker.availableSlots);
  return worker;
}

function observedAtMs(row: Row): number {
  return integer(row, 'observedAtMs');
}

export class PostgresWorkerSessionObservationRepository {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgreSQL Worker observation Pool is invalid');
    }
  }

  async inspect(workerId: string): Promise<Readonly<WorkerSessionInspection>> {
    assertWorkerId(workerId);
    const result = await this.pool.query<Row>(
      `WITH observation AS (
         SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS observed_at_ms
       )
       SELECT observation.observed_at_ms AS "observedAtMs", worker.*
       FROM observation
       LEFT JOIN LATERAL (
         SELECT ${SELECT_COLUMNS}
         FROM "ql3"."worker_sessions"
         WHERE worker_id = $1
         LIMIT 2
       ) AS worker ON TRUE`,
      [workerId],
    );
    if (result.rows.length !== 1) {
      throw new TypeError('PostgreSQL Worker inspection violated its bound');
    }
    const observed = observedAtMs(result.rows[0]!);
    if (
      result.rows[0]!.workerId !== null &&
      string(result.rows[0]!, 'workerId') !== workerId
    ) {
      throw new TypeError('PostgreSQL Worker inspection identity drifted');
    }
    return Object.freeze({
      observedAtMs: observed,
      worker:
        result.rows[0]!.workerId === null
          ? null
          : projectWorkerSessionObservation(record(result.rows[0]!), observed),
    });
  }

  async list(
    afterWorkerId: string | null,
  ): Promise<Readonly<WorkerSessionObservationPage>> {
    if (afterWorkerId !== null) assertWorkerId(afterWorkerId);
    const result = await this.pool.query<Row>(
      `WITH observation AS (
         SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS observed_at_ms
       ), page AS (
         SELECT ${SELECT_COLUMNS}
         FROM "ql3"."worker_sessions"
         WHERE ($1::varchar IS NULL OR worker_id > $1)
         ORDER BY worker_id
         LIMIT $2
       )
       SELECT observation.observed_at_ms AS "observedAtMs", page.*
       FROM observation LEFT JOIN page ON TRUE
       ORDER BY page."workerId"`,
      [afterWorkerId, MAX_WORKER_SESSION_OBSERVATION_PAGE_SIZE + 1],
    );
    if (
      result.rows.length < 1 ||
      result.rows.length > MAX_WORKER_SESSION_OBSERVATION_PAGE_SIZE + 1
    ) {
      throw new TypeError('PostgreSQL Worker observation page violated its bound');
    }
    const observed = observedAtMs(result.rows[0]!);
    if (result.rows.some((row) => observedAtMs(row) !== observed)) {
      throw new TypeError('PostgreSQL Worker observation clock drifted');
    }
    const observations =
      result.rows[0]!.workerId === null
        ? []
        : result.rows.map((row) =>
            projectWorkerSessionObservation(record(row), observed),
          );
    for (let index = 0; index < observations.length; index += 1) {
      const workerId = observations[index]!.workerId;
      const previous = observations[index - 1]?.workerId ?? afterWorkerId;
      if (previous !== null && workerId <= previous) {
        throw new TypeError('PostgreSQL Worker observation page is unordered');
      }
    }
    const page = observations.slice(
      0,
      MAX_WORKER_SESSION_OBSERVATION_PAGE_SIZE,
    );
    return Object.freeze({
      observedAtMs: observed,
      workers: Object.freeze(page.map(summarizeWorkerSessionObservation)),
      nextCursor:
        observations.length > MAX_WORKER_SESSION_OBSERVATION_PAGE_SIZE
          ? page.at(-1)!.workerId
          : null,
    });
  }
}
