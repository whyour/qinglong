// PostgreSQL authority for project policy snapshots and role bindings.
import {
  ProjectPolicyProjectNotFoundError,
  ProjectPolicyUnavailableError,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
  assertProjectPolicyProjectId,
  assertExpectedProjectRoleBindingVersion,
  normalizeProjectPolicySnapshot,
  normalizeProjectPolicySubject,
  normalizeProjectRoleBinding,
  type AppendProjectRoleBindingCommand,
  type AppendProjectRoleBindingResult,
  type ProjectPolicyRepository,
  type ProjectPolicySnapshot,
  type ProjectRoleBindingRecord,
} from '@qinglong/runtime-core/project-policy';
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryResult,
} from '@qinglong/runtime-core';

type QueryRow = Record<string, unknown>;

interface SnapshotRow extends QueryRow {
  projectId: unknown;
  projectName: unknown;
  projectSlug: unknown;
  projectStatus: unknown;
  projectVersion: unknown;
  projectCreatedAtMs: unknown;
  projectUpdatedAtMs: unknown;
  bindingProjectId: unknown;
  bindingSubjectType: unknown;
  bindingSubjectId: unknown;
  bindingVersion: unknown;
  bindingState: unknown;
  bindingRole: unknown;
  bindingMutationId: unknown;
  bindingChangedByType: unknown;
  bindingChangedById: unknown;
  bindingCreatedAtMs: unknown;
}

interface BindingRow extends QueryRow {
  projectId: unknown;
  subjectType: unknown;
  subjectId: unknown;
  version: unknown;
  state: unknown;
  role: unknown;
  mutationId: unknown;
  changedByType: unknown;
  changedById: unknown;
  createdAtMs: unknown;
}

const MAX_TRANSACTION_ATTEMPTS = 3;
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01', '55P03']);
const SNAPSHOT_SQL = `
SELECT
  project.id AS "projectId",
  project.name AS "projectName",
  project.slug AS "projectSlug",
  project.status AS "projectStatus",
  project.version AS "projectVersion",
  project.created_at_ms AS "projectCreatedAtMs",
  project.updated_at_ms AS "projectUpdatedAtMs",
  binding.project_id AS "bindingProjectId",
  binding.subject_type AS "bindingSubjectType",
  binding.subject_id AS "bindingSubjectId",
  binding.version AS "bindingVersion",
  binding.state AS "bindingState",
  binding.role AS "bindingRole",
  binding.mutation_id AS "bindingMutationId",
  binding.changed_by_type AS "bindingChangedByType",
  binding.changed_by_id AS "bindingChangedById",
  binding.created_at_ms AS "bindingCreatedAtMs"
FROM "ql3"."projects" AS project
LEFT JOIN LATERAL (
  SELECT *
  FROM "ql3"."project_role_bindings" AS candidate
  WHERE candidate.project_id = project.id
    AND candidate.subject_type = $2
    AND candidate.subject_id = $3
  ORDER BY candidate.version DESC
  LIMIT 1
) AS binding ON TRUE
WHERE project.id = $1
LIMIT 2
`.trim();
const BINDING_SELECT = `
SELECT
  project_id AS "projectId",
  subject_type AS "subjectType",
  subject_id AS "subjectId",
  version,
  state,
  role,
  mutation_id AS "mutationId",
  changed_by_type AS "changedByType",
  changed_by_id AS "changedById",
  created_at_ms AS "createdAtMs"
FROM "ql3"."project_role_bindings"
`.trim();

function requiredString(row: QueryRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProjectPolicyUnavailableError();
  }
  return value;
}

function requiredInteger(row: QueryRow, name: string): number {
  const value = row[name];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new ProjectPolicyUnavailableError();
}

function optionalString(row: QueryRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  return requiredString(row, name);
}

function bindingFromRow(row: BindingRow): Readonly<ProjectRoleBindingRecord> {
  try {
    const role = optionalString(row, 'role');
    return normalizeProjectRoleBinding({
      projectId: requiredString(row, 'projectId'),
      subject: {
        type: requiredString(
          row,
          'subjectType',
        ) as ProjectRoleBindingRecord['subject']['type'],
        id: requiredString(row, 'subjectId'),
      },
      version: requiredInteger(row, 'version'),
      state: requiredString(row, 'state') as ProjectRoleBindingRecord['state'],
      ...(role
        ? { role: role as NonNullable<ProjectRoleBindingRecord['role']> }
        : {}),
      mutationId: requiredString(row, 'mutationId'),
      changedBy: {
        type: requiredString(
          row,
          'changedByType',
        ) as ProjectRoleBindingRecord['changedBy']['type'],
        id: requiredString(row, 'changedById'),
      },
      createdAtMs: requiredInteger(row, 'createdAtMs'),
    });
  } catch {
    throw new ProjectPolicyUnavailableError();
  }
}

