import { normalizeApprovedActionBinding } from '@qinglong/runtime-core/approved-action';
import { normalizeApprovalDetailPreview } from '@qinglong/runtime-core/approval-discovery';
import {
  ClusterPluginPackageManagementClientRequestError,
  executeClusterAuthenticatedManagementClient,
  type ClusterAuthenticatedManagementClientResult,
  type ClusterPluginPackageManagementClientConnectionOptions,
  type ClusterPluginPackageManagementClientPaths,
} from '../management-support/pluginPackageManagementClient';
import {
  normalizeClusterApprovalManagementCommand,
  type ClusterApprovalManagementCommand,
  type ClusterApprovalManagementTransportResult,
} from './approvalManagementTransport';

const MANAGEMENT_PATH = '/api/v3/approvals/management';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ClusterApprovalManagementClientPaths =
  ClusterPluginPackageManagementClientPaths;
export type ClusterApprovalManagementClientConnectionOptions =
  ClusterPluginPackageManagementClientConnectionOptions;
export type ClusterApprovalManagementClientResult =
  ClusterAuthenticatedManagementClientResult<ClusterApprovalManagementTransportResult>;

function invalid(): never {
  throw new ClusterPluginPackageManagementClientRequestError();
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) invalid();
  return value;
}

function subject(value: unknown): void {
  const record = exact(value, ['type', 'id']);
  if (
    (record.type !== 'user' && record.type !== 'system' && record.type !== 'agent') ||
    typeof record.id !== 'string'
  ) {
    invalid();
  }
  identifier(record.id);
}

function safeTime(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
}

function action(value: unknown): void {
  try {
    normalizeApprovedActionBinding(value as never);
  } catch {
    invalid();
  }
}

function inspectApproval(
  value: unknown,
  command: Extract<ClusterApprovalManagementCommand, { operation: 'approval.inspect' }>,
): void {
  const approval = exact(value, [
    'projectId',
    'approvalRequestId',
    'version',
    'state',
    'risk',
    'decisionMode',
    'expectedAction',
    'requestedBy',
    'requestedAtMs',
    'expiresAtMs',
    'preview',
  ]);
  if (
    identifier(approval.projectId) !== command.request.projectId ||
    identifier(approval.approvalRequestId) !== command.request.approvalRequestId ||
    !Number.isSafeInteger(approval.version) ||
    Number(approval.version) < 1 ||
    typeof approval.state !== 'string' ||
    typeof approval.risk !== 'string' ||
    typeof approval.decisionMode !== 'string'
  ) {
    invalid();
  }
  action(approval.expectedAction);
  subject(approval.requestedBy);
  safeTime(approval.requestedAtMs);
  safeTime(approval.expiresAtMs);
  if (approval.preview !== null) {
    try {
      normalizeApprovalDetailPreview(approval.preview as never);
    } catch {
      invalid();
    }
  }
}

function decisionApproval(
  value: unknown,
  command: Extract<ClusterApprovalManagementCommand, { operation: 'approval.decide' }>,
): void {
  const approval = exact(value, [
    'projectId',
    'approvalRequestId',
    'version',
    'state',
    'expectedAction',
    'decisionId',
    'decision',
    'reasonCode',
    'decidedBy',
    'decidedAtMs',
  ]);
  if (
    identifier(approval.projectId) !== command.request.projectId ||
    identifier(approval.approvalRequestId) !== command.request.approvalRequestId ||
    approval.version !== 2 ||
    approval.state !== command.request.decision ||
    identifier(approval.decisionId) !== command.request.decisionId ||
    approval.decision !== command.request.decision ||
    approval.reasonCode !== command.request.reasonCode
  ) {
    invalid();
  }
  action(approval.expectedAction);
  subject(approval.decidedBy);
  safeTime(approval.decidedAtMs);
}

export function validateClusterApprovalManagementClientResult(
  value: unknown,
  command: Readonly<ClusterApprovalManagementCommand>,
): Readonly<ClusterApprovalManagementTransportResult> {
  const envelope = exact(value, [
    'schemaVersion',
    'operation',
    'status',
    'approval',
  ]);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.operation !== command.operation
  ) {
    invalid();
  }
  if (command.operation === 'approval.inspect') {
    if (
      (envelope.status !== 'found' && envelope.status !== 'absent') ||
      (envelope.status === 'absent') !== (envelope.approval === null)
    ) {
      invalid();
    }
    if (envelope.approval !== null) {
      inspectApproval(envelope.approval, command);
    }
  } else {
    if (
      envelope.status !== 'decided' &&
      envelope.status !== 'existing'
    ) {
      invalid();
    }
    decisionApproval(envelope.approval, command);
  }
  return Object.freeze(
    envelope as unknown as ClusterApprovalManagementTransportResult,
  );
}

const PROTOCOL = Object.freeze({
  managementPath: MANAGEMENT_PATH,
  clientCertificate: 'required' as const,
  normalizeCommand: normalizeClusterApprovalManagementCommand,
  validateResult: validateClusterApprovalManagementClientResult,
});

export async function executeClusterApprovalManagementClient(
  paths: ClusterApprovalManagementClientPaths,
  connectionOptions?: ClusterApprovalManagementClientConnectionOptions,
): Promise<Readonly<ClusterApprovalManagementClientResult>> {
  return executeClusterAuthenticatedManagementClient(
    paths,
    PROTOCOL,
    connectionOptions,
  );
}
