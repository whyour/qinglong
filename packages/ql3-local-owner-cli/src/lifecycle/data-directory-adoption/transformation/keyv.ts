import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LocalDataDirectoryAdoptionConfigurationError } from '../contract';
import { sameStat } from '../filesystem';
import { sha256Text } from '../manifest';
import {
  optionalPrivateDirectory,
  summarizePrivateTree,
  type PrivateTreeEvidence,
} from './files';

const KNOWN_KEYS = Object.freeze([
  Object.freeze({
    key: 'keyv:authInfo',
    target: 'credential_reissue' as const,
  }),
  Object.freeze({
    key: 'keyv:apps',
    target: 'main_database_apps_reconciliation' as const,
  }),
  Object.freeze({
    key: 'keyv:lang',
    target: 'main_database_system_settings_reconciliation' as const,
  }),
]);

type KeyvTarget = (typeof KNOWN_KEYS)[number]['target'];

export interface KeyvTransformationModel {
  readonly schema: 'qinglong/legacy-keyv-transformation@v1';
  readonly databasePresent: boolean;
  readonly integrity: 'absent' | 'ok';
  readonly mappings: readonly Readonly<{
    legacyKey: string;
    target: KeyvTarget;
    state: 'absent' | 'retired' | 'reconcile';
    valueDigest: string | null;
  }>[];
  readonly cachedLocale: 'zh' | 'en' | null;
  readonly unknownEntries: number;
  readonly unknownEntryDigest: string;
  readonly unknownSchemaObjects: number;
  readonly unknownSchemaDigest: string;
  readonly disabledAssetEntries: number;
  readonly activation: 'disabled';
}

export interface KeyvTransformation {
  readonly source: Readonly<PrivateTreeEvidence> | null;
  readonly model: Readonly<KeyvTransformationModel>;
  readonly assessment: 'ready' | 'manual_required';
}

