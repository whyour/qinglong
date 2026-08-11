import type { DatabaseSync } from 'node:sqlite';

import { assertLocalModelInvocationFeatureActive } from '../../feature-activation/localModelInvocationFeatureActivation';
import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
import {
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  createPluginPackagePromptOutputKeyRetirementCompletion,
  createPluginPackagePromptOutputKeyRetirementPreparation,
  normalizePluginPackagePromptOutputKeyRetirementCompletion,
  normalizePluginPackagePromptOutputKeyRetirementPreparation,
  normalizePluginPackagePromptOutputKeyRetirementRequest,
  type PluginPackagePromptOutputKeyRetirementCompletion,
  type PluginPackagePromptOutputKeyRetirementPreparation,
  type PluginPackagePromptOutputKeyRetirementRecord,
  type PluginPackagePromptOutputKeyRetirementRepository,
} from '../key-management/pluginPackagePromptOutputKeyRetirement';

type Row = Record<string, unknown>;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputKeyRetirementUnavailableError {
  return new PluginPackagePromptOutputKeyRetirementUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function parsePreparation(
  row: Row,
): Readonly<PluginPackagePromptOutputKeyRetirementPreparation> {
  try {
    const preparation =
      normalizePluginPackagePromptOutputKeyRetirementPreparation(
        JSON.parse(text(row, 'preparationJson')),
      );
    if (
      preparation.keyId !== text(row, 'keyId') ||
      preparation.retirementId !== text(row, 'retirementId') ||
      preparation.requestId !== text(row, 'requestId') ||
      preparation.mutationId !== text(row, 'mutationId') ||
      preparation.catalogDigest !== text(row, 'catalogDigest') ||
      preparation.materialProof !== text(row, 'materialProof') ||
      preparation.preparationDigest !== text(row, 'preparationDigest') ||
      JSON.stringify(preparation) !== text(row, 'preparationJson')
    ) {
      throw unavailable();
    }
    return preparation;
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  }
}

function parseCompletion(
  row: Row,
): Readonly<PluginPackagePromptOutputKeyRetirementCompletion> {
  try {
    const completion =
      normalizePluginPackagePromptOutputKeyRetirementCompletion(
        JSON.parse(text(row, 'completionJson')),
      );
    if (
      completion.keyId !== text(row, 'keyId') ||
      completion.retirementId !== text(row, 'retirementId') ||
      completion.requestId !== text(row, 'requestId') ||
      completion.mutationId !== text(row, 'mutationId') ||
      completion.preparationDigest !== text(row, 'preparationDigest') ||
      completion.retiredCatalogDigest !== text(row, 'retiredCatalogDigest') ||
      completion.absenceProof !== text(row, 'absenceProof') ||
      completion.completionDigest !== text(row, 'completionDigest') ||
      JSON.stringify(completion) !== text(row, 'completionJson')
    ) {
      throw unavailable();
    }
    return completion;
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  }
}

function readPreparation(
  client: DatabaseSync,
  keyId: string,
): Readonly<PluginPackagePromptOutputKeyRetirementPreparation> | null {
  const rows = client
    .prepare(
      `SELECT key_id AS "keyId", retirement_id AS "retirementId",
              request_id AS "requestId", mutation_id AS "mutationId",
              catalog_digest AS "catalogDigest",
              material_proof AS "materialProof",
              preparation_digest AS "preparationDigest",
              preparation_json AS "preparationJson"
         FROM "ModelInvocationPromptOutputKeyRetirementPreparations"
        WHERE key_id = ?
        LIMIT 2`,
    )
    .all(keyId) as Row[];
  if (rows.length > 1) throw unavailable();
  return rows[0] ? parsePreparation(rows[0]) : null;
}

function readCompletion(
  client: DatabaseSync,
  keyId: string,
): Readonly<PluginPackagePromptOutputKeyRetirementCompletion> | null {
  const rows = client
    .prepare(
      `SELECT key_id AS "keyId", retirement_id AS "retirementId",
              request_id AS "requestId", mutation_id AS "mutationId",
              preparation_digest AS "preparationDigest",
              retired_catalog_digest AS "retiredCatalogDigest",
              absence_proof AS "absenceProof",
              completion_digest AS "completionDigest",
              completion_json AS "completionJson"
         FROM "ModelInvocationPromptOutputKeyRetirementCompletions"
        WHERE key_id = ?
        LIMIT 2`,
    )
    .all(keyId) as Row[];
  if (rows.length > 1) throw unavailable();
  return rows[0] ? parseCompletion(rows[0]) : null;
}

function readRecord(
  client: DatabaseSync,
  keyId: string,
): Readonly<PluginPackagePromptOutputKeyRetirementRecord> | null {
  const preparation = readPreparation(client, keyId);
  if (!preparation) {
    if (readCompletion(client, keyId)) throw unavailable();
    return null;
  }
  const completion = readCompletion(client, keyId);
  if (
    completion &&
    (completion.preparationDigest !== preparation.preparationDigest ||
      completion.retirementId !== preparation.retirementId ||
      completion.requestId !== preparation.requestId ||
      completion.mutationId !== preparation.mutationId)
  ) {
    throw unavailable();
  }
  return Object.freeze({ preparation, completion });
}

function liveArtifactCount(client: DatabaseSync, keyId: string): number {
  const count = client
    .prepare(
      `SELECT count(*) AS count
         FROM "ModelInvocationPromptOutputArtifacts"
        WHERE key_id = ?`,
    )
    .get(keyId)?.count;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw unavailable();
  }
  return count as number;
}

