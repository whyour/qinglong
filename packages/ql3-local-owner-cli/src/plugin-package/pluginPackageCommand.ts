// Plugin Package owns its authenticated lifecycle command surface.
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from '@qinglong/local-command-file';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import {
  openLocalSqlitePluginPackageManagementDatabase,
  type LocalSqlitePluginPackageManagementDatabase,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/package-management';
import type {
  ApprovalRequestRecord,
  ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import type { ApprovedActionDispatchBatchSummary } from '@qinglong/runtime-core/approved-action-dispatcher';
import {
  normalizePluginPackageLifecycleImpact,
  type PluginPackageLifecycleAction,
  type PluginPackageLifecycleImpact,
  type PluginPackageLifecycleReceipt,
} from '@qinglong/runtime-core/plugin-package-lifecycle';
import {
  normalizePluginPackageSecretBindingPlan,
  type PluginPackageSecretBindingPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-plan';
import {
  pluginPackageInstallRecoveryAction,
  type PluginPackageInstallActionInput,
  type PluginPackageInstallInventoryItem,
} from '@qinglong/runtime-core/plugin-package-install';
import type { PluginPackageInstallProposal } from '@qinglong/runtime-core/plugin-package-proposal';

import { createLocalPluginPackageManagementService } from '@qinglong/local-admin/package-management';
import { createLocalPluginPackageLifecycleService } from '@qinglong/local-admin/package-lifecycle';
import { createLocalPluginPackageSecretBindingService } from '@qinglong/local-admin/package-secret-binding';

const MAX_PATH_BYTES = 4096;
const MAX_DISPATCH_LIMIT = 64;
const LOCAL_INSTALLATION_INVENTORY_LIMITS = Object.freeze({
  edge: 16,
  standalone: 64,
});
const LOCAL_INSTALLATION_INVENTORY_DEFAULTS = Object.freeze({
  edge: 8,
  standalone: 32,
});
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMMAND_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const LOCAL_PACKAGE_CONSUMER = Object.freeze({
  subject: Object.freeze({
    type: 'system' as const,
    id: 'local_plugin_package_consumer',
  }),
  authenticationId: 'local_plugin_package_consumer_v1',
});

export interface LocalPluginPackageCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: LocalSqliteProfile;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface ProposeLocalPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.propose';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly proposalAuditEventId: string;
    readonly approvalAuditEventId: string;
    readonly actionInput: PluginPackageInstallActionInput;
  };
}

export interface DecideLocalPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.decide';
  readonly options: LocalPluginPackageCommandOptions;
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

export interface ConsumeLocalPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.consume';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
    readonly expectedVersion: number;
    readonly consumptionId: string;
    readonly dispatchId: string;
    readonly auditEventId: string;
  };
}

export interface InspectLocalPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.inspect';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly actionRef: string;
    readonly approvalRequestId: string;
  };
}

export interface InspectLocalPluginPackageInstallationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.installation.inspect';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly projectId: string;
    readonly packageName: string;
  };
}

export interface ListLocalPluginPackageInstallationsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.installation.list';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly projectId: string;
    readonly limit?: number;
    readonly after?: Readonly<{ packageName: string }>;
  };
}

export interface DispatchLocalPluginPackageCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.dispatch';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly limit?: number;
  };
}

export interface PlanLocalPluginPackageLifecycleCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.lifecycle.plan';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly action: PluginPackageLifecycleAction;
    readonly projectId: string;
    readonly packageName: string;
  };
}

export interface ExecuteLocalPluginPackageLifecycleCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.lifecycle.execute';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly impact: PluginPackageLifecycleImpact;
    readonly approvalRequestId: string;
    readonly decisionId: string;
    readonly consumptionId: string;
    readonly dispatchId: string;
    readonly approvalAuditEventId: string;
    readonly decisionAuditEventId: string;
    readonly consumptionAuditEventId: string;
    readonly reasonCode: string;
  };
}

export interface PlanLocalPluginPackageSecretBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.secret-binding.plan';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly projectId: string;
    readonly packageName: string;
    readonly assignments: readonly Readonly<{
      name: string;
      secretRef: string | null;
    }>[];
  };
}

export interface ExecuteLocalPluginPackageSecretBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.secret-binding.execute';
  readonly options: LocalPluginPackageCommandOptions;
  readonly request: {
    readonly plan: PluginPackageSecretBindingPlan;
    readonly auditEventId: string;
  };
}

export type LocalPluginPackageCommand =
  | ProposeLocalPluginPackageCommand
  | DecideLocalPluginPackageCommand
  | ConsumeLocalPluginPackageCommand
  | InspectLocalPluginPackageCommand
  | InspectLocalPluginPackageInstallationCommand
  | ListLocalPluginPackageInstallationsCommand
  | DispatchLocalPluginPackageCommand
  | PlanLocalPluginPackageLifecycleCommand
  | ExecuteLocalPluginPackageLifecycleCommand
  | PlanLocalPluginPackageSecretBindingCommand
  | ExecuteLocalPluginPackageSecretBindingCommand;

export interface LocalPluginPackageCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<Readonly<LocalPluginPackageCommandResult>>;
}

export type LocalPluginPackageCommandResult =
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
      operation: 'plugin-package.consume';
      status: 'consumed' | 'existing';
      approval: ReturnType<typeof approvalSummary>;
      dispatch: ReturnType<typeof dispatchSummary>;
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
      operation: 'plugin-package.dispatch';
      summary: Readonly<ApprovedActionDispatchBatchSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.lifecycle.plan';
      impact: Readonly<PluginPackageLifecycleImpact>;
      summary: ReturnType<typeof lifecycleImpactSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.lifecycle.execute';
      status: 'created' | 'existing';
      approval: ReturnType<typeof approvalSummary>;
      receipt: ReturnType<typeof lifecycleReceiptSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.secret-binding.plan';
      plan: Readonly<PluginPackageSecretBindingPlan>;
      summary: ReturnType<typeof secretBindingPlanSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.secret-binding.execute';
      status: 'created' | 'existing';
      bindingDigest: string;
      generationDigest: string;
    }>;

