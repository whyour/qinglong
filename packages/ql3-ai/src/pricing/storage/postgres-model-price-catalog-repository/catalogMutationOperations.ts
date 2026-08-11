import type { PostgresPool } from '@qinglong/runtime-core';

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

import { runTransaction } from './authority';
import {
  databaseClock,
  headFromRow,
  headRows,
  insertHead,
  insertPublication,
  integer,
  publicationFromRow,
  publicationRows,
  wasRevoked,
} from './records';

export function publishOperation(
  pool: PostgresPool,
  commandValue: Readonly<ModelPriceCatalogPublishCommand>,
): Promise<Readonly<CommitModelPriceCatalogPublicationResult>> {
  const command = normalizeModelPriceCatalogPublishCommand(commandValue);
  return runTransaction(
    pool,
    command.provider,
    command.model,
    async (client) => {
      const rows = await publicationRows(
        client,
        `mutation_id = $1 OR (provider = $2 AND model = $3 AND price_revision = $4)`,
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
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          publication: stored,
        });
      }
      const publication = createModelPriceCatalogPublication(
        command,
        await databaseClock(client),
      );
      await insertPublication(client, publication);
      await client.query('COMMIT');
      return Object.freeze({ status: 'created' as const, publication });
    },
  );
}

export function transitionOperation(
  pool: PostgresPool,
  commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
): Promise<Readonly<CommitModelPriceCatalogHeadResult>> {
  const command = normalizeModelPriceCatalogTransitionCommand(commandValue);
  return runTransaction(
    pool,
    command.provider,
    command.model,
    async (client) => {
      const replayRows = await headRows(
        client,
        `provider = $1 AND model = $2 AND (mutation_id = $3 OR generation = $4)`,
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
        await client.query('COMMIT');
        return Object.freeze({ status: 'existing' as const, head: stored });
      }
      const currentRows = await headRows(
        client,
        'provider = $1 AND model = $2',
        [command.provider, command.model],
      );
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
          : await publicationRows(
              client,
              'provider = $1 AND model = $2 AND price_revision = $3',
              [command.provider, command.model, command.priceRevision],
            );
      if (targetRows.length > 1) throw new ModelPriceCatalogConflictError();
      const target = targetRows[0] ? publicationFromRow(targetRows[0]) : null;
      let head: Readonly<ModelPriceCatalogHead>;
      try {
        head = createModelPriceCatalogHead(
          current,
          command,
          target,
          await wasRevoked(
            client,
            command.provider,
            command.model,
            command.priceRevision,
          ),
          await databaseClock(client),
        );
      } catch (error) {
        if (error instanceof InvalidModelPriceCatalogError)
          throw new ModelPriceCatalogConflictError();
        throw error;
      }
      await insertHead(client, head);
      await client.query('COMMIT');
      return Object.freeze({ status: 'created' as const, head });
    },
  );
}
