import type { DatabaseSync } from 'node:sqlite';

import {
  InvalidPluginPackageAutomationPublicationError,
  MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_BYTES,
  PluginPackageAutomationPublicationConflictError,
  PluginPackageAutomationPublicationUnavailableError,
  assertPluginPackageAutomationPublicationSuccessor,
  assertPluginPackageAutomationPublicationRecoveryPageSize,
  normalizePluginPackageAutomationPublication,
  normalizePluginPackageAutomationPublicationRecoveryCursor,
  type PluginPackageAutomationPublication,
  type PluginPackageAutomationPublicationRecoveryPage,
  type PluginPackageAutomationPublicationRepository,
  type PluginPackageAutomationPublicationRecoverySource,
  type PluginPackageAutomationPublicationStartGuard,
} from '@qinglong/runtime-core/plugin-package-automation-publication';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackageAutomationPublicationError(message);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageAutomationPublicationUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageAutomationPublicationUnavailableError();
  }
  return value as number;
}

function targetIdentity(
  projectId: unknown,
  packageName: unknown,
): {
  readonly projectId: string;
  readonly packageName: string;
} {
  if (typeof projectId !== 'string' || !IDENTIFIER.test(projectId)) {
    return invalid('projectId is invalid');
  }
  if (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName)) {
    return invalid('packageName is invalid');
  }
  return { projectId, packageName };
}

function publicationDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid('publicationDigest is invalid');
  }
  return value;
}

