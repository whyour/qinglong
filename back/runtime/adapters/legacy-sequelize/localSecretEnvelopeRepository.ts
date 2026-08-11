import {
  DataTypes,
  Model,
  ModelStatic,
  QueryTypes,
  Sequelize,
  Transaction,
  UniqueConstraintError,
} from 'sequelize';
import { LOCAL_SECRET_ENVELOPE_TABLE } from '../../../migrations/0014-local-secret-envelopes';
import {
  LOCAL_SECRET_ALGORITHM,
  LocalSecretUnavailableError,
  LocalSecretVersionConflictError,
  assertLocalSecretMutationId,
  assertLocalSecretName,
  assertLocalSecretProjectId,
  createLocalSecretRef,
  normalizeLocalSecretEnvelope,
  type LocalSecretEnvelope,
  type LocalSecretReference,
} from '../../domain/localSecret';
import type {
  AppendLocalSecretEnvelopeCommand,
  AppendLocalSecretEnvelopeResult,
  LocalSecretEnvelopeRepository,
} from '../../ports/localSecretEnvelopeRepository';

const MAX_BATCH_SIZE = 64;
const RETRY_ATTEMPTS = 5;

interface LocalSecretEnvelopeRow {
  projectId: string;
  name: string;
  version: number;
  mutationId: string;
  keyId: string;
  algorithm: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  createdAtMs: number | string;
}

interface LocalSecretEnvelopeInstance
  extends Model<LocalSecretEnvelopeRow, LocalSecretEnvelopeRow>,
    LocalSecretEnvelopeRow {}

interface ResolvedSecretRow {
  position: number;
  project_id: string | null;
  secret_name: string | null;
  version: number | null;
  mutation_id: string | null;
  key_id: string | null;
  algorithm: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  created_at_ms: number | string | null;
}

