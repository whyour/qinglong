import type { PostgresPool } from '@qinglong/runtime-core';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  modelProviderCredentialBindingForTransition,
  type ModelProviderCredentialTransition,
} from '../modelProviderCredentialCatalog';
import {
  type ModelProviderCredentialAuditRecord,
  type ModelProviderCredentialAuditSink,
  type ModelProviderCredentialBinding,
  type ModelProviderCredentialBindingLookup,
  type ModelProviderCredentialBindingSource,
} from '../providerCredential';
import {
  PROVIDER_PATTERN,
  auditDigest,
  bindingFromRow,
  identity,
  integer,
  jsonObject,
  mapStorageError,
  normalizeAuditRecord,
  normalizeLookup,
  transitionFromRow,
  unavailable,
  type Queryable,
  type Row,
} from './storageProtocol';

/**
 * PostgreSQL runtime reader plus append-only content-free credential audit.
 * Administrative binding mutations are exposed by the subclass so runtime
 * composition never receives mutation authority.
 */
export class PostgresModelProviderCredentialReader
  implements
    ModelProviderCredentialBindingSource,
    ModelProviderCredentialAuditSink
{
  constructor(protected readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL model provider credential pool is invalid',
      );
    }
  }

  protected async transitionRows(
    queryable: Queryable,
    where: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    const result = await queryable.query<Row>(
      `SELECT
         project_id AS "projectId",
         provider,
         generation,
         mutation_id AS "mutationId",
         command_digest AS "commandDigest",
         transition_digest AS "transitionDigest",
         transition_json AS "transitionJson"
       FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions"
       WHERE ${where}
       ORDER BY generation DESC
       LIMIT 2`,
      values,
    );
    return result.rows;
  }

  async findCurrentTransition(
    projectIdValue: string,
    providerValue: string,
  ): Promise<Readonly<ModelProviderCredentialTransition> | null> {
    const projectId = identity(projectIdValue);
    const provider = identity(providerValue, PROVIDER_PATTERN);
    try {
      const rows = await this.transitionRows(
        this.pool,
        'project_id = $1 AND provider = $2',
        [projectId, provider],
      );
      if (
        rows.length > 1 &&
        integer(rows[0]!.generation) === integer(rows[1]!.generation)
      ) {
        throw unavailable();
      }
      return rows[0] ? transitionFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async resolveModelProviderCredentialBinding(
    lookupValue: Readonly<ModelProviderCredentialBindingLookup>,
  ): Promise<Readonly<ModelProviderCredentialBinding> | null> {
    const lookup = normalizeLookup(lookupValue);
    try {
      const result = await this.pool.query<Row>(
        `SELECT
           transition.project_id AS "projectId",
           transition.provider,
           transition.generation,
           transition.mutation_id AS "mutationId",
           transition.command_digest AS "commandDigest",
           transition.transition_digest AS "transitionDigest",
           transition.transition_json AS "transitionJson",
           binding.project_id AS "bindingProjectId",
           binding.provider AS "bindingProvider",
           binding.revision,
           binding.secret_ref AS "secretRef",
           binding.scheme,
           binding.binding_digest AS "bindingDigest",
           binding.binding_json AS "bindingJson"
         FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions"
           AS transition
         LEFT JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings"
           AS binding
           ON binding.project_id = transition.project_id
          AND binding.provider = transition.provider
          AND binding.revision = transition.active_binding_revision
         WHERE transition.project_id = $1
           AND transition.provider = $2
         ORDER BY transition.generation DESC
         LIMIT 1`,
        [lookup.projectId, lookup.provider],
      );
      if (result.rows.length !== 1) return null;
      const row = result.rows[0]!;
      const transition = transitionFromRow(row);
      if (transition.action === 'revoke') {
        return modelProviderCredentialBindingForTransition(transition, null);
      }
      if (
        row.bindingProjectId !== transition.projectId ||
        row.bindingProvider !== transition.provider
      ) {
        throw unavailable();
      }
      return modelProviderCredentialBindingForTransition(
        transition,
        bindingFromRow(row),
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async record(
    recordValue: Readonly<ModelProviderCredentialAuditRecord>,
  ): Promise<void> {
    const record = normalizeAuditRecord(recordValue);
    const digest = auditDigest(record);
    try {
      const inserted = await this.pool.query<Row>(
        `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits" (
           project_id, provider, request_id, operation, binding_revision,
           binding_digest, occurred_at_ms, audit_digest, audit_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (project_id, provider, request_id, operation) DO NOTHING
         RETURNING audit_digest AS "auditDigest"`,
        [
          record.projectId,
          record.provider,
          record.requestId,
          record.operation,
          record.bindingRevision,
          record.bindingDigest,
          record.occurredAtMs,
          digest,
          JSON.stringify(record),
        ],
      );
      if (
        inserted.rows.length === 1 &&
        inserted.rows[0]?.auditDigest === digest
      ) {
        return;
      }
      const existing = await this.pool.query<Row>(
        `SELECT audit_digest AS "auditDigest", audit_json AS "auditJson"
           FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits"
          WHERE project_id = $1 AND provider = $2
            AND request_id = $3 AND operation = $4
          LIMIT 2`,
        [record.projectId, record.provider, record.requestId, record.operation],
      );
      if (
        existing.rows.length !== 1 ||
        existing.rows[0]?.auditDigest !== digest ||
        JSON.stringify(
          normalizeAuditRecord(
            jsonObject(
              existing.rows[0]?.auditJson,
            ) as unknown as ModelProviderCredentialAuditRecord,
          ),
        ) !== JSON.stringify(record)
      ) {
        throw unavailable();
      }
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
