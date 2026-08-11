// PostgreSQL post-install resource materialization and recovery authority.
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidPluginPackageResourceMaterializationError,
  MAX_PLUGIN_PACKAGE_MATERIALIZED_REVISION_JSON_BYTES,
  PluginPackageResourceMaterializationConflictError,
  PluginPackageResourceMaterializationUnavailableError,
  normalizePluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevisionRepository,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';
import {
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';

import {
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const DIGEST = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackageResourceMaterializationError(message);
}

function unavailable(): PluginPackageResourceMaterializationUnavailableError {
  return new PluginPackageResourceMaterializationUnavailableError();
}

function generationDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid('generation digest is invalid');
  }
  return value;
}

function serialize(
  revision: Readonly<PluginPackageMaterializedRevision>,
): string {
  const value = JSON.stringify(revision);
  if (
    Buffer.byteLength(value, 'utf8') >
    MAX_PLUGIN_PACKAGE_MATERIALIZED_REVISION_JSON_BYTES
  ) {
    return invalid('materialized revision exceeds the durable JSON budget');
  }
  return value;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageResourceMaterializationError ||
    error instanceof PluginPackageResourceMaterializationConflictError ||
    error instanceof PluginPackageResourceMaterializationUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageResourceMaterializationConflictError(
      'durable revision identity is already bound',
    );
  }
  return new PluginPackageResourceMaterializationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class PostgresPluginPackageMaterializedRevisionRepository
  implements PluginPackageMaterializedRevisionRepository
{
  private readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;

  constructor(
    private readonly pool: Pick<PostgresPool, 'query'>,
    taskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry(),
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      !(taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
    ) {
      throw new TypeError(
        'PostgreSQL materialized revision repository options are invalid',
      );
    }
    this.taskSpecSemanticRegistry = taskSpecSemanticRegistry;
  }

  private parse(row: Row): Readonly<PluginPackageMaterializedRevision> {
    try {
      const revision = normalizePluginPackageMaterializedRevision(
        postgresRequiredJsonObject(
          row.revisionJson,
          unavailable,
        ) as unknown as PluginPackageMaterializedRevision,
        this.taskSpecSemanticRegistry,
      );
      if (
        revision.generation.generationDigest !==
          postgresRequiredString(row.generationDigest, unavailable) ||
        revision.generation.projectId !==
          postgresRequiredString(row.projectId, unavailable) ||
        revision.generation.packageName !==
          postgresRequiredString(row.packageName, unavailable) ||
        revision.generation.generation !==
          postgresRequiredInteger(row.generation, unavailable) ||
        revision.generation.lockDigest !==
          postgresRequiredString(row.lockDigest, unavailable) ||
        revision.manifestDigest !==
          postgresRequiredString(row.manifestDigest, unavailable) ||
        revision.revisionDigest !==
          postgresRequiredString(row.revisionDigest, unavailable)
      ) {
        throw unavailable();
      }
      const createdAtMs = postgresRequiredInteger(row.createdAtMs, unavailable);
      if (createdAtMs < 0) throw unavailable();
      return revision;
    } catch (error) {
      if (error instanceof PluginPackageResourceMaterializationUnavailableError) {
        throw error;
      }
      throw unavailable();
    }
  }

  private async findStored(
    digest: string,
  ): Promise<Readonly<PluginPackageMaterializedRevision> | null> {
    const result = await this.pool.query<Row>(
      `SELECT generation_digest AS "generationDigest",
              project_id AS "projectId",
              package_name AS "packageName",
              generation,
              lock_digest AS "lockDigest",
              manifest_digest AS "manifestDigest",
              revision_digest AS "revisionDigest",
              revision_json AS "revisionJson",
              created_at_ms AS "createdAtMs"
       FROM "ql3"."plugin_package_materialized_revisions"
       WHERE generation_digest = $1
       LIMIT 2`,
      [digest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    return this.parse(result.rows[0]!);
  }

  async find(
    digest: string,
  ): Promise<Readonly<PluginPackageMaterializedRevision> | null> {
    try {
      return await this.findStored(generationDigest(digest));
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async publish(
    value: Readonly<PluginPackageMaterializedRevision>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      revision: Readonly<PluginPackageMaterializedRevision>;
    }>
  > {
    const revision = normalizePluginPackageMaterializedRevision(
      value,
      this.taskSpecSemanticRegistry,
    );
    const revisionJson = serialize(revision);
    try {
      const inserted = await this.pool.query(
        `INSERT INTO "ql3"."plugin_package_materialized_revisions" (
           generation_digest, project_id, package_name, generation,
           lock_digest, manifest_digest, revision_digest, revision_json,
           created_at_ms
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
         ON CONFLICT (generation_digest) DO NOTHING
         RETURNING generation_digest`,
        [
          revision.generation.generationDigest,
          revision.generation.projectId,
          revision.generation.packageName,
          revision.generation.generation,
          revision.generation.lockDigest,
          revision.manifestDigest,
          revision.revisionDigest,
          revisionJson,
        ],
      );
      const stored = await this.findStored(
        revision.generation.generationDigest,
      );
      if (!stored) throw unavailable();
      if (
        stored.revisionDigest !== revision.revisionDigest ||
        JSON.stringify(stored) !== revisionJson
      ) {
        throw new PluginPackageResourceMaterializationConflictError(
          'generation digest is bound to another semantic revision',
        );
      }
      return Object.freeze({
        status: inserted.rows.length === 1 ? 'created' : 'existing',
        revision: stored,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
