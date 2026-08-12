import type { PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidPluginPackageSecretBindingError,
  MAX_PLUGIN_PACKAGE_SECRET_BINDING_JSON_BYTES,
  PluginPackageSecretBindingConflictError,
  PluginPackageSecretBindingUnavailableError,
  normalizePluginPackageSecretBinding,
  type PluginPackageSecretBinding,
  type PluginPackageSecretBindingRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding';

import {
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const DIGEST = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackageSecretBindingError(message);
}

function unavailable(): PluginPackageSecretBindingUnavailableError {
  return new PluginPackageSecretBindingUnavailableError();
}

function generationDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid('generation digest is invalid');
  }
  return value;
}

function serialize(binding: Readonly<PluginPackageSecretBinding>): string {
  const value = JSON.stringify(binding);
  if (
    Buffer.byteLength(value, 'utf8') >
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_JSON_BYTES
  ) {
    return invalid('durable JSON byte budget exceeded');
  }
  return value;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageSecretBindingError ||
    error instanceof PluginPackageSecretBindingConflictError ||
    error instanceof PluginPackageSecretBindingUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageSecretBindingConflictError(
      'durable binding identity is already bound',
    );
  }
  return new PluginPackageSecretBindingUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class PostgresPluginPackageSecretBindingRepository
  implements PluginPackageSecretBindingRepository
{
  constructor(private readonly pool: Pick<PostgresPool, 'query'>) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError(
        'PostgreSQL Plugin Package Secret binding repository options are invalid',
      );
    }
  }

  private parse(row: Row): Readonly<PluginPackageSecretBinding> {
    try {
      const binding = normalizePluginPackageSecretBinding(
        postgresRequiredJsonObject(row.bindingJson, unavailable),
      );
      if (
        binding.target.generationDigest !==
          postgresRequiredString(row.generationDigest, unavailable) ||
        binding.target.projectId !==
          postgresRequiredString(row.projectId, unavailable) ||
        binding.target.packageName !==
          postgresRequiredString(row.packageName, unavailable) ||
        binding.target.installationId !==
          postgresRequiredString(row.installationId, unavailable) ||
        binding.target.lockDigest !==
          postgresRequiredString(row.lockDigest, unavailable) ||
        binding.target.generation !==
          postgresRequiredInteger(row.generation, unavailable) ||
        binding.target.manifestDigest !==
          postgresRequiredString(row.manifestDigest, unavailable) ||
        binding.authority.kind !==
          postgresRequiredString(row.authorityKind, unavailable) ||
        binding.authority.evidenceDigest !==
          postgresRequiredString(row.evidenceDigest, unavailable) ||
        binding.boundAtMs !==
          postgresRequiredInteger(row.boundAtMs, unavailable) ||
        binding.bindingDigest !==
          postgresRequiredString(row.bindingDigest, unavailable)
      ) {
        throw unavailable();
      }
      return binding;
    } catch (error) {
      if (error instanceof PluginPackageSecretBindingUnavailableError) {
        throw error;
      }
      throw unavailable();
    }
  }

  private async findStored(
    digest: string,
  ): Promise<Readonly<PluginPackageSecretBinding> | null> {
    const result = await this.pool.query<Row>(
      `SELECT generation_digest AS "generationDigest",
              project_id AS "projectId",
              package_name AS "packageName",
              installation_id AS "installationId",
              lock_digest AS "lockDigest",
              generation,
              manifest_digest AS "manifestDigest",
              authority_kind AS "authorityKind",
              evidence_digest AS "evidenceDigest",
              bound_at_ms AS "boundAtMs",
              binding_digest AS "bindingDigest",
              binding_json AS "bindingJson"
       FROM "ql3"."plugin_package_secret_bindings"
       WHERE generation_digest = $1
       LIMIT 2`,
      [digest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    return this.parse(result.rows[0]!);
  }

  async find(
    digest: string,
  ): Promise<Readonly<PluginPackageSecretBinding> | null> {
    try {
      return await this.findStored(generationDigest(digest));
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async publish(value: Readonly<PluginPackageSecretBinding>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      binding: Readonly<PluginPackageSecretBinding>;
    }>
  > {
    const binding = normalizePluginPackageSecretBinding(value);
    const bindingJson = serialize(binding);
    try {
      const existing = await this.findStored(binding.target.generationDigest);
      if (existing) {
        if (JSON.stringify(existing) !== bindingJson) {
          throw new PluginPackageSecretBindingConflictError(
            'generation digest is bound to another Secret mapping',
          );
        }
        return Object.freeze({
          status: 'existing' as const,
          binding: existing,
        });
      }

      const inserted = await this.pool.query(
        `INSERT INTO "ql3"."plugin_package_secret_bindings" (
           generation_digest, project_id, package_name, installation_id,
           lock_digest, generation, manifest_digest, authority_kind,
           evidence_digest, bound_at_ms, binding_digest, binding_json
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
         FROM "ql3"."plugin_package_installs" AS install
         INNER JOIN "ql3"."plugin_package_install_heads" AS head
           ON head.installation_id = install.installation_id
          AND head.project_id = install.project_id
          AND head.package_name = install.package_name
         WHERE install.installation_id = $4
           AND install.project_id = $2
           AND install.package_name = $3
           AND install.lock_digest = $5
           AND install.active_lock_digest = $5
           AND install.target_generation = $6
           AND install.state = 'active'
           AND install.lock_json ->> 'manifestDigest' = $7
         ON CONFLICT (generation_digest) DO NOTHING
         RETURNING generation_digest`,
        [
          binding.target.generationDigest,
          binding.target.projectId,
          binding.target.packageName,
          binding.target.installationId,
          binding.target.lockDigest,
          binding.target.generation,
          binding.target.manifestDigest,
          binding.authority.kind,
          binding.authority.evidenceDigest,
          binding.boundAtMs,
          binding.bindingDigest,
          bindingJson,
        ],
      );
      const stored = await this.findStored(binding.target.generationDigest);
      if (!stored) {
        throw new PluginPackageSecretBindingConflictError(
          'binding target is not the current active Package generation',
        );
      }
      if (JSON.stringify(stored) !== bindingJson) {
        throw new PluginPackageSecretBindingConflictError(
          'generation digest is bound to another Secret mapping',
        );
      }
      return Object.freeze({
        status:
          inserted.rows.length === 1
            ? ('created' as const)
            : ('existing' as const),
        binding: stored,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
