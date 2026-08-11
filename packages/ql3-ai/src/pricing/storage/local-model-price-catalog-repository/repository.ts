import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../../model-invocation/localModelInvocationRepository';
import {
  InvalidModelPriceCatalogError,
  type CommitModelPriceCatalogHeadResult,
  type CommitModelPriceCatalogPublicationResult,
  type ModelPriceCatalogAdministrationRepository,
  type ModelPriceCatalogHead,
  type ModelPriceCatalogPublication,
  type ModelPriceCatalogPublishCommand,
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
import { PrivateLocalAuthority, isAuthority } from './authority';
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

export interface LocalModelPriceCatalogRepositoryOptions {
  readonly beforeAuthorizedMutation?: (
    client: DatabaseSync,
    authorization: Readonly<ModelPriceCatalogAuthorizationCommand>,
  ) => void;
}

export class LocalModelPriceCatalogRepository
  implements
    ModelPriceCatalogAdministrationRepository,
    ModelPriceCatalogAuthorizedAdministrationRepository
{
  readonly #authority: LocalModelInvocationOperationAuthority;
  readonly #client: DatabaseSync;
  readonly #beforeAuthorizedMutation:
    | NonNullable<
        LocalModelPriceCatalogRepositoryOptions['beforeAuthorizedMutation']
      >
    | undefined;

  constructor(
    authority: LocalModelInvocationOperationAuthority | DatabaseSync,
    options: LocalModelPriceCatalogRepositoryOptions = {},
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'beforeAuthorizedMutation') ||
      (options.beforeAuthorizedMutation !== undefined &&
        typeof options.beforeAuthorizedMutation !== 'function')
    ) {
      throw new InvalidModelPriceCatalogError(
        'local repository options are invalid',
      );
    }
    this.#authority = isAuthority(authority)
      ? authority
      : new PrivateLocalAuthority(authority);
    this.#client = this.#authority.client;
    this.#beforeAuthorizedMutation = options.beforeAuthorizedMutation;
  }

  findAuthorization(
    authorizationIdValue: string,
  ): Promise<Readonly<ModelPriceCatalogAuthorization> | null> {
    return findAuthorizationOperation(
      this.#authority,
      this.#client,
      authorizationIdValue,
    );
  }

  findPublication(
    lookupValue: Omit<ModelPriceCatalogLookup, 'signal'>,
  ): Promise<Readonly<ModelPriceCatalogPublication> | null> {
    return findPublicationOperation(this.#authority, this.#client, lookupValue);
  }

  findCurrent(
    providerValue: string,
    modelValue: string,
  ): Promise<Readonly<ModelPriceCatalogHead> | null> {
    return findCurrentOperation(
      this.#authority,
      this.#client,
      providerValue,
      modelValue,
    );
  }

  resolve(
    lookupValue: Readonly<ModelPriceCatalogLookup>,
  ): Promise<Readonly<ModelPriceCatalogEntry> | null> {
    return resolveOperation(this.#authority, this.#client, lookupValue);
  }

  publish(
    commandValue: Readonly<ModelPriceCatalogPublishCommand>,
  ): Promise<Readonly<CommitModelPriceCatalogPublicationResult>> {
    return publishOperation(this.#authority, this.#client, commandValue);
  }

  transition(
    commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
  ): Promise<Readonly<CommitModelPriceCatalogHeadResult>> {
    return transitionOperation(this.#authority, this.#client, commandValue);
  }

  publishAuthorized(
    commandValue: Readonly<ModelPriceCatalogPublishCommand>,
    authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>> {
    return publishAuthorizedOperation(
      this.#authority,
      this.#client,
      this.#beforeAuthorizedMutation,
      commandValue,
      authorizationValue,
    );
  }

  transitionAuthorized(
    commandValue: Readonly<ModelPriceCatalogTransitionCommand>,
    authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>> {
    return transitionAuthorizedOperation(
      this.#authority,
      this.#client,
      this.#beforeAuthorizedMutation,
      commandValue,
      authorizationValue,
    );
  }
}
