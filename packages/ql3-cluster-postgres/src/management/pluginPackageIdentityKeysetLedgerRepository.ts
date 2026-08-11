// PostgreSQL anti-rollback ledger shared by bounded Cluster management authorities.
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

export type ClusterManagementIdentityAuthority =
  | 'plugin-package-management'
  | 'worker-credential-management'
  | 'automation-management'
  | 'approval-management';
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

type Row = Record<string, unknown>;

export interface PluginPackageIdentityKeysetLedgerSnapshot {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly digest: string;
  readonly issuer: string;
  readonly audience: string;
  readonly activeKeyIds: readonly string[];
  readonly revokedKeyIds: readonly string[];
}

export interface PluginPackageIdentityKeysetLedgerPort {
  observe(
    snapshot: Readonly<PluginPackageIdentityKeysetLedgerSnapshot>,
  ): Promise<void>;
}

export class PostgresPluginPackageIdentityKeysetLedgerConflictError extends Error {
  readonly code = 'POSTGRES_PLUGIN_PACKAGE_IDENTITY_KEYSET_LEDGER_CONFLICT';

  constructor() {
    super('PostgreSQL Plugin Package identity keyset ledger conflicts');
    this.name = 'PostgresPluginPackageIdentityKeysetLedgerConflictError';
  }
}

export class PostgresPluginPackageIdentityKeysetLedgerUnavailableError extends Error {
  readonly code = 'POSTGRES_PLUGIN_PACKAGE_IDENTITY_KEYSET_LEDGER_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'PostgreSQL Plugin Package identity keyset ledger is unavailable',
      options,
    );
    this.name = 'PostgresPluginPackageIdentityKeysetLedgerUnavailableError';
  }
}

function reviewedKeyIds(
  value: readonly string[],
  minimum: number,
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new TypeError(
      'PostgreSQL Plugin Package identity key ids are invalid',
    );
  }
  const seen = new Set<string>();
  for (const keyId of value) {
    if (
      typeof keyId !== 'string' ||
      !KEY_ID_PATTERN.test(keyId) ||
      seen.has(keyId)
    ) {
      throw new TypeError(
        'PostgreSQL Plugin Package identity key ids are invalid',
      );
    }
    seen.add(keyId);
  }
  return Object.freeze([...value].sort());
}

function reviewedSnapshot(
  value: Readonly<PluginPackageIdentityKeysetLedgerSnapshot>,
): Readonly<PluginPackageIdentityKeysetLedgerSnapshot> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7 ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'generation',
          'digest',
          'issuer',
          'audience',
          'activeKeyIds',
          'revokedKeyIds',
        ].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.digest !== 'string' ||
    !DIGEST_PATTERN.test(value.digest) ||
    typeof value.issuer !== 'string' ||
    value.issuer.length < 1 ||
    value.issuer.length > 512 ||
    CONTROL_PATTERN.test(value.issuer) ||
    typeof value.audience !== 'string' ||
    value.audience.length < 1 ||
    value.audience.length > 256 ||
    CONTROL_PATTERN.test(value.audience)
  ) {
    throw new TypeError(
      'PostgreSQL Plugin Package identity keyset snapshot is invalid',
    );
  }
  const activeKeyIds = reviewedKeyIds(value.activeKeyIds, 1, 8);
  const revokedKeyIds = reviewedKeyIds(value.revokedKeyIds, 0, 64);
  if (activeKeyIds.some((keyId) => revokedKeyIds.includes(keyId))) {
    throw new TypeError(
      'PostgreSQL Plugin Package identity keyset snapshot is invalid',
    );
  }
  return Object.freeze({ ...value, activeKeyIds, revokedKeyIds });
}

