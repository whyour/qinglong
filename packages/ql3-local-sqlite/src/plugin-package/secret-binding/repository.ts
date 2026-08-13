import type { DatabaseSync } from 'node:sqlite';

import {
  InvalidPluginPackageSecretBindingError,
  MAX_PLUGIN_PACKAGE_SECRET_BINDING_JSON_BYTES,
  PluginPackageSecretBindingConflictError,
  PluginPackageSecretBindingUnavailableError,
  normalizePluginPackageSecretBinding,
  type PluginPackageSecretBinding,
  type PluginPackageSecretBindingRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

type Row = Record<string, unknown>;

const DIGEST = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackageSecretBindingError(message);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageSecretBindingUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageSecretBindingUnavailableError();
  }
  return value as number;
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
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new PluginPackageSecretBindingConflictError(
      'durable binding identity is already bound',
    );
  }
  return new PluginPackageSecretBindingUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalSqlitePluginPackageSecretBindingRepository
  implements PluginPackageSecretBindingRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  private parse(row: Row): Readonly<PluginPackageSecretBinding> {
    try {
      const binding = normalizePluginPackageSecretBinding(
        JSON.parse(text(row, 'bindingJson')),
      );
      if (
        binding.target.generationDigest !== text(row, 'generationDigest') ||
        binding.target.projectId !== text(row, 'projectId') ||
        binding.target.packageName !== text(row, 'packageName') ||
        binding.target.installationId !== text(row, 'installationId') ||
        binding.target.lockDigest !== text(row, 'lockDigest') ||
        binding.target.generation !== integer(row, 'generation') ||
        binding.target.manifestDigest !== text(row, 'manifestDigest') ||
        binding.authority.kind !== text(row, 'authorityKind') ||
        binding.authority.evidenceDigest !== text(row, 'evidenceDigest') ||
        binding.boundAtMs !== integer(row, 'boundAtMs') ||
        binding.bindingDigest !== text(row, 'bindingDigest')
      ) {
        throw new PluginPackageSecretBindingUnavailableError();
      }
      return binding;
    } catch (error) {
      if (error instanceof PluginPackageSecretBindingUnavailableError) {
        throw error;
      }
      throw new PluginPackageSecretBindingUnavailableError();
    }
  }

  private findStored(
    digest: string,
  ): Readonly<PluginPackageSecretBinding> | null {
    const row = this.authority.client
      .prepare(
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
         FROM "QingLong3PluginPackageSecretBindings"
         WHERE generation_digest = ?`,
      )
      .get(digest) as Row | undefined;
    return row ? this.parse(row) : null;
  }

  findInTransaction(
    digest: string,
  ): Readonly<PluginPackageSecretBinding> | null {
    try {
      return this.findStored(generationDigest(digest));
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private enqueue<T>(work: () => T): Promise<T> {
    return this.authority.enqueue(
      async () => {
        try {
          return work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new PluginPackageSecretBindingUnavailableError(),
    );
  }

  async find(
    digest: string,
  ): Promise<Readonly<PluginPackageSecretBinding> | null> {
    const normalized = generationDigest(digest);
    return await this.enqueue(() => this.findStored(normalized));
  }

  publish(value: Readonly<PluginPackageSecretBinding>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      binding: Readonly<PluginPackageSecretBinding>;
    }>
  > {
    const binding = normalizePluginPackageSecretBinding(value);
    return this.enqueue(() => this.publishInTransaction(binding));
  }

  publishInTransaction(value: Readonly<PluginPackageSecretBinding>): Readonly<{
    status: 'created' | 'existing';
    binding: Readonly<PluginPackageSecretBinding>;
  }> {
    const binding = normalizePluginPackageSecretBinding(value);
    const bindingJson = serialize(binding);
    try {
      const existing = this.findStored(binding.target.generationDigest);
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

      const result = this.authority.client
        .prepare(
          `INSERT INTO "QingLong3PluginPackageSecretBindings" (
             generation_digest, project_id, package_name, installation_id,
             lock_digest, generation, manifest_digest, authority_kind,
             evidence_digest, bound_at_ms, binding_digest, binding_json
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM "QingLong3PluginPackageInstalls" AS install
           INNER JOIN "QingLong3PluginPackageInstallHeads" AS head
             ON head.installation_id = install.installation_id
            AND head.project_id = install.project_id
            AND head.package_name = install.package_name
           WHERE install.installation_id = ?
             AND install.project_id = ?
             AND install.package_name = ?
             AND install.lock_digest = ?
             AND install.target_generation = ?
             AND json_extract(install.lock_json, '$.manifestDigest') = ?
             AND (
               (install.state = 'active' AND
                install.active_lock_digest = install.lock_digest) OR
               (install.state = 'staged' AND
                install.previous_active_lock_digest IS NOT NULL AND
                install.active_lock_digest = install.previous_active_lock_digest AND
                install.target_generation = (
                  SELECT MAX(history.target_generation)
                  FROM "QingLong3PluginPackageInstalls" AS history
                  WHERE history.project_id = install.project_id
                    AND history.package_name = install.package_name
                ) AND
                EXISTS (
                  SELECT 1
                  FROM "QingLong3PluginPackageInstalls" AS previous
                  WHERE previous.project_id = install.project_id
                    AND previous.package_name = install.package_name
                    AND previous.lock_digest = install.previous_active_lock_digest
                    AND previous.state = 'active'
                    AND previous.active_lock_digest = previous.lock_digest
                    AND previous.target_generation < install.target_generation
                ))
             )
           ON CONFLICT (generation_digest) DO NOTHING`,
        )
        .run(
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
          binding.target.installationId,
          binding.target.projectId,
          binding.target.packageName,
          binding.target.lockDigest,
          binding.target.generation,
          binding.target.manifestDigest,
        );
      const stored = this.findStored(binding.target.generationDigest);
      if (!stored) {
        throw new PluginPackageSecretBindingConflictError(
          'binding target is not the current active or reviewed staged Package generation',
        );
      }
      if (JSON.stringify(stored) !== bindingJson) {
        throw new PluginPackageSecretBindingConflictError(
          'generation digest is bound to another Secret mapping',
        );
      }
      return Object.freeze({
        status:
          result.changes === 1 ? ('created' as const) : ('existing' as const),
        binding: stored,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
