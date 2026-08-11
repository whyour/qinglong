import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';

import {
  type CommitModelPriceCatalogHeadResult,
  type CommitModelPriceCatalogPublicationResult,
  type ModelPriceCatalogAdministrationRepository,
  type ModelPriceCatalogHead,
  type ModelPriceCatalogPublication,
  type ModelPriceCatalogPublishCommand,
  type ModelPriceCatalogReader,
  type ModelPriceCatalogTransitionCommand,
} from '../../modelPriceCatalog';
import {
  type CommitAuthorizedModelPriceCatalogHeadResult,
  type CommitAuthorizedModelPriceCatalogPublicationResult,
  type ModelPriceCatalogAuthorization,
  type ModelPriceCatalogAuthorizationCommand,
  type ModelPriceCatalogAuthorizedAdministrationRepository,
} from '../../modelPriceCatalogManagement';
import type {
  ModelPriceCatalogEntry,
  ModelPriceCatalogLookup,
} from '../../pricing';

import {
  publishAuthorizedOperation,
  transitionAuthorizedOperation,
} from './authorizedMutationOperations';
import { assertPool } from './authority';
import {
  publishOperation,
  transitionOperation,
} from './catalogMutationOperations';
import {
  findAuthorizationOperation,
  findCurrentOperation,
  findPublicationOperation,
  resolveOperation,
} from './readOperations';
import {
  authorizationRows,
  headRows,
  insertAuthorization,
  publicationRows,
  type Row,
} from './records';

type Queryable = Pick<PostgresQueryable, 'query'>;

export class PostgresModelPriceCatalogReader
  implements ModelPriceCatalogReader
{
  constructor(protected readonly pool: PostgresPool) {
    assertPool(pool);
  }

  protected publicationRows(
    queryable: Queryable,
    where: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    return publicationRows(queryable, where, values);
  }

  protected headRows(
    queryable: Queryable,
    where: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    return headRows(queryable, where, values);
  }

  protected authorizationRows(
    queryable: Queryable,
    where: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    return authorizationRows(queryable, where, values);
  }

  findPublication(
    lookupValue: Omit<ModelPriceCatalogLookup, 'signal'>,
  ): Promise<Readonly<ModelPriceCatalogPublication> | null> {
    return findPublicationOperation(this.pool, lookupValue);
  }

  findCurrent(
    providerValue: string,
    modelValue: string,
  ): Promise<Readonly<ModelPriceCatalogHead> | null> {
    return findCurrentOperation(this.pool, providerValue, modelValue);
  }

  resolve(
    lookupValue: Readonly<ModelPriceCatalogLookup>,
  ): Promise<Readonly<ModelPriceCatalogEntry> | null> {
    return resolveOperation(this.pool, lookupValue);
  }
}

export class PostgresModelPriceCatalogRepository
  extends PostgresModelPriceCatalogReader
  implements
    ModelPriceCatalogAdministrationRepository,
    ModelPriceCatalogAuthorizedAdministrationRepository
{
  private insertAuthorization(
    client: PostgresClient,
    authorization: Readonly<ModelPriceCatalogAuthorization>,
  ): Promise<void> {
    return insertAuthorization(client, authorization);
  }

  findAuthorization(
    authorizationIdValue: string,
  ): Promise<Readonly<ModelPriceCatalogAuthorization> | null> {
    return findAuthorizationOperation(this.pool, authorizationIdValue);
  }

  publish(
    commandValue: Readonly<ModelPriceCatalogPublishCommand>,
  ): Promise<Readonly<CommitModelPriceCatalogPublicationResult>> {
    return publishOperation(this.pool, commandValue);
  }

  transition(
    commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
  ): Promise<Readonly<CommitModelPriceCatalogHeadResult>> {
    return transitionOperation(this.pool, commandValue);
  }

  publishAuthorized(
    commandValue: Readonly<ModelPriceCatalogPublishCommand>,
    authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>> {
    return publishAuthorizedOperation(
      this.pool,
      commandValue,
      authorizationValue,
    );
  }

  transitionAuthorized(
    commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
    authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>> {
    return transitionAuthorizedOperation(
      this.pool,
      commandValue,
      authorizationValue,
    );
  }
}
