/** Authenticated Plugin Package management transport boundary. */
import type {
  ApprovalRequestRecord,
  DecideApprovalRequestResult,
} from '@qinglong/runtime-core/approved-action';
import {
  pluginPackageInstallRecoveryAction,
  type PluginPackageInstallActionInput,
  type PluginPackageInstallInventoryItem,
} from '@qinglong/runtime-core/plugin-package-install';
import type {
  InspectPluginPackageInstallResult,
  ProposePluginPackageInstallResult,
} from '@qinglong/runtime-core/plugin-package-management';
import type { PluginPackageInstallProposal } from '@qinglong/runtime-core/plugin-package-proposal';
import type { PluginPackageLifecyclePlan } from '@qinglong/runtime-core/plugin-package-lifecycle-plan';
import type { PluginPackageSecretBindingAssignment } from '@qinglong/runtime-core/plugin-package-secret-binding';
import type { PluginPackageSecretBindingApprovalPlan } from '@qinglong/runtime-core/plugin-package-secret-binding-approval-plan';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { ClusterPluginPackageManagementService } from './pluginPackageManagement';
import type { ClusterPluginPackageLifecycleManagementService } from '../lifecycle/pluginPackageLifecycleManagement';
import type {
  ClusterPluginPackagePublisherTrustManagementService,
  InspectClusterPluginPackagePublisherRevocationResult,
  InspectClusterPluginPackagePublisherTrustTransitionResult,
} from '../publisher/pluginPackagePublisherTrustManagement';
import type { ClusterPluginPackageSecretBindingManagementService } from '../secret-binding/pluginPackageSecretBindingManagement';

const STRONG_CLUSTER_ASSURANCES = new Set(['multi_factor', 'hardware']);

export interface ClusterPluginPackageManagementAuthentication {
  authenticate(): Promise<Readonly<SecurityPrincipal> | null>;
}

export interface ProposeClusterPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.propose';
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly proposalAuditEventId: string;
    readonly approvalAuditEventId: string;
    readonly actionInput: PluginPackageInstallActionInput;
  };
}

export interface DecideClusterPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.decide';
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly expectedVersion: number;
    readonly decisionId: string;
    readonly auditEventId: string;
    readonly decision: 'approved' | 'rejected';
    readonly reasonCode: string;
  };
}

export interface InspectClusterPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.inspect';
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly inspectionId: string;
  };
}

export interface ProposeClusterPluginPackageLifecycleCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.lifecycle.propose';
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly approvalAuditEventId: string;
  };
}

export interface DecideClusterPluginPackageLifecycleCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.lifecycle.decide';
  readonly request: DecideClusterPluginPackageCommand['request'];
}

export interface InspectClusterPluginPackageLifecycleCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.lifecycle.inspect';
  readonly request: InspectClusterPluginPackageCommand['request'];
}

export interface InspectClusterPluginPackageInstallationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.installation.inspect';
  readonly request: {
    readonly projectId: string;
    readonly packageName: string;
    readonly inspectionId: string;
  };
}

export interface ListClusterPluginPackageInstallationsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.installation.list';
  readonly request: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<{ packageName: string }>;
    readonly inspectionId: string;
  };
}

export interface ProposeClusterPluginPackagePublisherRevocationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-revocation.propose';
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly proposalAuditEventId: string;
    readonly approvalAuditEventId: string;
    readonly publisher: string;
    readonly keyId: string;
    readonly authorizationMode: 'dual_control' | 'break_glass';
    readonly reasonCode:
      | 'suspected_key_compromise'
      | 'confirmed_key_compromise';
  };
}

export interface DecideClusterPluginPackagePublisherRevocationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-revocation.decide';
  readonly request: DecideClusterPluginPackageCommand['request'];
}

export interface InspectClusterPluginPackagePublisherRevocationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-revocation.inspect';
  readonly request: InspectClusterPluginPackageCommand['request'];
}

export interface ProposeClusterPluginPackagePublisherTrustTransitionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-trust-transition.propose';
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly proposalAuditEventId: string;
    readonly approvalAuditEventId: string;
    readonly mode: 'overlap_add' | 'safe_retire';
    readonly publisher: string;
    readonly keyId: string;
  };
}

export interface DecideClusterPluginPackagePublisherTrustTransitionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-trust-transition.decide';
  readonly request: DecideClusterPluginPackageCommand['request'];
}

export interface InspectClusterPluginPackagePublisherTrustTransitionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-trust-transition.inspect';
  readonly request: InspectClusterPluginPackageCommand['request'];
}

export interface PlanClusterPluginPackageSecretBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.secret-binding.plan';
  readonly request: {
    readonly actionRef: string;
    readonly projectId: string;
    readonly packageName: string;
    readonly assignments: readonly Readonly<PluginPackageSecretBindingAssignment>[];
  };
}

export interface ProposeClusterPluginPackageSecretBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.secret-binding.propose';
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly approvalAuditEventId: string;
  };
}

export interface DecideClusterPluginPackageSecretBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.secret-binding.decide';
  readonly request: DecideClusterPluginPackageCommand['request'];
}

export interface InspectClusterPluginPackageSecretBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.secret-binding.inspect';
  readonly request: InspectClusterPluginPackageCommand['request'];
}

export type ClusterPluginPackageManagementCommand =
  | ProposeClusterPluginPackageCommand
  | DecideClusterPluginPackageCommand
  | InspectClusterPluginPackageCommand
  | ProposeClusterPluginPackageLifecycleCommand
  | DecideClusterPluginPackageLifecycleCommand
  | InspectClusterPluginPackageLifecycleCommand
  | InspectClusterPluginPackageInstallationCommand
  | ListClusterPluginPackageInstallationsCommand
  | ProposeClusterPluginPackagePublisherRevocationCommand
  | DecideClusterPluginPackagePublisherRevocationCommand
  | InspectClusterPluginPackagePublisherRevocationCommand
  | ProposeClusterPluginPackagePublisherTrustTransitionCommand
  | DecideClusterPluginPackagePublisherTrustTransitionCommand
  | InspectClusterPluginPackagePublisherTrustTransitionCommand
  | PlanClusterPluginPackageSecretBindingCommand
  | ProposeClusterPluginPackageSecretBindingCommand
  | DecideClusterPluginPackageSecretBindingCommand
  | InspectClusterPluginPackageSecretBindingCommand;

export type ClusterPluginPackageManagementTransportResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.propose';
      proposalStatus: 'created' | 'existing';
      approvalStatus: 'created' | 'existing';
      proposal: ReturnType<typeof proposalSummary>;
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.decide';
      status: 'decided' | 'existing';
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.inspect';
      proposal: ReturnType<typeof proposalSummary> | null;
      approval: ReturnType<typeof approvalSummary> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.installation.inspect';
      installation: ReturnType<typeof installationSummary> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.installation.list';
      installations: readonly ReturnType<typeof installationSummary>[];
      truncated: boolean;
      next: Readonly<{ packageName: string }> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.lifecycle.propose';
      approvalStatus: 'created' | 'existing';
      plan: ReturnType<typeof lifecyclePlanSummary>;
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.lifecycle.decide';
      status: 'decided' | 'existing';
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.lifecycle.inspect';
      plan: ReturnType<typeof lifecyclePlanSummary> | null;
      approval: ReturnType<typeof approvalSummary> | null;
      stale: boolean;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-revocation.propose';
      proposalStatus: 'created' | 'existing';
      approvalStatus: 'created' | 'existing';
      proposal: ReturnType<typeof publisherRevocationProposalSummary>;
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-revocation.decide';
      status: 'decided' | 'existing';
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-revocation.inspect';
      proposal: ReturnType<typeof publisherRevocationProposalSummary> | null;
      approval: ReturnType<typeof approvalSummary> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-trust-transition.propose';
      proposalStatus: 'created' | 'existing';
      approvalStatus: 'created' | 'existing';
      proposal: ReturnType<typeof publisherTrustTransitionProposalSummary>;
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-trust-transition.decide';
      status: 'decided' | 'existing';
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-trust-transition.inspect';
      proposal: ReturnType<
        typeof publisherTrustTransitionProposalSummary
      > | null;
      approval: ReturnType<typeof approvalSummary> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.secret-binding.plan';
      status: 'created' | 'existing';
      plan: ReturnType<typeof secretBindingPlanSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.secret-binding.propose';
      approvalStatus: 'created' | 'existing';
      plan: ReturnType<typeof secretBindingPlanSummary>;
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.secret-binding.decide';
      status: 'decided' | 'existing';
      approval: ReturnType<typeof approvalSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.secret-binding.inspect';
      plan: ReturnType<typeof secretBindingPlanSummary> | null;
      approval: ReturnType<typeof approvalSummary> | null;
      stale: boolean;
    }>;

export interface ClusterPluginPackageManagementTransport {
  execute(
    command: unknown,
    authentication: ClusterPluginPackageManagementAuthentication,
  ): Promise<Readonly<ClusterPluginPackageManagementTransportResult>>;
}

