import { createHash } from 'node:crypto';

import {
  normalizeApprovedActionDispatchRecord,
  normalizeApprovedActionFence,
  type ApprovedActionDispatchRecord,
} from '../approved-action/approvedAction';
import {
  createPluginPackageLock,
  normalizePluginPackageInstallActionInput,
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  type PluginPackageInstallActionInput,
  type PluginPackageLock,
} from './installation/pluginPackageInstall';
import {
  normalizeProjectPolicySubject,
} from '../security/project-policy/projectPolicy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '../security/security';
import type { SecurityAuditRecord } from '../security/audit/securityAudit';

export const PLUGIN_PACKAGE_INSTALL_PROPOSAL_SCHEMA =
  'qinglong/plugin-package-install-proposal@v1' as const;
export const PLUGIN_PACKAGE_INSTALL_ACTION_TYPE =
  'plugin_package.install' as const;
export const PLUGIN_PACKAGE_INSTALL_PERMISSION = 'package.manage' as const;

export interface PluginPackageInstallProposal {
  readonly schema: typeof PLUGIN_PACKAGE_INSTALL_PROPOSAL_SCHEMA;
  readonly actionRef: string;
  readonly projectId: string;
  readonly actionType: typeof PLUGIN_PACKAGE_INSTALL_ACTION_TYPE;
  readonly permission: typeof PLUGIN_PACKAGE_INSTALL_PERMISSION;
  readonly actionInput: Readonly<PluginPackageInstallActionInput>;
  readonly actionDigest: string;
  readonly previewDigest: string;
  readonly proposedBy: Readonly<SecuritySubject>;
  readonly proposalFence: Readonly<SecurityPolicyFence>;
  readonly createdAtMs: number;
  readonly proposalDigest: string;
}

export interface CreatePluginPackageInstallProposalInput {
  readonly actionRef: string;
  readonly actionInput: PluginPackageInstallActionInput;
  readonly proposedBy: SecuritySubject;
  readonly proposalFence: SecurityPolicyFence;
  readonly createdAtMs: number;
}

export interface PluginPackageInstallProposalRepository {
  findProposalByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackageInstallProposal> | null>;
  createProposal(
    command: CreatePluginPackageInstallProposalCommand,
  ): Promise<Readonly<CreatePluginPackageInstallProposalResult>>;
}

export interface CreatePluginPackageInstallProposalCommand {
  readonly proposal: PluginPackageInstallProposal;
  readonly audit: SecurityAuditRecord;
}

export interface CreatePluginPackageInstallProposalResult {
  readonly status: 'created' | 'existing';
  readonly proposal: Readonly<PluginPackageInstallProposal>;
}

export class InvalidPluginPackageInstallProposalError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_PROPOSAL_INVALID';

  constructor(message: string) {
    super(`Plugin Package install proposal is invalid: ${message}`);
    this.name = 'InvalidPluginPackageInstallProposalError';
  }
}

export class PluginPackageInstallProposalBindingConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_PROPOSAL_BINDING_CONFLICT';

  constructor() {
    super('Plugin Package install proposal does not match its dispatch');
    this.name = 'PluginPackageInstallProposalBindingConflictError';
  }
}

export class PluginPackageInstallProposalConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_PROPOSAL_CONFLICT';

  constructor() {
    super('Plugin Package install proposal conflicts with durable authority');
    this.name = 'PluginPackageInstallProposalConflictError';
  }
}

export class PluginPackageInstallProposalUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_PROPOSAL_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package install proposal authority is unavailable', options);
    this.name = 'PluginPackageInstallProposalUnavailableError';
  }
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageInstallProposalError(
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidPluginPackageInstallProposalError(
      `${label} shape is invalid`,
    );
  }
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new InvalidPluginPackageInstallProposalError(
      'action reference is invalid',
    );
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidPluginPackageInstallProposalError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidPluginPackageInstallProposalError(`${label} is invalid`);
  }
  return value as number;
}

function contractDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function withoutProposalDigest(
  value: Omit<PluginPackageInstallProposal, 'proposalDigest'>,
): Omit<PluginPackageInstallProposal, 'proposalDigest'> {
  return Object.freeze(value);
}

function withProposalDigest(
  value: Omit<PluginPackageInstallProposal, 'proposalDigest'>,
): Readonly<PluginPackageInstallProposal> {
  const normalized = withoutProposalDigest(value);
  return Object.freeze({
    ...normalized,
    proposalDigest: contractDigest(
      'qinglong/plugin-package-install-proposal-digest@v1',
      normalized,
    ),
  });
}

