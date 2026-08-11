import type { PostgresPool } from '@qinglong/runtime-core';

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

import { runTransaction } from './authority';
import {
  authorizationFromRow,
  authorizationRows,
  databaseClock,
  headFromRow,
  headRows,
  insertAuthorization,
  insertHead,
  insertPublication,
  integer,
  publicationFromRow,
  publicationRows,
  wasRevoked,
} from './records';

export function publishAuthorizedOperation(
  pool: PostgresPool,
  commandValue: Readonly<ModelPriceCatalogPublishCommand>,
  authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>> {
  const command = normalizeModelPriceCatalogPublishCommand(commandValue);
  const authorizationCommand = normalizeModelPriceCatalogPublishAuthorization(
    command,
    authorizationValue,
  );
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
      const storedAuthorizationRows = await authorizationRows(
        client,
        'authorization_id = $1 OR catalog_command_digest = $2',
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
          authorization.commandDigest !== authorizationCommand.commandDigest ||
          authorization.resultDigest !== publication.publicationDigest
        )
          throw new ModelPriceCatalogConflictError();
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          publication,
          authorization,
        });
      }
      if (storedAuthorizationRows[0])
        throw new ModelPriceCatalogConflictError();
      const nowMs = await databaseClock(client);
      const publication = createModelPriceCatalogPublication(command, nowMs);
      const authorization = createModelPriceCatalogAuthorization(
        authorizationCommand,
        publication.publicationDigest,
        nowMs,
      );
      await insertPublication(client, publication);
      await insertAuthorization(client, authorization);
      await client.query('COMMIT');
      return Object.freeze({
        status: 'created' as const,
        publication,
        authorization,
      });
    },
  );
}

export function transitionAuthorizedOperation(
  pool: PostgresPool,
  commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
  authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>> {
  const command = normalizeModelPriceCatalogTransitionCommand(commandValue);
  const authorizationCommand =
    normalizeModelPriceCatalogTransitionAuthorization(
      command,
      authorizationValue,
    );
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
      const storedAuthorizationRows = await authorizationRows(
        client,
        'authorization_id = $1 OR catalog_command_digest = $2',
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
          authorization.commandDigest !== authorizationCommand.commandDigest ||
          authorization.resultDigest !== head.headDigest
        )
          throw new ModelPriceCatalogConflictError();
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          head,
          authorization,
        });
      }
      if (storedAuthorizationRows[0])
        throw new ModelPriceCatalogConflictError();
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
      if (command.action === 'activate') {
        if (!target) throw new ModelPriceCatalogConflictError();
        const targetAuthorizationRows = await authorizationRows(
          client,
          `operation = 'publish' AND result_digest = $1`,
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
      const revoked = await wasRevoked(
        client,
        command.provider,
        command.model,
        command.priceRevision,
      );
      const nowMs = await databaseClock(client);
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
      await insertHead(client, head);
      await insertAuthorization(client, authorization);
      await client.query('COMMIT');
      return Object.freeze({ status: 'created' as const, head, authorization });
    },
  );
}
