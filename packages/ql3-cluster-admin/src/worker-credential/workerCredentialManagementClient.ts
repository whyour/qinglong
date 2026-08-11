/** Worker credential management client boundary. */
import {
  executeClusterAuthenticatedManagementClient,
  type ClusterAuthenticatedManagementClientResult,
  type ClusterPluginPackageManagementClientConnectionOptions,
  type ClusterPluginPackageManagementClientPaths,
} from '../management-support/pluginPackageManagementClient';
import {
  normalizeClusterWorkerCredentialManagementCommand,
  type ClusterWorkerCredentialManagementCommand,
  type ClusterWorkerCredentialManagementTransportResult,
} from './management-server/workerCredentialManagementTransport';

const MANAGEMENT_PATH = '/api/v3/worker-credentials/management';
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type ClusterWorkerCredentialManagementClientPaths =
  ClusterPluginPackageManagementClientPaths;
export type ClusterWorkerCredentialManagementClientConnectionOptions =
  ClusterPluginPackageManagementClientConnectionOptions;
export type ClusterWorkerCredentialManagementClientResult =
  ClusterAuthenticatedManagementClientResult<ClusterWorkerCredentialManagementTransportResult>;

function invalid(): never {
  throw new Error('Worker credential management response is invalid');
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return record;
}

function boundedScalar(value: unknown): void {
  if (
    value !== null &&
    !(typeof value === 'boolean') &&
    !(typeof value === 'number' && Number.isSafeInteger(value)) &&
    !(
      typeof value === 'string' &&
      value.length <= 2_048 &&
      !CONTROL_PATTERN.test(value)
    )
  ) {
    invalid();
  }
}

function subject(value: unknown): void {
  const record = exactRecord(value, ['type', 'id']);
  if (record.type !== 'user') invalid();
  boundedScalar(record.id);
}

function plan(value: unknown): void {
  const record = exactRecord(value, [
    'actionRef',
    'authorityProjectId',
    'action',
    'target',
    'requestedBy',
    'plannedAtMs',
    'expiresAtMs',
    'previewDigest',
    'planDigest',
  ]);
  const target = exactRecord(record.target, [
    'deliveryId',
    'workerId',
    'credentialId',
    'previousCredentialId',
    'credentialNotBeforeAtMs',
    'credentialExpiresAtMs',
    'deploymentTargetDigest',
    'deploymentGeneration',
  ]);
  for (const entry of Object.values(record)) {
    if (entry !== record.target && entry !== record.requestedBy)
      boundedScalar(entry);
  }
  for (const entry of Object.values(target)) boundedScalar(entry);
  subject(record.requestedBy);
  if (!['issue', 'rotate'].includes(String(record.action))) invalid();
}

function approval(value: unknown): void {
  const record = exactRecord(value, [
    'id',
    'projectId',
    'version',
    'state',
    'risk',
    'decisionMode',
    'requestedBy',
    'requestedAtMs',
    'expiresAtMs',
    'decision',
    'decisionReasonCode',
    'decidedBy',
    'decidedAtMs',
    'dispatchId',
    'consumedAtMs',
    'actionType',
    'actionRef',
    'actionDigest',
    'previewDigest',
  ]);
  for (const entry of Object.values(record)) {
    if (entry !== record.requestedBy && entry !== record.decidedBy)
      boundedScalar(entry);
  }
  subject(record.requestedBy);
  if (record.decidedBy !== null) subject(record.decidedBy);
  if (
    !/^worker_credential\.delivery\.(?:issue|rotate)$/.test(
      String(record.actionType),
    )
  ) {
    invalid();
  }
}

export function validateClusterWorkerCredentialManagementClientResult(
  value: unknown,
  command: Readonly<ClusterWorkerCredentialManagementCommand>,
): Readonly<ClusterWorkerCredentialManagementTransportResult> {
  const operation = command.operation;
  const keys =
    operation === 'worker-credential.plan'
      ? ['schemaVersion', 'operation', 'status', 'plan']
      : operation === 'worker-credential.propose'
      ? ['schemaVersion', 'operation', 'approvalStatus', 'plan', 'approval']
      : operation === 'worker-credential.decide'
      ? ['schemaVersion', 'operation', 'status', 'approval']
      : ['schemaVersion', 'operation', 'plan', 'approval', 'stale'];
  const record = exactRecord(value, keys);
  if (record.schemaVersion !== 1 || record.operation !== operation) invalid();
  if (operation === 'worker-credential.plan') {
    if (!['created', 'existing'].includes(String(record.status))) invalid();
    plan(record.plan);
  } else if (operation === 'worker-credential.propose') {
    if (!['created', 'existing'].includes(String(record.approvalStatus)))
      invalid();
    plan(record.plan);
    approval(record.approval);
  } else if (operation === 'worker-credential.decide') {
    if (!['decided', 'existing'].includes(String(record.status))) invalid();
    approval(record.approval);
  } else {
    if (typeof record.stale !== 'boolean') invalid();
    if (record.plan !== null) plan(record.plan);
    if (record.approval !== null) approval(record.approval);
  }
  return Object.freeze(
    record as unknown as ClusterWorkerCredentialManagementTransportResult,
  );
}

const PROTOCOL = Object.freeze({
  managementPath: MANAGEMENT_PATH,
  clientCertificate: 'required' as const,
  normalizeCommand: normalizeClusterWorkerCredentialManagementCommand,
  validateResult: validateClusterWorkerCredentialManagementClientResult,
});

export async function executeClusterWorkerCredentialManagementClient(
  paths: ClusterWorkerCredentialManagementClientPaths,
  connectionOptions?: ClusterWorkerCredentialManagementClientConnectionOptions,
): Promise<Readonly<ClusterWorkerCredentialManagementClientResult>> {
  return executeClusterAuthenticatedManagementClient(
    paths,
    PROTOCOL,
    connectionOptions,
  );
}
