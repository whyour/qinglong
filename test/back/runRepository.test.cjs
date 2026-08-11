require('ts-node/register/transpile-only');

const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const { runSchemaMigration } = require('../../back/migrations/0002-run-schema');
const {
  runCancellationRequestMigration,
} = require('../../back/migrations/0004-run-cancellation-request');
const {
  runAttemptDeadlineMigration,
} = require('../../back/migrations/0006-run-attempt-deadline');
const {
  runRetryPolicyMigration,
} = require('../../back/migrations/0011-run-retry-policy');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  registerRunRepositoryContract,
} = require('../contracts/runRepositoryContract.cjs');

registerRunRepositoryContract({
  name: 'LegacySequelizeRunRepository contract',
  async createRepository() {
    const database = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
    });
    await runMigrations({
      database,
      migrationModel: defineSchemaMigrationModel(database),
      migrations: [
        runSchemaMigration,
        runCancellationRequestMigration,
        runAttemptDeadlineMigration,
        runRetryPolicyMigration,
      ],
      logger: { info() {} },
    });
    return {
      repository: new LegacySequelizeRunRepository(database),
      close: () => database.close(),
    };
  },
});
