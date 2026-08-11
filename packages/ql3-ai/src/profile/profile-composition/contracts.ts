import type {
  GenerateRequest,
  GenerateResult,
  ModelChunk,
  ModelInvocationContext,
  ModelInvocationPolicyProvider,
  ModelProvider,
} from '../../model-gateway/model';
import type {
  DurableModelInvocationCoordinator,
  ModelInvocationRecoverySummary,
} from '../../model-invocation/durableModelInvocationCoordinator';
import type { ModelInvocationSuccessfulCompletionSink } from '../../model-gateway/gateway';
import type {
  ModelInvocationResolutionDecision,
  ModelInvocationResolutionRecord,
  ModelInvocationResolutionRepository,
  ResolveModelInvocationOptions,
} from '../../model-invocation/modelInvocationResolution';
import type {
  ModelInvocationUsageLedgerPage,
  ModelInvocationUsageLedgerQuery,
  ModelInvocationUsageLedgerRepository,
  ModelInvocationUsageLedgerSummary,
  ModelInvocationUsageLedgerSummaryQuery,
} from '../../usage/usageLedger';
import type {
  ModelInvocationQuotaRepository,
  ModelInvocationQuotaWindowUsage,
} from '../../usage/usageQuota';
import type {
  ModelInvocationPriceQuote,
  ModelInvocationPriceSettlement,
  ModelInvocationPricingRepository,
  ModelPriceCatalogResolver,
} from '../../pricing/pricing';
import type {
  CommitAuthorizedModelPriceCatalogHeadResult,
  CommitAuthorizedModelPriceCatalogPublicationResult,
  ModelPriceCatalogAuthorizedAdministrationRepository,
  ModelPriceCatalogManagementAuthorizer,
  ModelPriceCatalogManagementDecisionMode,
  ModelPriceCatalogManagementQuota,
  PublishModelPriceCatalogRequest,
  TransitionModelPriceCatalogRequest,
} from '../../pricing/modelPriceCatalogManagement';

export const MODEL_GATEWAY_PROFILES = [
  'edge',
  'standalone',
  'cluster',
] as const;
export const MODEL_GATEWAY_PROFILE_STATES = [
  'disabled',
  'storage_ready',
  'recovery_ready',
  'active',
  'draining',
  'stopped',
  'failed',
] as const;

export type ModelGatewayProfile = (typeof MODEL_GATEWAY_PROFILES)[number];
export type ModelGatewayProfileState =
  (typeof MODEL_GATEWAY_PROFILE_STATES)[number];

export interface ModelGatewayProfileAudit {
  readonly profile: ModelGatewayProfile;
  readonly state: ModelGatewayProfileState;
  readonly maxConcurrent?: number;
  readonly recoveryLimit?: number;
  readonly recovered?: number;
  readonly alreadyCompleted?: number;
}

export interface ModelGatewayStorageAuthority {
  readonly repository: ModelInvocationResolutionRepository &
    ModelInvocationUsageLedgerRepository &
    ModelInvocationQuotaRepository &
    ModelInvocationPricingRepository;
  readonly pricing: ModelPriceCatalogResolver;
  close?(): void | Promise<void>;
}

export interface ModelGatewayProviderAuthority {
  readonly providers: readonly ModelProvider[];
  readonly policies: ModelInvocationPolicyProvider;
  dispose?(): void | Promise<void>;
}

export interface BootstrapModelGatewayProfileOptions {
  readonly enabled?: boolean;
  readonly profile: ModelGatewayProfile;
  readonly loadStorage: () => Promise<ModelGatewayStorageAuthority>;
  readonly loadProviders: () => Promise<ModelGatewayProviderAuthority>;
  readonly confirmActive?: () => void | Promise<void>;
  readonly createSuccessfulCompletion?: (
    coordinator: DurableModelInvocationCoordinator,
  ) => ModelInvocationSuccessfulCompletionSink;
  readonly audit: (
    record: Readonly<ModelGatewayProfileAudit>,
  ) => void | Promise<void>;
  readonly maxConcurrent?: number;
  readonly recoveryLimit?: number;
  readonly now?: () => number;
}

