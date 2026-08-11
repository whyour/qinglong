import {
  DataTypes,
  Model,
  ModelStatic,
  QueryTypes,
  Sequelize,
  Transaction,
  UniqueConstraintError,
} from 'sequelize';
import {
  PROJECT_ROLE_BINDING_TABLE,
  PROJECT_TABLE,
} from '../../../migrations/0017-project-policy';
import {
  MAX_PROJECT_ROLE_BINDING_VERSION,
  ProjectPolicyProjectNotFoundError,
  ProjectPolicyUnavailableError,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  normalizeProjectPolicySnapshot,
  normalizeProjectRoleBindingRecord,
  type ProjectPolicySnapshot,
  type ProjectRoleBindingRecord,
} from '../../domain/projectPolicy';
import type {
  AppendProjectRoleBindingCommand,
  AppendProjectRoleBindingResult,
  ProjectPolicyRepository,
} from '../../ports/projectPolicyRepository';

const RETRY_ATTEMPTS = 5;

interface ProjectRoleBindingRow {
  projectId: string;
  subjectType: string;
  subjectId: string;
  version: number;
  state: string;
  role: string | null;
  mutationId: string;
  changedByType: string;
  changedById: string;
  createdAtMs: number | string;
}

interface ProjectRoleBindingInstance
  extends Model<ProjectRoleBindingRow, ProjectRoleBindingRow>,
    ProjectRoleBindingRow {}

interface ProjectPolicySnapshotRow {
  project_id: string;
  project_name: string;
  project_slug: string;
  project_status: string;
  project_version: number;
  project_created_at_ms: number | string;
  project_updated_at_ms: number | string;
  binding_project_id: string | null;
  binding_subject_type: string | null;
  binding_subject_id: string | null;
  binding_version: number | null;
  binding_state: string | null;
  binding_role: string | null;
  binding_mutation_id: string | null;
  binding_changed_by_type: string | null;
  binding_changed_by_id: string | null;
  binding_created_at_ms: number | string | null;
}