function samePreparationIntent(
  preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>,
  command: Readonly<{
    keyId: string;
    retirementId: string;
    requestId: string;
    mutationId: string;
    catalogDigest: string;
    materialProof: string;
  }>,
): boolean {
  return (
    preparation.keyId === command.keyId &&
    preparation.retirementId === command.retirementId &&
    preparation.requestId === command.requestId &&
    preparation.mutationId === command.mutationId &&
    preparation.catalogDigest === command.catalogDigest &&
    preparation.materialProof === command.materialProof
  );
}

function transaction<T>(client: DatabaseSync, work: () => T): T {
  client.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    client.exec('COMMIT');
    return result;
  } catch (cause) {
    try {
      client.exec('ROLLBACK');
    } catch {
      throw unavailable(cause);
    }
    throw cause;
  }
}

export function assertLocalPluginPackagePromptOutputKeyNotRetiring(
  client: DatabaseSync,
  keyId: string,
): void {
  const normalized = normalizePluginPackagePromptOutputKeyRetirementRequest({
    keyId,
    retirementId: 'key-fence-probe',
    requestId: 'key-fence-probe',
    mutationId: 'key-fence-probe',
  });
  if (readPreparation(client, normalized.keyId)) {
    throw new PluginPackagePromptOutputKeyRetirementConflictError();
  }
}

