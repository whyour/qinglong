import type {
  SecurityPrincipal,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import { MODEL_PRICE_CURRENCY } from '../pricing';
import type {
  CommitModelPriceCatalogHeadResult,
  CommitModelPriceCatalogPublicationResult,
  ModelPriceCatalogAction,
  ModelPriceCatalogAdministrationRepository,
  ModelPriceCatalogPublishCommand,
  ModelPriceCatalogTransitionCommand,
} from '../modelPriceCatalog';

export const MODEL_PRICE_CATALOG_POLICY_DECISION_SCHEMA =
  'qinglong/model-price-catalog-policy-decision@v1' as const;
export const MODEL_PRICE_CATALOG_AUTHORIZATION_COMMAND_SCHEMA =
  'qinglong/model-price-catalog-authorization-command@v1' as const;
export const MODEL_PRICE_CATALOG_AUTHORIZATION_SCHEMA =
  'qinglong/model-price-catalog-authorization@v1' as const;
export const MODEL_PRICE_CATALOG_MANAGEMENT_OPERATIONS = [
  'publish',
  'activate',
  'deactivate',
  'revoke',
] as const;
export const MODEL_PRICE_CATALOG_MANAGEMENT_DECISION_MODES = [
  'human_confirmation',
  'separation_of_duty',
] as const;
export const MAX_MODEL_PRICE_CATALOG_PRINCIPAL_AGE_MS = 5 * 60 * 1000;

export type ModelPriceCatalogManagementOperation =
  (typeof MODEL_PRICE_CATALOG_MANAGEMENT_OPERATIONS)[number];
export type ModelPriceCatalogManagementDecisionMode =
  (typeof MODEL_PRICE_CATALOG_MANAGEMENT_DECISION_MODES)[number];

export interface ModelPriceCatalogPolicyDecision {
  readonly schema: typeof MODEL_PRICE_CATALOG_POLICY_DECISION_SCHEMA;
  readonly effect: 'allow' | 'deny';
  readonly revision: string;
  readonly reasons: readonly string[];
  readonly decisionDigest: string;
}

export interface AuthorizeModelPriceCatalogManagementRequest {
  readonly operation: ModelPriceCatalogManagementOperation;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string | null;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface ModelPriceCatalogManagementAuthorizer {
  authorize(
    request: Readonly<AuthorizeModelPriceCatalogManagementRequest>,
  ): Promise<Readonly<ModelPriceCatalogPolicyDecision>>;
}

export interface ConsumeModelPriceCatalogManagementQuotaCommand {
  readonly operation: ModelPriceCatalogManagementOperation;
  readonly subject: SecuritySubject;
  readonly idempotencyKey: string;
}

export interface ModelPriceCatalogManagementQuota {
  consume(
    command: Readonly<ConsumeModelPriceCatalogManagementQuotaCommand>,
  ): Promise<void>;
}

export interface ModelPriceCatalogAuthorizationCommand {
  readonly schema: typeof MODEL_PRICE_CATALOG_AUTHORIZATION_COMMAND_SCHEMA;
  readonly authorizationId: string;
  readonly requestId: string;
  readonly operation: ModelPriceCatalogManagementOperation;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string | null;
  readonly catalogCommandDigest: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policy: Readonly<ModelPriceCatalogPolicyDecision>;
  readonly decisionMode: ModelPriceCatalogManagementDecisionMode;
  readonly commandDigest: string;
}

export interface ModelPriceCatalogAuthorization {
  readonly schema: typeof MODEL_PRICE_CATALOG_AUTHORIZATION_SCHEMA;
  readonly authorizationId: string;
  readonly requestId: string;
  readonly operation: ModelPriceCatalogManagementOperation;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string | null;
  readonly catalogCommandDigest: string;
  readonly resultDigest: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policy: Readonly<ModelPriceCatalogPolicyDecision>;
  readonly decisionMode: ModelPriceCatalogManagementDecisionMode;
  readonly commandDigest: string;
  readonly committedAtMs: number;
  readonly authorizationDigest: string;
}

export interface CommitAuthorizedModelPriceCatalogPublicationResult
  extends CommitModelPriceCatalogPublicationResult {
  readonly authorization: Readonly<ModelPriceCatalogAuthorization>;
}

export interface CommitAuthorizedModelPriceCatalogHeadResult
  extends CommitModelPriceCatalogHeadResult {
  readonly authorization: Readonly<ModelPriceCatalogAuthorization>;
}

export interface ModelPriceCatalogAuthorizedAdministrationRepository
  extends ModelPriceCatalogAdministrationRepository {
  findAuthorization(
    authorizationId: string,
  ): Promise<Readonly<ModelPriceCatalogAuthorization> | null>;
  publishAuthorized(
    command: Readonly<ModelPriceCatalogPublishCommand>,
    authorization: Readonly<ModelPriceCatalogAuthorizationCommand>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>>;
  transitionAuthorized(
    command: Readonly<ModelPriceCatalogTransitionCommand>,
    authorization: Readonly<ModelPriceCatalogAuthorizationCommand>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>>;
}

export interface BaseManagementRequest {
  readonly authorizationId: string;
  readonly requestId: string;
  readonly mutationId: string;
  readonly provider: string;
  readonly model: string;
  readonly principal: SecurityPrincipal;
}

export interface PublishModelPriceCatalogRequest extends BaseManagementRequest {
  readonly priceRevision: string;
  readonly currency: typeof MODEL_PRICE_CURRENCY;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
}

export interface TransitionModelPriceCatalogRequest
  extends BaseManagementRequest {
  readonly expectedGeneration: number;
  readonly expectedHeadDigest: string | null;
  readonly action: ModelPriceCatalogAction;
  readonly priceRevision: string | null;
}

export interface ModelPriceCatalogManagementService {
  publish(
    request: Readonly<PublishModelPriceCatalogRequest>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>>;
  transition(
    request: Readonly<TransitionModelPriceCatalogRequest>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>>;
}

export interface CreateModelPriceCatalogManagementServiceOptions {
  readonly decisionMode: ModelPriceCatalogManagementDecisionMode;
  readonly authorizer: ModelPriceCatalogManagementAuthorizer;
  readonly quota?: ModelPriceCatalogManagementQuota;
  readonly now?: () => number;
}

export class InvalidModelPriceCatalogManagementValueError extends TypeError {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_INVALID';

  constructor(message: string) {
    super(`Model price catalog management is invalid: ${message}`);
    this.name = 'InvalidModelPriceCatalogManagementValueError';
  }
}

export class ModelPriceCatalogManagementAuthenticationError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Model price catalog management requires a recent strong User');
    this.name = 'ModelPriceCatalogManagementAuthenticationError';
  }
}

export class ModelPriceCatalogManagementAuthorizationError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_FORBIDDEN';

  constructor() {
    super('Model price catalog management is not authorized');
    this.name = 'ModelPriceCatalogManagementAuthorizationError';
  }
}

export class ModelPriceCatalogManagementSeparationOfDutyError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_SEPARATION_OF_DUTY_REQUIRED';

  constructor() {
    super('Model price activation requires a different publishing User');
    this.name = 'ModelPriceCatalogManagementSeparationOfDutyError';
  }
}

export class ModelPriceCatalogManagementQuotaExceededError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_QUOTA_EXCEEDED';

  constructor(readonly retryAfterMs: number) {
    if (
      !Number.isSafeInteger(retryAfterMs) ||
      retryAfterMs < 1 ||
      retryAfterMs > 5 * 60 * 1000
    ) {
      throw new TypeError('Model price catalog quota retry delay is invalid');
    }
    super('Model price catalog management quota is exhausted');
    this.name = 'ModelPriceCatalogManagementQuotaExceededError';
  }
}

export class ModelPriceCatalogManagementUnavailableError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Model price catalog management is unavailable', options);
    this.name = 'ModelPriceCatalogManagementUnavailableError';
  }
}