export function createPluginPackageInstallProposal(
  inputValue: CreatePluginPackageInstallProposalInput,
): Readonly<PluginPackageInstallProposal> {
  const input = dataRecord(inputValue, 'proposal input');
  exactKeys(
    input,
    [
      'actionRef',
      'actionInput',
      'proposedBy',
      'proposalFence',
      'createdAtMs',
    ],
    'proposal input',
  );
  const actionInput = normalizePluginPackageInstallActionInput(
    inputValue.actionInput,
  );
  const proposedBy = normalizeProjectPolicySubject(inputValue.proposedBy);
  return withProposalDigest({
    schema: PLUGIN_PACKAGE_INSTALL_PROPOSAL_SCHEMA,
    actionRef: actionRef(inputValue.actionRef),
    projectId: actionInput.projectId,
    actionType: PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
    permission: PLUGIN_PACKAGE_INSTALL_PERMISSION,
    actionInput,
    actionDigest: pluginPackageInstallActionDigest(actionInput),
    previewDigest: pluginPackageInstallPlanDigest(actionInput.plan),
    proposedBy,
    proposalFence: normalizeApprovedActionFence(inputValue.proposalFence),
    createdAtMs: timestamp(inputValue.createdAtMs, 'creation time'),
  });
}

export function normalizePluginPackageInstallProposal(
  value: PluginPackageInstallProposal,
): Readonly<PluginPackageInstallProposal> {
  const proposal = dataRecord(value, 'proposal');
  exactKeys(
    proposal,
    [
      'schema',
      'actionRef',
      'projectId',
      'actionType',
      'permission',
      'actionInput',
      'actionDigest',
      'previewDigest',
      'proposedBy',
      'proposalFence',
      'createdAtMs',
      'proposalDigest',
    ],
    'proposal',
  );
  if (
    value.schema !== PLUGIN_PACKAGE_INSTALL_PROPOSAL_SCHEMA ||
    value.actionType !== PLUGIN_PACKAGE_INSTALL_ACTION_TYPE ||
    value.permission !== PLUGIN_PACKAGE_INSTALL_PERMISSION
  ) {
    throw new InvalidPluginPackageInstallProposalError(
      'schema or action authority is invalid',
    );
  }
  const normalized = createPluginPackageInstallProposal({
    actionRef: actionRef(value.actionRef),
    actionInput: value.actionInput,
    proposedBy: value.proposedBy,
    proposalFence: value.proposalFence,
    createdAtMs: timestamp(value.createdAtMs, 'creation time'),
  });
  const proposalDigest = digest(value.proposalDigest, 'proposal digest');
  if (
    value.projectId !== normalized.projectId ||
    value.actionDigest !== normalized.actionDigest ||
    value.previewDigest !== normalized.previewDigest ||
    proposalDigest !== normalized.proposalDigest
  ) {
    throw new InvalidPluginPackageInstallProposalError(
      'proposal digest or derived binding is invalid',
    );
  }
  return normalized;
}

export function resolvePluginPackageInstallProposal(
  proposalValue: PluginPackageInstallProposal,
  dispatchValue: ApprovedActionDispatchRecord,
  createdAtMsValue: number,
): Readonly<PluginPackageLock> {
  const proposal = normalizePluginPackageInstallProposal(proposalValue);
  const dispatch = normalizeApprovedActionDispatchRecord(dispatchValue);
  const createdAtMs = timestamp(createdAtMsValue, 'lock creation time');
  if (
    dispatch.projectId !== proposal.projectId ||
    dispatch.action.actionRef !== proposal.actionRef ||
    dispatch.action.actionType !== proposal.actionType ||
    dispatch.action.permission !== proposal.permission ||
    dispatch.action.actionDigest !== proposal.actionDigest ||
    dispatch.action.previewDigest !== proposal.previewDigest ||
    dispatch.requestedBy.type !== proposal.proposedBy.type ||
    dispatch.requestedBy.id !== proposal.proposedBy.id ||
    dispatch.createdAtMs < proposal.createdAtMs ||
    createdAtMs < dispatch.createdAtMs ||
    createdAtMs >= dispatch.expiresAtMs
  ) {
    throw new PluginPackageInstallProposalBindingConflictError();
  }
  return createPluginPackageLock({
    ...proposal.actionInput,
    approval: {
      requestId: dispatch.approvalRequestId,
      requestVersion: dispatch.approvalRequestVersion,
      dispatchId: dispatch.id,
      actionDigest: dispatch.action.actionDigest,
      previewDigest: dispatch.action.previewDigest,
      approvedBy: dispatch.approvedBy,
      approvedAtMs: dispatch.approvedAtMs,
      expiresAtMs: dispatch.expiresAtMs,
      fence: dispatch.approvalFence,
    },
    createdAtMs,
  });
}
