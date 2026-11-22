// Stop the real migration transaction on either side of COMMIT. The harness
// reads through a separate SQLite connection before killing the worker or VM.
const fs = require('node:fs');
const path = require('node:path');
const [modules, side, checkpoint] = process.argv.slice(2);
const { sequelize } = require(path.join(modules, 'data'));
const { migrateSchema, prunedExitMigrationId } = require(path.join(
  modules,
  'data/schemaMigrations',
));
if (!['before', 'after'].includes(side))
  throw new Error('Unknown commit boundary');
const transaction = sequelize.transaction.bind(sequelize);
sequelize.transaction = (callback) =>
  transaction(async (tx) => {
    await callback(tx);
    const [rows] = await sequelize.query(
      `SELECT
    (SELECT COUNT(*) FROM SchemaMigrations WHERE id=$id) AS marker,
    (SELECT COUNT(*) FROM CronUnmatchedBoundExits) AS proofs`,
      { transaction: tx, bind: { id: prunedExitMigrationId } },
    );
    if (rows[0].marker !== 1 || rows[0].proofs === 0)
      throw new Error('No verified migration batch');
    const hold = () => {
      fs.writeFileSync(
        checkpoint + '.tmp',
        JSON.stringify({ side, pid: process.pid, ...rows[0] }),
        { flag: 'wx' },
      );
      fs.renameSync(checkpoint + '.tmp', checkpoint);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    if (side === 'before') hold();
    else tx.afterCommit(hold);
  });
migrateSchema(sequelize).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