function snapshotFromRow(row: SnapshotRow): Readonly<ProjectPolicySnapshot> {
  const bindingValues = [
    row.bindingProjectId,
    row.bindingSubjectType,
    row.bindingSubjectId,
    row.bindingVersion,
    row.bindingState,
    row.bindingMutationId,
    row.bindingChangedByType,
    row.bindingChangedById,
    row.bindingCreatedAtMs,
  ];
  const noBinding = bindingValues.every((value) => value === null);
  if (!noBinding && bindingValues.some((value) => value === null)) {
    throw new ProjectPolicyUnavailableError();
  }
  try {
    return normalizeProjectPolicySnapshot({
      project: {
        id: requiredString(row, 'projectId'),
        name: requiredString(row, 'projectName'),
        slug: requiredString(row, 'projectSlug'),
        status: requiredString(
          row,
          'projectStatus',
        ) as ProjectPolicySnapshot['project']['status'],
        version: requiredInteger(row, 'projectVersion'),
        createdAtMs: requiredInteger(row, 'projectCreatedAtMs'),
        updatedAtMs: requiredInteger(row, 'projectUpdatedAtMs'),
      },
      ...(noBinding
        ? {}
        : {
            binding: bindingFromRow({
              projectId: row.bindingProjectId,
              subjectType: row.bindingSubjectType,
              subjectId: row.bindingSubjectId,
              version: row.bindingVersion,
              state: row.bindingState,
              role: row.bindingRole,
              mutationId: row.bindingMutationId,
              changedByType: row.bindingChangedByType,
              changedById: row.bindingChangedById,
              createdAtMs: row.bindingCreatedAtMs,
            }),
          }),
    });
  } catch {
    throw new ProjectPolicyUnavailableError();
  }
}

function sameBinding(
  left: Readonly<ProjectRoleBindingRecord>,
  right: Readonly<ProjectRoleBindingRecord>,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.subject.type === right.subject.type &&
    left.subject.id === right.subject.id &&
    left.version === right.version &&
    left.state === right.state &&
    left.role === right.role &&
    left.mutationId === right.mutationId &&
    left.changedBy.type === right.changedBy.type &&
    left.changedBy.id === right.changedBy.id &&
    left.createdAtMs === right.createdAtMs
  );
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function configureTransaction(client: PostgresClient): Promise<void> {
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
    // Preserve the primary transaction failure; release discards broken clients.
  }
}

/** PostgreSQL implementation of the shared append-only Project Policy port. */
export class PostgresProjectPolicyRepository
  implements ProjectPolicyRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Project Policy pool is invalid');
    }
  }

  async resolve(
    projectId: string,
    requestedSubject: Parameters<ProjectPolicyRepository['resolve']>[1],
  ): Promise<Readonly<ProjectPolicySnapshot> | null> {
    assertProjectPolicyProjectId(projectId);
    const subject = normalizeProjectPolicySubject(requestedSubject);
    let result: PostgresQueryResult<SnapshotRow>;
    try {
      result = await this.pool.query<SnapshotRow>(SNAPSHOT_SQL, [
        projectId,
        subject.type,
        subject.id,
      ]);
    } catch {
      throw new ProjectPolicyUnavailableError();
    }
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new ProjectPolicyUnavailableError();
    return snapshotFromRow(result.rows[0]!);
  }

  async append(
    command: AppendProjectRoleBindingCommand,
  ): Promise<AppendProjectRoleBindingResult> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new TypeError('Project role binding command is invalid');
    }
    assertExpectedProjectRoleBindingVersion(command.expectedCurrentVersion);
    const binding = normalizeProjectRoleBinding(command.binding);
    if (binding.version !== command.expectedCurrentVersion + 1) {
      throw new ProjectRoleBindingVersionConflictError();
    }

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw new ProjectPolicyUnavailableError();
      }
      let began = false;
      try {
        await configureTransaction(client);
        began = true;
        const project = await client.query(
          'SELECT id FROM "ql3"."projects" WHERE id = $1 FOR UPDATE',
          [binding.projectId],
        );
        if (project.rows.length === 0) {
          throw new ProjectPolicyProjectNotFoundError();
        }
        if (project.rows.length !== 1)
          throw new ProjectPolicyUnavailableError();

        const replay = await client.query<BindingRow>(
          `${BINDING_SELECT} WHERE project_id = $1 AND mutation_id = $2 LIMIT 2`,
          [binding.projectId, binding.mutationId],
        );
        if (replay.rows.length > 1) throw new ProjectPolicyUnavailableError();
        if (replay.rows[0]) {
          const previous = bindingFromRow(replay.rows[0]);
          if (!sameBinding(previous, binding)) {
            throw new ProjectRoleBindingMutationConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', binding: previous });
        }

        const current = await client.query<{ version: unknown }>(
          `SELECT version FROM "ql3"."project_role_bindings"
           WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
           ORDER BY version DESC LIMIT 1`,
          [binding.projectId, binding.subject.type, binding.subject.id],
        );
        if (current.rows.length > 1) throw new ProjectPolicyUnavailableError();
        const currentVersion = current.rows[0]
          ? requiredInteger(current.rows[0], 'version')
          : 0;
        if (currentVersion !== command.expectedCurrentVersion) {
          throw new ProjectRoleBindingVersionConflictError();
        }

        await client.query(
          `INSERT INTO "ql3"."project_role_bindings" (
             project_id, subject_type, subject_id, version, state, role,
             mutation_id, changed_by_type, changed_by_id, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            binding.projectId,
            binding.subject.type,
            binding.subject.id,
            binding.version,
            binding.state,
            binding.role ?? null,
            binding.mutationId,
            binding.changedBy.type,
            binding.changedBy.id,
            binding.createdAtMs,
          ],
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'inserted', binding });
      } catch (error) {
        if (began) await rollback(client);
        if (
          error instanceof ProjectPolicyProjectNotFoundError ||
          error instanceof ProjectRoleBindingVersionConflictError ||
          error instanceof ProjectRoleBindingMutationConflictError ||
          error instanceof ProjectPolicyUnavailableError
        ) {
          throw error;
        }
        if (
          attempt < MAX_TRANSACTION_ATTEMPTS - 1 &&
          (RETRYABLE_SQL_STATES.has(sqlState(error) ?? '') ||
            sqlState(error) === '23505')
        ) {
          continue;
        }
        throw new ProjectPolicyUnavailableError();
      } finally {
        client.release();
      }
    }
    throw new ProjectPolicyUnavailableError();
  }
}