export interface ClusterPluginPackageManagementTransportOptions {
  readonly service: ClusterPluginPackageManagementService;
  readonly lifecycle?: ClusterPluginPackageLifecycleManagementService;
  readonly publisherTrust?: ClusterPluginPackagePublisherTrustManagementService;
  readonly secretBinding?: ClusterPluginPackageSecretBindingManagementService;
  readonly now?: () => number;
}

export class ClusterPluginPackageManagementTransportConfigurationError extends TypeError {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_TRANSPORT_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(
      `Cluster Plugin Package transport configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPluginPackageManagementTransportConfigurationError';
  }
}

export class ClusterPluginPackageManagementTransportRequestError extends TypeError {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_TRANSPORT_REQUEST_INVALID';

  constructor(message: string) {
    super(`Cluster Plugin Package transport request is invalid: ${message}`);
    this.name = 'ClusterPluginPackageManagementTransportRequestError';
  }
}

export class ClusterPluginPackageManagementTransportAuthenticationError extends Error {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_TRANSPORT_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Cluster Plugin Package transport requires a strong User principal');
    this.name = 'ClusterPluginPackageManagementTransportAuthenticationError';
  }
}

export class ClusterPluginPackageManagementTransportUnavailableError extends Error {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_TRANSPORT_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Cluster Plugin Package transport is unavailable');
    this.name = 'ClusterPluginPackageManagementTransportUnavailableError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterPluginPackageManagementTransportRequestError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ClusterPluginPackageManagementTransportRequestError(
      `${label} shape is invalid`,
    );
  }
}

export function normalizeClusterPluginPackageManagementCommand(
  value: unknown,
): Readonly<ClusterPluginPackageManagementCommand> {
  exactObject(value, ['schemaVersion', 'operation', 'request'], 'command');
  if (value.schemaVersion !== 1) {
    throw new ClusterPluginPackageManagementTransportRequestError(
      'schemaVersion is invalid',
    );
  }
  switch (value.operation) {
    case 'plugin-package.propose':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'proposalAuditEventId',
          'approvalAuditEventId',
          'actionInput',
        ],
        'proposal request',
      );
      break;
    case 'plugin-package.decide':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'expectedVersion',
          'decisionId',
          'auditEventId',
          'decision',
          'reasonCode',
        ],
        'decision request',
      );
      break;
    case 'plugin-package.inspect':
      exactObject(
        value.request,
        ['actionRef', 'approvalRequestId', 'inspectionId'],
        'inspection request',
      );
      break;
    case 'plugin-package.lifecycle.propose':
      exactObject(
        value.request,
        ['actionRef', 'approvalAuditEventId', 'approvalRequestId'],
        'lifecycle proposal request',
      );
      break;
    case 'plugin-package.lifecycle.decide':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'expectedVersion',
          'decisionId',
          'auditEventId',
          'decision',
          'reasonCode',
        ],
        'lifecycle decision request',
      );
      break;
    case 'plugin-package.lifecycle.inspect':
      exactObject(
        value.request,
        ['actionRef', 'approvalRequestId', 'inspectionId'],
        'lifecycle inspection request',
      );
      break;
    case 'plugin-package.installation.inspect':
      exactObject(
        value.request,
        ['inspectionId', 'packageName', 'projectId'],
        'installation inspection request',
      );
      break;
    case 'plugin-package.installation.list': {
      const hasAfter =
        !!value.request &&
        typeof value.request === 'object' &&
        !Array.isArray(value.request) &&
        Object.hasOwn(value.request, 'after');
      exactObject(
        value.request,
        ['inspectionId', 'limit', 'projectId', ...(hasAfter ? ['after'] : [])],
        'installation list request',
      );
      if (hasAfter) {
        exactObject(
          value.request.after,
          ['packageName'],
          'installation list cursor',
        );
      }
      break;
    }
    case 'plugin-package.publisher-revocation.propose':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'proposalAuditEventId',
          'approvalAuditEventId',
          'publisher',
          'keyId',
          'authorizationMode',
          'reasonCode',
        ],
        'publisher revocation proposal request',
      );
      break;
    case 'plugin-package.publisher-revocation.decide':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'expectedVersion',
          'decisionId',
          'auditEventId',
          'decision',
          'reasonCode',
        ],
        'publisher revocation decision request',
      );
      break;
    case 'plugin-package.publisher-revocation.inspect':
      exactObject(
        value.request,
        ['actionRef', 'approvalRequestId', 'inspectionId'],
        'publisher revocation inspection request',
      );
      break;
    case 'plugin-package.publisher-trust-transition.propose':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'proposalAuditEventId',
          'approvalAuditEventId',
          'mode',
          'publisher',
          'keyId',
        ],
        'publisher trust transition proposal request',
      );
      break;
    case 'plugin-package.publisher-trust-transition.decide':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'expectedVersion',
          'decisionId',
          'auditEventId',
          'decision',
          'reasonCode',
        ],
        'publisher trust transition decision request',
      );
      break;
    case 'plugin-package.publisher-trust-transition.inspect':
      exactObject(
        value.request,
        ['actionRef', 'approvalRequestId', 'inspectionId'],
        'publisher trust transition inspection request',
      );
      break;
    case 'plugin-package.secret-binding.plan':
      exactObject(
        value.request,
        ['actionRef', 'assignments', 'packageName', 'projectId'],
        'Secret binding plan request',
      );
      if (!Array.isArray(value.request.assignments)) {
        throw new ClusterPluginPackageManagementTransportRequestError(
          'Secret binding assignments are invalid',
        );
      }
      for (const assignment of value.request.assignments) {
        exactObject(assignment, ['name', 'secretRef'], 'Secret binding assignment');
      }
      break;
    case 'plugin-package.secret-binding.propose':
      exactObject(
        value.request,
        ['actionRef', 'approvalAuditEventId', 'approvalRequestId'],
        'Secret binding proposal request',
      );
      break;
    case 'plugin-package.secret-binding.decide':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'expectedVersion',
          'decisionId',
          'auditEventId',
          'decision',
          'reasonCode',
        ],
        'Secret binding decision request',
      );
      break;
    case 'plugin-package.secret-binding.inspect':
      exactObject(
        value.request,
        ['actionRef', 'approvalRequestId', 'inspectionId'],
        'Secret binding inspection request',
      );
      break;
    default:
      throw new ClusterPluginPackageManagementTransportRequestError(
        'operation is not publicly available',
      );
  }
  return Object.freeze(
    value as unknown as ClusterPluginPackageManagementCommand,
  );
}

function proposalSummary(proposal: Readonly<PluginPackageInstallProposal>) {
  return Object.freeze({
    actionRef: proposal.actionRef,
    projectId: proposal.projectId,
    packageName: proposal.actionInput.manifest.metadata.name,
    packageVersion: proposal.actionInput.manifest.metadata.version,
    operation: proposal.actionInput.plan.operation,
    sourceKind: proposal.actionInput.source.kind,
    architecture: proposal.actionInput.architecture,
    deploymentProfile: proposal.actionInput.deploymentProfile,
    targetGeneration: proposal.actionInput.targetGeneration,
    actionDigest: proposal.actionDigest,
    previewDigest: proposal.previewDigest,
    proposalDigest: proposal.proposalDigest,
    createdAtMs: proposal.createdAtMs,
  });
}

function installationSummary(
  item: Readonly<PluginPackageInstallInventoryItem>,
) {
  const { record, quarantine } = item;
  return Object.freeze({
    installationId: record.installationId,
    projectId: record.projectId,
    packageName: record.packageName,
    packageVersion: record.packageVersion,
    operation: record.operation,
    state: record.state,
    targetGeneration: record.targetGeneration,
    activeLockDigest: record.activeLockDigest,
    previousActiveLockDigest: record.previousActiveLockDigest,
    recoveryAction: pluginPackageInstallRecoveryAction(record),
    availability: quarantine
      ? ('quarantined' as const)
      : record.state === 'active'
      ? ('active' as const)
      : ('not_active' as const),
    quarantineReason: quarantine?.reasonCode ?? null,
    quarantineAuthorizationMode: quarantine?.authorizationMode ?? null,
    quarantineEventDigest: quarantine?.eventDigest ?? null,
    quarantinedAtMs: quarantine?.occurredAtMs ?? null,
    withdrawalStatus: quarantine?.capabilityStatus ?? null,
    withdrawalReceiptDigest: quarantine?.receiptDigest ?? null,
    withdrawalCommittedAtMs: quarantine?.committedAtMs ?? null,
    failureReason: record.failure?.reason ?? null,
    failedFrom: record.failure?.failedFrom ?? null,
    failedAtMs: record.failure?.failedAtMs ?? null,
    version: record.version,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    recordDigest: record.recordDigest,
  });
}

function approvalSummary(approval: Readonly<ApprovalRequestRecord>) {
  return Object.freeze({
    id: approval.id,
    projectId: approval.projectId,
    version: approval.version,
    state: approval.state,
    risk: approval.risk,
    decisionMode: approval.decisionMode,
    requestedAtMs: approval.requestedAtMs,
    expiresAtMs: approval.expiresAtMs,
    decision: approval.decision,
    decisionReasonCode: approval.decisionReasonCode,
    decidedAtMs: approval.decidedAtMs,
    dispatchId: approval.dispatchId,
    consumedAtMs: approval.consumedAtMs,
    actionDigest: approval.action.actionDigest,
    previewDigest: approval.action.previewDigest,
  });
}

function lifecyclePlanSummary(
  plan: Readonly<PluginPackageLifecyclePlan>,
) {
  return Object.freeze({
    actionRef: plan.actionRef,
    planDigest: plan.planDigest,
    plannedAtMs: plan.plannedAtMs,
    expiresAtMs: plan.expiresAtMs,
    action: plan.impact.action,
    projectId: plan.impact.target.projectId,
    packageName: plan.impact.target.packageName,
    installationId: plan.impact.target.installationId,
    lockDigest: plan.impact.target.lockDigest,
    installVersion: plan.impact.target.installVersion,
    installRecordDigest: plan.impact.target.installRecordDigest,
    expected: plan.impact.expected,
    generationDigest: plan.impact.generationDigest,
    materializedRevisionDigest: plan.impact.materializedRevisionDigest,
    currentToolSnapshotDigest: plan.impact.currentToolSnapshotDigest,
    taskIds: plan.impact.taskIds,
    resourceCounts: plan.impact.resourceCounts,
    referenceGraphDigest: plan.impact.referenceGraphDigest,
    blockingReferences: plan.impact.blockingReferences,
    impactDigest: plan.impact.impactDigest,
  });
}

function secretBindingPlanSummary(
  plan: Readonly<PluginPackageSecretBindingApprovalPlan>,
) {
  return Object.freeze({
    actionRef: plan.actionRef,
    projectId: plan.bindingPlan.target.projectId,
    packageName: plan.bindingPlan.target.packageName,
    installationId: plan.bindingPlan.target.installationId,
    generation: plan.bindingPlan.target.generation,
    generationDigest: plan.bindingPlan.target.generationDigest,
    lockDigest: plan.bindingPlan.target.lockDigest,
    manifestDigest: plan.bindingPlan.target.manifestDigest,
    entries: plan.bindingPlan.entries,
    plannedAtMs: plan.bindingPlan.plannedAtMs,
    expiresAtMs: plan.expiresAtMs,
    planDigest: plan.bindingPlan.planDigest,
    approvalPlanDigest: plan.approvalPlanDigest,
  });
}

function publisherRevocationProposalSummary(
  proposal: NonNullable<
    InspectClusterPluginPackagePublisherRevocationResult['proposal']
  >,
) {
  return Object.freeze({
    actionRef: proposal.actionRef,
    projectId: proposal.projectId,
    trustAuthorityId: proposal.actionInput.trustAuthorityId,
    trustGeneration: proposal.actionInput.trustGeneration,
    publisher: proposal.actionInput.publisher,
    keyId: proposal.actionInput.keyId,
    previousTrustDigest: proposal.actionInput.previousTrustDigest,
    currentTrustDigest: proposal.actionInput.currentTrustDigest,
    authorizationMode: proposal.actionInput.authorizationMode,
    reasonCode: proposal.actionInput.reasonCode,
    actionDigest: proposal.actionDigest,
    previewDigest: proposal.previewDigest,
    proposalDigest: proposal.proposalDigest,
    createdAtMs: proposal.createdAtMs,
  });
}

function publisherTrustTransitionProposalSummary(
  proposal: NonNullable<
    InspectClusterPluginPackagePublisherTrustTransitionResult['proposal']
  >,
) {
  return Object.freeze({
    actionRef: proposal.actionRef,
    projectId: proposal.projectId,
    trustAuthorityId: proposal.actionInput.trustAuthorityId,
    trustGeneration: proposal.actionInput.trustGeneration,
    mode: proposal.actionInput.mode,
    publisher: proposal.actionInput.publisher,
    keyId: proposal.actionInput.keyId,
    previousTrustDigest: proposal.actionInput.previousTrustDigest,
    currentTrustDigest: proposal.actionInput.currentTrustDigest,
    actionDigest: proposal.actionDigest,
    previewDigest: proposal.previewDigest,
    proposalDigest: proposal.proposalDigest,
    createdAtMs: proposal.createdAtMs,
  });
}

function exactDecisionReplay(
  current: Readonly<{
    approvalRequest: Readonly<ApprovalRequestRecord> | null;
  }>,
  command: Readonly<
    | DecideClusterPluginPackageCommand
    | DecideClusterPluginPackageLifecycleCommand
    | DecideClusterPluginPackagePublisherRevocationCommand
    | DecideClusterPluginPackagePublisherTrustTransitionCommand
    | DecideClusterPluginPackageSecretBindingCommand
  >,
  principal: Readonly<SecurityPrincipal>,
): Readonly<DecideApprovalRequestResult> | null {
  const approval = current.approvalRequest;
  if (
    approval?.action.actionRef !== command.request.actionRef ||
    approval.decisionId !== command.request.decisionId ||
    approval.decision !== command.request.decision ||
    approval.decisionReasonCode !== command.request.reasonCode ||
    approval.decidedBy?.type !== principal.subject.type ||
    approval.decidedBy.id !== principal.subject.id
  ) {
    return null;
  }
  return Object.freeze({
    status: 'existing' as const,
    request: approval,
  });
}

export function createClusterPluginPackageManagementTransport(
  options: ClusterPluginPackageManagementTransportOptions,
): Readonly<ClusterPluginPackageManagementTransport> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'service' &&
        key !== 'lifecycle' &&
        key !== 'publisherTrust' &&
        key !== 'secretBinding' &&
        key !== 'now',
    ) ||
    !options.service ||
    typeof options.service.propose !== 'function' ||
    typeof options.service.decide !== 'function' ||
    typeof options.service.inspect !== 'function' ||
    typeof options.service.inspectAuthorized !== 'function' ||
    typeof options.service.inspectInstallationAuthorized !== 'function' ||
    typeof options.service.listInstallationsAuthorized !== 'function' ||
    (options.lifecycle !== undefined &&
      (!options.lifecycle ||
        typeof options.lifecycle.propose !== 'function' ||
        typeof options.lifecycle.decide !== 'function' ||
        typeof options.lifecycle.inspectAuthorized !== 'function')) ||
    (options.publisherTrust !== undefined &&
      (!options.publisherTrust ||
        typeof options.publisherTrust.propose !== 'function' ||
        typeof options.publisherTrust.inspect !== 'function' ||
        typeof options.publisherTrust.inspectAuthorized !== 'function')) ||
    (options.secretBinding !== undefined &&
      (!options.secretBinding ||
        typeof options.secretBinding.plan !== 'function' ||
        typeof options.secretBinding.propose !== 'function' ||
        typeof options.secretBinding.decide !== 'function' ||
        typeof options.secretBinding.inspectAuthorized !== 'function')) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterPluginPackageManagementTransportConfigurationError(
      'options are invalid',
    );
  }
  const now = options.now ?? Date.now;

  return Object.freeze({
    async execute(
      commandValue: unknown,
      authentication: ClusterPluginPackageManagementAuthentication,
    ): Promise<Readonly<ClusterPluginPackageManagementTransportResult>> {
      const command =
        normalizeClusterPluginPackageManagementCommand(commandValue);
      if (
        !authentication ||
        typeof authentication !== 'object' ||
        Array.isArray(authentication) ||
        Object.keys(authentication).some((key) => key !== 'authenticate') ||
        typeof authentication.authenticate !== 'function'
      ) {
        throw new ClusterPluginPackageManagementTransportConfigurationError(
          'authentication authority is invalid',
        );
      }
      let candidate: Readonly<SecurityPrincipal> | null;
      try {
        candidate = await authentication.authenticate();
      } catch (error) {
        throw new ClusterPluginPackageManagementTransportUnavailableError(
          error,
        );
      }
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new ClusterPluginPackageManagementTransportUnavailableError();
      }
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          candidate as SecurityPrincipal,
          observedAtMs,
        );
      } catch {
        throw new ClusterPluginPackageManagementTransportAuthenticationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_CLUSTER_ASSURANCES.has(principal.assurance)
      ) {
        throw new ClusterPluginPackageManagementTransportAuthenticationError();
      }

      switch (command.operation) {
        case 'plugin-package.propose': {
          const current = await options.service.inspect(
            command.request.actionRef,
            command.request.approvalRequestId,
          );
          const result: Readonly<ProposePluginPackageInstallResult> =
            await options.service.propose({
              ...command.request,
              requestedAtMs:
                current.approvalRequest?.requestedAtMs ??
                current.proposal?.createdAtMs ??
                observedAtMs,
              principal,
            });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            proposalStatus: result.proposalStatus,
            approvalStatus: result.approvalStatus,
            proposal: proposalSummary(result.proposal),
            approval: approvalSummary(result.approvalRequest),
          });
        }
        case 'plugin-package.decide': {
          const current = await options.service.inspect(
            command.request.actionRef,
            command.request.approvalRequestId,
          );
          const replay = exactDecisionReplay(current, command, principal);
          const result =
            replay ??
            (await options.service.decide({
              approvalRequestId: command.request.approvalRequestId,
              expectedVersion: command.request.expectedVersion,
              decisionId: command.request.decisionId,
              auditEventId: command.request.auditEventId,
              decision: command.request.decision,
              reasonCode: command.request.reasonCode,
              decidedAtMs: observedAtMs,
              principal,
            }));
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            approval: approvalSummary(result.request),
          });
        }
        case 'plugin-package.inspect': {
          const result = await options.service.inspectAuthorized({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            proposal: result.proposal ? proposalSummary(result.proposal) : null,
            approval: result.approvalRequest
              ? approvalSummary(result.approvalRequest)
              : null,
          });
        }
        case 'plugin-package.installation.inspect': {
          const record = await options.service.inspectInstallationAuthorized({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            installation: record ? installationSummary(record) : null,
          });
        }
        case 'plugin-package.installation.list': {
          const page = await options.service.listInstallationsAuthorized({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            installations: Object.freeze(page.items.map(installationSummary)),
            truncated: page.truncated,
            next: page.next ?? null,
          });
        }
        case 'plugin-package.lifecycle.propose': {
          if (!options.lifecycle) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'lifecycle management is not configured',
            );
          }
          const result = await options.lifecycle.propose({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            approvalStatus: result.approvalStatus,
            plan: lifecyclePlanSummary(result.plan),
            approval: approvalSummary(result.approvalRequest),
          });
        }
        case 'plugin-package.lifecycle.decide': {
          if (!options.lifecycle) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'lifecycle management is not configured',
            );
          }
          const result = await options.lifecycle.decide({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            approval: approvalSummary(result.request),
          });
        }
        case 'plugin-package.lifecycle.inspect': {
          if (!options.lifecycle) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'lifecycle management is not configured',
            );
          }
          const result = await options.lifecycle.inspectAuthorized({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            plan: result.plan ? lifecyclePlanSummary(result.plan) : null,
            approval: result.approvalRequest
              ? approvalSummary(result.approvalRequest)
              : null,
            stale: result.stale,
          });
        }
        case 'plugin-package.secret-binding.plan': {
          if (!options.secretBinding) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'Secret binding management is not configured',
            );
          }
          const result = await options.secretBinding.plan({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            plan: secretBindingPlanSummary(result.plan),
          });
        }
        case 'plugin-package.secret-binding.propose': {
          if (!options.secretBinding) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'Secret binding management is not configured',
            );
          }
          const result = await options.secretBinding.propose({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            approvalStatus: result.approvalStatus,
            plan: secretBindingPlanSummary(result.plan),
            approval: approvalSummary(result.approvalRequest),
          });
        }
        case 'plugin-package.secret-binding.decide': {
          if (!options.secretBinding) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'Secret binding management is not configured',
            );
          }
          const result = await options.secretBinding.decide({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            approval: approvalSummary(result.request),
          });
        }
        case 'plugin-package.secret-binding.inspect': {
          if (!options.secretBinding) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'Secret binding management is not configured',
            );
          }
          const result = await options.secretBinding.inspectAuthorized({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            plan: result.plan ? secretBindingPlanSummary(result.plan) : null,
            approval: result.approvalRequest
              ? approvalSummary(result.approvalRequest)
              : null,
            stale: result.stale,
          });
        }
        case 'plugin-package.publisher-revocation.propose': {
          if (!options.publisherTrust) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'publisher trust management is not configured',
            );
          }
          const current = await options.publisherTrust.inspect(
            command.request.actionRef,
            command.request.approvalRequestId,
          );
          const result = await options.publisherTrust.propose({
            ...command.request,
            requestedAtMs:
              current.approvalRequest?.requestedAtMs ??
              current.proposal?.createdAtMs ??
              observedAtMs,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            proposalStatus: result.proposalStatus,
            approvalStatus: result.approvalStatus,
            proposal: publisherRevocationProposalSummary(result.proposal),
            approval: approvalSummary(result.approvalRequest),
          });
        }
        case 'plugin-package.publisher-revocation.decide': {
          if (!options.publisherTrust) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'publisher trust management is not configured',
            );
          }
          const current = await options.publisherTrust.inspect(
            command.request.actionRef,
            command.request.approvalRequestId,
          );
          if (
            !current.proposal ||
            !current.approvalRequest ||
            current.proposal.actionRef !==
              current.approvalRequest.action.actionRef ||
            current.proposal.actionDigest !==
              current.approvalRequest.action.actionDigest ||
            current.proposal.previewDigest !==
              current.approvalRequest.action.previewDigest
          ) {
            throw new ClusterPluginPackageManagementTransportRequestError(
              'publisher revocation authority does not match',
            );
          }
          if (
            current.proposal.actionInput.authorizationMode === 'break_glass' &&
            principal.assurance !== 'hardware'
          ) {
            throw new ClusterPluginPackageManagementTransportAuthenticationError();
          }
          const replay = exactDecisionReplay(current, command, principal);
          const result =
            replay ??
            (await options.service.decide({
              approvalRequestId: command.request.approvalRequestId,
              expectedVersion: command.request.expectedVersion,
              decisionId: command.request.decisionId,
              auditEventId: command.request.auditEventId,
              decision: command.request.decision,
              reasonCode: command.request.reasonCode,
              decidedAtMs: observedAtMs,
              principal,
            }));
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            approval: approvalSummary(result.request),
          });
        }
        case 'plugin-package.publisher-revocation.inspect': {
          if (!options.publisherTrust) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'publisher trust management is not configured',
            );
          }
          const result = await options.publisherTrust.inspectAuthorized({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            proposal: result.proposal
              ? publisherRevocationProposalSummary(result.proposal)
              : null,
            approval: result.approvalRequest
              ? approvalSummary(result.approvalRequest)
              : null,
          });
        }
        case 'plugin-package.publisher-trust-transition.propose': {
          if (
            !options.publisherTrust ||
            typeof options.publisherTrust.proposeTransition !== 'function' ||
            typeof options.publisherTrust.inspectTransition !== 'function'
          ) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'publisher trust management is not configured',
            );
          }
          const current = await options.publisherTrust.inspectTransition(
            command.request.actionRef,
            command.request.approvalRequestId,
          );
          const result = await options.publisherTrust.proposeTransition({
            ...command.request,
            requestedAtMs:
              current.approvalRequest?.requestedAtMs ??
              current.proposal?.createdAtMs ??
              observedAtMs,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            proposalStatus: result.proposalStatus,
            approvalStatus: result.approvalStatus,
            proposal: publisherTrustTransitionProposalSummary(result.proposal),
            approval: approvalSummary(result.approvalRequest),
          });
        }
        case 'plugin-package.publisher-trust-transition.decide': {
          if (
            !options.publisherTrust ||
            typeof options.publisherTrust.inspectTransition !== 'function'
          ) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'publisher trust management is not configured',
            );
          }
          const current = await options.publisherTrust.inspectTransition(
            command.request.actionRef,
            command.request.approvalRequestId,
          );
          if (
            !current.proposal ||
            !current.approvalRequest ||
            current.approvalRequest.decisionMode !== 'separation_of_duty' ||
            current.proposal.actionRef !==
              current.approvalRequest.action.actionRef ||
            current.proposal.actionDigest !==
              current.approvalRequest.action.actionDigest ||
            current.proposal.previewDigest !==
              current.approvalRequest.action.previewDigest
          ) {
            throw new ClusterPluginPackageManagementTransportRequestError(
              'publisher trust transition authority does not match',
            );
          }
          const replay = exactDecisionReplay(current, command, principal);
          const result =
            replay ??
            (await options.service.decide({
              approvalRequestId: command.request.approvalRequestId,
              expectedVersion: command.request.expectedVersion,
              decisionId: command.request.decisionId,
              auditEventId: command.request.auditEventId,
              decision: command.request.decision,
              reasonCode: command.request.reasonCode,
              decidedAtMs: observedAtMs,
              principal,
            }));
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            approval: approvalSummary(result.request),
          });
        }
        case 'plugin-package.publisher-trust-transition.inspect': {
          if (
            !options.publisherTrust ||
            typeof options.publisherTrust.inspectTransitionAuthorized !==
              'function'
          ) {
            throw new ClusterPluginPackageManagementTransportConfigurationError(
              'publisher trust management is not configured',
            );
          }
          const result =
            await options.publisherTrust.inspectTransitionAuthorized({
              ...command.request,
              principal,
            });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            proposal: result.proposal
              ? publisherTrustTransitionProposalSummary(result.proposal)
              : null,
            approval: result.approvalRequest
              ? approvalSummary(result.approvalRequest)
              : null,
          });
        }
      }
    },
  });
}
