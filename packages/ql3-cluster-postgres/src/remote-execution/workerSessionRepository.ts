// PostgreSQL Remote Worker sessions are owned by this domain.
import type {
  AvailableWorkerSessionPage,
  HeartbeatWorkerSessionCommand,
  PostgresClient,
  PostgresPool,
  RegisterWorkerSessionCommand,
  RegisterWorkerSessionResult,
  TransitionWorkerSessionCommand,
  WorkerSessionRecord,
  WorkerSessionRepository,
  WorkerSessionStatus,
} from '@qinglong/runtime-core';
import {
  MAX_AVAILABLE_WORKER_PAGE_SIZE,
  MAX_WORKER_CONCURRENT_RUNS,
  WORKER_SESSION_STATUSES,
  WorkerSessionConflictError,
  WorkerSessionFenceRejectedError,
  assertWorkerCapabilitiesSnapshot,
  assertWorkerConcurrency,
  assertWorkerId,
  assertWorkerSessionId,
  assertWorkerSessionLeaseDuration,
  assertWorkerSessionRecord,
} from '@qinglong/runtime-core';
import {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
  normalizeAuthenticatedWorkerCredentialIdentity,
  normalizeWorkerCredentialDeliveryRecord,
  type AuthenticatedWorkerCredentialIdentity,
  type AuthenticatedWorkerSessionRepository,
  type WorkerCredentialDeliveryRecord,
} from '@qinglong/runtime-core/worker-credential-delivery';

type Row = Record<string, unknown>;

interface DeliveryRow extends Row {
  deliveryId: unknown;
  version: unknown;
  state: unknown;
  workerId: unknown;
  credentialId: unknown;
  credentialVersion: unknown;
  previousCredentialId: unknown;
  secretDigest: unknown;
  tokenDigest: unknown;
  deploymentTargetDigest: unknown;
  deploymentGeneration: unknown;
  stagedAtMs: unknown;
  credentialCommittedAtMs: unknown;
  publishedAtMs: unknown;
  publicationDigest: unknown;
  observedAtMs: unknown;
  observedSessionId: unknown;
  observedSessionVersion: unknown;
  previousRevokedAtMs: unknown;
}

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

const DELIVERY_COLUMNS = `
  delivery_id AS "deliveryId", version, state,
  worker_id AS "workerId", credential_id AS "credentialId",
  credential_version AS "credentialVersion",
  previous_credential_id AS "previousCredentialId",
  secret_digest AS "secretDigest", token_digest AS "tokenDigest",
  deployment_target_digest AS "deploymentTargetDigest",
  deployment_generation AS "deploymentGeneration",
  staged_at_ms AS "stagedAtMs",
  credential_committed_at_ms AS "credentialCommittedAtMs",
  published_at_ms AS "publishedAtMs",
  publication_digest AS "publicationDigest",
  observed_at_ms AS "observedAtMs",
  observed_session_id AS "observedSessionId",
  observed_session_version AS "observedSessionVersion",
  previous_revoked_at_ms AS "previousRevokedAtMs"
`.trim();

