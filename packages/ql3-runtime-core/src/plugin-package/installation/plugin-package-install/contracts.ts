import type {
  PluginPackageArchitecture,
  PluginPackageDeploymentProfile,
  PluginPackageInstallEnvironment,
  PluginPackageInstallPlan,
  PluginPackageManifest,
  PluginPackagePlanOperation,
} from '../../pluginPackage';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '../../../security/security';
import type { PluginPackageResourceReference } from '../../pluginPackageResourceGeneration';

export const PLUGIN_PACKAGE_LOCK_SCHEMA =
  'qinglong/plugin-package-lock@v2' as const;
export const PLUGIN_PACKAGE_INSTALL_SCHEMA =
  'qinglong/plugin-package-install@v1' as const;
export const PLUGIN_PACKAGE_INSTALL_ACTION_SCHEMA =
  'qinglong/plugin-package-install-action@v1' as const;
export const MAX_PLUGIN_PACKAGE_SOURCE_BYTES = 1024 ** 4;
export const MAX_PLUGIN_PACKAGE_INSTALL_VERSION = 2_147_483_647;
export const MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE = 64;
export const MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE = 64;

export const PLUGIN_PACKAGE_SOURCE_KINDS = ['oci', 'offline'] as const;
export const PLUGIN_PACKAGE_INSTALL_STATES = [
  'queued',
  'staged',
  'activating',
  'active',
  'failed',
] as const;
export const PLUGIN_PACKAGE_INSTALL_FAILURE_REASONS = [
  'source_unavailable',
  'source_mismatch',
  'stage_failed',
  'activation_failed',
  'activation_fact_conflict',
  'approval_expired',
  'policy_fence_changed',
  'resource_exhausted',
] as const;
export const PLUGIN_PACKAGE_INSTALL_RECOVERY_ACTIONS = [
  'resume_stage',
  'resume_activation',
  'inspect_activation',
  'none',
] as const;

export type PluginPackageSourceKind =
  (typeof PLUGIN_PACKAGE_SOURCE_KINDS)[number];
export type PluginPackageInstallState =
  (typeof PLUGIN_PACKAGE_INSTALL_STATES)[number];
export type PluginPackageInstallFailureReason =
  (typeof PLUGIN_PACKAGE_INSTALL_FAILURE_REASONS)[number];
export type PluginPackageInstallRecoveryAction =
  (typeof PLUGIN_PACKAGE_INSTALL_RECOVERY_ACTIONS)[number];

export interface PluginPackageSourceLock {
  readonly kind: PluginPackageSourceKind;
  readonly locator: string;
  readonly artifactDigest: string;
  readonly artifactBytes: number;
  readonly contentDigest: string;
}

export interface PluginPackageApprovalLock {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly dispatchId: string;
  readonly actionDigest: string;
  readonly previewDigest: string;
  readonly approvedBy: Readonly<SecuritySubject>;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly fence: Readonly<SecurityPolicyFence>;
}

export interface CreatePluginPackageLockInput {
  readonly lockId: string;
  readonly projectId: string;
  readonly manifest: PluginPackageManifest;
  readonly plan: PluginPackageInstallPlan;
  readonly environment: PluginPackageInstallEnvironment;
  readonly previousManifest?: PluginPackageManifest;
  readonly source: PluginPackageSourceLock;
  readonly approval: PluginPackageApprovalLock;
  readonly architecture: PluginPackageArchitecture;
  readonly deploymentProfile: PluginPackageDeploymentProfile;
  readonly targetGeneration: number;
  readonly previousLockDigest?: string;
  readonly createdAtMs: number;
}

export type PluginPackageInstallActionInput = Omit<
  CreatePluginPackageLockInput,
  'approval' | 'createdAtMs'
>;

export interface PluginPackageLock {
  readonly schema: typeof PLUGIN_PACKAGE_LOCK_SCHEMA;
  readonly lockId: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly operation: PluginPackagePlanOperation;
  readonly source: Readonly<PluginPackageSourceLock>;
  readonly manifestDigest: string;
  readonly resources: readonly Readonly<PluginPackageResourceReference>[];
  readonly planDigest: string;
  readonly environmentDigest: string;
  readonly actionDigest: string;
  readonly approval: Readonly<PluginPackageApprovalLock>;
  readonly architecture: PluginPackageArchitecture;
  readonly deploymentProfile: PluginPackageDeploymentProfile;
  readonly targetGeneration: number;
  readonly previousLockDigest?: string;
  readonly createdAtMs: number;
  readonly lockDigest: string;
}

export interface PluginPackageStageReceipt {
  readonly stageRef: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
  readonly evidenceDigest: string;
  readonly stagedAtMs: number;
  readonly receiptDigest: string;
}

export interface PluginPackageActivationReceipt {
  readonly activationRef: string;
  readonly intentDigest: string;
  readonly generation: number;
  readonly contentDigest: string;
  readonly activatedAtMs: number;
  readonly receiptDigest: string;
}

export type CreatePluginPackageActivationReceiptInput = Omit<
  PluginPackageActivationReceipt,
  'receiptDigest'
>;

export interface PluginPackageInstallFailure {
  readonly reason: PluginPackageInstallFailureReason;
  readonly failedFrom: Exclude<PluginPackageInstallState, 'active' | 'failed'>;
  readonly failedAtMs: number;
}

