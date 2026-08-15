import {
  CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
  type ClusterCopilotClientCommand,
} from '../copilot-client/contracts';

export const CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA =
  'qinglong/cluster-copilot-console-read-request@v1' as const;
export const CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-console-read-response@v1' as const;

export type ClusterCopilotConsoleReadOperation = 'inspect' | 'output';

export interface ClusterCopilotConsoleReadRequest {
  readonly schema: typeof CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA;
  readonly operation: ClusterCopilotConsoleReadOperation;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly requestId: string;
}

export class InvalidClusterCopilotConsoleReadRequestError extends TypeError {
  readonly code = 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID';

  constructor() {
    super('Cluster Copilot Console read request is invalid');
    this.name = 'InvalidClusterCopilotConsoleReadRequestError';
  }
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;

function invalid(): never {
  throw new InvalidClusterCopilotConsoleReadRequestError();
}

export function normalizeClusterCopilotConsoleReadRequest(
  value: unknown,
): Readonly<ClusterCopilotConsoleReadRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'operation',
    'projectId',
    'requestId',
    'schema',
    'sourceRunId',
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    record.schema !== CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA ||
    (record.operation !== 'inspect' && record.operation !== 'output') ||
    typeof record.projectId !== 'string' ||
    !IDENTITY.test(record.projectId) ||
    typeof record.sourceRunId !== 'string' ||
    !RUN_ID.test(record.sourceRunId) ||
    typeof record.requestId !== 'string' ||
    !IDENTITY.test(record.requestId)
  ) {
    return invalid();
  }
  return Object.freeze({
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation: record.operation,
    projectId: record.projectId,
    sourceRunId: record.sourceRunId,
    requestId: record.requestId,
  });
}

export function clusterCopilotConsoleClientCommand(
  request: Readonly<ClusterCopilotConsoleReadRequest>,
): Readonly<ClusterCopilotClientCommand> {
  const normalized = normalizeClusterCopilotConsoleReadRequest(request);
  return Object.freeze({
    schema: CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
    operation: normalized.operation,
    projectId: normalized.projectId,
    sourceRunId: normalized.sourceRunId,
    requestId: normalized.requestId,
  });
}