export class LocalPluginPackagePromptOutputKeyRetirementRepository
  implements PluginPackagePromptOutputKeyRetirementRepository
{
  readonly #authority: LocalModelInvocationOperationAuthority;
  readonly #now: () => number;
  readonly #beforeMutation: (
    client: DatabaseSync,
    phase: 'prepare' | 'complete',
  ) => void;

  constructor(
    options: Readonly<{
      authority: LocalModelInvocationOperationAuthority;
      now?: () => number;
      beforeMutation?: (
        client: DatabaseSync,
        phase: 'prepare' | 'complete',
      ) => void;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.authority ||
      typeof options.authority.enqueue !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.beforeMutation !== undefined &&
        typeof options.beforeMutation !== 'function')
    ) {
      throw unavailable();
    }
    this.#authority = options.authority;
    this.#now = options.now ?? Date.now;
    this.#beforeMutation = options.beforeMutation ?? (() => undefined);
  }

  async find(
    keyId: string,
  ): Promise<Readonly<PluginPackagePromptOutputKeyRetirementRecord> | null> {
    const normalized = normalizePluginPackagePromptOutputKeyRetirementRequest({
      keyId,
      retirementId: 'key-find-probe',
      requestId: 'key-find-probe',
      mutationId: 'key-find-probe',
    });
    return this.#authority.enqueue(
      async () => readRecord(this.#authority.client, normalized.keyId),
      () => unavailable(),
    );
  }

  async prepare(
    command: Readonly<{
      keyId: string;
      retirementId: string;
      requestId: string;
      mutationId: string;
      catalogDigest: string;
      materialProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    }>
  > {
    const request = normalizePluginPackagePromptOutputKeyRetirementRequest({
      keyId: command.keyId,
      retirementId: command.retirementId,
      requestId: command.requestId,
      mutationId: command.mutationId,
    });
    const preparedAtMs = this.#now();
    const preparation = createPluginPackagePromptOutputKeyRetirementPreparation(
      {
        ...request,
        catalogDigest: command.catalogDigest,
        materialProof: command.materialProof,
        preparedAtMs,
      },
    );
    return this.#authority.enqueue(
      async () =>
        transaction(this.#authority.client, () => {
          const client = this.#authority.client;
          assertLocalModelInvocationFeatureActive(client);
          this.#beforeMutation(client, 'prepare');
          const existing = readRecord(client, request.keyId);
          if (existing) {
            if (
              !samePreparationIntent(existing.preparation, {
                ...request,
                catalogDigest: preparation.catalogDigest,
                materialProof: preparation.materialProof,
              })
            ) {
              throw new PluginPackagePromptOutputKeyRetirementConflictError();
            }
            return Object.freeze({
              status: 'existing' as const,
              preparation: existing.preparation,
            });
          }
          if (liveArtifactCount(client, request.keyId) !== 0) {
            throw new PluginPackagePromptOutputKeyRetirementConflictError();
          }
          client
            .prepare(
              `INSERT INTO "ModelInvocationPromptOutputKeyRetirementPreparations" (
                 key_id, retirement_id, request_id, mutation_id,
                 catalog_digest, material_proof, prepared_at_ms,
                 preparation_digest, preparation_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              preparation.keyId,
              preparation.retirementId,
              preparation.requestId,
              preparation.mutationId,
              preparation.catalogDigest,
              preparation.materialProof,
              preparation.preparedAtMs,
              preparation.preparationDigest,
              JSON.stringify(preparation),
            );
          return Object.freeze({
            status: 'created' as const,
            preparation,
          });
        }),
      () => unavailable(),
    );
  }

  async complete(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
      retiredCatalogDigest: string;
      absenceProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      completion: Readonly<PluginPackagePromptOutputKeyRetirementCompletion>;
    }>
  > {
    const preparation =
      normalizePluginPackagePromptOutputKeyRetirementPreparation(
        command.preparation,
      );
    const completedAtMs = this.#now();
    const completion = createPluginPackagePromptOutputKeyRetirementCompletion({
      preparation,
      retiredCatalogDigest: command.retiredCatalogDigest,
      absenceProof: command.absenceProof,
      completedAtMs,
    });
    return this.#authority.enqueue(
      async () =>
        transaction(this.#authority.client, () => {
          const client = this.#authority.client;
          assertLocalModelInvocationFeatureActive(client);
          this.#beforeMutation(client, 'complete');
          const durable = readRecord(client, preparation.keyId);
          if (
            !durable ||
            JSON.stringify(durable.preparation) !== JSON.stringify(preparation)
          ) {
            throw new PluginPackagePromptOutputKeyRetirementConflictError();
          }
          if (durable.completion) {
            if (
              durable.completion.preparationDigest !==
                preparation.preparationDigest ||
              durable.completion.retiredCatalogDigest !==
                completion.retiredCatalogDigest ||
              durable.completion.absenceProof !== completion.absenceProof
            ) {
              throw new PluginPackagePromptOutputKeyRetirementConflictError();
            }
            return Object.freeze({
              status: 'existing' as const,
              completion: durable.completion,
            });
          }
          if (liveArtifactCount(client, preparation.keyId) !== 0) {
            throw new PluginPackagePromptOutputKeyRetirementConflictError();
          }
          client
            .prepare(
              `INSERT INTO "ModelInvocationPromptOutputKeyRetirementCompletions" (
                 key_id, retirement_id, request_id, mutation_id,
                 preparation_digest, retired_catalog_digest, absence_proof,
                 completed_at_ms, completion_digest, completion_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              completion.keyId,
              completion.retirementId,
              completion.requestId,
              completion.mutationId,
              completion.preparationDigest,
              completion.retiredCatalogDigest,
              completion.absenceProof,
              completion.completedAtMs,
              completion.completionDigest,
              JSON.stringify(completion),
            );
          return Object.freeze({
            status: 'created' as const,
            completion,
          });
        }),
      () => unavailable(),
    );
  }
}
