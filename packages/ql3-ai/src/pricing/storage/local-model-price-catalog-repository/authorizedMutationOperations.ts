import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../../model-invocation/localModelInvocationRepository';
import {
  createModelPriceCatalogHead,
  createModelPriceCatalogPublication,
  InvalidModelPriceCatalogError,
  ModelPriceCatalogConflictError,
  normalizeModelPriceCatalogPublishCommand,
  normalizeModelPriceCatalogTransitionCommand,
  type ModelPriceCatalogHead,
  type ModelPriceCatalogPublishCommand,
  type ModelPriceCatalogTransitionCommand,
} from '../../modelPriceCatalog';
import {
  createModelPriceCatalogAuthorization,
  normalizeModelPriceCatalogPublishAuthorization,
  normalizeModelPriceCatalogTransitionAuthorization,
  type CommitAuthorizedModelPriceCatalogHeadResult,
  type CommitAuthorizedModelPriceCatalogPublicationResult,
  type ModelPriceCatalogAuthorizationCommand,
} from '../../modelPriceCatalogManagement';

import { enqueueOperation } from './authority';
import {
  authorizationFromRow,
  authorizationRows,
  headFromRow,
  headRows,
  insertAuthorization,
  integer,
  isFreshReauthorizationReplay,
  publicationFromRow,
  publicationRows,
  type Row,
} from './records';

export type BeforeAuthorizedMutation = (
  client: DatabaseSync,
  authorization: Readonly<ModelPriceCatalogAuthorizationCommand>,
) => void;

function rollback(client: DatabaseSync, began: boolean): void {
  if (began && client.isTransaction) {
    try {
      client.exec('ROLLBACK');
    } catch {
      // Preserve the original failure; the shared authority owns close.
    }
  }
}

