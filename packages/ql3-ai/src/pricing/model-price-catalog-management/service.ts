import {
  createModelPriceCatalogPublishCommand,
  createModelPriceCatalogTransitionCommand,
  type ModelPriceCatalogPublication,
} from '../modelPriceCatalog';
import {
  createModelPriceCatalogAuthorizationCommand,
  normalizeModelPriceCatalogPolicyDecision,
} from './authorization';
import {
  InvalidModelPriceCatalogManagementValueError,
  MODEL_PRICE_CATALOG_MANAGEMENT_DECISION_MODES,
  ModelPriceCatalogManagementAuthorizationError,
  ModelPriceCatalogManagementQuotaExceededError,
  ModelPriceCatalogManagementSeparationOfDutyError,
  ModelPriceCatalogManagementUnavailableError,
  type BaseManagementRequest,
  type CommitAuthorizedModelPriceCatalogHeadResult,
  type CommitAuthorizedModelPriceCatalogPublicationResult,
  type CreateModelPriceCatalogManagementServiceOptions,
  type ModelPriceCatalogAuthorizationCommand,
  type ModelPriceCatalogAuthorizedAdministrationRepository,
  type ModelPriceCatalogManagementOperation,
  type ModelPriceCatalogManagementService,
  type ModelPriceCatalogPolicyDecision,
  type PublishModelPriceCatalogRequest,
  type TransitionModelPriceCatalogRequest,
} from './contracts';
import {
  currentTime,
  exactRequest,
  normalizedPrincipal,
  unavailable,
} from './validation';
export function createModelPriceCatalogManagementService(
  repository: ModelPriceCatalogAuthorizedAdministrationRepository,
  options: CreateModelPriceCatalogManagementServiceOptions,
): Readonly<ModelPriceCatalogManagementService> {
  if (
    !repository ||
    typeof repository.findPublication !== 'function' ||
    typeof repository.findCurrent !== 'function' ||
    typeof repository.findAuthorization !== 'function' ||
    typeof repository.publishAuthorized !== 'function' ||
    typeof repository.transitionAuthorized !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'decisionMode' &&
        key !== 'authorizer' &&
        key !== 'quota' &&
        key !== 'now',
    ) ||
    !MODEL_PRICE_CATALOG_MANAGEMENT_DECISION_MODES.includes(
      options.decisionMode,
    ) ||
    !options.authorizer ||
    typeof options.authorizer.authorize !== 'function' ||
    (options.quota !== undefined &&
      (!options.quota || typeof options.quota.consume !== 'function')) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new InvalidModelPriceCatalogManagementValueError(
      'service options are invalid',
    );
  }
  const now = options.now ?? Date.now;

  const authorize = async (
    operationValue: ModelPriceCatalogManagementOperation,
    request: BaseManagementRequest,
    priceRevision: string | null,
    catalogCommandDigest: string,
  ): Promise<Readonly<ModelPriceCatalogAuthorizationCommand>> => {
    const principal = normalizedPrincipal(request.principal, currentTime(now));
    let policy: Readonly<ModelPriceCatalogPolicyDecision>;
    try {
      policy = normalizeModelPriceCatalogPolicyDecision(
        await options.authorizer.authorize({
          operation: operationValue,
          provider: request.provider,
          model: request.model,
          priceRevision,
          requestId: request.requestId,
          principal,
        }),
      );
    } catch (error) {
      throw unavailable(error);
    }
    if (policy.effect !== 'allow') {
      throw new ModelPriceCatalogManagementAuthorizationError();
    }
    if (options.quota) {
      try {
        await options.quota.consume({
          operation: operationValue,
          subject: principal.subject,
          idempotencyKey: request.authorizationId,
        });
      } catch (error) {
        if (error instanceof ModelPriceCatalogManagementQuotaExceededError) {
          throw error;
        }
        throw unavailable(error);
      }
    }
    return createModelPriceCatalogAuthorizationCommand({
      authorizationId: request.authorizationId,
      requestId: request.requestId,
      operation: operationValue,
      provider: request.provider,
      model: request.model,
      priceRevision,
      catalogCommandDigest,
      principal,
      policy,
      decisionMode: options.decisionMode,
    });
  };

  return Object.freeze({
    async publish(
      request: Readonly<PublishModelPriceCatalogRequest>,
    ): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>> {
      exactRequest(
        request,
        [
          'authorizationId',
          'requestId',
          'mutationId',
          'provider',
          'model',
          'principal',
          'priceRevision',
          'currency',
          'inputMicrosPerMillionTokens',
          'outputMicrosPerMillionTokens',
        ],
        'publish request',
      );
      const principal = normalizedPrincipal(
        request.principal,
        currentTime(now),
      );
      const command = createModelPriceCatalogPublishCommand({
        provider: request.provider,
        model: request.model,
        priceRevision: request.priceRevision,
        currency: request.currency,
        inputMicrosPerMillionTokens: request.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens: request.outputMicrosPerMillionTokens,
        mutationId: request.mutationId,
        publishedByUserId: principal.subject.id,
      });
      const authorization = await authorize(
        'publish',
        { ...request, principal },
        request.priceRevision,
        command.commandDigest,
      );
      return repository.publishAuthorized(command, authorization);
    },

    async transition(
      request: Readonly<TransitionModelPriceCatalogRequest>,
    ): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>> {
      exactRequest(
        request,
        [
          'authorizationId',
          'requestId',
          'mutationId',
          'provider',
          'model',
          'principal',
          'expectedGeneration',
          'expectedHeadDigest',
          'action',
          'priceRevision',
        ],
        'transition request',
      );
      const principal = normalizedPrincipal(
        request.principal,
        currentTime(now),
      );
      const command = createModelPriceCatalogTransitionCommand({
        provider: request.provider,
        model: request.model,
        expectedGeneration: request.expectedGeneration,
        expectedHeadDigest: request.expectedHeadDigest,
        action: request.action,
        priceRevision: request.priceRevision,
        mutationId: request.mutationId,
        changedByUserId: principal.subject.id,
      });
      const authorization = await authorize(
        request.action,
        { ...request, principal },
        request.priceRevision,
        command.commandDigest,
      );
      if (
        options.decisionMode === 'separation_of_duty' &&
        request.action === 'activate'
      ) {
        let publication: Readonly<ModelPriceCatalogPublication> | null;
        try {
          publication = await repository.findPublication({
            provider: request.provider,
            model: request.model,
            priceRevision: request.priceRevision!,
          });
        } catch (error) {
          throw unavailable(error);
        }
        if (!publication) {
          throw new ModelPriceCatalogManagementUnavailableError();
        }
        if (publication.publishedByUserId === principal.subject.id) {
          throw new ModelPriceCatalogManagementSeparationOfDutyError();
        }
      }
      return repository.transitionAuthorized(command, authorization);
    },
  });
}
