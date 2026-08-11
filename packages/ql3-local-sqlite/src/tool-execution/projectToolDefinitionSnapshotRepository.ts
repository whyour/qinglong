import type { DatabaseSync } from 'node:sqlite';

import {
  InvalidProjectToolDefinitionSnapshotError,
  MAX_PROJECT_TOOL_DEFINITION_SNAPSHOT_JSON_BYTES,
  MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES,
  ProjectToolDefinitionSnapshotConflictError,
  ProjectToolDefinitionSnapshotUnavailableError,
  assertProjectToolDefinitionSnapshotRecoveryPageSize,
  assertProjectToolDefinitionSnapshotSourcePageSize,
  normalizeProjectToolDefinitionSnapshot,
  normalizeProjectToolDefinitionSnapshotPendingProjectCursor,
  normalizeProjectToolDefinitionSnapshotRecord,
  normalizeProjectToolDefinitionSnapshotSourceCursor,
  projectToolDefinitionActiveVectorDigest,
  type ProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshotPendingProjectPage,
  type ProjectToolDefinitionSnapshotRecord,
  type ProjectToolDefinitionSnapshotRepository,
  type ProjectToolDefinitionSnapshotSource,
  type ProjectToolDefinitionSnapshotSourcePage,
  type ProjectToolDefinitionSnapshotSourceRepository,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import { assertProjectPolicyProjectId } from '@qinglong/runtime-core/project-policy';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

function invalid(message: string): never {
  throw new InvalidProjectToolDefinitionSnapshotError(message);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new ProjectToolDefinitionSnapshotUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProjectToolDefinitionSnapshotUnavailableError();
  }
  return value as number;
}

function normalizeProjectId(value: unknown): string {
  try {
    assertProjectPolicyProjectId(value as string);
  } catch {
    return invalid('projectId is invalid');
  }
  return value as string;
}

function serialize(snapshot: Readonly<ProjectToolDefinitionSnapshot>): string {
  const value = JSON.stringify(snapshot);
  if (
    Buffer.byteLength(value, 'utf8') >
    MAX_PROJECT_TOOL_DEFINITION_SNAPSHOT_JSON_BYTES
  ) {
    return invalid('snapshot exceeds the durable JSON budget');
  }
  return value;
}

