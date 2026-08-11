import type { DatabaseSync } from 'node:sqlite';

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

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const DIGEST = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackageResourceMaterializationError(message);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageResourceMaterializationUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageResourceMaterializationUnavailableError();
  }
  return value as number;
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
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new PluginPackageResourceMaterializationConflictError(
      'durable revision identity is already bound',
    );
  }
  return new PluginPackageResourceMaterializationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalSqlitePluginPackageMaterializedRevisionRepository
  implements PluginPackageMaterializedRevisionRepository
{
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;

  constructor(
    authority: LocalSqliteOperationAuthority | DatabaseSync,
    taskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry(),
  ) {
    if (!(taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)) {
      throw new TypeError('TaskSpec semantic registry is invalid');
    }
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.taskSpecSemanticRegistry = taskSpecSemanticRegistry;
  }

  private parse(row: Row): Readonly<PluginPackageMaterializedRevision> {
    try {
      const revision = normalizePluginPackageMaterializedRevision(
        JSON.parse(text(row, 'revisionJson')) as PluginPackageMaterializedRevision,
        this.taskSpecSemanticRegistry,
      );
      if (
        revision.generation.generationDigest !==
          text(row, 'generationDigest') ||
        revision.generation.projectId !== text(row, 'projectId') ||
        revision.generation.packageName !== text(row, 'packageName') ||
        revision.generation.generation !== integer(row, 'generation') ||
        revision.generation.lockDigest !== text(row, 'lockDigest') ||
        revision.manifestDigest !== text(row, 'manifestDigest') ||
        revision.revisionDigest !== text(row, 'revisionDigest')
      ) {
        throw new PluginPackageResourceMaterializationUnavailableError();
      }
      integer(row, 'createdAtMs');
      return revision;
    } catch (error) {
      if (error instanceof PluginPackageResourceMaterializationUnavailableError) {
        throw error;
      }
      throw new PluginPackageResourceMaterializationUnavailableError();
    }
  }

  private findStored(
    digest: string,
  ): Readonly<PluginPackageMaterializedRevision> | null {
    const row = this.authority.client
      .prepare(
        `SELECT
           generation_digest AS "generationDigest",
           project_id AS "projectId",
           package_name AS "packageName",
           generation,
           lock_digest AS "lockDigest",
           manifest_digest AS "manifestDigest",
           revision_digest AS "revisionDigest",
           revision_json AS "revisionJson",
           created_at_ms AS "createdAtMs"
         FROM "QingLong3PluginPackageMaterializedRevisions"
         WHERE generation_digest = ?`,
      )
      .get(digest) as Row | undefined;
    return row ? this.parse(row) : null;
  }

  private enqueue<T>(work: () => T): Promise<T> {
    return this.authority.enqueue(
      async () => {
        try {
          return work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new PluginPackageResourceMaterializationUnavailableError(),
    );
  }

  async find(
    digest: string,
  ): Promise<Readonly<PluginPackageMaterializedRevision> | null> {
    const normalizedDigest = generationDigest(digest);
    return await this.enqueue(() => this.findStored(normalizedDigest));
  }

  publish(
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
    return this.enqueue(() => {
      const result = this.authority.client
        .prepare(
          `INSERT INTO "QingLong3PluginPackageMaterializedRevisions" (
             generation_digest, project_id, package_name, generation,
             lock_digest, manifest_digest, revision_digest, revision_json,
             created_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?,
             CAST(unixepoch('subsec') * 1000 AS INTEGER))
           ON CONFLICT (generation_digest) DO NOTHING`,
        )
        .run(
          revision.generation.generationDigest,
          revision.generation.projectId,
          revision.generation.packageName,
          revision.generation.generation,
          revision.generation.lockDigest,
          revision.manifestDigest,
          revision.revisionDigest,
          revisionJson,
        );
      const stored = this.findStored(revision.generation.generationDigest);
      if (!stored) {
        throw new PluginPackageResourceMaterializationUnavailableError();
      }
      if (
        stored.revisionDigest !== revision.revisionDigest ||
        JSON.stringify(stored) !== revisionJson
      ) {
        throw new PluginPackageResourceMaterializationConflictError(
          'generation digest is bound to another semantic revision',
        );
      }
      return Object.freeze({
        status: result.changes === 1 ? 'created' : 'existing',
        revision: stored,
      });
    });
  }
}
