// PostgreSQL adapter owned by Plugin Package publication and recovery.
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  InvalidPluginPackageAutomationPublicationError,
  MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_BYTES,
  PluginPackageAutomationPublicationConflictError,
  PluginPackageAutomationPublicationUnavailableError,
  assertPluginPackageAutomationPublicationRecoveryPageSize,
  assertPluginPackageAutomationPublicationSuccessor,
  normalizePluginPackageAutomationPublication,
  normalizePluginPackageAutomationPublicationRecoveryCursor,
  type PluginPackageAutomationPublication,
  type PluginPackageAutomationPublicationRecoveryPage,
  type PluginPackageAutomationPublicationRepository,
  type PluginPackageAutomationPublicationRecoverySource,
  type PluginPackageAutomationPublicationStartGuard,
} from '@qinglong/runtime-core/plugin-package-automation-publication';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackageAutomationPublicationError(message);
}

function unavailable(
  error?: unknown,
): PluginPackageAutomationPublicationUnavailableError {
  return new PluginPackageAutomationPublicationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function targetIdentity(projectId: unknown, packageName: unknown): {
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
  const state = postgresSqlState(error);
  if (
    state === '23503' ||
    state === '23505' ||
    state === '23514' ||
    state === '40001'
  ) {
    return new PluginPackageAutomationPublicationConflictError(
      'durable publication chain changed',
    );
  }
  return unavailable(error);
}

export class PostgresPluginPackageAutomationPublicationRepository
  implements
    PluginPackageAutomationPublicationRepository,
    PluginPackageAutomationPublicationRecoverySource,
    PluginPackageAutomationPublicationStartGuard
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL automation publication repository is invalid',
      );
    }
  }

  #parse(row: Row): Readonly<PluginPackageAutomationPublication> {
    try {
      const publication = normalizePluginPackageAutomationPublication(
        postgresRequiredJsonObject(
          row.publicationJson,
          unavailable,
        ) as unknown as PluginPackageAutomationPublication,
      );
      if (
        publication.publicationDigest !==
          postgresRequiredString(row.publicationDigest, unavailable) ||
        publication.target.projectId !==
          postgresRequiredString(row.projectId, unavailable) ||
        publication.target.packageName !==
          postgresRequiredString(row.packageName, unavailable) ||
        publication.target.installationId !==
          postgresRequiredString(row.installationId, unavailable) ||
        publication.target.lockDigest !==
          postgresRequiredString(row.lockDigest, unavailable) ||
        publication.target.generation !==
          postgresRequiredInteger(row.generation, unavailable) ||
        publication.target.generationDigest !==
          postgresRequiredString(row.generationDigest, unavailable) ||
        publication.target.materializedRevisionDigest !==
          postgresRequiredString(row.materializedRevisionDigest, unavailable) ||
        publication.state !==
          postgresRequiredString(row.state, unavailable) ||
        publication.version !==
          postgresRequiredInteger(row.version, unavailable) ||
        publication.publishedAtMs !==
          postgresRequiredInteger(row.publishedAtMs, unavailable)
      ) {
        throw unavailable();
      }
      return publication;
    } catch (error) {
      if (
        error instanceof PluginPackageAutomationPublicationUnavailableError
      ) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #findByDigest(
    queryable: Queryable,
    digest: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null> {
    const result = await queryable.query<Row>(
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
       FROM "ql3"."plugin_package_automation_publications"
       WHERE publication_digest = $1
       LIMIT 2`,
      [digest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    return this.#parse(result.rows[0]!);
  }

  async #findCurrent(
    queryable: Queryable,
    projectId: string,
    packageName: string,
    lock = false,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null> {
    const result = await queryable.query<Row>(
      `SELECT publication.publication_digest AS "publicationDigest",
              publication.project_id AS "projectId",
              publication.package_name AS "packageName",
              publication.installation_id AS "installationId",
              publication.lock_digest AS "lockDigest",
              publication.generation,
              publication.generation_digest AS "generationDigest",
              publication.materialized_revision_digest
                AS "materializedRevisionDigest",
              publication.state,
              publication.version,
              publication.published_at_ms AS "publishedAtMs",
              publication.publication_json AS "publicationJson"
       FROM "ql3"."plugin_package_automation_publication_heads" AS head
       JOIN "ql3"."plugin_package_automation_publications" AS publication
         ON publication.publication_digest = head.publication_digest
       WHERE head.project_id = $1 AND head.package_name = $2
       LIMIT 2${lock ? ' FOR UPDATE OF head' : ''}`,
      [projectId, packageName],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    return this.#parse(result.rows[0]!);
  }

  async findCurrent(
    projectIdValue: string,
    packageNameValue: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null> {
    const { projectId, packageName } = targetIdentity(
      projectIdValue,
      packageNameValue,
    );
    try {
      return await this.#findCurrent(this.pool, projectId, packageName);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByDigest(
    publicationDigestValue: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null> {
    const digest = publicationDigest(publicationDigestValue);
    try {
      return await this.#findByDigest(this.pool, digest);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async isStartAllowed(
    projectIdValue: string,
    packageNameValue: string,
    publicationDigestValue: string,
  ): Promise<boolean> {
    const { projectId, packageName } = targetIdentity(
      projectIdValue,
      packageNameValue,
    );
    const digest = publicationDigest(publicationDigestValue);
    try {
      const result = await this.pool.query<Row>(
        `SELECT "ql3"."plugin_package_automation_start_allowed"(
           $1::varchar, $2::varchar, $3::char(64)
         ) AS "allowed"`,
        [projectId, packageName, digest],
      );
      if (
        result.rows.length !== 1 ||
        typeof result.rows[0]?.allowed !== 'boolean'
      ) {
        throw unavailable();
      }
      return result.rows[0].allowed;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listPendingPage(options: {
    readonly limit: number;
    readonly after?: Readonly<{
      readonly projectId: string;
      readonly packageName: string;
    }>;
  }): Promise<Readonly<PluginPackageAutomationPublicationRecoveryPage>> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new InvalidPluginPackageAutomationPublicationError(
        'pending page options are invalid',
      );
    }
    assertPluginPackageAutomationPublicationRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageAutomationPublicationRecoveryCursor(
            options.after,
          );
    try {
      const result = await this.pool.query<Row>(
        `SELECT install.project_id AS "projectId",
                install.package_name AS "packageName"
         FROM "ql3"."plugin_package_install_heads" AS install_head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = install_head.installation_id
         JOIN "ql3"."plugin_package_materialized_revisions" AS revision
           ON revision.project_id = install.project_id
          AND revision.package_name = install.package_name
          AND revision.generation = install.target_generation
          AND revision.lock_digest = install.lock_digest
         LEFT JOIN
           "ql3"."plugin_package_automation_publication_heads" AS publication
           ON publication.project_id = install.project_id
          AND publication.package_name = install.package_name
         WHERE install.state = 'active'
           AND install.active_lock_digest = install.lock_digest
           AND NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_quarantine_events" AS quarantine
             WHERE quarantine.project_id = install.project_id
               AND quarantine.package_name = install.package_name
               AND quarantine.installation_id = install.installation_id
               AND quarantine.lock_digest = install.lock_digest
           )
           AND (
             publication.generation_digest IS NULL OR
             publication.generation_digest <> revision.generation_digest
           )
           AND NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_publisher_provenance" AS provenance
             JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
               ON revoked.publisher = provenance.publisher
              AND revoked.key_id = provenance.key_id
             WHERE provenance.installation_id = install.installation_id
               AND provenance.lock_digest = install.lock_digest
           )
           AND (
             $1::varchar IS NULL OR install.project_id > $1 OR
             (install.project_id = $1 AND install.package_name > $2)
           )
         ORDER BY install.project_id, install.package_name
         LIMIT $3`,
        [
          after?.projectId ?? null,
          after?.packageName ?? null,
          options.limit + 1,
        ],
      );
      const truncated = result.rows.length > options.limit;
      const candidates = result.rows.slice(0, options.limit).map((row) =>
        Object.freeze({
          projectId: postgresRequiredString(row.projectId, unavailable),
          packageName: postgresRequiredString(row.packageName, unavailable),
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
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findCurrentInTransaction(
    client: PostgresClient,
    projectIdValue: string,
    packageNameValue: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null> {
    const { projectId, packageName } = targetIdentity(
      projectIdValue,
      packageNameValue,
    );
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'PostgreSQL automation publication transaction is invalid',
      );
    }
    return this.#findCurrent(client, projectId, packageName, true);
  }

  async publishInTransaction(
    client: PostgresClient,
    value: Readonly<PluginPackageAutomationPublication>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      publication: Readonly<PluginPackageAutomationPublication>;
    }>
  > {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'PostgreSQL automation publication transaction is invalid',
      );
    }
    const publication = normalizePluginPackageAutomationPublication(value);
    const publicationJson = serialize(publication);
    const existing = await this.#findByDigest(
      client,
      publication.publicationDigest,
    );
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
    const current = await this.#findCurrent(
      client,
      publication.target.projectId,
      publication.target.packageName,
      true,
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
        assertPluginPackageAutomationPublicationSuccessor(
          current,
          publication,
        );
      } catch (error) {
        if (error instanceof InvalidPluginPackageAutomationPublicationError) {
          throw new PluginPackageAutomationPublicationConflictError(
            'automation publication does not succeed the current head',
          );
        }
        throw error;
      }
    }
    const revision = await client.query<Row>(
      `SELECT revision_digest AS "revisionDigest",
              project_id AS "projectId",
              package_name AS "packageName",
              generation,
              lock_digest AS "lockDigest"
       FROM "ql3"."plugin_package_materialized_revisions"
       WHERE generation_digest = $1
       LIMIT 2`,
      [publication.target.generationDigest],
    );
    if (
      revision.rows.length !== 1 ||
      postgresRequiredString(
        revision.rows[0]!.revisionDigest,
        unavailable,
      ) !== publication.target.materializedRevisionDigest ||
      postgresRequiredString(revision.rows[0]!.projectId, unavailable) !==
        publication.target.projectId ||
      postgresRequiredString(
        revision.rows[0]!.packageName,
        unavailable,
      ) !== publication.target.packageName ||
      postgresRequiredInteger(
        revision.rows[0]!.generation,
        unavailable,
      ) !== publication.target.generation ||
      postgresRequiredString(revision.rows[0]!.lockDigest, unavailable) !==
        publication.target.lockDigest
    ) {
      throw new PluginPackageAutomationPublicationConflictError(
        'materialized revision fence does not match publication target',
      );
    }
    const securityFence = await client.query<Row>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM "ql3"."plugin_package_quarantine_events" AS quarantine
           WHERE quarantine.project_id = $1
             AND quarantine.package_name = $2
             AND quarantine.installation_id = $3
             AND quarantine.lock_digest = $4
         ) OR EXISTS (
           SELECT 1
           FROM "ql3"."plugin_package_publisher_provenance" AS provenance
           JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
             ON revoked.publisher = provenance.publisher
            AND revoked.key_id = provenance.key_id
           WHERE provenance.installation_id = $3
             AND provenance.lock_digest = $4
         ) AS "blocked"`,
      [
        publication.target.projectId,
        publication.target.packageName,
        publication.target.installationId,
        publication.target.lockDigest,
      ],
    );
    if (
      securityFence.rows.length !== 1 ||
      typeof securityFence.rows[0]?.blocked !== 'boolean'
    ) {
      throw unavailable();
    }
    if (securityFence.rows[0].blocked) {
      throw new PluginPackageAutomationPublicationConflictError(
        'security-fenced Package generation cannot publish automation',
      );
    }
    await client.query(
      `INSERT INTO "ql3"."plugin_package_automation_publications" (
         publication_digest, project_id, package_name, installation_id,
         lock_digest, generation, generation_digest,
         materialized_revision_digest, state, version,
         previous_publication_digest, lifecycle_event_digest,
         published_at_ms, publication_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14::jsonb
       )`,
      [
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
      ],
    );
    if (!current) {
      await client.query(
        `INSERT INTO "ql3"."plugin_package_automation_publication_heads" (
           project_id, package_name, publication_digest,
           generation_digest, state, version, updated_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          publication.target.projectId,
          publication.target.packageName,
          publication.publicationDigest,
          publication.target.generationDigest,
          publication.state,
          publication.version,
          publication.publishedAtMs,
        ],
      );
    } else {
      const updated = await client.query(
        `UPDATE "ql3"."plugin_package_automation_publication_heads"
         SET publication_digest = $1, generation_digest = $2, state = $3,
             version = $4, updated_at_ms = $5
         WHERE project_id = $6 AND package_name = $7
           AND publication_digest = $8 AND version = $9`,
        [
          publication.publicationDigest,
          publication.target.generationDigest,
          publication.state,
          publication.version,
          publication.publishedAtMs,
          publication.target.projectId,
          publication.target.packageName,
          current.publicationDigest,
          current.version,
        ],
      );
      if (updated.rowCount !== 1) {
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

  async publish(
    value: Readonly<PluginPackageAutomationPublication>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      publication: Readonly<PluginPackageAutomationPublication>;
    }>
  > {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        if (attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS) continue;
        throw unavailable(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const result = await this.publishInTransaction(client, value);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS &&
          (state === undefined ||
            state.startsWith('08') ||
            POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state))
        ) {
          continue;
        }
        throw mapStorageError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