function same(
  left: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
  right: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactOptions(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function sourceFromRow(
  row: Row,
): Readonly<ProjectToolDefinitionSnapshotSource> {
  if (text(row, 'activeState') !== 'active') {
    throw new ProjectToolDefinitionSnapshotUnavailableError();
  }
  return Object.freeze({
    installationId: text(row, 'installationId'),
    packageName: text(row, 'packageName'),
    generation: integer(row, 'generation'),
    generationDigest: text(row, 'generationDigest'),
    lockDigest: text(row, 'lockDigest'),
    revisionDigest: text(row, 'revisionDigest'),
  });
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidProjectToolDefinitionSnapshotError ||
    error instanceof ProjectToolDefinitionSnapshotConflictError ||
    error instanceof ProjectToolDefinitionSnapshotUnavailableError
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
    return new ProjectToolDefinitionSnapshotConflictError(
      'snapshot identity is already bound',
    );
  }
  return new ProjectToolDefinitionSnapshotUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalSqliteProjectToolDefinitionSnapshotRepository
  implements
    ProjectToolDefinitionSnapshotRepository,
    ProjectToolDefinitionSnapshotSourceRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
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
      () => new ProjectToolDefinitionSnapshotUnavailableError(),
    );
  }

  private currentSources(
    projectId: string,
  ): readonly Readonly<ProjectToolDefinitionSnapshotSource>[] {
    const rows = this.authority.client
      .prepare(
        `SELECT
           head."package_name" AS "packageName",
           active_install."installation_id" AS "installationId",
           active_install."target_generation" AS "generation",
           revision."generation_digest" AS "generationDigest",
           active_install."lock_digest" AS "lockDigest",
           revision."revision_digest" AS "revisionDigest",
           active_install."state" AS "activeState"
         FROM "QingLong3PluginPackageInstallHeads" AS head
         JOIN "QingLong3PluginPackageInstalls" AS head_install
           ON head_install."installation_id" = head."installation_id"
         LEFT JOIN "QingLong3PluginPackageInstalls" AS active_install
           ON active_install."project_id" = head."project_id"
          AND active_install."package_name" = head."package_name"
          AND active_install."lock_digest" =
            head_install."active_lock_digest"
         LEFT JOIN "QingLong3PluginPackageMaterializedRevisions" AS revision
           ON revision."project_id" = active_install."project_id"
          AND revision."package_name" = active_install."package_name"
          AND revision."generation" = active_install."target_generation"
          AND revision."lock_digest" = active_install."lock_digest"
         LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
           ON quarantine."project_id" = active_install."project_id"
          AND quarantine."package_name" = active_install."package_name"
          AND quarantine."installation_id" = active_install."installation_id"
          AND quarantine."lock_digest" = active_install."lock_digest"
         LEFT JOIN "QingLong3PluginPackageLifecycleHeads" AS lifecycle
           ON lifecycle."project_id" = active_install."project_id"
          AND lifecycle."package_name" = active_install."package_name"
          AND lifecycle."installation_id" =
            active_install."installation_id"
          AND lifecycle."lock_digest" = active_install."lock_digest"
          AND lifecycle."install_record_digest" =
            active_install."record_digest"
         WHERE head."project_id" = ?
           AND head_install."active_lock_digest" IS NOT NULL
           AND quarantine."event_digest" IS NULL
           AND (
             lifecycle."event_digest" IS NULL OR
             lifecycle."disposition" = 'active'
           )
         ORDER BY head."package_name", active_install."installation_id"`,
      )
      .all(projectId) as Row[];
    if (rows.length > MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES) {
      throw new ProjectToolDefinitionSnapshotUnavailableError();
    }
    const sources = rows.map(sourceFromRow);
    if (
      sources.some(
        (source, index) =>
          index > 0 && sources[index - 1]!.packageName >= source.packageName,
      )
    ) {
      throw new ProjectToolDefinitionSnapshotUnavailableError();
    }
    return Object.freeze(sources);
  }

  private sourceRows(
    projectId: string,
    activeVectorDigest: string,
  ): readonly Readonly<ProjectToolDefinitionSnapshotSource>[] {
    const rows = this.authority.client
      .prepare(
        `SELECT
           installation_id AS "installationId",
           package_name AS "packageName",
           generation,
           generation_digest AS "generationDigest",
           lock_digest AS "lockDigest",
           revision_digest AS "revisionDigest"
         FROM "QingLong3ProjectToolDefinitionSnapshotSources"
         WHERE project_id = ? AND active_vector_digest = ?
         ORDER BY package_name`,
      )
      .all(projectId, activeVectorDigest) as Row[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          installationId: text(row, 'installationId'),
          packageName: text(row, 'packageName'),
          generation: integer(row, 'generation'),
          generationDigest: text(row, 'generationDigest'),
          lockDigest: text(row, 'lockDigest'),
          revisionDigest: text(row, 'revisionDigest'),
        }),
      ),
    );
  }

  private parseRecord(row: Row): Readonly<ProjectToolDefinitionSnapshotRecord> {
    try {
      const snapshot = normalizeProjectToolDefinitionSnapshot(
        JSON.parse(text(row, 'snapshotJson')) as ProjectToolDefinitionSnapshot,
      );
      const record = normalizeProjectToolDefinitionSnapshotRecord({
        snapshot,
        committedAtMs: integer(row, 'committedAtMs'),
      });
      if (
        snapshot.projectId !== text(row, 'projectId') ||
        snapshot.activeVectorDigest !== text(row, 'activeVectorDigest') ||
        snapshot.definitionsDigest !== text(row, 'definitionsDigest') ||
        snapshot.snapshotDigest !== text(row, 'snapshotDigest') ||
        !same(
          snapshot.sources,
          this.sourceRows(snapshot.projectId, snapshot.activeVectorDigest),
        )
      ) {
        throw new ProjectToolDefinitionSnapshotUnavailableError();
      }
      return record;
    } catch (error) {
      if (error instanceof ProjectToolDefinitionSnapshotUnavailableError) {
        throw error;
      }
      throw new ProjectToolDefinitionSnapshotUnavailableError();
    }
  }

  private findStored(
    projectId: string,
    activeVectorDigest: string,
  ): Readonly<ProjectToolDefinitionSnapshotRecord> | null {
    const row = this.authority.client
      .prepare(
        `SELECT
           project_id AS "projectId",
           active_vector_digest AS "activeVectorDigest",
           definitions_digest AS "definitionsDigest",
           snapshot_digest AS "snapshotDigest",
           snapshot_json AS "snapshotJson",
           committed_at_ms AS "committedAtMs"
         FROM "QingLong3ProjectToolDefinitionSnapshots"
         WHERE project_id = ? AND active_vector_digest = ?`,
      )
      .get(projectId, activeVectorDigest) as Row | undefined;
    return row ? this.parseRecord(row) : null;
  }

  private currentActiveVectorDigest(
    projectId: string,
    sources: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
  ): string {
    try {
      return projectToolDefinitionActiveVectorDigest(projectId, sources);
    } catch {
      throw new ProjectToolDefinitionSnapshotUnavailableError();
    }
  }

  findCurrent(
    projectIdValue: string,
  ): Promise<Readonly<ProjectToolDefinitionSnapshotRecord> | null> {
    const projectId = normalizeProjectId(projectIdValue);
    return this.enqueue(() => {
      const sources = this.currentSources(projectId);
      const activeVectorDigest = this.currentActiveVectorDigest(
        projectId,
        sources,
      );
      const record = this.findStored(projectId, activeVectorDigest);
      if (!record) return null;
      if (!same(record.snapshot.sources, sources)) {
        throw new ProjectToolDefinitionSnapshotUnavailableError();
      }
      return record;
    });
  }

  listActiveSourcePage(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<{ readonly packageName: string }>;
  }): Promise<Readonly<ProjectToolDefinitionSnapshotSourcePage>> {
    exactOptions(
      options,
      ['limit', 'projectId'],
      ['after'],
      'snapshot source page options',
    );
    const projectId = normalizeProjectId(options.projectId);
    assertProjectToolDefinitionSnapshotSourcePageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizeProjectToolDefinitionSnapshotSourceCursor(options.after);
    return this.enqueue(() => {
      const rows = this.authority.client
        .prepare(
          `SELECT
             head."package_name" AS "packageName",
             active_install."installation_id" AS "installationId",
             active_install."target_generation" AS "generation",
             revision."generation_digest" AS "generationDigest",
             active_install."lock_digest" AS "lockDigest",
             revision."revision_digest" AS "revisionDigest",
             active_install."state" AS "activeState"
           FROM "QingLong3PluginPackageInstallHeads" AS head
           JOIN "QingLong3PluginPackageInstalls" AS head_install
             ON head_install."installation_id" = head."installation_id"
           LEFT JOIN "QingLong3PluginPackageInstalls" AS active_install
             ON active_install."project_id" = head."project_id"
            AND active_install."package_name" = head."package_name"
            AND active_install."lock_digest" =
              head_install."active_lock_digest"
           LEFT JOIN "QingLong3PluginPackageMaterializedRevisions" AS revision
             ON revision."project_id" = active_install."project_id"
            AND revision."package_name" = active_install."package_name"
            AND revision."generation" = active_install."target_generation"
            AND revision."lock_digest" = active_install."lock_digest"
           LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
             ON quarantine."project_id" = active_install."project_id"
            AND quarantine."package_name" = active_install."package_name"
            AND quarantine."installation_id" =
              active_install."installation_id"
            AND quarantine."lock_digest" = active_install."lock_digest"
           WHERE head."project_id" = ?
             AND head_install."active_lock_digest" IS NOT NULL
             AND quarantine."event_digest" IS NULL
             AND head."package_name" > ?
           ORDER BY head."package_name", active_install."installation_id"
           LIMIT ?`,
        )
        .all(projectId, after?.packageName ?? '', options.limit + 1) as Row[];
      const truncated = rows.length > options.limit;
      const sources = Object.freeze(
        rows.slice(0, options.limit).map(sourceFromRow),
      );
      if (
        sources.some(
          (source, index) =>
            index > 0 && sources[index - 1]!.packageName >= source.packageName,
        )
      ) {
        throw new ProjectToolDefinitionSnapshotUnavailableError();
      }
      const last = sources.at(-1);
      return Object.freeze({
        sources,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ packageName: last.packageName }) }
          : {}),
      });
    });
  }

  listPendingProjectPage(options: {
    readonly limit: number;
    readonly after?: Readonly<{ readonly projectId: string }>;
  }): Promise<Readonly<ProjectToolDefinitionSnapshotPendingProjectPage>> {
    exactOptions(
      options,
      ['limit'],
      ['after'],
      'snapshot pending Project page options',
    );
    assertProjectToolDefinitionSnapshotRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizeProjectToolDefinitionSnapshotPendingProjectCursor(
            options.after,
          );
    return this.enqueue(() => {
      const rows = this.authority.client
        .prepare(
          `WITH active_sources AS (
             SELECT
               head."project_id" AS project_id,
               head."package_name" AS package_name,
               active_install."installation_id" AS installation_id,
               active_install."target_generation" AS generation,
               revision."generation_digest" AS generation_digest,
               active_install."lock_digest" AS lock_digest,
               revision."revision_digest" AS revision_digest,
               CASE
                 WHEN active_install."state" = 'active'
                  AND active_install."installation_id" IS NOT NULL
                  AND revision."generation_digest" IS NOT NULL
                  AND revision."revision_digest" IS NOT NULL
                 THEN 1 ELSE 0
               END AS valid
             FROM "QingLong3PluginPackageInstallHeads" AS head
             JOIN "QingLong3PluginPackageInstalls" AS head_install
               ON head_install."installation_id" = head."installation_id"
             LEFT JOIN "QingLong3PluginPackageInstalls" AS active_install
               ON active_install."project_id" = head."project_id"
              AND active_install."package_name" = head."package_name"
              AND active_install."lock_digest" =
                head_install."active_lock_digest"
             LEFT JOIN "QingLong3PluginPackageMaterializedRevisions" AS revision
               ON revision."project_id" = active_install."project_id"
              AND revision."package_name" = active_install."package_name"
              AND revision."generation" = active_install."target_generation"
              AND revision."lock_digest" = active_install."lock_digest"
             LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
               ON quarantine."project_id" = active_install."project_id"
              AND quarantine."package_name" = active_install."package_name"
              AND quarantine."installation_id" =
                active_install."installation_id"
              AND quarantine."lock_digest" = active_install."lock_digest"
             WHERE head_install."active_lock_digest" IS NOT NULL
               AND quarantine."event_digest" IS NULL
           )
           SELECT project."id" AS "projectId"
           FROM "QingLong3Projects" AS project
           WHERE project."status" = 'active'
             AND project."id" COLLATE BINARY > ? COLLATE BINARY
             AND (
               EXISTS (
                 SELECT 1
                 FROM active_sources AS active
                 WHERE active.project_id = project."id"
                   AND active.valid = 0
               )
               OR NOT EXISTS (
                 SELECT 1
                 FROM "QingLong3ProjectToolDefinitionSnapshots" AS snapshot
                 WHERE snapshot."project_id" = project."id"
                   AND NOT EXISTS (
                     SELECT 1
                     FROM active_sources AS active
                     WHERE active.project_id = project."id"
                       AND active.valid = 1
                       AND NOT EXISTS (
                         SELECT 1
                         FROM "QingLong3ProjectToolDefinitionSnapshotSources" AS stored
                         WHERE stored."project_id" = snapshot."project_id"
                           AND stored."active_vector_digest" =
                             snapshot."active_vector_digest"
                           AND stored."package_name" = active.package_name
                           AND stored."installation_id" =
                             active.installation_id
                           AND stored."generation" = active.generation
                           AND stored."generation_digest" =
                             active.generation_digest
                           AND stored."lock_digest" = active.lock_digest
                           AND stored."revision_digest" =
                             active.revision_digest
                       )
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM "QingLong3ProjectToolDefinitionSnapshotSources" AS stored
                     WHERE stored."project_id" = snapshot."project_id"
                       AND stored."active_vector_digest" =
                         snapshot."active_vector_digest"
                       AND NOT EXISTS (
                         SELECT 1
                         FROM active_sources AS active
                         WHERE active.project_id = project."id"
                           AND active.valid = 1
                           AND active.package_name = stored."package_name"
                           AND active.installation_id =
                             stored."installation_id"
                           AND active.generation = stored."generation"
                           AND active.generation_digest =
                             stored."generation_digest"
                           AND active.lock_digest = stored."lock_digest"
                           AND active.revision_digest =
                             stored."revision_digest"
                       )
                   )
               )
             )
           ORDER BY project."id" COLLATE BINARY
           LIMIT ?`,
        )
        .all(after?.projectId ?? '', options.limit + 1) as Row[];
      const truncated = rows.length > options.limit;
      const projectIds = Object.freeze(
        rows
          .slice(0, options.limit)
          .map((row) => normalizeProjectId(row.projectId)),
      );
      const last = projectIds.at(-1);
      return Object.freeze({
        projectIds,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ projectId: last }) }
          : {}),
      });
    });
  }

  publish(value: Readonly<ProjectToolDefinitionSnapshot>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<ProjectToolDefinitionSnapshotRecord>;
    }>
  > {
    const snapshot = normalizeProjectToolDefinitionSnapshot(value);
    const snapshotJson = serialize(snapshot);
    return this.enqueue(() => {
      this.authority.client.exec('BEGIN IMMEDIATE');
      try {
        const currentSources = this.currentSources(snapshot.projectId);
        if (!same(snapshot.sources, currentSources)) {
          throw new ProjectToolDefinitionSnapshotConflictError(
            'snapshot source vector is not the current active Package vector',
          );
        }
        const result = this.authority.client
          .prepare(
            `INSERT INTO "QingLong3ProjectToolDefinitionSnapshots" (
               project_id, active_vector_digest, definitions_digest,
               snapshot_digest, snapshot_json, committed_at_ms
             )
             VALUES (?, ?, ?, ?, ?,
               CAST(unixepoch('subsec') * 1000 AS INTEGER))
             ON CONFLICT (project_id, active_vector_digest) DO NOTHING`,
          )
          .run(
            snapshot.projectId,
            snapshot.activeVectorDigest,
            snapshot.definitionsDigest,
            snapshot.snapshotDigest,
            snapshotJson,
          );
        if (result.changes === 1) {
          const insertSource = this.authority.client.prepare(
            `INSERT INTO "QingLong3ProjectToolDefinitionSnapshotSources" (
               project_id, active_vector_digest, package_name,
               installation_id, generation, generation_digest,
               lock_digest, revision_digest
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const source of snapshot.sources) {
            insertSource.run(
              snapshot.projectId,
              snapshot.activeVectorDigest,
              source.packageName,
              source.installationId,
              source.generation,
              source.generationDigest,
              source.lockDigest,
              source.revisionDigest,
            );
          }
        }
        const stored = this.findStored(
          snapshot.projectId,
          snapshot.activeVectorDigest,
        );
        if (!stored) {
          throw new ProjectToolDefinitionSnapshotUnavailableError();
        }
        if (JSON.stringify(stored.snapshot) !== snapshotJson) {
          throw new ProjectToolDefinitionSnapshotConflictError(
            'active vector is bound to another semantic snapshot',
          );
        }
        this.authority.client.exec('COMMIT');
        return Object.freeze({
          status:
            result.changes === 1 ? ('created' as const) : ('existing' as const),
          record: stored,
        });
      } catch (error) {
        if (this.authority.client.isTransaction) {
          this.authority.client.exec('ROLLBACK');
        }
        throw error;
      }
    });
  }
}
