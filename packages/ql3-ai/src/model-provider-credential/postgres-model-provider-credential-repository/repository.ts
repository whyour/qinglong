import type { PostgresClient } from '@qinglong/runtime-core';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  ModelProviderCredentialAdministrationMutationConflictError,
  normalizeAuthorizedModelProviderCredentialTransitionMutation,
  type AuthorizedModelProviderCredentialTransitionMutation,
  type ModelProviderCredentialAdministrationRepository,
} from '../modelProviderCredentialAdministration';
import {
  ModelProviderCredentialTransitionConflictError,
  createModelProviderCredentialTransition,
  normalizeModelProviderCredentialTransitionCommand,
  type CommitModelProviderCredentialTransitionResult,
  type ModelProviderCredentialCatalogRepository,
  type ModelProviderCredentialTransitionCommand,
} from '../modelProviderCredentialCatalog';
import { digestModelProviderCredentialBinding } from '../providerCredential';
import {
  administrationAuditFromRow,
  administrationAuditRows,
  confirmAdministrationFence,
  insertAdministrationAudit,
  mapAdministrationStorageError,
  sameAdministrationReplayAudit,
} from './administrationProtocol';
import { PostgresModelProviderCredentialReader } from './reader';
import {
  integer,
  mapStorageError,
  rollback,
  transitionFromRow,
  unavailable,
  type Row,
} from './storageProtocol';

