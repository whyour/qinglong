import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  PluginPackagePromptOutputKeyRotationConflictError,
  PluginPackagePromptOutputKeyRotationUnavailableError,
  createPluginPackagePromptOutputKeyRotationCompletion,
  createPluginPackagePromptOutputKeyRotationPreparation,
  normalizePluginPackagePromptOutputKeyRotationCompletion,
  normalizePluginPackagePromptOutputKeyRotationPreparation,
  normalizePluginPackagePromptOutputKeyRotationRequest,
  type PluginPackagePromptOutputKeyRotationCompletion,
  type PluginPackagePromptOutputKeyRotationPreparation,
  type PluginPackagePromptOutputKeyRotationRecord,
  type PluginPackagePromptOutputKeyRotationRepository,
  type PluginPackagePromptOutputKeyRotationState,
} from '../key-management/pluginPackagePromptOutputKeyRotation';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const MAX_ATTEMPTS = 3;
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
const CONFLICT_SQL_STATES = new Set(['23503', '23505', '23514']);
const ROTATION_FENCE_LOCK_SEED = 0x514c0303;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputKeyRotationUnavailableError {
  return new PluginPackagePromptOutputKeyRotationUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqlState(cause: unknown): string | null {
  return cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string'
    ? cause.code
    : null;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const parsed =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw unavailable();
  }
  return parsed as number;
}

function json(row: Row, key: string): Record<string, unknown> {
  try {
    const value = row[key];
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw unavailable();
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw cause instanceof PluginPackagePromptOutputKeyRotationUnavailableError
      ? cause
      : unavailable(cause);
  }
}

function parsePreparation(
  row: Row,
): Readonly<PluginPackagePromptOutputKeyRotationPreparation> {
  try {
    const preparation =
      normalizePluginPackagePromptOutputKeyRotationPreparation(
        json(
          row,
          'preparationJson',
        ) as unknown as PluginPackagePromptOutputKeyRotationPreparation,
      );
    if (
      preparation.rotationId !== text(row, 'rotationId') ||
      preparation.requestId !== text(row, 'requestId') ||
      preparation.mutationId !== text(row, 'mutationId') ||
      preparation.expectedSecretUid !== text(row, 'expectedSecretUid') ||
      preparation.expectedActiveKeyId !== text(row, 'expectedActiveKeyId') ||
      preparation.expectedCatalogDigest !==
        text(row, 'expectedCatalogDigest') ||
      preparation.newKeyId !== text(row, 'newKeyId') ||
      preparation.materialProof !== text(row, 'materialProof') ||
      preparation.preparedAtMs !== integer(row, 'preparedAtMs') ||
      preparation.preparationDigest !== text(row, 'preparationDigest')
    ) {
      throw unavailable();
    }
    return preparation;
  } catch (cause) {
    throw cause instanceof PluginPackagePromptOutputKeyRotationUnavailableError
      ? cause
      : unavailable(cause);
  }
}

function parseCompletion(
  row: Row,
): Readonly<PluginPackagePromptOutputKeyRotationCompletion> {
  try {
    const completion = normalizePluginPackagePromptOutputKeyRotationCompletion(
      json(
        row,
        'completionJson',
      ) as unknown as PluginPackagePromptOutputKeyRotationCompletion,
    );
    if (
      completion.rotationId !== text(row, 'rotationId') ||
      completion.requestId !== text(row, 'requestId') ||
      completion.mutationId !== text(row, 'mutationId') ||
      completion.preparationDigest !== text(row, 'preparationDigest') ||
      completion.generation !== integer(row, 'generation') ||
      completion.previousActiveKeyId !== text(row, 'previousActiveKeyId') ||
      completion.activeKeyId !== text(row, 'activeKeyId') ||
      completion.catalogDigest !== text(row, 'catalogDigest') ||
      completion.materialProof !== text(row, 'materialProof') ||
      completion.completedAtMs !== integer(row, 'completedAtMs') ||
      completion.completionDigest !== text(row, 'completionDigest')
    ) {
      throw unavailable();
    }
    return completion;
  } catch (cause) {
    throw cause instanceof PluginPackagePromptOutputKeyRotationUnavailableError
      ? cause
      : unavailable(cause);
  }
}

