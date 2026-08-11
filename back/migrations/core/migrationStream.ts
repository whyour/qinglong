export const MIGRATION_STREAM_DIALECTS = ['sqlite', 'postgresql'] as const;

export type MigrationStreamDialect = (typeof MIGRATION_STREAM_DIALECTS)[number];

export const MIGRATION_ID_SCHEMES = [
  'sqlite-numbered',
  'postgres-prefixed',
] as const;

export type MigrationIdScheme = (typeof MIGRATION_ID_SCHEMES)[number];

export const MIGRATION_CHECKSUM_SCHEMES = ['sha256', 'legacy-opaque'] as const;

export type MigrationChecksumScheme =
  (typeof MIGRATION_CHECKSUM_SCHEMES)[number];

export interface MigrationStreamRecord {
  streamId: string;
  dialect: MigrationStreamDialect;
  migrationId: string;
  checksum: string;
  appliedAtMs: number;
}

export interface MigrationStreamStep<TContext> {
  id: string;
  checksum: string;
  up(context: TContext): Promise<void>;
}

export interface MigrationStreamTransaction<TContext> {
  readonly context: TContext;
  findById(migrationId: string): Promise<MigrationStreamRecord | null>;
  insert(record: MigrationStreamRecord): Promise<void>;
}

export interface MigrationStreamStore<TContext> {
  ensureHistory(): Promise<void>;
  listAll(): Promise<readonly MigrationStreamRecord[]>;
  findById(migrationId: string): Promise<MigrationStreamRecord | null>;
  transaction<T>(
    work: (transaction: MigrationStreamTransaction<TContext>) => Promise<T>,
  ): Promise<T>;
}

export interface MigrationStreamDefinition<TContext> {
  id: string;
  dialect: MigrationStreamDialect;
  migrationIdScheme: MigrationIdScheme;
  checksumScheme: MigrationChecksumScheme;
  migrations: readonly MigrationStreamStep<TContext>[];
}

export interface RunMigrationStreamOptions<TContext> {
  stream: MigrationStreamDefinition<TContext>;
  store: MigrationStreamStore<TContext>;
  clock?: () => number;
  logger?: { info(message: string): unknown };
}

const STREAM_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SQLITE_MIGRATION_ID_PATTERN = /^\d{4}-[a-z0-9][a-z0-9-]{0,122}$/;
const POSTGRES_MIGRATION_ID_PATTERN = /^pg-\d{4}-[a-z0-9][a-z0-9-]{0,119}$/;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LEGACY_CHECKSUM_LENGTH = 255;

export class InvalidMigrationStreamError extends TypeError {
  constructor(message: string) {
    super(`Migration stream is invalid: ${message}`);
    this.name = 'InvalidMigrationStreamError';
  }
}

export class MigrationStreamChecksumMismatchError extends Error {
  constructor(
    readonly migrationId: string,
    readonly databaseChecksum: string,
    readonly codeChecksum: string,
  ) {
    super(
      `Migration checksum mismatch: ${migrationId} ` +
        `(database=${databaseChecksum}, code=${codeChecksum})`,
    );
    this.name = 'MigrationStreamChecksumMismatchError';
  }
}

export class MigrationStreamHistoryCorruptionError extends Error {
  constructor(readonly migrationId: string) {
    super(`Migration history is corrupt: ${migrationId}`);
    this.name = 'MigrationStreamHistoryCorruptionError';
  }
}

export class MigrationStreamAheadOfCodeError extends Error {
  constructor(readonly migrationId: string) {
    super(`Migration history is ahead of this code: ${migrationId}`);
    this.name = 'MigrationStreamAheadOfCodeError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    keys.length === canonical.length &&
    keys.every((key, index) => key === canonical[index])
  );
}