function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`PostgreSQL Worker session ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const normalized =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized)) {
    throw new TypeError(`PostgreSQL Worker session ${key} is invalid`);
  }
  return normalized;
}

function nullableString(row: Row, key: string): string | null {
  return row[key] === null ? null : string(row, key);
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

function deliveryRecord(
  row: DeliveryRow,
): Readonly<WorkerCredentialDeliveryRecord> {
  return normalizeWorkerCredentialDeliveryRecord({
    deliveryId: string(row, 'deliveryId'),
    version: integer(row, 'version'),
    state: string(row, 'state') as WorkerCredentialDeliveryRecord['state'],
    workerId: string(row, 'workerId'),
    credentialId: string(row, 'credentialId'),
    credentialVersion: integer(row, 'credentialVersion'),
    previousCredentialId: nullableString(row, 'previousCredentialId'),
    secretDigest: string(row, 'secretDigest'),
    tokenDigest: string(row, 'tokenDigest'),
    deploymentTargetDigest: string(row, 'deploymentTargetDigest'),
    deploymentGeneration: string(row, 'deploymentGeneration'),
    stagedAtMs: integer(row, 'stagedAtMs'),
    credentialCommittedAtMs: integer(row, 'credentialCommittedAtMs'),
    publishedAtMs: nullableInteger(row, 'publishedAtMs'),
    publicationDigest: nullableString(row, 'publicationDigest'),
    observedAtMs: nullableInteger(row, 'observedAtMs'),
    observedSessionId: nullableString(row, 'observedSessionId'),
    observedSessionVersion: nullableInteger(row, 'observedSessionVersion'),
    previousRevokedAtMs: nullableInteger(row, 'previousRevokedAtMs'),
  });
}

function sameDeliveryIdentity(
  current: Readonly<WorkerCredentialDeliveryRecord>,
  previous: Readonly<WorkerCredentialDeliveryRecord>,
): boolean {
  return (
    current.deliveryId === previous.deliveryId &&
    current.workerId === previous.workerId &&
    current.credentialId === previous.credentialId &&
    current.credentialVersion === previous.credentialVersion &&
    current.previousCredentialId === previous.previousCredentialId &&
    current.secretDigest === previous.secretDigest &&
    current.tokenDigest === previous.tokenDigest &&
    current.deploymentTargetDigest === previous.deploymentTargetDigest &&
    current.deploymentGeneration === previous.deploymentGeneration &&
    current.stagedAtMs === previous.stagedAtMs &&
    current.credentialCommittedAtMs === previous.credentialCommittedAtMs
  );
}

async function observeCredentialDelivery(
  client: PostgresClient,
  requestedCredential: AuthenticatedWorkerCredentialIdentity,
  worker: Readonly<WorkerSessionRecord>,
  nowMs: number,
): Promise<void> {
  const credential = normalizeAuthenticatedWorkerCredentialIdentity(
    requestedCredential,
  );
  if (credential.workerId !== worker.workerId || worker.version < 1) {
    throw new WorkerCredentialDeliveryConflictError();
  }
  const result = await client.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
       FROM "ql3"."worker_credential_deliveries"
      WHERE worker_id = $1
        AND credential_id = $2
        AND credential_version = $3
      ORDER BY delivery_id ASC, version ASC
      LIMIT 5`,
    [credential.workerId, credential.credentialId, credential.credentialVersion],
  );
  if (result.rows.length === 0) return;
  if (result.rows.length > 4) {
    throw new WorkerCredentialDeliveryConflictError();
  }
  const records = result.rows.map(deliveryRecord);
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index]!;
    const previous = records[index - 1];
    if (current.version !== index + 1) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    if (!previous) continue;
    if (
      !sameDeliveryIdentity(current, previous) ||
      (current.version >= 3 &&
        (current.publishedAtMs !== previous.publishedAtMs ||
          current.publicationDigest !== previous.publicationDigest)) ||
      (current.version >= 4 &&
        (current.observedAtMs !== previous.observedAtMs ||
          current.observedSessionId !== previous.observedSessionId ||
          current.observedSessionVersion !== previous.observedSessionVersion))
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
  }
  const latest = records.at(-1)!;
  if (latest.state === 'credential_committed') {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  if (latest.state !== 'published') return;
  const observed = normalizeWorkerCredentialDeliveryRecord({
    ...latest,
    version: 3,
    state: 'observed',
    observedAtMs: nowMs,
    observedSessionId: worker.sessionId,
    observedSessionVersion: worker.version,
  });
  await client.query(
    `INSERT INTO "ql3"."worker_credential_deliveries" (
       delivery_id, version, state, worker_id, credential_id,
       credential_version, previous_credential_id, secret_digest,
       token_digest, deployment_target_digest, deployment_generation,
       staged_at_ms, credential_committed_at_ms, published_at_ms,
       publication_digest, observed_at_ms, observed_session_id,
       observed_session_version, previous_revoked_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19
     )`,
    [
      observed.deliveryId, observed.version, observed.state,
      observed.workerId, observed.credentialId, observed.credentialVersion,
      observed.previousCredentialId, observed.secretDigest,
      observed.tokenDigest, observed.deploymentTargetDigest,
      observed.deploymentGeneration, observed.stagedAtMs,
      observed.credentialCommittedAtMs, observed.publishedAtMs,
      observed.publicationDigest, observed.observedAtMs,
      observed.observedSessionId, observed.observedSessionVersion,
      observed.previousRevokedAtMs,
    ],
  );
}

