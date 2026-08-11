import {
  DataTypes,
  Model,
  ModelStatic,
  Sequelize,
  UniqueConstraintError,
} from 'sequelize';
import { LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE } from '../../../migrations/0013-local-execution-context-recipes';
import {
  assertLocalExecutionContextRef,
  createLocalExecutionContextRecipeRecord,
  localExecutionContextRecipeDigest,
  normalizeLocalExecutionContextRecipe,
  type LocalExecutionContextRecipe,
} from '../../domain/localExecutionContextRecipe';
import type {
  InsertLocalExecutionContextRecipeResult,
  LocalExecutionContextRecipeRepository,
} from '../../ports/localExecutionContextRecipeRepository';

interface LocalExecutionContextRecipeRow {
  contextRef: string;
  environmentRecipe: string;
  contentDigest: string;
  createdAtMs: number | string;
}

interface LocalExecutionContextRecipeInstance
  extends Model<LocalExecutionContextRecipeRow, LocalExecutionContextRecipeRow>,
    LocalExecutionContextRecipeRow {}

export class LocalExecutionContextRecipeConflictError extends Error {
  constructor(readonly contextRef: string) {
    super(`Local execution context recipe ${contextRef} is immutable`);
    this.name = 'LocalExecutionContextRecipeConflictError';
  }
}

export class LocalExecutionContextRecipeCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalExecutionContextRecipeCorruptError';
  }
}

function defineRecipeModel(
  database: Sequelize,
): ModelStatic<LocalExecutionContextRecipeInstance> {
  return database.define<LocalExecutionContextRecipeInstance>(
    'Ql3LocalExecutionContextRecipe',
    {
      contextRef: {
        field: 'context_ref',
        type: DataTypes.STRING(512),
        allowNull: false,
        primaryKey: true,
      },
      environmentRecipe: {
        field: 'environment_recipe',
        type: DataTypes.TEXT,
        allowNull: false,
      },
      contentDigest: {
        field: 'content_digest',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
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

function rowToRecipe(
  row: LocalExecutionContextRecipeRow,
): LocalExecutionContextRecipe {
  let environment: unknown;
  try {
    environment = JSON.parse(row.environmentRecipe);
  } catch {
    throw new LocalExecutionContextRecipeCorruptError(
      'Stored local execution context recipe is not valid JSON',
    );
  }
  try {
    const normalized = normalizeLocalExecutionContextRecipe({
      contextRef: row.contextRef,
      environment: environment as LocalExecutionContextRecipe['environment'],
    });
    if (JSON.stringify(normalized.environment) !== row.environmentRecipe) {
      throw new LocalExecutionContextRecipeCorruptError(
        'Stored local execution context recipe is not canonical',
      );
    }
    if (
      !/^[0-9a-f]{64}$/.test(row.contentDigest) ||
      localExecutionContextRecipeDigest(normalized) !== row.contentDigest
    ) {
      throw new LocalExecutionContextRecipeCorruptError(
        'Stored local execution context recipe digest does not match',
      );
    }
    return createLocalExecutionContextRecipeRecord(
      normalized,
      Number(row.createdAtMs),
    );
  } catch (error) {
    if (error instanceof LocalExecutionContextRecipeCorruptError) throw error;
    throw new LocalExecutionContextRecipeCorruptError(
      `Stored local execution context recipe is invalid: ${
        error instanceof Error ? error.message : 'unknown validation error'
      }`,
    );
  }
}

export class LegacySequelizeLocalExecutionContextRecipeRepository
  implements LocalExecutionContextRecipeRepository
{
  private readonly recipe: ModelStatic<LocalExecutionContextRecipeInstance>;

  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Legacy local context recipe repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.recipe = defineRecipeModel(database);
  }

  async resolve(
    contextRef: string,
  ): Promise<LocalExecutionContextRecipe | null> {
    assertLocalExecutionContextRef(contextRef);
    const row = (await this.recipe.findByPk(contextRef, {
      raw: true,
    })) as unknown as LocalExecutionContextRecipeRow | null;
    return row ? rowToRecipe(row) : null;
  }

  async insert(
    recipe: LocalExecutionContextRecipe,
    createdAtMs: number,
  ): Promise<InsertLocalExecutionContextRecipeResult> {
    const record = createLocalExecutionContextRecipeRecord(recipe, createdAtMs);
    const values: LocalExecutionContextRecipeRow = {
      contextRef: record.contextRef,
      environmentRecipe: JSON.stringify(record.environment),
      contentDigest: record.contentDigest,
      createdAtMs: record.createdAtMs,
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.recipe.create(values);
        return 'inserted';
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          const existing = await this.resolve(record.contextRef);
          if (
            existing &&
            localExecutionContextRecipeDigest(existing) === record.contentDigest
          ) {
            return 'idempotent';
          }
          throw new LocalExecutionContextRecipeConflictError(record.contextRef);
        }
        if (errorCode(error) === 'SQLITE_BUSY' && attempt < 4) {
          await retryDelay(attempt);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Local context recipe insert retry budget exhausted');
  }
}
