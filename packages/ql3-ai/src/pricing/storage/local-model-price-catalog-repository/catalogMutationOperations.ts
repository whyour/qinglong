import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../../model-invocation/localModelInvocationRepository';
import {
  createModelPriceCatalogHead,
  createModelPriceCatalogPublication,
  InvalidModelPriceCatalogError,
  ModelPriceCatalogConflictError,
  normalizeModelPriceCatalogPublishCommand,
  normalizeModelPriceCatalogTransitionCommand,
  type CommitModelPriceCatalogHeadResult,
  type CommitModelPriceCatalogPublicationResult,
  type ModelPriceCatalogHead,
  type ModelPriceCatalogPublishCommand,
  type ModelPriceCatalogTransitionCommand,
} from '../../modelPriceCatalog';

import { enqueueOperation } from './authority';
import {
  headFromRow,
  headRows,
  integer,
  publicationFromRow,
  publicationRows,
  type Row,
} from './records';

function rollback(client: DatabaseSync, began: boolean): void {
  if (began && client.isTransaction) {
    try {
      client.exec('ROLLBACK');
    } catch {
      // Preserve the original failure; the shared authority owns close.
    }
  }
}

export function publishOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: Readonly<ModelPriceCatalogPublishCommand>,
): Promise<Readonly<CommitModelPriceCatalogPublicationResult>> {
  const command = normalizeModelPriceCatalogPublishCommand(commandValue);
  return enqueueOperation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
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
      if (rows.length > 1) throw new ModelPriceCatalogConflictError();
      if (rows[0]) {
        const stored = publicationFromRow(rows[0]);
        if (stored.commandDigest !== command.commandDigest)
          throw new ModelPriceCatalogConflictError();
        client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'existing' as const,
          publication: stored,
        });
      }
      const clock = client
        .prepare(`SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now`)
        .get() as Row;
      const publication = createModelPriceCatalogPublication(
        command,
        integer(clock, 'now'),
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
      client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'created' as const, publication });
    } catch (error) {
      rollback(client, began);
      throw error;
    }
  });
}

export function transitionOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
): Promise<Readonly<CommitModelPriceCatalogHeadResult>> {
  const command = normalizeModelPriceCatalogTransitionCommand(commandValue);
  return enqueueOperation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
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
      if (replayRows.length > 1) throw new ModelPriceCatalogConflictError();
      if (replayRows[0]) {
        const stored = headFromRow(replayRows[0]);
        if (stored.commandDigest !== command.commandDigest)
          throw new ModelPriceCatalogConflictError();
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, head: stored });
      }
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
      let head: Readonly<ModelPriceCatalogHead>;
      try {
        head = createModelPriceCatalogHead(
          current,
          command,
          target,
          revoked,
          integer(clock, 'now'),
        );
      } catch (error) {
        if (error instanceof InvalidModelPriceCatalogError)
          throw new ModelPriceCatalogConflictError();
        throw error;
      }
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
      client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'created' as const, head });
    } catch (error) {
      rollback(client, began);
      throw error;
    }
  });
}