function emptyModel(): Readonly<KeyvTransformationModel> {
  return Object.freeze({
    schema: 'qinglong/legacy-keyv-transformation@v1',
    databasePresent: false,
    integrity: 'absent',
    mappings: Object.freeze(
      KNOWN_KEYS.map((entry) =>
        Object.freeze({
          legacyKey: entry.key,
          target: entry.target,
          state: 'absent' as const,
          valueDigest: null,
        }),
      ),
    ),
    cachedLocale: null,
    unknownEntries: 0,
    unknownEntryDigest: sha256Text(''),
    unknownSchemaObjects: 0,
    unknownSchemaDigest: sha256Text(''),
    disabledAssetEntries: 0,
    activation: 'disabled',
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function cachedLocale(value: string): 'zh' | 'en' | null {
  try {
    const envelope = JSON.parse(value) as unknown;
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      !exactKeys(envelope, ['expires', 'value'])
    ) {
      return null;
    }
    const candidate = envelope as {
      readonly expires?: unknown;
      value?: unknown;
    };
    return candidate.expires === null &&
      (candidate.value === 'zh' || candidate.value === 'en')
      ? candidate.value
      : null;
  } catch {
    return null;
  }
}

export function transformLegacyKeyv(
  categoryRoot: string,
  uid: number,
  profile: 'edge' | 'standalone',
): Readonly<KeyvTransformation> {
  if (
    !optionalPrivateDirectory(categoryRoot, uid, 'Keyv transformation input')
  ) {
    return Object.freeze({
      source: null,
      model: emptyModel(),
      assessment: 'ready',
    });
  }
  const source = summarizePrivateTree(categoryRoot, uid);
  const databasePath = path.join(categoryRoot, 'keyv.sqlite');
  let expected: fs.BigIntStats;
  try {
    expected = fs.lstatSync(databasePath, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return Object.freeze({
        source,
        model: Object.freeze({
          ...emptyModel(),
          disabledAssetEntries: source.entries,
        }),
        assessment: source.entries === 0 ? 'ready' : 'manual_required',
      });
    }
    throw error;
  }
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.nlink !== 1n ||
    expected.uid !== BigInt(uid) ||
    (expected.mode & 0o777n) !== 0o600n
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staged Keyv database identity or mode is invalid',
    );
  }

  const client = new DatabaseSync(databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5_000,
  });
  const values = new Map<string, string>();
  let unknownEntries = 0;
  const unknownEntryHash = crypto.createHash('sha256');
  let unknownSchemaObjects = 0;
  const unknownSchemaHash = crypto.createHash('sha256');
  try {
    client.enableDefensive(true);
    client.exec(
      `PRAGMA trusted_schema = OFF; PRAGMA query_only = ON; PRAGMA mmap_size = 0; PRAGMA cache_size = ${
        profile === 'edge' ? -2048 : -8192
      }`,
    );
    const integrity = client.prepare('PRAGMA integrity_check(1)').get() as
      | { readonly integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staged Keyv database integrity check failed',
      );
    }
    const tables = client.prepare(`PRAGMA table_list('keyv')`).all() as Array<{
      readonly schema?: unknown;
      readonly name?: unknown;
      readonly type?: unknown;
      readonly ncol?: unknown;
      readonly wr?: unknown;
      readonly strict?: unknown;
    }>;
    if (
      tables.length !== 1 ||
      tables[0]?.schema !== 'main' ||
      tables[0]?.name !== 'keyv' ||
      tables[0]?.type !== 'table' ||
      tables[0]?.ncol !== 2 ||
      tables[0]?.wr !== 0 ||
      tables[0]?.strict !== 0
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staged Keyv database is not a reviewed ordinary table',
      );
    }
    const columns = client.prepare(`PRAGMA table_info('keyv')`).all() as Array<{
      readonly name?: unknown;
      readonly type?: unknown;
      readonly pk?: unknown;
    }>;
    if (
      columns.length !== 2 ||
      columns[0]?.name !== 'key' ||
      columns[0]?.type !== 'VARCHAR(255)' ||
      columns[0]?.pk !== 1 ||
      columns[1]?.name !== 'value' ||
      columns[1]?.type !== 'TEXT' ||
      columns[1]?.pk !== 0
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staged Keyv database schema is not the reviewed v4 shape',
      );
    }
    const schema = client
      .prepare(
        `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY CAST(name AS BLOB)`,
      )
      .all() as Array<{
      readonly type?: unknown;
      readonly name?: unknown;
      readonly tableName?: unknown;
      readonly sql?: unknown;
    }>;
    for (const object of schema) {
      if (
        object.type === 'table' &&
        object.name === 'keyv' &&
        object.tableName === 'keyv'
      ) {
        continue;
      }
      unknownSchemaObjects += 1;
      unknownSchemaHash.update(
        `${sha256Text(JSON.stringify(object))}\n`,
        'utf8',
      );
    }
    const rowBudget = profile === 'edge' ? 256 : 2_048;
    const byteBudget = profile === 'edge' ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
    let rows = 0;
    let bytes = 0;
    const statement = client.prepare(
      `SELECT key, value, length(CAST(value AS BLOB)) AS valueBytes
         FROM keyv
        ORDER BY CAST(key AS BLOB)`,
    );
    for (const row of statement.iterate() as Iterable<{
      readonly key?: unknown;
      readonly value?: unknown;
      readonly valueBytes?: unknown;
    }>) {
      rows += 1;
      if (
        rows > rowBudget ||
        typeof row.key !== 'string' ||
        Buffer.byteLength(row.key, 'utf8') > 255 ||
        typeof row.value !== 'string' ||
        !Number.isSafeInteger(row.valueBytes) ||
        (row.valueBytes as number) < 0 ||
        (row.valueBytes as number) > 1024 * 1024 ||
        !Number.isSafeInteger(bytes + (row.valueBytes as number)) ||
        bytes + (row.valueBytes as number) > byteBudget
      ) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'staged Keyv data exceeds the Profile budget',
        );
      }
      bytes += row.valueBytes as number;
      if (KNOWN_KEYS.some((entry) => entry.key === row.key)) {
        values.set(row.key, row.value);
      } else {
        unknownEntries += 1;
        unknownEntryHash.update(
          `${sha256Text(row.key)}:${sha256Text(row.value)}\n`,
          'utf8',
        );
      }
    }
  } finally {
    client.close();
  }
  if (!sameStat(expected, fs.lstatSync(databasePath, { bigint: true }))) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staged Keyv database changed while transforming',
    );
  }

  const localeValue = values.get('keyv:lang');
  const locale = localeValue === undefined ? null : cachedLocale(localeValue);
  const mappings = Object.freeze(
    KNOWN_KEYS.map((entry) => {
      const value = values.get(entry.key);
      return Object.freeze({
        legacyKey: entry.key,
        target: entry.target,
        state:
          value === undefined
            ? ('absent' as const)
            : entry.key === 'keyv:authInfo'
            ? ('retired' as const)
            : ('reconcile' as const),
        valueDigest: value === undefined ? null : sha256Text(value),
      });
    }),
  );
  const disabledAssetEntries = Math.max(0, source.entries - 1);
  const model = Object.freeze({
    schema: 'qinglong/legacy-keyv-transformation@v1' as const,
    databasePresent: true,
    integrity: 'ok' as const,
    mappings,
    cachedLocale: locale,
    unknownEntries,
    unknownEntryDigest: unknownEntryHash.digest('hex'),
    unknownSchemaObjects,
    unknownSchemaDigest: unknownSchemaHash.digest('hex'),
    disabledAssetEntries,
    activation: 'disabled' as const,
  });
  return Object.freeze({
    source,
    model,
    assessment:
      unknownEntries > 0 ||
      unknownSchemaObjects > 0 ||
      disabledAssetEntries > 0 ||
      (localeValue !== undefined && locale === null)
        ? 'manual_required'
        : 'ready',
  });
}