export class LocalPluginPackageCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Plugin Package command configuration is invalid: ${message}`);
    this.name = 'LocalPluginPackageCommandConfigurationError';
  }
}

interface LocalPluginPackageCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqlitePluginPackageManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPluginPackageCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalPluginPackageCommandConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalPluginPackageCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function options(value: unknown): LocalPluginPackageCommandOptions {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  exactObject(
    value,
    [
      'deploymentRoot',
      'databasePath',
      'profile',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  for (const key of [
    'deploymentRoot',
    'databasePath',
    'ownerPepperKeyringDirectory',
    'credentialFilePath',
  ] as const) {
    boundedPath(value[key], key);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalPluginPackageCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalPluginPackageCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze(value as unknown as LocalPluginPackageCommandOptions);
}

function normalizeCommand(value: unknown): Readonly<LocalPluginPackageCommand> {
  exactObject(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    'command',
  );
  if (value.schemaVersion !== 1) {
    throw new LocalPluginPackageCommandConfigurationError(
      'schemaVersion is invalid',
    );
  }
  const commandOptions = options(value.options);
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
    case 'plugin-package.consume':
      exactObject(
        value.request,
        [
          'actionRef',
          'approvalRequestId',
          'expectedVersion',
          'consumptionId',
          'dispatchId',
          'auditEventId',
        ],
        'consumption request',
      );
      break;
    case 'plugin-package.inspect':
      exactObject(
        value.request,
        ['actionRef', 'approvalRequestId'],
        'inspection request',
      );
      break;
    case 'plugin-package.installation.inspect':
      exactObject(
        value.request,
        ['packageName', 'projectId'],
        'installation inspection request',
      );
      if (
        typeof value.request.projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(value.request.projectId) ||
        typeof value.request.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(value.request.packageName)
      ) {
        throw new LocalPluginPackageCommandConfigurationError(
          'installation inspection identity is invalid',
        );
      }
      break;
    case 'plugin-package.installation.list': {
      const request =
        value.request && typeof value.request === 'object'
          ? (value.request as Record<string, unknown>)
          : {};
      const hasLimit = Object.hasOwn(request, 'limit');
      const hasAfter = Object.hasOwn(request, 'after');
      exactObject(
        value.request,
        [
          'projectId',
          ...(hasLimit ? ['limit'] : []),
          ...(hasAfter ? ['after'] : []),
        ],
        'installation list request',
      );
      if (
        typeof request.projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(request.projectId) ||
        (request.limit !== undefined &&
          (!Number.isSafeInteger(request.limit) ||
            (request.limit as number) < 1 ||
            (request.limit as number) >
              LOCAL_INSTALLATION_INVENTORY_LIMITS[commandOptions.profile]))
      ) {
        throw new LocalPluginPackageCommandConfigurationError(
          'installation list request is invalid',
        );
      }
      if (request.after !== undefined) {
        exactObject(request.after, ['packageName'], 'installation list cursor');
        if (
          typeof request.after.packageName !== 'string' ||
          !PACKAGE_NAME_PATTERN.test(request.after.packageName)
        ) {
          throw new LocalPluginPackageCommandConfigurationError(
            'installation list cursor is invalid',
          );
        }
      }
      break;
    }
    case 'plugin-package.dispatch': {
      const hasLimit =
        !!value.request &&
        typeof value.request === 'object' &&
        !Array.isArray(value.request) &&
        Object.hasOwn(value.request, 'limit');
      exactObject(value.request, hasLimit ? ['limit'] : [], 'dispatch request');
      if (
        (value.request as { limit?: unknown }).limit !== undefined &&
        (!Number.isSafeInteger((value.request as { limit?: unknown }).limit) ||
          ((value.request as { limit?: number }).limit as number) < 1 ||
          ((value.request as { limit?: number }).limit as number) >
            MAX_DISPATCH_LIMIT)
      ) {
        throw new LocalPluginPackageCommandConfigurationError(
          'dispatch limit is invalid',
        );
      }
      break;
    }
    case 'plugin-package.lifecycle.plan':
      exactObject(
        value.request,
        ['action', 'packageName', 'projectId'],
        'lifecycle plan request',
      );
      if (
        (value.request.action !== 'disable' &&
          value.request.action !== 'enable' &&
          value.request.action !== 'uninstall') ||
        typeof value.request.projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(value.request.projectId) ||
        typeof value.request.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(value.request.packageName)
      ) {
        throw new LocalPluginPackageCommandConfigurationError(
          'lifecycle plan request is invalid',
        );
      }
      break;
    case 'plugin-package.lifecycle.execute':
      exactObject(
        value.request,
        [
          'approvalAuditEventId',
          'approvalRequestId',
          'consumptionAuditEventId',
          'consumptionId',
          'decisionAuditEventId',
          'decisionId',
          'dispatchId',
          'impact',
          'reasonCode',
        ],
        'lifecycle execution request',
      );
      try {
        normalizePluginPackageLifecycleImpact(
          value.request.impact as PluginPackageLifecycleImpact,
        );
      } catch (error) {
        throw new LocalPluginPackageCommandConfigurationError(
          'lifecycle impact is invalid',
          error,
        );
      }
      if (
        [
          value.request.approvalRequestId,
          value.request.decisionId,
          value.request.consumptionId,
          value.request.dispatchId,
          value.request.approvalAuditEventId,
          value.request.decisionAuditEventId,
          value.request.consumptionAuditEventId,
        ].some(
          (candidate) =>
            typeof candidate !== 'string' ||
            !COMMAND_IDENTIFIER_PATTERN.test(candidate),
        ) ||
        typeof value.request.reasonCode !== 'string' ||
        !REASON_CODE_PATTERN.test(value.request.reasonCode)
      ) {
        throw new LocalPluginPackageCommandConfigurationError(
          'lifecycle execution identity is invalid',
        );
      }
      break;
    case 'plugin-package.secret-binding.plan':
      exactObject(
        value.request,
        ['assignments', 'packageName', 'projectId'],
        'Secret binding plan request',
      );
      if (
        typeof value.request.projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(value.request.projectId) ||
        typeof value.request.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(value.request.packageName) ||
        !Array.isArray(value.request.assignments) ||
        value.request.assignments.length < 1 ||
        value.request.assignments.length > 64
      ) {
        throw new LocalPluginPackageCommandConfigurationError(
          'Secret binding plan request is invalid',
        );
      }
      for (const assignment of value.request.assignments) {
        exactObject(assignment, ['name', 'secretRef'], 'Secret assignment');
        if (
          typeof assignment.name !== 'string' ||
          !/^[A-Z_][A-Z0-9_]{0,127}$/.test(assignment.name) ||
          (assignment.secretRef !== null &&
            (typeof assignment.secretRef !== 'string' ||
              Buffer.byteLength(assignment.secretRef, 'utf8') > 512))
        ) {
          throw new LocalPluginPackageCommandConfigurationError(
            'Secret assignment is invalid',
          );
        }
      }
      break;
    case 'plugin-package.secret-binding.execute':
      exactObject(
        value.request,
        ['auditEventId', 'plan'],
        'Secret binding execution request',
      );
      if (
        typeof value.request.auditEventId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value.request.auditEventId,
        )
      ) {
        throw new LocalPluginPackageCommandConfigurationError(
          'Secret binding audit event ID is invalid',
        );
      }
      try {
        normalizePluginPackageSecretBindingPlan(value.request.plan);
      } catch (error) {
        throw new LocalPluginPackageCommandConfigurationError(
          'Secret binding plan is invalid',
          error,
        );
      }
      break;
    default:
      throw new LocalPluginPackageCommandConfigurationError(
        'operation is invalid',
      );
  }
  return Object.freeze({
    ...value,
    options: commandOptions,
  } as unknown as LocalPluginPackageCommand);
}

function readCommandFile(
  commandFilePath: string,
): Readonly<LocalPluginPackageCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (error instanceof LocalPluginPackageCommandConfigurationError) {
      throw error;
    }
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalPluginPackageCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw error;
  }
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

function dispatchSummary(dispatch: Readonly<ApprovedActionDispatchRecord>) {
  return Object.freeze({
    id: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    projectId: dispatch.projectId,
    actionRef: dispatch.action.actionRef,
    actionDigest: dispatch.action.actionDigest,
    createdAtMs: dispatch.createdAtMs,
    expiresAtMs: dispatch.expiresAtMs,
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

function lifecycleImpactSummary(
  impact: Readonly<PluginPackageLifecycleImpact>,
) {
  return Object.freeze({
    action: impact.action,
    projectId: impact.target.projectId,
    packageName: impact.target.packageName,
    installationId: impact.target.installationId,
    lockDigest: impact.target.lockDigest,
    installVersion: impact.target.installVersion,
    installRecordDigest: impact.target.installRecordDigest,
    expectedVersion: impact.expected.version,
    expectedDisposition: impact.expected.disposition,
    expectedEventDigest: impact.expected.eventDigest,
    generationDigest: impact.generationDigest,
    materializedRevisionDigest: impact.materializedRevisionDigest,
    currentToolSnapshotDigest: impact.currentToolSnapshotDigest,
    taskIds: impact.taskIds,
    resourceCounts: impact.resourceCounts,
    referenceGraphDigest: impact.referenceGraphDigest,
    blockingReferences: impact.blockingReferences,
    impactDigest: impact.impactDigest,
  });
}

function lifecycleReceiptSummary(
  receipt: Readonly<PluginPackageLifecycleReceipt>,
) {
  return Object.freeze({
    eventDigest: receipt.eventDigest,
    action: receipt.action,
    projectId: receipt.target.projectId,
    packageName: receipt.target.packageName,
    installationId: receipt.target.installationId,
    lockDigest: receipt.target.lockDigest,
    lifecycleVersion: receipt.lifecycle.version,
    disposition: receipt.lifecycle.disposition,
    capabilityStatus: receipt.capability.status,
    taskTransitions: receipt.capability.taskTransitions.length,
    previousActiveVectorDigest: receipt.capability.previousActiveVectorDigest,
    currentActiveVectorDigest: receipt.capability.currentActiveVectorDigest,
    currentToolSnapshotDigest: receipt.capability.currentToolSnapshotDigest,
    retainedSourceCount: receipt.capability.retainedSourceCount,
    committedAtMs: receipt.committedAtMs,
    receiptDigest: receipt.receiptDigest,
  });
}

function secretBindingPlanSummary(
  plan: Readonly<PluginPackageSecretBindingPlan>,
) {
  return Object.freeze({
    projectId: plan.target.projectId,
    packageName: plan.target.packageName,
    installationId: plan.target.installationId,
    generation: plan.target.generation,
    generationDigest: plan.target.generationDigest,
    manifestDigest: plan.target.manifestDigest,
    assignments: Object.freeze(
      plan.entries.map((entry) =>
        Object.freeze({
          name: entry.name,
          required: entry.required,
          bound: entry.secretRef !== null,
          secretRef: entry.secretRef,
        }),
      ),
    ),
    plannedAtMs: plan.plannedAtMs,
    planDigest: plan.planDigest,
  });
}

async function execute(
  command: Readonly<LocalPluginPackageCommand>,
  database: LocalSqlitePluginPackageManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<Readonly<LocalPluginPackageCommandResult>> {
  await authenticated.confirm();
  if (command.operation === 'plugin-package.secret-binding.plan') {
    const service = createLocalPluginPackageSecretBindingService(
      database.authority,
    );
    const plan = await service.plan({
      ...command.request,
      principal: authenticated.principal,
      plannedAtMs: Date.now(),
    });
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      plan,
      summary: secretBindingPlanSummary(plan),
    });
  }
  if (command.operation === 'plugin-package.secret-binding.execute') {
    const service = createLocalPluginPackageSecretBindingService(
      database.authority,
    );
    const result = await service.execute({
      ...command.request,
      principal: authenticated.principal,
      confirmAuthorization: authenticated.confirm,
    });
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      ...result,
    });
  }
  if (command.operation === 'plugin-package.lifecycle.plan') {
    const service = createLocalPluginPackageLifecycleService({
      authority: database.authority,
    });
    const impact = await service.plan(
      command.request.action,
      command.request.projectId,
      command.request.packageName,
      authenticated.principal,
    );
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      impact,
      summary: lifecycleImpactSummary(impact),
    });
  }
  if (command.operation === 'plugin-package.lifecycle.execute') {
    const service = createLocalPluginPackageLifecycleService({
      authority: database.authority,
    });
    const result = await service.execute({
      ...command.request,
      principal: authenticated.principal,
      confirmAuthorization: authenticated.confirm,
    });
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: result.status,
      approval: approvalSummary(result.approval),
      receipt: lifecycleReceiptSummary(result.receipt),
    });
  }
  if (command.operation === 'plugin-package.installation.inspect') {
    const { LocalSqlitePluginPackageInstallRepository } = await import(
      '@qinglong/local-sqlite/plugin-package-install'
    );
    const repository = new LocalSqlitePluginPackageInstallRepository(
      database.authority,
    );
    const item = await repository.findCurrent(
      command.request.projectId,
      command.request.packageName,
    );
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      installation: item ? installationSummary(item) : null,
    });
  }
  if (command.operation === 'plugin-package.installation.list') {
    const { LocalSqlitePluginPackageInstallRepository } = await import(
      '@qinglong/local-sqlite/plugin-package-install'
    );
    const repository = new LocalSqlitePluginPackageInstallRepository(
      database.authority,
    );
    const page = await repository.listCurrentPage({
      projectId: command.request.projectId,
      limit:
        command.request.limit ??
        LOCAL_INSTALLATION_INVENTORY_DEFAULTS[command.options.profile],
      ...(command.request.after === undefined
        ? {}
        : { after: command.request.after }),
    });
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      installations: Object.freeze(page.items.map(installationSummary)),
      truncated: page.truncated,
      next: page.next ?? null,
    });
  }
  const service = createLocalPluginPackageManagementService({
    authority: database.authority,
    profile: command.options.profile,
    consumer: LOCAL_PACKAGE_CONSUMER,
    dispatcher: {
      owner: 'local_plugin_package_dispatcher',
      defaultBatchSize: 4,
      createId: randomUUID,
    },
  });
  switch (command.operation) {
    case 'plugin-package.propose': {
      const current = await service.inspect(
        command.request.actionRef,
        command.request.approvalRequestId,
      );
      const result = await service.propose({
        ...command.request,
        requestedAtMs:
          current.approvalRequest?.requestedAtMs ??
          current.proposal?.createdAtMs ??
          Date.now(),
        principal: authenticated.principal,
      });
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        proposalStatus: result.proposalStatus,
        approvalStatus: result.approvalStatus,
        proposal: proposalSummary(result.proposal),
        approval: approvalSummary(result.approvalRequest),
      });
    }
    case 'plugin-package.decide': {
      const { actionRef, ...decisionRequest } = command.request;
      const current = await service.inspect(
        actionRef,
        command.request.approvalRequestId,
      );
      if (
        current.approvalRequest?.action.actionRef === actionRef &&
        current.approvalRequest.decisionId === command.request.decisionId &&
        current.approvalRequest.decision === command.request.decision &&
        current.approvalRequest.decisionReasonCode ===
          command.request.reasonCode &&
        current.approvalRequest.decidedBy?.type ===
          authenticated.principal.subject.type &&
        current.approvalRequest.decidedBy.id ===
          authenticated.principal.subject.id
      ) {
        return Object.freeze({
          schemaVersion: 1,
          operation: command.operation,
          status: 'existing',
          approval: approvalSummary(current.approvalRequest),
        });
      }
      const result = await service.decide({
        ...decisionRequest,
        decidedAtMs: Date.now(),
        principal: authenticated.principal,
      });
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        status: result.status,
        approval: approvalSummary(result.request),
      });
    }
    case 'plugin-package.consume': {
      const { actionRef, ...consumptionRequest } = command.request;
      const current = await service.inspect(
        actionRef,
        command.request.approvalRequestId,
      );
      const result = await service.consume({
        ...consumptionRequest,
        consumedAtMs:
          current.approvalRequest?.consumptionId ===
            command.request.consumptionId &&
          current.approvalRequest.dispatchId === command.request.dispatchId &&
          current.approvalRequest.consumedAtMs !== null
            ? current.approvalRequest.consumedAtMs
            : Date.now(),
      });
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        status: result.status,
        approval: approvalSummary(result.request),
        dispatch: dispatchSummary(result.dispatch),
      });
    }
    case 'plugin-package.inspect': {
      const result = await service.inspect(
        command.request.actionRef,
        command.request.approvalRequestId,
      );
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        proposal: result.proposal ? proposalSummary(result.proposal) : null,
        approval: result.approvalRequest
          ? approvalSummary(result.approvalRequest)
          : null,
      });
    }
    case 'plugin-package.dispatch': {
      const result = await service.dispatch(command.request.limit);
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        summary: result,
      });
    }
  }
}

function dependencies(
  value: LocalPluginPackageCommandRunnerDependencies,
): Readonly<LocalPluginPackageCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function'
  ) {
    throw new LocalPluginPackageCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function createLocalPluginPackageCommandRunner(
  candidateDependencies: LocalPluginPackageCommandRunnerDependencies = {
    openDatabase: openLocalSqlitePluginPackageManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
  },
): LocalPluginPackageCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      const database = await adapters.openDatabase({
        databasePath: command.options.databasePath,
        profile: command.options.profile,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      });
      try {
        const authenticated = await adapters.authenticate(database, {
          deploymentRoot: command.options.deploymentRoot,
          databasePath: command.options.databasePath,
          ownerPepperKeyringDirectory:
            command.options.ownerPepperKeyringDirectory,
          credentialFilePath: command.options.credentialFilePath,
          authenticationNamespace: 'local_package',
        });
        return await execute(command, database, authenticated);
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalPluginPackageCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalPluginPackageCommandResult>> {
  return createLocalPluginPackageCommandRunner().run(commandFilePath);
}