function checksumIsValid(
  scheme: MigrationChecksumScheme,
  value: unknown,
): value is string {
  if (typeof value !== 'string') return false;
  return scheme === 'sha256'
    ? CHECKSUM_PATTERN.test(value)
    : value.length <= MAX_LEGACY_CHECKSUM_LENGTH;
}

function validateDefinition<TContext>(
  stream: MigrationStreamDefinition<TContext>,
): void {
  if (!stream || typeof stream !== 'object' || Array.isArray(stream)) {
    throw new InvalidMigrationStreamError('definition must be an object');
  }
  if (
    !exactKeys(stream, [
      'id',
      'dialect',
      'migrationIdScheme',
      'checksumScheme',
      'migrations',
    ])
  ) {
    throw new InvalidMigrationStreamError('definition shape is invalid');
  }
  if (!STREAM_ID_PATTERN.test(stream.id)) {
    throw new InvalidMigrationStreamError('id is invalid');
  }
  if (!MIGRATION_STREAM_DIALECTS.includes(stream.dialect)) {
    throw new InvalidMigrationStreamError('dialect is invalid');
  }
  if (!MIGRATION_ID_SCHEMES.includes(stream.migrationIdScheme)) {
    throw new InvalidMigrationStreamError('migrationIdScheme is invalid');
  }
  if (!MIGRATION_CHECKSUM_SCHEMES.includes(stream.checksumScheme)) {
    throw new InvalidMigrationStreamError('checksumScheme is invalid');
  }
  if (
    (stream.dialect === 'sqlite' &&
      stream.migrationIdScheme !== 'sqlite-numbered') ||
    (stream.dialect === 'postgresql' &&
      stream.migrationIdScheme !== 'postgres-prefixed')
  ) {
    throw new InvalidMigrationStreamError(
      'migrationIdScheme does not match dialect',
    );
  }
  if (!Array.isArray(stream.migrations)) {
    throw new InvalidMigrationStreamError('migrations must be an array');
  }
  const ids = new Set<string>();
  for (const migration of stream.migrations) {
    if (
      !migration ||
      typeof migration !== 'object' ||
      Array.isArray(migration) ||
      !exactKeys(migration, ['id', 'checksum', 'up']) ||
      !(
        stream.migrationIdScheme === 'sqlite-numbered'
          ? SQLITE_MIGRATION_ID_PATTERN
          : POSTGRES_MIGRATION_ID_PATTERN
      ).test(migration.id) ||
      !checksumIsValid(stream.checksumScheme, migration.checksum) ||
      typeof migration.up !== 'function'
    ) {
      throw new InvalidMigrationStreamError('migration is invalid');
    }
    if (ids.has(migration.id)) {
      throw new InvalidMigrationStreamError(
        `duplicate migration id: ${migration.id}`,
      );
    }
    ids.add(migration.id);
  }
}

function validateRecord(
  value: MigrationStreamRecord,
  stream: MigrationStreamDefinition<unknown>,
  migrationId: string,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'streamId',
      'dialect',
      'migrationId',
      'checksum',
      'appliedAtMs',
    ]) ||
    value.streamId !== stream.id ||
    value.dialect !== stream.dialect ||
    value.migrationId !== migrationId ||
    !checksumIsValid(stream.checksumScheme, value.checksum) ||
    !Number.isSafeInteger(value.appliedAtMs) ||
    value.appliedAtMs < 0
  ) {
    throw new MigrationStreamHistoryCorruptionError(migrationId);
  }
}

function assertChecksum(
  record: MigrationStreamRecord,
  migration: MigrationStreamStep<unknown>,
): void {
  if (record.checksum !== migration.checksum) {
    throw new MigrationStreamChecksumMismatchError(
      migration.id,
      record.checksum,
      migration.checksum,
    );
  }
}