function serialize(
  publication: Readonly<PluginPackageAutomationPublication>,
): string {
  const value = JSON.stringify(publication);
  if (
    Buffer.byteLength(value, 'utf8') >
    MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_BYTES
  ) {
    return invalid('publication exceeds the durable JSON budget');
  }
  return value;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageAutomationPublicationError ||
    error instanceof PluginPackageAutomationPublicationConflictError ||
    error instanceof PluginPackageAutomationPublicationUnavailableError
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
    return new PluginPackageAutomationPublicationConflictError(
      'durable publication chain changed',
    );
  }
  return new PluginPackageAutomationPublicationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalSqlitePluginPackageAutomationPublicationRepository
  implements
    PluginPackageAutomationPublicationRepository,
    PluginPackageAutomationPublicationRecoverySource,
    PluginPackageAutomationPublicationStartGuard
{
  readonly #authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  #parse(row: Row): Readonly<PluginPackageAutomationPublication> {
    try {
      const publication = normalizePluginPackageAutomationPublication(
        JSON.parse(
          text(row, 'publicationJson'),
        ) as PluginPackageAutomationPublication,
      );
      if (
        publication.publicationDigest !== text(row, 'publicationDigest') ||
        publication.target.projectId !== text(row, 'projectId') ||
        publication.target.packageName !== text(row, 'packageName') ||
        publication.target.installationId !== text(row, 'installationId') ||
        publication.target.lockDigest !== text(row, 'lockDigest') ||
        publication.target.generation !== integer(row, 'generation') ||
        publication.target.generationDigest !== text(row, 'generationDigest') ||
        publication.target.materializedRevisionDigest !==
          text(row, 'materializedRevisionDigest') ||
        publication.state !== text(row, 'state') ||
        publication.version !== integer(row, 'version') ||
        publication.publishedAtMs !== integer(row, 'publishedAtMs')
      ) {
        throw new PluginPackageAutomationPublicationUnavailableError();
      }
      return publication;
    } catch (error) {
      if (error instanceof PluginPackageAutomationPublicationUnavailableError) {
        throw error;
      }
      throw new PluginPackageAutomationPublicationUnavailableError();
    }
  }

  #select(
    where: string,
    values: readonly (string | number | null)[],
  ): Row | undefined {
    return this.#authority.client
      .prepare(
        `SELECT publication_digest AS "publicationDigest",
                project_id AS "projectId",
                package_name AS "packageName",
                installation_id AS "installationId",
                lock_digest AS "lockDigest",
                generation,
                generation_digest AS "generationDigest",
                materialized_revision_digest AS "materializedRevisionDigest",
                state,
                version,
                published_at_ms AS "publishedAtMs",
                publication_json AS "publicationJson"
         FROM "QingLong3PluginPackageAutomationPublications"
         WHERE ${where}`,
      )
      .get(...values) as Row | undefined;
  }

  #findByDigest(
    digest: string,
  ): Readonly<PluginPackageAutomationPublication> | null {
    const row = this.#select('publication_digest = ?', [digest]);
    return row ? this.#parse(row) : null;
  }

  #findCurrent(
    projectId: string,
    packageName: string,
  ): Readonly<PluginPackageAutomationPublication> | null {
    const row = this.#select(
      `publication_digest = (
         SELECT publication_digest
         FROM "QingLong3PluginPackageAutomationPublicationHeads"
         WHERE project_id = ? AND package_name = ?
       )`,
      [projectId, packageName],
    );
    return row ? this.#parse(row) : null;
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new PluginPackageAutomationPublicationUnavailableError(),
    );
  }

  findCurrent(
    projectIdValue: string,
    packageNameValue: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null> {
    const { projectId, packageName } = targetIdentity(
      projectIdValue,
      packageNameValue,
    );
    return this.#enqueue(() => this.#findCurrent(projectId, packageName));
  }

  findByDigest(
    publicationDigestValue: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null> {
    const digest = publicationDigest(publicationDigestValue);
    return this.#enqueue(() => this.#findByDigest(digest));
  }

  isStartAllowed(
    projectIdValue: string,
    packageNameValue: string,
    publicationDigestValue: string,
  ): Promise<boolean> {
    const { projectId, packageName } = targetIdentity(
      projectIdValue,
      packageNameValue,
    );
    const digest = publicationDigest(publicationDigestValue);
    return this.#enqueue(() => {
      const row = this.#authority.client
        .prepare(
          `SELECT EXISTS (
             SELECT 1
             FROM "QingLong3PluginPackageAutomationPublicationHeads" AS head
             JOIN "QingLong3PluginPackageAutomationPublications" AS publication
               ON publication.publication_digest = head.publication_digest
             JOIN "QingLong3PluginPackageInstallHeads" AS install_head
               ON install_head.project_id = publication.project_id
              AND install_head.package_name = publication.package_name
              AND install_head.installation_id =
                publication.installation_id
             JOIN "QingLong3PluginPackageInstalls" AS install
               ON install.installation_id = install_head.installation_id
              AND install.lock_digest = publication.lock_digest
             LEFT JOIN "QingLong3PluginPackageLifecycleHeads" AS lifecycle
               ON lifecycle.project_id = publication.project_id
              AND lifecycle.package_name = publication.package_name
             WHERE head.project_id = ?
               AND head.package_name = ?
               AND head.publication_digest = ?
               AND publication.state = 'active'
               AND install.state = 'active'
               AND install.active_lock_digest = publication.lock_digest
               AND (
                 lifecycle.event_digest IS NULL OR
                 lifecycle.disposition = 'active'
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
                 WHERE quarantine.project_id = publication.project_id
                   AND quarantine.package_name = publication.package_name
                   AND quarantine.installation_id =
                     publication.installation_id
                   AND quarantine.lock_digest = publication.lock_digest
               )
           ) AS "allowed"`,
        )
        .get(projectId, packageName, digest) as Row | undefined;
      if (!row || (row.allowed !== 0 && row.allowed !== 1)) {
        throw new PluginPackageAutomationPublicationUnavailableError();
      }
      return row.allowed === 1;
    });
  }

  listPendingPage(options: {
    readonly limit: number;
    readonly after?: Readonly<{
      readonly projectId: string;
      readonly packageName: string;
    }>;
  }): Promise<Readonly<PluginPackageAutomationPublicationRecoveryPage>> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return Promise.reject(
        new InvalidPluginPackageAutomationPublicationError(
          'pending page options are invalid',
        ),
      );
    }
    assertPluginPackageAutomationPublicationRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageAutomationPublicationRecoveryCursor(
            options.after,
          );
    return this.#enqueue(() => {
      const rows = this.#authority.client
        .prepare(
          `SELECT install.project_id AS "projectId",
                  install.package_name AS "packageName"
           FROM "QingLong3PluginPackageInstallHeads" AS install_head
           JOIN "QingLong3PluginPackageInstalls" AS install
             ON install.installation_id = install_head.installation_id
           JOIN "QingLong3PluginPackageMaterializedRevisions" AS revision
             ON revision.project_id = install.project_id
            AND revision.package_name = install.package_name
            AND revision.generation = install.target_generation
            AND revision.lock_digest = install.lock_digest
           LEFT JOIN
             "QingLong3PluginPackageAutomationPublicationHeads" AS publication
             ON publication.project_id = install.project_id
            AND publication.package_name = install.package_name
           WHERE install.state = 'active'
             AND install.active_lock_digest = install.lock_digest
             AND NOT EXISTS (
               SELECT 1
               FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
               WHERE quarantine.project_id = install.project_id
                 AND quarantine.package_name = install.package_name
                 AND quarantine.installation_id = install.installation_id
                 AND quarantine.lock_digest = install.lock_digest
             )
             AND (
               publication.generation_digest IS NULL OR
               publication.generation_digest <> revision.generation_digest
             )
             AND (
               ? IS NULL OR install.project_id > ? OR
               (install.project_id = ? AND install.package_name > ?)
             )
           ORDER BY install.project_id, install.package_name
           LIMIT ?`,
        )
        .all(
          after?.projectId ?? null,
          after?.projectId ?? null,
          after?.projectId ?? null,
          after?.packageName ?? null,
          options.limit + 1,
        ) as Row[];
      const truncated = rows.length > options.limit;
      const candidates = rows.slice(0, options.limit).map((row) =>
        Object.freeze({
          projectId: text(row, 'projectId'),
          packageName: text(row, 'packageName'),
        }),
      );
      const last = candidates.at(-1);
      return Object.freeze({
        candidates: Object.freeze(candidates),
        truncated,
        ...(truncated && last
          ? {
              next: Object.freeze({
                projectId: last.projectId,
                packageName: last.packageName,
              }),
            }
          : {}),
      });
    });
  }

  findCurrentInTransaction(
    projectIdValue: string,
    packageNameValue: string,
  ): Readonly<PluginPackageAutomationPublication> | null {
    const { projectId, packageName } = targetIdentity(
      projectIdValue,
      packageNameValue,
    );
    if (!this.#authority.client.isTransaction) {
      throw new PluginPackageAutomationPublicationUnavailableError();
    }
    return this.#findCurrent(projectId, packageName);
  }

  #publishInTransaction(
    value: Readonly<PluginPackageAutomationPublication>,
    securityWithdrawal: boolean,
  ): Readonly<{
    status: 'created' | 'existing';
    publication: Readonly<PluginPackageAutomationPublication>;
  }> {
    const client = this.#authority.client;
    if (!client.isTransaction) {
      throw new PluginPackageAutomationPublicationUnavailableError();
    }
    const publication = normalizePluginPackageAutomationPublication(value);
    const publicationJson = serialize(publication);
    const existing = this.#findByDigest(publication.publicationDigest);
    if (existing) {
      if (serialize(existing) !== publicationJson) {
        throw new PluginPackageAutomationPublicationConflictError(
          'publication digest is bound to another semantic publication',
        );
      }
      return Object.freeze({
        status: 'existing' as const,
        publication: existing,
      });
    }
    const current = this.#findCurrent(
      publication.target.projectId,
      publication.target.packageName,
    );
    if (publication.version === 1) {
      if (current) {
        throw new PluginPackageAutomationPublicationConflictError(
          'Package already has an automation publication head',
        );
      }
    } else {
      if (!current) {
        throw new PluginPackageAutomationPublicationConflictError(
          'previous automation publication head is absent',
        );
      }
      try {
        assertPluginPackageAutomationPublicationSuccessor(current, publication);
      } catch (error) {
        if (error instanceof InvalidPluginPackageAutomationPublicationError) {
          throw new PluginPackageAutomationPublicationConflictError(
            'automation publication does not succeed the current head',
          );
        }
        throw error;
      }
    }
    const revision = client
      .prepare(
        `SELECT revision_digest AS "revisionDigest",
                project_id AS "projectId",
                package_name AS "packageName",
                generation,
                lock_digest AS "lockDigest"
         FROM "QingLong3PluginPackageMaterializedRevisions"
         WHERE generation_digest = ?`,
      )
      .get(publication.target.generationDigest) as Row | undefined;
    if (
      !revision ||
      text(revision, 'revisionDigest') !==
        publication.target.materializedRevisionDigest ||
      text(revision, 'projectId') !== publication.target.projectId ||
      text(revision, 'packageName') !== publication.target.packageName ||
      integer(revision, 'generation') !== publication.target.generation ||
      text(revision, 'lockDigest') !== publication.target.lockDigest
    ) {
      throw new PluginPackageAutomationPublicationConflictError(
        'materialized revision fence does not match publication target',
      );
    }
    if (!securityWithdrawal) {
      const securityFence = client
        .prepare(
          `SELECT EXISTS (
             SELECT 1
             FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
             WHERE quarantine.project_id = ?
               AND quarantine.package_name = ?
               AND quarantine.installation_id = ?
               AND quarantine.lock_digest = ?
           ) AS "blocked"`,
        )
        .get(
          publication.target.projectId,
          publication.target.packageName,
          publication.target.installationId,
          publication.target.lockDigest,
        ) as Row | undefined;
      if (
        !securityFence ||
        (securityFence.blocked !== 0 && securityFence.blocked !== 1)
      ) {
        throw new PluginPackageAutomationPublicationUnavailableError();
      }
      if (securityFence.blocked === 1) {
        throw new PluginPackageAutomationPublicationConflictError(
          'quarantined Package generation cannot publish automation',
        );
      }
    }
    client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageAutomationPublications" (
           publication_digest, project_id, package_name, installation_id,
           lock_digest, generation, generation_digest,
           materialized_revision_digest, state, version,
           previous_publication_digest, lifecycle_event_digest,
           published_at_ms, publication_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        publication.publicationDigest,
        publication.target.projectId,
        publication.target.packageName,
        publication.target.installationId,
        publication.target.lockDigest,
        publication.target.generation,
        publication.target.generationDigest,
        publication.target.materializedRevisionDigest,
        publication.state,
        publication.version,
        publication.previousPublicationDigest,
        publication.lifecycleEventDigest,
        publication.publishedAtMs,
        publicationJson,
      );
    if (!current) {
      client
        .prepare(
          `INSERT INTO "QingLong3PluginPackageAutomationPublicationHeads" (
             project_id, package_name, publication_digest,
             generation_digest, state, version, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          publication.target.projectId,
          publication.target.packageName,
          publication.publicationDigest,
          publication.target.generationDigest,
          publication.state,
          publication.version,
          publication.publishedAtMs,
        );
    } else {
      const updated = client
        .prepare(
          `UPDATE "QingLong3PluginPackageAutomationPublicationHeads"
           SET publication_digest = ?, generation_digest = ?, state = ?,
               version = ?, updated_at_ms = ?
           WHERE project_id = ? AND package_name = ?
             AND publication_digest = ? AND version = ?`,
        )
        .run(
          publication.publicationDigest,
          publication.target.generationDigest,
          publication.state,
          publication.version,
          publication.publishedAtMs,
          publication.target.projectId,
          publication.target.packageName,
          current.publicationDigest,
          current.version,
        );
      if (updated.changes !== 1) {
        throw new PluginPackageAutomationPublicationConflictError(
          'automation publication head changed',
        );
      }
    }
    return Object.freeze({
      status: 'created' as const,
      publication,
    });
  }

  publishInTransaction(
    value: Readonly<PluginPackageAutomationPublication>,
  ): Readonly<{
    status: 'created' | 'existing';
    publication: Readonly<PluginPackageAutomationPublication>;
  }> {
    return this.#publishInTransaction(value, false);
  }

  publishSecurityWithdrawalInTransaction(
    value: Readonly<PluginPackageAutomationPublication>,
  ): Readonly<{
    status: 'created' | 'existing';
    publication: Readonly<PluginPackageAutomationPublication>;
  }> {
    const publication = normalizePluginPackageAutomationPublication(value);
    if (publication.state !== 'withdrawn') {
      throw new PluginPackageAutomationPublicationConflictError(
        'security withdrawal must narrow automation state',
      );
    }
    return this.#publishInTransaction(publication, true);
  }

  publish(value: Readonly<PluginPackageAutomationPublication>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      publication: Readonly<PluginPackageAutomationPublication>;
    }>
  > {
    return this.#enqueue(() => {
      const client = this.#authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        const result = this.publishInTransaction(value);
        client.exec('COMMIT');
        return result;
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        throw error;
      }
    });
  }
}