function defineBindingModel(
  database: Sequelize,
): ModelStatic<ProjectRoleBindingInstance> {
  return database.define<ProjectRoleBindingInstance>(
    'Ql3ProjectRoleBinding',
    {
      projectId: {
        field: 'project_id',
        type: DataTypes.STRING(128),
        allowNull: false,
        primaryKey: true,
      },
      subjectType: {
        field: 'subject_type',
        type: DataTypes.STRING(32),
        allowNull: false,
        primaryKey: true,
      },
      subjectId: {
        field: 'subject_id',
        type: DataTypes.STRING(255),
        allowNull: false,
        primaryKey: true,
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
      state: { type: DataTypes.STRING(16), allowNull: false },
      role: { type: DataTypes.STRING(16), allowNull: true },
      mutationId: {
        field: 'mutation_id',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      changedByType: {
        field: 'changed_by_type',
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      changedById: {
        field: 'changed_by_id',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: PROJECT_ROLE_BINDING_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function rowToBinding(
  row: ProjectRoleBindingRow,
): Readonly<ProjectRoleBindingRecord> {
  try {
    return normalizeProjectRoleBindingRecord({
      projectId: row.projectId,
      subject: {
        type: row.subjectType as ProjectRoleBindingRecord['subject']['type'],
        id: row.subjectId,
      },
      version: Number(row.version),
      state: row.state as ProjectRoleBindingRecord['state'],
      ...(row.role === null
        ? {}
        : { role: row.role as NonNullable<ProjectRoleBindingRecord['role']> }),
      mutationId: row.mutationId,
      changedBy: {
        type: row.changedByType as ProjectRoleBindingRecord['changedBy']['type'],
        id: row.changedById,
      },
      createdAtMs: Number(row.createdAtMs),
    });
  } catch {
    throw new ProjectPolicyUnavailableError();
  }
}

function snapshotRowToValue(
  row: ProjectPolicySnapshotRow,
): Readonly<ProjectPolicySnapshot> {
  const bindingFields = [
    row.binding_project_id,
    row.binding_subject_type,
    row.binding_subject_id,
    row.binding_version,
    row.binding_state,
    row.binding_mutation_id,
    row.binding_changed_by_type,
    row.binding_changed_by_id,
    row.binding_created_at_ms,
  ];
  const noBinding = bindingFields.every((value) => value === null);
  if (!noBinding && bindingFields.some((value) => value === null)) {
    throw new ProjectPolicyUnavailableError();
  }
  try {
    return normalizeProjectPolicySnapshot({
      project: {
        id: row.project_id,
        name: row.project_name,
        slug: row.project_slug,
        status:
          row.project_status as ProjectPolicySnapshot['project']['status'],
        version: Number(row.project_version),
        createdAtMs: Number(row.project_created_at_ms),
        updatedAtMs: Number(row.project_updated_at_ms),
      },
      ...(noBinding
        ? {}
        : {
            binding: {
              projectId: row.binding_project_id!,
              subject: {
                type: row.binding_subject_type as ProjectRoleBindingRecord['subject']['type'],
                id: row.binding_subject_id!,
              },
              version: Number(row.binding_version),
              state: row.binding_state as ProjectRoleBindingRecord['state'],
              ...(row.binding_role === null
                ? {}
                : {
                    role: row.binding_role as NonNullable<
                      ProjectRoleBindingRecord['role']
                    >,
                  }),
              mutationId: row.binding_mutation_id!,
              changedBy: {
                type: row.binding_changed_by_type as ProjectRoleBindingRecord['changedBy']['type'],
                id: row.binding_changed_by_id!,
              },
              createdAtMs: Number(row.binding_created_at_ms),
            },
          }),
    });
  } catch (error) {
    if (error instanceof ProjectPolicyUnavailableError) throw error;
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

function assertExpectedVersion(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= MAX_PROJECT_ROLE_BINDING_VERSION
  ) {
    throw new TypeError('Project role binding expected version is invalid');
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const candidate of [
    error,
    'original' in error ? error.original : undefined,
    'parent' in error ? error.parent : undefined,
  ]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'code' in candidate &&
      typeof candidate.code === 'string'
    ) {
      return candidate.code;
    }
  }
  return undefined;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
}

export class LegacySequelizeProjectPolicyRepository
  implements ProjectPolicyRepository
{
  private readonly bindings: ModelStatic<ProjectRoleBindingInstance>;

  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Project policy repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.bindings = defineBindingModel(database);
  }

  async resolve(
    projectId: string,
    requestedSubject: Parameters<ProjectPolicyRepository['resolve']>[1],
  ): Promise<Readonly<ProjectPolicySnapshot> | null> {
    assertProjectPolicyProjectId(projectId);
    const subject = normalizePolicySubject(requestedSubject);
    const rows = await this.database.query<ProjectPolicySnapshotRow>(
      `SELECT project.id AS project_id,
              project.name AS project_name,
              project.slug AS project_slug,
              project.status AS project_status,
              project.version AS project_version,
              project.created_at_ms AS project_created_at_ms,
              project.updated_at_ms AS project_updated_at_ms,
              binding.project_id AS binding_project_id,
              binding.subject_type AS binding_subject_type,
              binding.subject_id AS binding_subject_id,
              binding.version AS binding_version,
              binding.state AS binding_state,
              binding.role AS binding_role,
              binding.mutation_id AS binding_mutation_id,
              binding.changed_by_type AS binding_changed_by_type,
              binding.changed_by_id AS binding_changed_by_id,
              binding.created_at_ms AS binding_created_at_ms
         FROM "${PROJECT_TABLE}" AS project
    LEFT JOIN "${PROJECT_ROLE_BINDING_TABLE}" AS binding
           ON binding.project_id = project.id
          AND binding.subject_type = :subjectType
          AND binding.subject_id = :subjectId
          AND binding.version = (
            SELECT MAX(current.version)
              FROM "${PROJECT_ROLE_BINDING_TABLE}" AS current
             WHERE current.project_id = project.id
               AND current.subject_type = :subjectType
               AND current.subject_id = :subjectId
          )
        WHERE project.id = :projectId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          projectId,
          subjectType: subject.type,
          subjectId: subject.id,
        },
      },
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ProjectPolicyUnavailableError();
    return snapshotRowToValue(rows[0]);
  }

  async append(
    command: AppendProjectRoleBindingCommand,
  ): Promise<AppendProjectRoleBindingResult> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new TypeError('Project role binding command must be an object');
    }
    assertExpectedVersion(command.expectedCurrentVersion);
    const binding = normalizeProjectRoleBindingRecord(command.binding);
    if (binding.version !== command.expectedCurrentVersion + 1) {
      throw new ProjectRoleBindingVersionConflictError();
    }
    const values: ProjectRoleBindingRow = {
      projectId: binding.projectId,
      subjectType: binding.subject.type,
      subjectId: binding.subject.id,
      version: binding.version,
      state: binding.state,
      role: binding.role ?? null,
      mutationId: binding.mutationId,
      changedByType: binding.changedBy.type,
      changedById: binding.changedBy.id,
      createdAtMs: binding.createdAtMs,
    };
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          async (transaction) => {
            const replay = await this.bindings.findOne({
              where: {
                projectId: binding.projectId,
                mutationId: binding.mutationId,
              },
              raw: true,
              transaction,
            });
            if (replay) {
              const previous = rowToBinding(replay);
              if (!sameBinding(previous, binding)) {
                throw new ProjectRoleBindingMutationConflictError();
              }
              return { status: 'existing', binding: previous };
            }
            const projects = await this.database.query<{ id: string }>(
              `SELECT id FROM "${PROJECT_TABLE}" WHERE id = :projectId LIMIT 1`,
              {
                type: QueryTypes.SELECT,
                replacements: { projectId: binding.projectId },
                transaction,
              },
            );
            if (projects.length !== 1) {
              throw new ProjectPolicyProjectNotFoundError();
            }
            const current = await this.bindings.findOne({
              where: {
                projectId: binding.projectId,
                subjectType: binding.subject.type,
                subjectId: binding.subject.id,
              },
              order: [['version', 'DESC']],
              raw: true,
              transaction,
            });
            const currentVersion = current ? Number(current.version) : 0;
            if (currentVersion !== command.expectedCurrentVersion) {
              throw new ProjectRoleBindingVersionConflictError();
            }
            await this.bindings.create(values, { transaction });
            return { status: 'inserted', binding };
          },
        );
      } catch (error) {
        if (
          error instanceof ProjectRoleBindingVersionConflictError ||
          error instanceof ProjectRoleBindingMutationConflictError ||
          error instanceof ProjectPolicyProjectNotFoundError ||
          error instanceof ProjectPolicyUnavailableError
        ) {
          throw error;
        }
        if (
          (error instanceof UniqueConstraintError ||
            errorCode(error) === 'SQLITE_BUSY') &&
          attempt < RETRY_ATTEMPTS - 1
        ) {
          await retryDelay(attempt);
          continue;
        }
        throw error;
      }
    }
    throw new ProjectPolicyUnavailableError();
  }
}
