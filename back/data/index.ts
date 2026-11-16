import { Sequelize, Transaction } from 'sequelize';
import config from '../config/index';
import type { Database } from 'sqlite3';
import { join } from 'path';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: join(config.dbPath, 'database.sqlite'),
  logging: false,
  retry: {
    max: 10,
    match: ['SQLITE_BUSY: database is locked'],
  },
  pool: {
    max: 5,
    min: 2,
    idle: 30000,
    acquire: 30000,
    evict: 10000,
  },
  transactionType: Transaction.TYPES.IMMEDIATE,
});

// In DELETE journal mode, EXTRA flushes the unlink that makes a transaction
// final. Sequelize opens a separate SQLite handle for each transaction.
const initialized = new WeakMap<Database, Promise<void>>();
sequelize.addHook('beforeQuery', async (_options, query) => {
  const connection = query.connection as Database;
  let ready = initialized.get(connection);
  if (!ready) {
    ready = new Promise<void>((resolve, reject) => {
      connection.run('PRAGMA synchronous=EXTRA', error => error ? reject(error) : resolve());
    }).catch(error => {
      initialized.delete(connection);
      throw error;
    });
    initialized.set(connection, ready);
  }
  await ready;
});

// SQLite transactions use dedicated file handles outside Sequelize 6's pool.
// Its default destroyConnection targets the pool on COMMIT/ROLLBACK errors,
// leaving the native writer open. The SQLite release path closes that handle.
sequelize.connectionManager.destroyConnection = async (connection) => {
  sequelize.connectionManager.releaseConnection(connection);
};

export type ResponseType<T> = { code: number; data?: T; message?: string };