export interface PluginPackageInstallRecord {
  readonly schema: typeof PLUGIN_PACKAGE_INSTALL_SCHEMA;
  readonly installationId: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly operation: PluginPackagePlanOperation;
  readonly lockDigest: string;
  readonly targetGeneration: number;
  readonly previousActiveLockDigest: string | null;
  readonly activeLockDigest: string | null;
  readonly state: PluginPackageInstallState;
  readonly version: number;
  readonly lastMutationId: string;
  readonly lastMutationDigest: string;
  readonly stageReceipt: Readonly<PluginPackageStageReceipt> | null;
  readonly activationReceipt: Readonly<PluginPackageActivationReceipt> | null;
  readonly failure: Readonly<PluginPackageInstallFailure> | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly recordDigest: string;
}

export interface CreatePluginPackageInstallInput {
  readonly installationId: string;
  readonly mutationId: string;
  readonly occurredAtMs: number;
}

export type PluginPackageInstallEvent =
  | Readonly<{
      type: 'stage_completed';
      mutationId: string;
      occurredAtMs: number;
      stageRef: string;
      artifactDigest: string;
      manifestDigest: string;
      contentDigest: string;
      evidenceDigest: string;
    }>
  | Readonly<{
      type: 'activation_started';
      mutationId: string;
      occurredAtMs: number;
    }>
  | Readonly<{
      type: 'activation_committed';
      mutationId: string;
      occurredAtMs: number;
      activationRef: string;
      intentDigest: string;
      generation: number;
      contentDigest: string;
    }>
  | Readonly<{
      type: 'failed';
      mutationId: string;
      occurredAtMs: number;
      reason: PluginPackageInstallFailureReason;
    }>;

export interface PluginPackageInstallCommit {
  readonly installationId: string;
  readonly expectedVersion: number;
  readonly expectedRecordDigest: string;
  readonly mutationId: string;
  readonly mutationDigest: string;
  readonly record: Readonly<PluginPackageInstallRecord>;
}

export interface PluginPackageInstallHeadExpectation {
  readonly installationId: string;
  readonly version: number;
  readonly recordDigest: string;
}

export interface PluginPackageInstallCreate {
  readonly installationId: string;
  readonly mutationId: string;
  readonly mutationDigest: string;
  readonly expectedHead: Readonly<PluginPackageInstallHeadExpectation> | null;
  readonly lock: Readonly<PluginPackageLock>;
  readonly record: Readonly<PluginPackageInstallRecord>;
}

export interface PluginPackageInstallRecoveryCursor {
  readonly packageName: string;
  readonly installationId: string;
}

export interface PluginPackageInstallRecoveryPage {
  readonly records: readonly Readonly<PluginPackageInstallRecord>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackageInstallRecoveryCursor>;
}

export interface PluginPackageInstallInventoryCursor {
  readonly packageName: string;
}

export interface PluginPackageInstallInventoryQuarantine {
  readonly eventDigest: string;
  readonly reasonCode: 'suspected_key_compromise' | 'confirmed_key_compromise';
  readonly authorizationMode: 'dual_control' | 'break_glass';
  readonly occurredAtMs: number;
  readonly capabilityStatus: 'not_active' | 'withdrawn';
  readonly receiptDigest: string;
  readonly committedAtMs: number;
}

export interface PluginPackageInstallInventoryItem {
  readonly record: Readonly<PluginPackageInstallRecord>;
  readonly quarantine: Readonly<PluginPackageInstallInventoryQuarantine> | null;
}

export interface PluginPackageInstallInventoryPage {
  readonly items: readonly Readonly<PluginPackageInstallInventoryItem>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackageInstallInventoryCursor>;
}

/**
 * Read-only product query boundary for the current install head of each package.
 * It stays separate from the mutation/recovery repository so management
 * surfaces cannot accidentally acquire write authority.
 */
export interface PluginPackageInstallInventoryRepository {
  findCurrent(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageInstallInventoryItem> | null>;
  listCurrentPage(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<PluginPackageInstallInventoryCursor>;
  }): Promise<Readonly<PluginPackageInstallInventoryPage>>;
}

export interface PluginPackageInstallRepository {
  find(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageInstallRecord> | null>;
  findLock(lockDigest: string): Promise<Readonly<PluginPackageLock> | null>;
  create(command: Readonly<PluginPackageInstallCreate>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  >;
  commit(command: Readonly<PluginPackageInstallCommit>): Promise<
    Readonly<{
      status: 'committed' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  >;
  listRecoveryPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackageInstallRecoveryCursor>;
  }): Promise<Readonly<PluginPackageInstallRecoveryPage>>;
}

export class InvalidPluginPackageLockError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_LOCK_INVALID';

  constructor(message: string) {
    super(`Plugin Package lock is invalid: ${message}`);
    this.name = 'InvalidPluginPackageLockError';
  }
}

export class InvalidPluginPackageInstallError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_INVALID';

  constructor(message: string) {
    super(`Plugin Package install is invalid: ${message}`);
    this.name = 'InvalidPluginPackageInstallError';
  }
}

export class PluginPackageInstallTransitionConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_TRANSITION_CONFLICT';

  constructor() {
    super('Plugin Package install transition conflicts with durable state');
    this.name = 'PluginPackageInstallTransitionConflictError';
  }
}

export class PluginPackageInstallMutationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_MUTATION_CONFLICT';

  constructor() {
    super(
      'Plugin Package install mutation conflicts with its previous request',
    );
    this.name = 'PluginPackageInstallMutationConflictError';
  }
}

export class PluginPackageInstallUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package install storage is unavailable', options);
    this.name = 'PluginPackageInstallUnavailableError';
  }
}
