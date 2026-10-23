import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { EntitySchema, Type } from '@mikro-orm/core';
import { MikroORM, SqliteDriver, NodeSqliteDialect, raw } from '@mikro-orm/sql';
import { entityDefinitions } from './schema';

// Sequelize DATE readers expect TEXT. Numeric epoch dates would break rollback.
class LegacyDateType extends Type<Date, string> {
  convertToDatabaseValue(value: Date) {
    return value == null
      ? value
      : value.toISOString().replace('T', ' ').replace('Z', ' +00:00');
  }
  convertToJSValue(value: string | Date) {
    return value == null
      ? value
      : value instanceof Date
      ? value
      : new Date(value);
  }
  getColumnType() {
    return 'DATETIME';
  }
  compareAsType() {
    return 'string' as const;
  }
  get runtimeType() {
    return 'Date';
  }
}

const entities = Object.values(entityDefinitions).map(
  (definition) =>
    new EntitySchema({
      ...definition,
      properties: Object.fromEntries(
        Object.entries(definition.properties).map(([name, field]) => [
          name,
          {
            ...field,
            type:
              field.type === 'legacyDate' ? new LegacyDateType() : field.type,
          },
        ]),
      ),
    } as any),
);
let orm: Awaited<ReturnType<typeof MikroORM.init<SqliteDriver>>>;
let cache: any;
const transactions: number[] = [];
let ready: Promise<void>;
let workerData: { storage: string; cacheStorage?: string; ownerPid: number };

async function initialize() {
  if (workerData.storage !== ':memory:')
    mkdirSync(dirname(workerData.storage), { recursive: true });
  orm = await MikroORM.init<SqliteDriver>({
    driver: SqliteDriver,
    driverOptions: new NodeSqliteDialect(workerData.storage),
    dbName: workerData.storage,
    entities,
    debug: false,
    allowGlobalContext: false,
    discovery: { warnWhenNoEntities: false },
  });
  await orm.em.getConnection().execute('PRAGMA busy_timeout=10000');
}

function filter(name: keyof typeof entityDefinitions, value: any): any {
  if (value === undefined) throw new Error('Undefined database predicate');
  if (value == null || typeof value !== 'object' || value instanceof Date)
    return value;
  if (Array.isArray(value)) return value.map((part) => filter(name, part));
  const properties = entityDefinitions[name].properties;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]: [string, any]) => {
      if (item === undefined) throw new Error('Undefined database predicate');
      // LIKE searches JSON's serialized text, matching the pre-migration behavior.
      if (
        key in properties &&
        (properties as any)[key].type === 'json' &&
        item &&
        typeof item === 'object' &&
        '$like' in item
      )
        return [raw(`cast("${key}" as text)`), item];
      return [key, filter(name, item)];
    }),
  );
}

function values(
  name: keyof typeof entityDefinitions,
  payload: Record<string, any>,
  insert = false,
) {
  const properties = entityDefinitions[name].properties;
  const data = Object.fromEntries(
    Object.entries(payload).filter(
      ([key, value]) => key in properties && value !== undefined,
    ),
  );
  for (const [key, value] of Object.entries(data)) {
    if ((properties as any)[key].type === 'json' && value !== null)
      data[key] = JSON.parse(JSON.stringify(value));
  }
  const now = new Date();
  if (insert && !data.createdAt) data.createdAt = now;
  data.updatedAt = now;
  return data;
}

function plain(name: keyof typeof entityDefinitions, row: any) {
  if (!row) return null;
  return Object.fromEntries(
    Object.keys(entityDefinitions[name].properties)
      .filter((key) => row[key] !== undefined)
      .map((key) => [key, row[key]]),
  );
}

