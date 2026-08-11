import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import type { Migration } from './types';

export const LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE =
  'LocalExecutionContextRecipes';
export const LOCAL_EXECUTION_CONTEXT_RECIPE_CREATED_INDEX =
  'local_execution_context_recipes_created_idx';

const manifest = {
  table: LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
  columns: [
    'context_ref',
    'environment_recipe',
    'content_digest',
    'created_at_ms',
  ],
  indexes: [
    `${LOCAL_EXECUTION_CONTEXT_RECIPE_CREATED_INDEX}(created_at_ms,context_ref)`,
  ],
  constraints: ['local_execution_context_recipes_created_at_check'],
};

export const localExecutionContextRecipeManifest = manifest;

export const localExecutionContextRecipeMigration: Migration = {
  id: '0013-local-execution-context-recipes',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
      {
        context_ref: {
          type: DataTypes.STRING(512),
          allowNull: false,
          primaryKey: true,
        },
        environment_recipe: { type: DataTypes.TEXT, allowNull: false },
        content_digest: { type: DataTypes.STRING(64), allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE, {
      fields: ['created_at_ms'],
      type: 'check',
      where: { created_at_ms: { [Op.gte]: 0 } },
      name: 'local_execution_context_recipes_created_at_check',
      transaction,
    });
    await queryInterface.addIndex(
      LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
      ['created_at_ms', 'context_ref'],
      { name: LOCAL_EXECUTION_CONTEXT_RECIPE_CREATED_INDEX, transaction },
    );
  },
};