export function auditMigrationStreamHistory<TContext>(
  history: readonly MigrationStreamRecord[],
  stream: MigrationStreamDefinition<TContext>,
): ReadonlySet<string> {
  if (!Array.isArray(history)) {
    throw new MigrationStreamHistoryCorruptionError('history');
  }
  const migrationsById = new Map(
    stream.migrations.map((migration, index) => [
      migration.id,
      { migration, index },
    ]),
  );
  const appliedIds = new Set<string>();
  const appliedIndexes = new Set<number>();
  for (const record of history) {
    const expected = migrationsById.get(record?.migrationId);
    if (!expected) {
      throw new MigrationStreamAheadOfCodeError(
        record?.migrationId ?? 'unknown',
      );
    }
    if (appliedIds.has(record.migrationId)) {
      throw new MigrationStreamHistoryCorruptionError(record.migrationId);
    }
    validateRecord(
      record,
      stream as MigrationStreamDefinition<unknown>,
      expected.migration.id,
    );
    assertChecksum(record, expected.migration as MigrationStreamStep<unknown>);
    appliedIds.add(record.migrationId);
    appliedIndexes.add(expected.index);
  }
  for (let index = 0; index < appliedIndexes.size; index += 1) {
    if (!appliedIndexes.has(index)) {
      throw new MigrationStreamHistoryCorruptionError(
        stream.migrations[index].id,
      );
    }
  }
  return appliedIds;
}

/**
 * Dialect-neutral migration ordering and history semantics. Concrete stores own
 * SQL, leader election and transaction APIs; this core never imports a driver.
 */
export async function runMigrationStream<TContext>(
  options: RunMigrationStreamOptions<TContext>,
): Promise<void> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new InvalidMigrationStreamError('options must be an object');
  }
  const expectedKeys = [
    'stream',
    'store',
    ...(options.clock === undefined ? [] : ['clock']),
    ...(options.logger === undefined ? [] : ['logger']),
  ];
  if (!exactKeys(options, expectedKeys)) {
    throw new InvalidMigrationStreamError('options shape is invalid');
  }
  validateDefinition(options.stream);
  if (
    !options.store ||
    typeof options.store !== 'object' ||
    typeof options.store.ensureHistory !== 'function' ||
    typeof options.store.listAll !== 'function' ||
    typeof options.store.findById !== 'function' ||
    typeof options.store.transaction !== 'function'
  ) {
    throw new InvalidMigrationStreamError('store is invalid');
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') {
    throw new InvalidMigrationStreamError('clock is invalid');
  }
  await options.store.ensureHistory();
  const appliedAtStart = auditMigrationStreamHistory(
    await options.store.listAll(),
    options.stream,
  );
  for (const migration of options.stream.migrations) {
    if (appliedAtStart.has(migration.id)) continue;
    const applied = await options.store.findById(migration.id);
    if (applied) {
      validateRecord(
        applied,
        options.stream as MigrationStreamDefinition<unknown>,
        migration.id,
      );
      assertChecksum(applied, migration as MigrationStreamStep<unknown>);
      continue;
    }
    let appliedNow = false;
    await options.store.transaction(async (transaction) => {
      const appliedInsideTransaction = await transaction.findById(migration.id);
      if (appliedInsideTransaction) {
        validateRecord(
          appliedInsideTransaction,
          options.stream as MigrationStreamDefinition<unknown>,
          migration.id,
        );
        assertChecksum(
          appliedInsideTransaction,
          migration as MigrationStreamStep<unknown>,
        );
        return;
      }
      await migration.up(transaction.context);
      const appliedAtMs = clock();
      if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
        throw new InvalidMigrationStreamError(
          'clock must return a non-negative safe integer',
        );
      }
      await transaction.insert({
        streamId: options.stream.id,
        dialect: options.stream.dialect,
        migrationId: migration.id,
        checksum: migration.checksum,
        appliedAtMs,
      });
      appliedNow = true;
    });
    if (appliedNow) {
      options.logger?.info(
        `[migration:${options.stream.id}] Applied ${migration.id}`,
      );
    }
  }
}