async function execute(
  operation: string,
  args: any[],
  token?: number,
): Promise<any> {
  await ready;
  // Reject queued work after owner death; the monitor interrupts running SQL.
  if (process.ppid !== workerData.ownerPid) process.exit(1);
  const connection = orm.em.getConnection();
  if (operation === 'begin') {
    await connection.execute(
      transactions.length ? `SAVEPOINT "ql_${token}"` : 'BEGIN IMMEDIATE',
    );
    transactions.push(token!);
    return;
  }
  if (token !== transactions[transactions.length - 1])
    throw new Error('Database transaction ownership mismatch');
  if (operation === 'commit' || operation === 'rollback') {
    if (!transactions.length) throw new Error('No active database transaction');
    const nested = transactions.length > 1;
    if (operation === 'rollback' && nested)
      await connection.execute(`ROLLBACK TO SAVEPOINT "ql_${token}"`);
    await connection.execute(
      nested ? `RELEASE SAVEPOINT "ql_${token}"` : operation.toUpperCase(),
    );
    transactions.pop();
    return;
  }
  if (operation === 'close') {
    if (transactions.length)
      throw new Error('Cannot close an active transaction');
    cache?.close();
    await orm.close();
    return;
  }
  if (operation === 'query') return connection.execute(args[0], args[1]);
  if (operation === 'cache') {
    if (!workerData.cacheStorage)
      throw new Error('No cache database configured');
    if (!cache) {
      const { DatabaseSync } = require('node:sqlite');
      mkdirSync(dirname(workerData.cacheStorage), { recursive: true });
      cache = new DatabaseSync(workerData.cacheStorage);
      cache.exec(
        'PRAGMA busy_timeout=10000;CREATE TABLE IF NOT EXISTS keyv(key VARCHAR(255) PRIMARY KEY,value TEXT)',
      );
    }
    const [action, key, value] = args;
    switch (action) {
      case 'get':
        return cache.prepare('SELECT value FROM keyv WHERE key=?').get(key)
          ?.value;
      case 'set':
        cache
          .prepare(
            'INSERT INTO keyv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          )
          .run(key, value);
        return true;
      case 'delete':
        return (
          cache.prepare('DELETE FROM keyv WHERE key=?').run(key).changes > 0
        );
      default:
        throw new Error('Unsupported cache operation');
    }
  }
  const [name, condition, options = {}] = args as [
    keyof typeof entityDefinitions,
    any,
    any,
  ];
  if (!(name in entityDefinitions)) throw new Error('Unknown entity');
  const em = orm.em.fork();
  const entityName = entities.find((entity) => entity.meta.className === name)!;
  if (operation !== 'insert' && condition == null)
    throw new Error('Missing database predicate');
  const query = operation === 'insert' ? {} : filter(name, condition);
  const readOptions = {
    ...options,
    orderBy: options.orderBy?.map((order: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(order).map(([field, direction]) => [
          name === 'Env' && field === 'isPinned'
            ? raw('COALESCE("isPinned",0)')
            : field,
          direction,
        ]),
      ),
    ),
  };
  switch (operation) {
    case 'find':
      return (await em.find(entityName, query, readOptions)).map((row) =>
        plain(name, row),
      );
    case 'findOne':
      return plain(name, await em.findOne(entityName, query, readOptions));
    case 'count':
      return em.count(entityName, query);
    case 'insert': {
      const id = await em.insert(entityName, values(name, condition, true));
      return plain(name, await em.findOneOrFail(entityName, { id }));
    }
    case 'nativeUpdate':
      return em.nativeUpdate(entityName, query, values(name, options));
    case 'nativeDelete':
      return em.nativeDelete(entityName, query);
    default:
      throw new Error('Unsupported database operation');
  }
}

export function startDatabaseWorker(settings: typeof workerData) {
  workerData = settings;
  ready = initialize();
  void ready.catch(() => {});
  let queue = Promise.resolve();
  process.on('message', ({ id, operation, args, token }) => {
    // Continue after a failed statement so the owner can still roll back.
    queue = queue.then(async () => {
      try {
        process.send?.({
          id,
          value: await execute(operation, args, token),
        });
      } catch (error: any) {
        const code =
          error.name === 'UniqueConstraintViolationException'
            ? 'UNIQUE_CONSTRAINT'
            : error.name === 'TableNotFoundException'
            ? 'DATABASE_SCHEMA_MISSING'
            : (
                {
                  5: 'SQLITE_BUSY',
                  6: 'SQLITE_LOCKED',
                  8: 'SQLITE_READONLY',
                  10: 'SQLITE_IOERR',
                  11: 'SQLITE_CORRUPT',
                  13: 'SQLITE_FULL',
                  14: 'SQLITE_CANTOPEN',
                  26: 'SQLITE_NOTADB',
                } as Record<number, string>
              )[Number(error.errcode) & 255] || 'DATABASE_QUERY_FAILED';
        process.send?.({
          id,
          error: {
            code,
            message:
              code === 'UNIQUE_CONSTRAINT'
                ? 'Resource already exists'
                : `Database operation failed (${code})`,
          },
        });
      }
    });
  });
}