function defineLocalSecretEnvelopeModel(
  database: Sequelize,
): ModelStatic<LocalSecretEnvelopeInstance> {
  return database.define<LocalSecretEnvelopeInstance>(
    'Ql3LocalSecretEnvelope',
    {
      projectId: {
        field: 'project_id',
        type: DataTypes.STRING(128),
        allowNull: false,
        primaryKey: true,
      },
      name: {
        field: 'secret_name',
        type: DataTypes.STRING(128),
        allowNull: false,
        primaryKey: true,
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
      mutationId: {
        field: 'mutation_id',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      keyId: {
        field: 'key_id',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      algorithm: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      nonce: { type: DataTypes.BLOB, allowNull: false },
      ciphertext: { type: DataTypes.BLOB, allowNull: false },
      authTag: {
        field: 'auth_tag',
        type: DataTypes.BLOB,
        allowNull: false,
      },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: LOCAL_SECRET_ENVELOPE_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function rowToEnvelope(row: LocalSecretEnvelopeRow): LocalSecretEnvelope {
  try {
    return normalizeLocalSecretEnvelope({
      projectId: row.projectId,
      name: row.name,
      version: Number(row.version),
      mutationId: row.mutationId,
      keyId: row.keyId,
      algorithm: row.algorithm as typeof LOCAL_SECRET_ALGORITHM,
      nonce: Buffer.from(row.nonce).toString('base64url'),
      ciphertext: Buffer.from(row.ciphertext).toString('base64url'),
      authTag: Buffer.from(row.authTag).toString('base64url'),
      createdAtMs: Number(row.createdAtMs),
    });
  } catch {
    throw new LocalSecretUnavailableError();
  }
}

function resolvedRowToEnvelope(
  row: ResolvedSecretRow,
): LocalSecretEnvelope | null {
  if (row.version === null) return null;
  if (
    row.project_id === null ||
    row.secret_name === null ||
    row.mutation_id === null ||
    row.key_id === null ||
    row.algorithm === null ||
    row.nonce === null ||
    row.ciphertext === null ||
    row.auth_tag === null ||
    row.created_at_ms === null
  ) {
    throw new LocalSecretUnavailableError();
  }
  return rowToEnvelope({
    projectId: row.project_id,
    name: row.secret_name,
    version: row.version,
    mutationId: row.mutation_id,
    keyId: row.key_id,
    algorithm: row.algorithm,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.auth_tag,
    createdAtMs: row.created_at_ms,
  });
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

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2_147_483_647) {
    throw new TypeError('Local Secret expected current version is invalid');
  }
}

export class LegacySequelizeLocalSecretEnvelopeRepository
  implements LocalSecretEnvelopeRepository
{
  private readonly envelope: ModelStatic<LocalSecretEnvelopeInstance>;

  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Local Secret envelope repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.envelope = defineLocalSecretEnvelopeModel(database);
  }

  async append(
    command: AppendLocalSecretEnvelopeCommand,
  ): Promise<AppendLocalSecretEnvelopeResult> {
    assertExpectedVersion(command.expectedCurrentVersion);
    const envelope = normalizeLocalSecretEnvelope(command.envelope);
    if (envelope.version !== command.expectedCurrentVersion + 1) {
      throw new LocalSecretVersionConflictError();
    }
    const values = this.values(envelope);
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          async (transaction) => {
            const replay = await this.envelope.findOne({
              where: {
                projectId: envelope.projectId,
                name: envelope.name,
                mutationId: envelope.mutationId,
              },
              raw: true,
              transaction,
            });
            if (replay) {
              return { status: 'existing', envelope: rowToEnvelope(replay) };
            }
            const current = await this.envelope.findOne({
              where: { projectId: envelope.projectId, name: envelope.name },
              order: [['version', 'DESC']],
              raw: true,
              transaction,
            });
            const currentVersion = current ? Number(current.version) : 0;
            if (currentVersion !== command.expectedCurrentVersion) {
              throw new LocalSecretVersionConflictError();
            }
            await this.envelope.create(values, { transaction });
            return { status: 'inserted', envelope };
          },
        );
      } catch (error) {
        if (error instanceof LocalSecretVersionConflictError) throw error;
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
    throw new LocalSecretUnavailableError();
  }

  async findByMutation(
    projectId: string,
    name: string,
    mutationId: string,
  ): Promise<LocalSecretEnvelope | null> {
    assertLocalSecretProjectId(projectId);
    assertLocalSecretName(name);
    assertLocalSecretMutationId(mutationId);
    const row = await this.envelope.findOne({
      where: { projectId, name, mutationId },
      raw: true,
    });
    return row ? rowToEnvelope(row) : null;
  }

  async resolveMany(
    references: readonly LocalSecretReference[],
  ): Promise<readonly (LocalSecretEnvelope | null)[]> {
    if (!Array.isArray(references) || references.length > MAX_BATCH_SIZE) {
      throw new RangeError('Local Secret batch is too large');
    }
    if (references.length === 0) return Object.freeze([]);
    const replacements: Record<string, string | number | null> = {};
    const requestedValues = references.map((reference, position) => {
      createLocalSecretRef(reference);
      replacements[`position${position}`] = position;
      replacements[`project${position}`] = reference.projectId;
      replacements[`name${position}`] = reference.name;
      replacements[`version${position}`] = reference.version ?? null;
      return `(:position${position}, :project${position}, :name${position}, :version${position})`;
    });
    const rows = await this.database.query<ResolvedSecretRow>(
      `WITH requested(position, project_id, secret_name, requested_version) AS (
        VALUES ${requestedValues.join(', ')}
      )
      SELECT requested.position,
             envelope.project_id,
             envelope.secret_name,
             envelope.version,
             envelope.mutation_id,
             envelope.key_id,
             envelope.algorithm,
             envelope.nonce,
             envelope.ciphertext,
             envelope.auth_tag,
             envelope.created_at_ms
        FROM requested
        LEFT JOIN "${LOCAL_SECRET_ENVELOPE_TABLE}" AS envelope
          ON envelope.project_id = requested.project_id
         AND envelope.secret_name = requested.secret_name
         AND envelope.version = COALESCE(
           requested.requested_version,
           (SELECT MAX(current.version)
              FROM "${LOCAL_SECRET_ENVELOPE_TABLE}" AS current
             WHERE current.project_id = requested.project_id
               AND current.secret_name = requested.secret_name)
         )
       ORDER BY requested.position ASC`,
      { type: QueryTypes.SELECT, replacements },
    );
    if (rows.length !== references.length) {
      throw new LocalSecretUnavailableError();
    }
    return Object.freeze(rows.map(resolvedRowToEnvelope));
  }

  private values(envelope: LocalSecretEnvelope): LocalSecretEnvelopeRow {
    return {
      projectId: envelope.projectId,
      name: envelope.name,
      version: envelope.version,
      mutationId: envelope.mutationId,
      keyId: envelope.keyId,
      algorithm: envelope.algorithm,
      nonce: Buffer.from(envelope.nonce, 'base64url'),
      ciphertext: Buffer.from(envelope.ciphertext, 'base64url'),
      authTag: Buffer.from(envelope.authTag, 'base64url'),
      createdAtMs: envelope.createdAtMs,
    };
  }
}