async function readPreparation(
  queryable: Queryable,
  rotationId: string,
): Promise<Readonly<PluginPackagePromptOutputKeyRotationPreparation> | null> {
  const result = await queryable.query<Row>(
    `SELECT rotation_id AS "rotationId", request_id AS "requestId",
            mutation_id AS "mutationId",
            expected_secret_uid AS "expectedSecretUid",
            expected_active_key_id AS "expectedActiveKeyId",
            expected_catalog_digest AS "expectedCatalogDigest",
            new_key_id AS "newKeyId", material_proof AS "materialProof",
            prepared_at_ms AS "preparedAtMs",
            preparation_digest AS "preparationDigest",
            preparation_json AS "preparationJson"
       FROM "ql3_ai"."model_invocation_prompt_output_key_rotation_preparations"
      WHERE rotation_id = $1
      LIMIT 2`,
    [rotationId],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0] ? parsePreparation(result.rows[0]) : null;
}

async function readCompletion(
  queryable: Queryable,
  rotationId: string,
): Promise<Readonly<PluginPackagePromptOutputKeyRotationCompletion> | null> {
  const result = await queryable.query<Row>(
    `SELECT rotation_id AS "rotationId", request_id AS "requestId",
            mutation_id AS "mutationId",
            preparation_digest AS "preparationDigest",
            generation, previous_active_key_id AS "previousActiveKeyId",
            active_key_id AS "activeKeyId", catalog_digest AS "catalogDigest",
            material_proof AS "materialProof",
            completed_at_ms AS "completedAtMs",
            completion_digest AS "completionDigest",
            completion_json AS "completionJson"
       FROM "ql3_ai"."model_invocation_prompt_output_key_rotation_completions"
      WHERE rotation_id = $1
      LIMIT 2`,
    [rotationId],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0] ? parseCompletion(result.rows[0]) : null;
}

async function readRecord(
  queryable: Queryable,
  rotationId: string,
): Promise<Readonly<PluginPackagePromptOutputKeyRotationRecord> | null> {
  const preparation = await readPreparation(queryable, rotationId);
  const completion = await readCompletion(queryable, rotationId);
  if (!preparation) {
    if (completion) throw unavailable();
    return null;
  }
  if (
    completion &&
    (completion.preparationDigest !== preparation.preparationDigest ||
      completion.requestId !== preparation.requestId ||
      completion.mutationId !== preparation.mutationId ||
      completion.previousActiveKeyId !== preparation.expectedActiveKeyId ||
      completion.activeKeyId !== preparation.newKeyId ||
      completion.materialProof !== preparation.materialProof)
  ) {
    throw unavailable();
  }
  return Object.freeze({ preparation, completion });
}

function samePreparationIntent(
  preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>,
  command: Readonly<PluginPackagePromptOutputKeyRotationPreparation>,
): boolean {
  return (
    preparation.rotationId === command.rotationId &&
    preparation.requestId === command.requestId &&
    preparation.mutationId === command.mutationId &&
    preparation.expectedSecretUid === command.expectedSecretUid &&
    preparation.expectedActiveKeyId === command.expectedActiveKeyId &&
    preparation.expectedCatalogDigest === command.expectedCatalogDigest &&
    preparation.newKeyId === command.newKeyId &&
    preparation.materialProof === command.materialProof
  );
}

function normalizedRotationId(rotationId: string): string {
  return normalizePluginPackagePromptOutputKeyRotationRequest({
    rotationId,
    requestId: 'rotation-fence-probe',
    mutationId: 'rotation-fence-probe',
    expectedSecretUid: 'rotation-fence-probe',
    expectedActiveKeyId: 'rotation-key-before',
    expectedCatalogDigest: '0'.repeat(64),
    newKeyId: 'rotation-key-after',
  }).rotationId;
}