function integer(row: Row, name: string): number {
  const value = Number(row[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function text(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error(`invalid ${name}`);
  return value;
}

function textArray(row: Row, name: string): readonly string[] {
  const value = row[name];
  if (
    !Array.isArray(value) ||
    value.some((candidate) => typeof candidate !== 'string')
  ) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function includesAll(
  candidate: readonly string[],
  required: readonly string[],
): boolean {
  const values = new Set(candidate);
  return required.every((value) => values.has(value));
}

async function rollback(client: PostgresClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class PostgresPluginPackageIdentityKeysetLedgerRepository
  implements PluginPackageIdentityKeysetLedgerPort
{
  readonly #authority: ClusterManagementIdentityAuthority;

  constructor(
    private readonly pool: PostgresPool,
    authority: ClusterManagementIdentityAuthority = 'plugin-package-management',
  ) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError(
        'PostgreSQL Plugin Package identity keyset ledger pool is invalid',
      );
    }
    if (
      authority !== 'plugin-package-management' &&
      authority !== 'worker-credential-management' &&
      authority !== 'automation-management' &&
      authority !== 'approval-management'
    ) {
      throw new TypeError(
        'PostgreSQL management identity keyset authority is invalid',
      );
    }
    this.#authority = authority;
  }

  async observe(
    value: Readonly<PluginPackageIdentityKeysetLedgerSnapshot>,
  ): Promise<void> {
    const candidate = reviewedSnapshot(value);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new PostgresPluginPackageIdentityKeysetLedgerUnavailableError({
        cause: error,
      });
    }
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "ql3"."plugin_package_identity_keyset_ledger" (
           authority, generation, digest, issuer, audience,
           active_key_ids, revoked_key_ids, updated_at_ms
         )
         VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
           floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
         )
         ON CONFLICT (authority) DO NOTHING`,
        [
          this.#authority,
          candidate.generation,
          candidate.digest,
          candidate.issuer,
          candidate.audience,
          JSON.stringify(candidate.activeKeyIds),
          JSON.stringify(candidate.revokedKeyIds),
        ],
      );
      const selected = await client.query<Row>(
        `SELECT generation, digest, issuer, audience,
                active_key_ids AS "activeKeyIds",
                revoked_key_ids AS "revokedKeyIds"
         FROM "ql3"."plugin_package_identity_keyset_ledger"
         WHERE authority = $1
         FOR UPDATE`,
        [this.#authority],
      );
      if (selected.rows.length !== 1) throw new Error('ledger row is missing');
      const current = selected.rows[0]!;
      const generation = integer(current, 'generation');
      const digest = text(current, 'digest');
      const issuer = text(current, 'issuer');
      const audience = text(current, 'audience');
      const activeKeyIds = textArray(current, 'activeKeyIds');
      const revokedKeyIds = textArray(current, 'revokedKeyIds');
      const exact =
        generation === candidate.generation &&
        digest === candidate.digest &&
        issuer === candidate.issuer &&
        audience === candidate.audience &&
        sameArray(activeKeyIds, candidate.activeKeyIds) &&
        sameArray(revokedKeyIds, candidate.revokedKeyIds);
      if (!exact) {
        const retained = [
          ...candidate.activeKeyIds,
          ...candidate.revokedKeyIds,
        ];
        if (
          candidate.generation <= generation ||
          candidate.issuer !== issuer ||
          candidate.audience !== audience ||
          !includesAll(candidate.revokedKeyIds, revokedKeyIds) ||
          !includesAll(retained, activeKeyIds)
        ) {
          throw new PostgresPluginPackageIdentityKeysetLedgerConflictError();
        }
        await client.query(
          `UPDATE "ql3"."plugin_package_identity_keyset_ledger"
           SET generation = $2,
               digest = $3,
               active_key_ids = $4::jsonb,
               revoked_key_ids = $5::jsonb,
               updated_at_ms =
                 floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
           WHERE authority = $1`,
          [
            this.#authority,
            candidate.generation,
            candidate.digest,
            JSON.stringify(candidate.activeKeyIds),
            JSON.stringify(candidate.revokedKeyIds),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      if (
        error instanceof PostgresPluginPackageIdentityKeysetLedgerConflictError
      ) {
        throw error;
      }
      throw new PostgresPluginPackageIdentityKeysetLedgerUnavailableError({
        cause: error,
      });
    } finally {
      client.release();
    }
  }
}