export interface ActiveModelGatewayCapability {
  readonly profile: ModelGatewayProfile;
  readonly recovery: Readonly<ModelInvocationRecoverySummary>;
  readonly maxConcurrent: number;
  readonly recoveryLimit: number;
  readonly accepting: boolean;
  readonly activeOperations: number;
  supportsSuccessfulCompletionSink(
    sink: ModelInvocationSuccessfulCompletionSink,
  ): boolean;
  generate(
    request: GenerateRequest,
    context: ModelInvocationContext,
  ): Promise<Readonly<GenerateResult>>;
  stream(
    request: GenerateRequest,
    context: ModelInvocationContext,
  ): AsyncIterable<Readonly<ModelChunk>>;
  resolveUnknown(options: {
    readonly invocationId: string;
    readonly decision: ModelInvocationResolutionDecision;
    readonly resolvedByUserId: string;
    readonly resolvedAtMs: number;
  }): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<ModelInvocationResolutionRecord>;
    }>
  >;
  listProjectUsage(
    query: ModelInvocationUsageLedgerQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerPage>>;
  summarizeProjectUsage(
    query: ModelInvocationUsageLedgerSummaryQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerSummary>>;
  readQuotaWindowUsage(
    projectId: string,
    atMs?: number,
  ): Promise<Readonly<ModelInvocationQuotaWindowUsage> | null>;
  findPriceQuote(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationPriceQuote> | null>;
  findPriceSettlement(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationPriceSettlement> | null>;
  stop(): Promise<'draining' | 'stopped'>;
}

export type BootstrapModelGatewayProfileResult =
  | {
      readonly status: 'disabled';
      readonly profile: ModelGatewayProfile;
      stop(): Promise<'stopped'>;
    }
  | {
      readonly status: 'active';
      readonly profile: ModelGatewayProfile;
      readonly capability: ActiveModelGatewayCapability;
    };

export class ModelGatewayProfileUnavailableError extends Error {
  readonly code = 'MODEL_GATEWAY_PROFILE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('The model gateway Profile is unavailable', options);
    this.name = 'ModelGatewayProfileUnavailableError';
  }
}

export class ModelGatewayProfileDrainingError extends Error {
  readonly code = 'MODEL_GATEWAY_PROFILE_DRAINING';

  constructor() {
    super('The model gateway Profile is draining');
    this.name = 'ModelGatewayProfileDrainingError';
  }
}

export const MODEL_PRICE_CATALOG_MANAGEMENT_PROFILE_STATES = [
  'disabled',
  'authority_ready',
  'active',
  'draining',
  'stopped',
  'failed',
] as const;

export type ModelPriceCatalogManagementProfileState =
  (typeof MODEL_PRICE_CATALOG_MANAGEMENT_PROFILE_STATES)[number];

export interface ModelPriceCatalogManagementProfileAudit {
  readonly profile: ModelGatewayProfile;
  readonly state: ModelPriceCatalogManagementProfileState;
  readonly decisionMode: ModelPriceCatalogManagementDecisionMode;
}

export interface ModelPriceCatalogManagementAuthority {
  readonly repository: ModelPriceCatalogAuthorizedAdministrationRepository;
  readonly authorizer: ModelPriceCatalogManagementAuthorizer;
  readonly quota?: ModelPriceCatalogManagementQuota;
  close?(): void | Promise<void>;
}

export interface BootstrapModelPriceCatalogManagementProfileOptions {
  readonly enabled?: boolean;
  readonly profile: ModelGatewayProfile;
  readonly loadAuthority: () => Promise<ModelPriceCatalogManagementAuthority>;
  readonly audit: (
    record: Readonly<ModelPriceCatalogManagementProfileAudit>,
  ) => void | Promise<void>;
  readonly now?: () => number;
}

export interface ActiveModelPriceCatalogManagementCapability {
  readonly profile: ModelGatewayProfile;
  readonly decisionMode: ModelPriceCatalogManagementDecisionMode;
  readonly accepting: boolean;
  readonly activeOperations: number;
  publish(
    request: Readonly<PublishModelPriceCatalogRequest>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogPublicationResult>>;
  transition(
    request: Readonly<TransitionModelPriceCatalogRequest>,
  ): Promise<Readonly<CommitAuthorizedModelPriceCatalogHeadResult>>;
  stop(): Promise<'draining' | 'stopped'>;
}

export type BootstrapModelPriceCatalogManagementProfileResult =
  | {
      readonly status: 'disabled';
      readonly profile: ModelGatewayProfile;
      readonly decisionMode: ModelPriceCatalogManagementDecisionMode;
      stop(): Promise<'stopped'>;
    }
  | {
      readonly status: 'active';
      readonly profile: ModelGatewayProfile;
      readonly decisionMode: ModelPriceCatalogManagementDecisionMode;
      readonly capability: ActiveModelPriceCatalogManagementCapability;
    };

export class ModelPriceCatalogManagementProfileUnavailableError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_PROFILE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('The model price catalog management Profile is unavailable', options);
    this.name = 'ModelPriceCatalogManagementProfileUnavailableError';
  }
}

export class ModelPriceCatalogManagementProfileDrainingError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_MANAGEMENT_PROFILE_DRAINING';

  constructor() {
    super('The model price catalog management Profile is draining');
    this.name = 'ModelPriceCatalogManagementProfileDrainingError';
  }
}
