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

function boundedText(value: unknown, nullable = false): void {
  if (value === null && nullable) return;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid();
  }
}

function nonNegativeInteger(value: unknown, nullable = false): void {
  if (value === null && nullable) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
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

const WORKER_OBSERVATION_KEYS = [
  'architecture',
  'availableSlots',
  'compatibility',
  'generation',
  'lastHeartbeatAtMs',
  'leaseExpiresAtMs',
  'lifecycle',
  'maxConcurrentRuns',
  'observedAtMs',
  'operatingSystem',
  'protocolVersion',
  'registeredAtMs',
  'sessionId',
  'sessionVersion',
  'supportTier',
  'updatedAtMs',
  'workerId',
] as const;

function workerObservation(value: unknown, detailed: boolean): void {
  const record = exactRecord(
    value,
    detailed
      ? [...WORKER_OBSERVATION_KEYS, 'declaredCapacity', 'runtimes']
      : WORKER_OBSERVATION_KEYS,
  );
  boundedText(record.workerId);
  boundedText(record.sessionId);
  boundedText(record.protocolVersion);
  boundedText(record.operatingSystem, true);
  for (const key of [
    'generation',
    'sessionVersion',
    'maxConcurrentRuns',
    'availableSlots',
    'registeredAtMs',
    'lastHeartbeatAtMs',
    'leaseExpiresAtMs',
    'updatedAtMs',
    'observedAtMs',
  ] as const) {
    nonNegativeInteger(record[key]);
  }
  if (
    !['online', 'draining', 'offline', 'lease_expired'].includes(
      String(record.lifecycle),
    ) ||
    ![
      'default_placement',
      'explicit_placement_required',
      'protocol_incompatible',
    ].includes(String(record.compatibility)) ||
    !['tier1', 'candidate', 'experimental', 'legacy-only'].includes(
      String(record.supportTier),
    ) ||
    !['amd64', 'arm64', 'ppc64le', 's390x', 'arm/v7', 'arm/v6', '386'].includes(
      String(record.architecture),
    )
  ) {
    invalid();
  }
  if (
    (record.generation as number) < 1 ||
    (record.maxConcurrentRuns as number) < 1 ||
    (record.availableSlots as number) > (record.maxConcurrentRuns as number) ||
    (record.lastHeartbeatAtMs as number) < (record.registeredAtMs as number) ||
    (record.updatedAtMs as number) < (record.lastHeartbeatAtMs as number) ||
    (record.observedAtMs as number) < (record.updatedAtMs as number) ||
    (record.lifecycle !== 'offline' &&
      (record.leaseExpiresAtMs as number) <=
        (record.lastHeartbeatAtMs as number)) ||
    (['online', 'draining'].includes(String(record.lifecycle)) &&
      (record.leaseExpiresAtMs as number) <= (record.observedAtMs as number)) ||
    (record.lifecycle === 'lease_expired' &&
      (record.leaseExpiresAtMs as number) > (record.observedAtMs as number)) ||
    (['draining', 'offline'].includes(String(record.lifecycle)) &&
      (record.availableSlots as number) !== 0)
  ) {
    invalid();
  }
  if (!detailed) return;
  if (!Array.isArray(record.runtimes) || record.runtimes.length > 32) invalid();
  for (const runtime of record.runtimes) {
    const item = exactRecord(runtime, ['name', 'version']);
    boundedText(item.name);
    boundedText(item.version);
  }
  const capacity = exactRecord(record.declaredCapacity, [
    'cpuCores',
    'diskBytes',
    'gpuCount',
    'memoryBytes',
  ]);
  nonNegativeInteger(capacity.cpuCores, true);
  nonNegativeInteger(capacity.memoryBytes, true);
  nonNegativeInteger(capacity.diskBytes, true);
  nonNegativeInteger(capacity.gpuCount);
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
      : operation === 'worker-credential.inspect'
      ? ['schemaVersion', 'operation', 'plan', 'approval', 'stale']
      : operation === 'worker-session.inspect'
      ? ['schemaVersion', 'operation', 'observedAtMs', 'worker']
      : [
          'schemaVersion',
          'operation',
          'observedAtMs',
          'workers',
          'nextCursor',
        ];
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
  } else if (operation === 'worker-credential.inspect') {
    if (typeof record.stale !== 'boolean') invalid();
    if (record.plan !== null) plan(record.plan);
    if (record.approval !== null) approval(record.approval);
  } else if (operation === 'worker-session.inspect') {
    nonNegativeInteger(record.observedAtMs);
    if (record.worker !== null) {
      workerObservation(record.worker, true);
      if (
        (record.worker as Record<string, unknown>).observedAtMs !==
        record.observedAtMs
      ) {
        invalid();
      }
    }
  } else {
    nonNegativeInteger(record.observedAtMs);
    boundedText(record.nextCursor, true);
    if (!Array.isArray(record.workers) || record.workers.length > 16) invalid();
    let previous = '';
    for (const worker of record.workers) {
      workerObservation(worker, false);
      const item = worker as Record<string, unknown>;
      if (
        item.observedAtMs !== record.observedAtMs ||
        typeof item.workerId !== 'string' ||
        item.workerId <= previous
      ) {
        invalid();
      }
      previous = item.workerId;
    }
    if (
      (record.nextCursor !== null &&
        (record.workers.length === 0 || record.nextCursor !== previous)) ||
      (record.nextCursor === null && record.workers.length > 16)
    ) {
      invalid();
    }
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