export class PostgresModelProviderCredentialRepository
  extends PostgresModelProviderCredentialReader
  implements
    ModelProviderCredentialCatalogRepository,
    ModelProviderCredentialAdministrationRepository
{
  async commit(
    commandValue: Readonly<ModelProviderCredentialTransitionCommand>,
  ): Promise<Readonly<CommitModelProviderCredentialTransitionResult>> {
    const command =
      normalizeModelProviderCredentialTransitionCommand(commandValue);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw unavailable(error);
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([command.projectId, command.provider])],
      );
      const replayRows = await this.transitionRows(client, 'mutation_id = $1', [
        command.mutationId,
      ]);
      if (replayRows.length > 1) throw unavailable();
      if (replayRows[0]) {
        const stored = transitionFromRow(replayRows[0]);
        if (stored.commandDigest !== command.commandDigest) {
          throw new ModelProviderCredentialTransitionConflictError();
        }
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          transition: stored,
        });
      }
      const currentRows = await this.transitionRows(
        client,
        'project_id = $1 AND provider = $2',
        [command.projectId, command.provider],
      );
      const current = currentRows[0] ? transitionFromRow(currentRows[0]) : null;
      if ((current?.generation ?? 0) !== command.expectedGeneration) {
        throw new ModelProviderCredentialTransitionConflictError();
      }
      const clock = await client.query<Row>(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now`,
      );
      if (clock.rows.length !== 1 || !clock.rows[0]) throw unavailable();
      const transition = createModelProviderCredentialTransition(
        command,
        current,
        integer(clock.rows[0].now),
      );
      if (command.binding) {
        await client.query(
          `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings" (
             project_id, provider, revision, secret_ref, scheme,
             binding_digest, binding_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            command.binding.projectId,
            command.binding.provider,
            command.binding.revision,
            command.binding.secretRef,
            command.binding.scheme,
            digestModelProviderCredentialBinding(command.binding),
            JSON.stringify(command.binding),
          ],
        );
      }
      await client.query(
        `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions" (
           project_id, provider, generation, action,
           active_binding_revision, active_binding_digest,
           previous_transition_digest, mutation_id,
           changed_by_type, changed_by_id, changed_at_ms,
           command_digest, transition_digest, transition_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14::jsonb
         )`,
        [
          transition.projectId,
          transition.provider,
          transition.generation,
          transition.action,
          transition.activeBindingRevision,
          transition.activeBindingDigest,
          transition.previousTransitionDigest,
          transition.mutationId,
          transition.changedBy.type,
          transition.changedBy.id,
          transition.changedAtMs,
          transition.commandDigest,
          transition.transitionDigest,
          JSON.stringify(transition),
        ],
      );
      await client.query('COMMIT');
      return Object.freeze({ status: 'created' as const, transition });
    } catch (error) {
      await rollback(client);
      throw mapStorageError(error);
    } finally {
      client.release();
    }
  }

  async commitAuthorized(
    mutationValue: AuthorizedModelProviderCredentialTransitionMutation,
  ): Promise<Readonly<CommitModelProviderCredentialTransitionResult>> {
    const mutation =
      normalizeAuthorizedModelProviderCredentialTransitionMutation(
        mutationValue,
      );
    const { command, audit } = mutation;
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw unavailable(error);
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([command.projectId, command.provider])],
      );
      await confirmAdministrationFence(client, mutation);
      const replayRows = await this.transitionRows(client, 'mutation_id = $1', [
        command.mutationId,
      ]);
      const auditRows = await administrationAuditRows(client, audit.eventId);
      if (replayRows.length > 1 || auditRows.length > 1) {
        throw new ModelProviderCredentialAdministrationMutationConflictError();
      }
      if (replayRows[0]) {
        const stored = transitionFromRow(replayRows[0]);
        let storedAudit: Readonly<SecurityAuditRecord>;
        try {
          if (!auditRows[0]) {
            throw new ModelProviderCredentialAdministrationMutationConflictError();
          }
          storedAudit = administrationAuditFromRow(auditRows[0]);
        } catch (error) {
          if (
            error instanceof
            ModelProviderCredentialAdministrationMutationConflictError
          ) {
            throw error;
          }
          throw new ModelProviderCredentialAdministrationMutationConflictError();
        }
        if (
          stored.commandDigest !== command.commandDigest ||
          !sameAdministrationReplayAudit(storedAudit, audit)
        ) {
          throw new ModelProviderCredentialAdministrationMutationConflictError();
        }
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          transition: stored,
        });
      }
      if (auditRows[0]) {
        throw new ModelProviderCredentialAdministrationMutationConflictError();
      }
      const currentRows = await this.transitionRows(
        client,
        'project_id = $1 AND provider = $2',
        [command.projectId, command.provider],
      );
      const current = currentRows[0] ? transitionFromRow(currentRows[0]) : null;
      if ((current?.generation ?? 0) !== command.expectedGeneration) {
        throw new ModelProviderCredentialAdministrationMutationConflictError();
      }
      const clock = await client.query<Row>(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now`,
      );
      if (clock.rows.length !== 1 || !clock.rows[0]) throw unavailable();
      const transition = createModelProviderCredentialTransition(
        command,
        current,
        integer(clock.rows[0].now),
      );
      if (command.binding) {
        await client.query(
          `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings" (
             project_id, provider, revision, secret_ref, scheme,
             binding_digest, binding_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            command.binding.projectId,
            command.binding.provider,
            command.binding.revision,
            command.binding.secretRef,
            command.binding.scheme,
            digestModelProviderCredentialBinding(command.binding),
            JSON.stringify(command.binding),
          ],
        );
      }
      await client.query(
        `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions" (
           project_id, provider, generation, action,
           active_binding_revision, active_binding_digest,
           previous_transition_digest, mutation_id,
           changed_by_type, changed_by_id, changed_at_ms,
           command_digest, transition_digest, transition_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14::jsonb
         )`,
        [
          transition.projectId,
          transition.provider,
          transition.generation,
          transition.action,
          transition.activeBindingRevision,
          transition.activeBindingDigest,
          transition.previousTransitionDigest,
          transition.mutationId,
          transition.changedBy.type,
          transition.changedBy.id,
          transition.changedAtMs,
          transition.commandDigest,
          transition.transitionDigest,
          JSON.stringify(transition),
        ],
      );
      await insertAdministrationAudit(client, audit);
      await client.query('COMMIT');
      return Object.freeze({ status: 'created' as const, transition });
    } catch (error) {
      await rollback(client);
      throw mapAdministrationStorageError(error);
    } finally {
      client.release();
    }
  }
}