export function publishAuthorizedOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  beforeAuthorizedMutation: BeforeAuthorizedMutation | undefined,
  commandValue: Readonly<ModelPriceCatalogPublishCommand>,
  authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>> {
  const command = normalizeModelPriceCatalogPublishCommand(commandValue);
  const authorizationCommand = normalizeModelPriceCatalogPublishAuthorization(
    command,
    authorizationValue,
  );
  return enqueueOperation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      beforeAuthorizedMutation?.(client, authorizationCommand);
      const rows = publicationRows(
        client,
        `mutation_id = ? OR (provider = ? AND model = ? AND price_revision = ?)`,
        [
          command.mutationId,
          command.provider,
          command.model,
          command.priceRevision,
        ],
      );
      const storedAuthorizationRows = authorizationRows(
        client,
        'authorization_id = ? OR catalog_command_digest = ?',
        [
          authorizationCommand.authorizationId,
          authorizationCommand.catalogCommandDigest,
        ],
      );
      if (rows.length > 1 || storedAuthorizationRows.length > 1)
        throw new ModelPriceCatalogConflictError();
      if (rows[0]) {
        const publication = publicationFromRow(rows[0]);
        const authorization = storedAuthorizationRows[0]
          ? authorizationFromRow(storedAuthorizationRows[0])
          : null;
        if (
          publication.commandDigest !== command.commandDigest ||
          !authorization ||
          !isFreshReauthorizationReplay(authorization, authorizationCommand) ||
          authorization.resultDigest !== publication.publicationDigest
        )
          throw new ModelPriceCatalogConflictError();
        client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'existing' as const,
          publication,
          authorization,
        });
      }
      if (storedAuthorizationRows[0])
        throw new ModelPriceCatalogConflictError();
      const clock = client
        .prepare(`SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now`)
        .get() as Row;
      const nowMs = integer(clock, 'now');
      const publication = createModelPriceCatalogPublication(command, nowMs);
      const authorization = createModelPriceCatalogAuthorization(
        authorizationCommand,
        publication.publicationDigest,
        nowMs,
      );
      client
        .prepare(
          `INSERT INTO "ModelPriceCatalogPublications" (provider, model, price_revision, catalog_digest, mutation_id, command_digest, publication_digest, published_at_ms, published_by_user_id, publication_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          publication.entry.provider,
          publication.entry.model,
          publication.entry.priceRevision,
          publication.entry.catalogDigest,
          publication.mutationId,
          publication.commandDigest,
          publication.publicationDigest,
          publication.entry.publishedAtMs,
          publication.publishedByUserId,
          JSON.stringify(publication),
        );
      insertAuthorization(client, authorization);
      client.exec('COMMIT');
      began = false;
      return Object.freeze({
        status: 'created' as const,
        publication,
        authorization,
      });
    } catch (error) {
      rollback(client, began);
      throw error;
    }
  });
}

export function transitionAuthorizedOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  beforeAuthorizedMutation: BeforeAuthorizedMutation | undefined,
  commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
  authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>> {
  const command = normalizeModelPriceCatalogTransitionCommand(commandValue);
  const authorizationCommand =
    normalizeModelPriceCatalogTransitionAuthorization(
      command,
      authorizationValue,
    );
  return enqueueOperation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      beforeAuthorizedMutation?.(client, authorizationCommand);
      const replayRows = headRows(
        client,
        `provider = ? AND model = ? AND (mutation_id = ? OR generation = ?)`,
        [
          command.provider,
          command.model,
          command.mutationId,
          command.expectedGeneration + 1,
        ],
      );
      const storedAuthorizationRows = authorizationRows(
        client,
        'authorization_id = ? OR catalog_command_digest = ?',
        [
          authorizationCommand.authorizationId,
          authorizationCommand.catalogCommandDigest,
        ],
      );
      if (replayRows.length > 1 || storedAuthorizationRows.length > 1)
        throw new ModelPriceCatalogConflictError();
      if (replayRows[0]) {
        const head = headFromRow(replayRows[0]);
        const authorization = storedAuthorizationRows[0]
          ? authorizationFromRow(storedAuthorizationRows[0])
          : null;
        if (
          head.commandDigest !== command.commandDigest ||
          !authorization ||
          !isFreshReauthorizationReplay(authorization, authorizationCommand) ||
          authorization.resultDigest !== head.headDigest
        )
          throw new ModelPriceCatalogConflictError();
        client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'existing' as const,
          head,
          authorization,
        });
      }
      if (storedAuthorizationRows[0])
        throw new ModelPriceCatalogConflictError();
      const currentRows = headRows(client, 'provider = ? AND model = ?', [
        command.provider,
        command.model,
      ]);
      if (
        currentRows.length > 1 &&
        integer(currentRows[0]!, 'generation') ===
          integer(currentRows[1]!, 'generation')
      )
        throw new ModelPriceCatalogConflictError();
      const current = currentRows[0] ? headFromRow(currentRows[0]) : null;
      const targetRows =
        command.priceRevision === null
          ? []
          : publicationRows(
              client,
              'provider = ? AND model = ? AND price_revision = ?',
              [command.provider, command.model, command.priceRevision],
            );
      if (targetRows.length > 1) throw new ModelPriceCatalogConflictError();
      const target = targetRows[0] ? publicationFromRow(targetRows[0]) : null;
      if (command.action === 'activate') {
        if (!target) throw new ModelPriceCatalogConflictError();
        const targetAuthorizationRows = authorizationRows(
          client,
          `operation = 'publish' AND result_digest = ?`,
          [target.publicationDigest],
        );
        if (targetAuthorizationRows.length !== 1)
          throw new ModelPriceCatalogConflictError();
        const targetAuthorization = authorizationFromRow(
          targetAuthorizationRows[0]!,
        );
        if (
          authorizationCommand.decisionMode === 'separation_of_duty' &&
          targetAuthorization.principal.subject.id ===
            authorizationCommand.principal.subject.id
        )
          throw new ModelPriceCatalogConflictError();
      }
      const revoked =
        command.priceRevision === null
          ? false
          : !!client
              .prepare(
                `SELECT 1 FROM "ModelPriceCatalogHeads" WHERE provider = ? AND model = ? AND revoked_price_revision = ? LIMIT 1`,
              )
              .get(command.provider, command.model, command.priceRevision);
      const clock = client
        .prepare(`SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now`)
        .get() as Row;
      const nowMs = integer(clock, 'now');
      let head: Readonly<ModelPriceCatalogHead>;
      try {
        head = createModelPriceCatalogHead(
          current,
          command,
          target,
          revoked,
          nowMs,
        );
      } catch (error) {
        if (error instanceof InvalidModelPriceCatalogError)
          throw new ModelPriceCatalogConflictError();
        throw error;
      }
      const authorization = createModelPriceCatalogAuthorization(
        authorizationCommand,
        head.headDigest,
        nowMs,
      );
      client
        .prepare(
          `INSERT INTO "ModelPriceCatalogHeads" (provider, model, generation, previous_head_digest, active_price_revision, active_catalog_digest, revoked_price_revision, revoked_catalog_digest, action, mutation_id, changed_by_user_id, changed_at_ms, command_digest, head_digest, head_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          head.provider,
          head.model,
          head.generation,
          head.previousHeadDigest,
          head.activePriceRevision,
          head.activeCatalogDigest,
          head.revokedPriceRevision,
          head.revokedCatalogDigest,
          head.action,
          head.mutationId,
          head.changedByUserId,
          head.changedAtMs,
          head.commandDigest,
          head.headDigest,
          JSON.stringify(head),
        );
      insertAuthorization(client, authorization);
      client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'created' as const, head, authorization });
    } catch (error) {
      rollback(client, began);
      throw error;
    }
  });
}