function record(row: Row): WorkerSessionRecord {
  const status = string(row, 'status');
  if (!WORKER_SESSION_STATUSES.includes(status as WorkerSessionStatus)) {
    throw new TypeError('PostgreSQL Worker session status is invalid');
  }
  const result: WorkerSessionRecord = Object.freeze({
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
  assertWorkerSessionRecord(result);
  return result;
}

function assertRegister(command: RegisterWorkerSessionCommand): void {
  assertWorkerId(command.workerId);
  assertWorkerSessionId(command.sessionId);
  assertWorkerCapabilitiesSnapshot(
    command.capabilitiesJson,
    command.capabilitiesHash,
  );
  assertWorkerConcurrency(command.maxConcurrentRuns, command.availableSlots);
  assertWorkerSessionLeaseDuration(command.leaseDurationMs);
}

function assertHeartbeat(command: HeartbeatWorkerSessionCommand): void {
  assertWorkerId(command.workerId);
  assertWorkerSessionId(command.sessionId);
  if (
    !Number.isSafeInteger(command.availableSlots) ||
    command.availableSlots < 0 ||
    command.availableSlots > MAX_WORKER_CONCURRENT_RUNS
  ) {
    throw new RangeError('Worker heartbeat availableSlots is invalid');
  }
  for (const [name, value, minimum] of [
    ['generation', command.generation, 1],
    ['expectedVersion', command.expectedVersion, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`Worker heartbeat ${name} is invalid`);
    }
  }
  assertWorkerSessionLeaseDuration(command.leaseDurationMs);
}

function assertTransition(command: TransitionWorkerSessionCommand): void {
  assertWorkerId(command.workerId);
  assertWorkerSessionId(command.sessionId);
  if (command.status !== 'draining' && command.status !== 'offline') {
    throw new TypeError('Worker transition status is invalid');
  }
  if (
    !Number.isSafeInteger(command.generation) ||
    command.generation < 1 ||
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion < 0
  ) {
    throw new RangeError('Worker transition fence is invalid');
  }
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
}

async function observedAtMs(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
      AS "observedAtMs"
  `);
  if (result.rows.length !== 1) {
    throw new TypeError('PostgreSQL Worker observation is invalid');
  }
  return integer(result.rows[0]!, 'observedAtMs');
}

function fence(
  current: WorkerSessionRecord | null,
  command: {
    workerId: string;
    sessionId: string;
    generation: number;
    expectedVersion: number;
  },
  nowMs: number,
): void {
  if (!current) throw new WorkerSessionFenceRejectedError(command.workerId, 'missing');
  if (current.sessionId !== command.sessionId) {
    throw new WorkerSessionFenceRejectedError(command.workerId, 'session_mismatch');
  }
  if (current.generation !== command.generation) {
    throw new WorkerSessionFenceRejectedError(command.workerId, 'generation_mismatch');
  }
  if (current.version !== command.expectedVersion) {
    throw new WorkerSessionFenceRejectedError(command.workerId, 'version_mismatch');
  }
  if (current.status === 'offline') {
    throw new WorkerSessionFenceRejectedError(command.workerId, 'offline');
  }
  if (current.leaseExpiresAtMs <= nowMs) {
    throw new WorkerSessionFenceRejectedError(command.workerId, 'lease_expired');
  }
}

export class PostgresWorkerSessionRepository
  implements WorkerSessionRepository, AuthenticatedWorkerSessionRepository
{
  constructor(private readonly pool: PostgresPool) {}

  async findById(workerId: string): Promise<WorkerSessionRecord | null> {
    assertWorkerId(workerId);
    const result = await this.pool.query<Row>(
      `SELECT ${SELECT_COLUMNS} FROM "ql3"."worker_sessions" WHERE worker_id = $1`,
      [workerId],
    );
    if (result.rows.length > 1) {
      throw new TypeError('PostgreSQL Worker lookup returned multiple rows');
    }
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async register(
    command: RegisterWorkerSessionCommand,
  ): Promise<RegisterWorkerSessionResult> {
    assertRegister(command);
    const client = await this.pool.connect();
    try {
      await begin(client);
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 684022785147727641::bigint))`,
        [command.workerId],
      );
      const currentResult = await client.query<Row>(
        `SELECT ${SELECT_COLUMNS} FROM "ql3"."worker_sessions" WHERE worker_id = $1 FOR UPDATE`,
        [command.workerId],
      );
      const current = currentResult.rows[0] ? record(currentResult.rows[0]) : null;
      const nowMs = await observedAtMs(client);
      if (current?.sessionId === command.sessionId) {
        if (
          current.capabilitiesJson !== command.capabilitiesJson ||
          current.capabilitiesHash !== command.capabilitiesHash ||
          current.maxConcurrentRuns !== command.maxConcurrentRuns ||
          current.availableSlots !== command.availableSlots
        ) {
          throw new WorkerSessionConflictError(command.workerId);
        }
        if (current.status === 'offline') {
          throw new WorkerSessionFenceRejectedError(command.workerId, 'offline');
        }
        if (current.leaseExpiresAtMs <= nowMs) {
          throw new WorkerSessionFenceRejectedError(command.workerId, 'lease_expired');
        }
        await client.query('COMMIT');
        return Object.freeze({ worker: current, replacedSession: false });
      }
      const generation = current ? current.generation + 1 : 1;
      const version = current ? current.version + 1 : 0;
      if (generation > 2_147_483_647 || version > 2_147_483_647) {
        throw new RangeError('Worker session generation or version overflowed');
      }
      const expiresAtMs = nowMs + command.leaseDurationMs;
      const result = await client.query<Row>(
        `
          INSERT INTO "ql3"."worker_sessions" (
            worker_id, session_id, generation, status, version,
            capabilities_json, capabilities_hash, max_concurrent_runs,
            available_slots, registered_at_ms, last_heartbeat_at_ms,
            lease_expires_at_ms, updated_at_ms
          ) VALUES ($1, $2, $3, 'online', $4, $5, $6, $7, $8, $9, $9, $10, $9)
          ON CONFLICT (worker_id) DO UPDATE SET
            session_id = EXCLUDED.session_id,
            generation = EXCLUDED.generation,
            status = EXCLUDED.status,
            version = EXCLUDED.version,
            capabilities_json = EXCLUDED.capabilities_json,
            capabilities_hash = EXCLUDED.capabilities_hash,
            max_concurrent_runs = EXCLUDED.max_concurrent_runs,
            available_slots = EXCLUDED.available_slots,
            registered_at_ms = EXCLUDED.registered_at_ms,
            last_heartbeat_at_ms = EXCLUDED.last_heartbeat_at_ms,
            lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
            updated_at_ms = EXCLUDED.updated_at_ms
          RETURNING ${SELECT_COLUMNS}
        `,
        [
          command.workerId,
          command.sessionId,
          generation,
          version,
          command.capabilitiesJson,
          command.capabilitiesHash,
          command.maxConcurrentRuns,
          command.availableSlots,
          nowMs,
          expiresAtMs,
        ],
      );
      if (result.rows.length !== 1) {
        throw new TypeError('PostgreSQL Worker registration returned no row');
      }
      await client.query('COMMIT');
      return Object.freeze({
        worker: record(result.rows[0]!),
        replacedSession: current !== null,
      });
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the originating failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(
    command: HeartbeatWorkerSessionCommand,
  ): Promise<WorkerSessionRecord> {
    return this.heartbeatInternal(command);
  }

  async heartbeatAuthenticated(
    command: HeartbeatWorkerSessionCommand,
    credential: AuthenticatedWorkerCredentialIdentity,
  ): Promise<WorkerSessionRecord> {
    return this.heartbeatInternal(command, credential);
  }

  private async heartbeatInternal(
    command: HeartbeatWorkerSessionCommand,
    credential?: AuthenticatedWorkerCredentialIdentity,
  ): Promise<WorkerSessionRecord> {
    assertHeartbeat(command);
    return this.mutate(command.workerId, async (client, nowMs, current) => {
      fence(current, command, nowMs);
      if (!current) throw new WorkerSessionFenceRejectedError(command.workerId, 'missing');
      assertWorkerConcurrency(current.maxConcurrentRuns, command.availableSlots);
      const result = await client.query<Row>(
        `
          UPDATE "ql3"."worker_sessions"
          SET version = version + 1,
              available_slots = CASE WHEN status = 'draining' THEN 0 ELSE $5 END,
              last_heartbeat_at_ms = $6,
              lease_expires_at_ms = $7,
              updated_at_ms = $6
          WHERE worker_id = $1 AND session_id = $2 AND generation = $3 AND version = $4
          RETURNING ${SELECT_COLUMNS}
        `,
        [
          command.workerId,
          command.sessionId,
          command.generation,
          command.expectedVersion,
          command.availableSlots,
          nowMs,
          nowMs + command.leaseDurationMs,
        ],
      );
      if (result.rows.length !== 1) {
        throw new WorkerSessionFenceRejectedError(command.workerId, 'version_mismatch');
      }
      const worker = record(result.rows[0]!);
      if (credential) {
        await observeCredentialDelivery(client, credential, worker, nowMs);
      }
      return worker;
    });
  }

  async transition(
    command: TransitionWorkerSessionCommand,
  ): Promise<WorkerSessionRecord> {
    return this.transitionInternal(command);
  }

  async transitionAuthenticated(
    command: TransitionWorkerSessionCommand,
    credential: AuthenticatedWorkerCredentialIdentity,
  ): Promise<WorkerSessionRecord> {
    return this.transitionInternal(command, credential);
  }

  private async transitionInternal(
    command: TransitionWorkerSessionCommand,
    credential?: AuthenticatedWorkerCredentialIdentity,
  ): Promise<WorkerSessionRecord> {
    assertTransition(command);
    return this.mutate(command.workerId, async (client, nowMs, current) => {
      fence(current, command, nowMs);
      const result = await client.query<Row>(
        `
          UPDATE "ql3"."worker_sessions"
          SET version = version + 1,
              status = $5::varchar,
              available_slots = 0,
              lease_expires_at_ms = CASE
                WHEN $5::varchar = 'offline' THEN $6
                ELSE lease_expires_at_ms
              END,
              updated_at_ms = $6
          WHERE worker_id = $1 AND session_id = $2 AND generation = $3 AND version = $4
          RETURNING ${SELECT_COLUMNS}
        `,
        [
          command.workerId,
          command.sessionId,
          command.generation,
          command.expectedVersion,
          command.status,
          nowMs,
        ],
      );
      if (result.rows.length !== 1) {
        throw new WorkerSessionFenceRejectedError(command.workerId, 'version_mismatch');
      }
      const worker = record(result.rows[0]!);
      if (credential) {
        await observeCredentialDelivery(client, credential, worker, nowMs);
      }
      return worker;
    });
  }

  async listAvailable(
    options: Readonly<{ afterWorkerId?: string; limit?: number }> = {},
  ): Promise<AvailableWorkerSessionPage> {
    const limit = options.limit ?? 16;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AVAILABLE_WORKER_PAGE_SIZE) {
      throw new RangeError(
        `Worker page limit must be between 1 and ${MAX_AVAILABLE_WORKER_PAGE_SIZE}`,
      );
    }
    if (options.afterWorkerId !== undefined) assertWorkerId(options.afterWorkerId);
    const result = await this.pool.query<Row>(
      `
        WITH observation AS (
          SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS observed_at_ms
        ), available AS (
          SELECT ${SELECT_COLUMNS}
          FROM "ql3"."worker_sessions", observation
          WHERE status = 'online'
            AND available_slots > 0
            AND lease_expires_at_ms > observation.observed_at_ms
            AND ($1::varchar IS NULL OR worker_id > $1)
          ORDER BY worker_id
          LIMIT $2
        )
        SELECT observation.observed_at_ms AS "observedAtMs", available.*
        FROM observation LEFT JOIN available ON TRUE
        ORDER BY available."workerId"
      `,
      [options.afterWorkerId ?? null, limit + 1],
    );
    if (result.rows.length < 1 || result.rows.length > limit + 1) {
      throw new TypeError('PostgreSQL Worker page violated its bound');
    }
    const observed = integer(result.rows[0]!, 'observedAtMs');
    const workers = result.rows[0]!.workerId === null
      ? []
      : result.rows.map((row) => record(row));
    const page = workers.slice(0, limit);
    const last = page.at(-1);
    return Object.freeze({
      observedAtMs: observed,
      workers: Object.freeze(page),
      truncated: workers.length > limit,
      ...(workers.length > limit && last ? { nextCursor: last.workerId } : {}),
    });
  }

  private async mutate<T>(
    workerId: string,
    work: (
      client: PostgresClient,
      nowMs: number,
      current: WorkerSessionRecord | null,
    ) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await begin(client);
      const currentResult = await client.query<Row>(
        `SELECT ${SELECT_COLUMNS} FROM "ql3"."worker_sessions" WHERE worker_id = $1 FOR UPDATE`,
        [workerId],
      );
      const nowMs = await observedAtMs(client);
      const result = await work(
        client,
        nowMs,
        currentResult.rows[0] ? record(currentResult.rows[0]) : null,
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the originating failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