async function lockRotationFence(
  client: PostgresClient,
  preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`, [
    `ql3-ai:prompt-output-key-rotation:${preparation.expectedSecretUid}:${preparation.expectedCatalogDigest}`,
    ROTATION_FENCE_LOCK_SEED,
  ]);
}

export class PostgresPluginPackagePromptOutputKeyRotationRepository
  implements PluginPackagePromptOutputKeyRotationRepository
{
  readonly #pool: PostgresPool;
  readonly #now: () => number;

  constructor(options: Readonly<{ pool: PostgresPool; now?: () => number }>) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.pool ||
      typeof options.pool.query !== 'function' ||
      typeof options.pool.connect !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw unavailable();
    }
    this.#pool = options.pool;
    this.#now = options.now ?? Date.now;
  }

  async find(
    rotationId: string,
  ): Promise<Readonly<PluginPackagePromptOutputKeyRotationRecord> | null> {
    try {
      return await readRecord(this.#pool, normalizedRotationId(rotationId));
    } catch (cause) {
      throw cause instanceof
        PluginPackagePromptOutputKeyRotationUnavailableError
        ? cause
        : unavailable(cause);
    }
  }

  async prepare(
    command: Readonly<{
      request: Parameters<
        typeof normalizePluginPackagePromptOutputKeyRotationRequest
      >[0];
      materialProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
    }>
  > {
    const request = normalizePluginPackagePromptOutputKeyRotationRequest(
      command.request,
    );
    const preparation = createPluginPackagePromptOutputKeyRotationPreparation({
      request,
      materialProof: command.materialProof,
      preparedAtMs: this.#now(),
    });
    return this.#transaction(async (client) => {
      await lockRotationFence(client, preparation);
      const existing = await readRecord(client, request.rotationId);
      if (existing) {
        if (!samePreparationIntent(existing.preparation, preparation)) {
          throw new PluginPackagePromptOutputKeyRotationConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          preparation: existing.preparation,
        });
      }
      await client.query(
        `INSERT INTO "ql3_ai"."model_invocation_prompt_output_key_rotation_preparations" (
           rotation_id, request_id, mutation_id, expected_secret_uid,
           expected_active_key_id, expected_catalog_digest, new_key_id,
           material_proof, prepared_at_ms, preparation_digest, preparation_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          preparation.rotationId,
          preparation.requestId,
          preparation.mutationId,
          preparation.expectedSecretUid,
          preparation.expectedActiveKeyId,
          preparation.expectedCatalogDigest,
          preparation.newKeyId,
          preparation.materialProof,
          preparation.preparedAtMs,
          preparation.preparationDigest,
          JSON.stringify(preparation),
        ],
      );
      return Object.freeze({
        status: 'created' as const,
        preparation,
      });
    });
  }

  async complete(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
      state: Readonly<PluginPackagePromptOutputKeyRotationState>;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      completion: Readonly<PluginPackagePromptOutputKeyRotationCompletion>;
    }>
  > {
    const preparation =
      normalizePluginPackagePromptOutputKeyRotationPreparation(
        command.preparation,
      );
    const completion = createPluginPackagePromptOutputKeyRotationCompletion({
      preparation,
      state: command.state,
      completedAtMs: this.#now(),
    });
    return this.#transaction(async (client) => {
      await lockRotationFence(client, preparation);
      const durable = await readRecord(client, preparation.rotationId);
      if (
        !durable ||
        JSON.stringify(durable.preparation) !== JSON.stringify(preparation)
      ) {
        throw new PluginPackagePromptOutputKeyRotationConflictError();
      }
      if (durable.completion) {
        if (
          durable.completion.preparationDigest !==
            completion.preparationDigest ||
          durable.completion.generation !== completion.generation ||
          durable.completion.catalogDigest !== completion.catalogDigest ||
          durable.completion.materialProof !== completion.materialProof
        ) {
          throw new PluginPackagePromptOutputKeyRotationConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          completion: durable.completion,
        });
      }
      await client.query(
        `INSERT INTO "ql3_ai"."model_invocation_prompt_output_key_rotation_completions" (
           rotation_id, request_id, mutation_id, preparation_digest,
           generation, previous_active_key_id, active_key_id,
           catalog_digest, material_proof, completed_at_ms,
           completion_digest, completion_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [
          completion.rotationId,
          completion.requestId,
          completion.mutationId,
          completion.preparationDigest,
          completion.generation,
          completion.previousActiveKeyId,
          completion.activeKeyId,
          completion.catalogDigest,
          completion.materialProof,
          completion.completedAtMs,
          completion.completionDigest,
          JSON.stringify(completion),
        ],
      );
      return Object.freeze({
        status: 'created' as const,
        completion,
      });
    });
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (cause) {
        try {
          await client.query('ROLLBACK');
        } catch {
          throw unavailable(cause);
        }
        const state = sqlState(cause);
        if (
          state &&
          RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < MAX_ATTEMPTS
        ) {
          continue;
        }
        if (state && CONFLICT_SQL_STATES.has(state)) {
          throw new PluginPackagePromptOutputKeyRotationConflictError();
        }
        if (
          cause instanceof PluginPackagePromptOutputKeyRotationConflictError ||
          cause instanceof PluginPackagePromptOutputKeyRotationUnavailableError
        ) {
          throw cause;
        }
        throw unavailable(cause);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
