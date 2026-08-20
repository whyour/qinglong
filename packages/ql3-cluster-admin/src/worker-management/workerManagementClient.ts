/** Read-only product client boundary for bounded Worker session observation. */
import {
  executeClusterAuthenticatedManagementClient,
  type ClusterAuthenticatedManagementClientResult,
  type ClusterAuthenticatedManagementCommandExecution,
  type ClusterPluginPackageManagementClientConnectionOptions,
} from '../management-support/pluginPackageManagementClient';
import {
  ClusterWorkerCredentialManagementTransportRequestError,
  normalizeClusterWorkerCredentialManagementCommand,
  type ClusterWorkerCredentialManagementCommand,
  type ClusterWorkerCredentialManagementTransportResult,
} from '../worker-credential/management-server/workerCredentialManagementTransport';
import { validateClusterWorkerCredentialManagementClientResult } from '../worker-credential/workerCredentialManagementClient';

const MANAGEMENT_PATH = '/api/v3/workers/management';

export type ClusterWorkerManagementCommand = Extract<
  ClusterWorkerCredentialManagementCommand,
  { readonly operation: 'worker-session.inspect' | 'worker-session.list' }
>;
export type ClusterWorkerManagementTransportResult = Extract<
  ClusterWorkerCredentialManagementTransportResult,
  { readonly operation: 'worker-session.inspect' | 'worker-session.list' }
>;
export type ClusterWorkerManagementClientExecution =
  ClusterAuthenticatedManagementCommandExecution<ClusterWorkerManagementCommand>;
export type ClusterWorkerManagementClientConnectionOptions =
  ClusterPluginPackageManagementClientConnectionOptions;
export type ClusterWorkerManagementClientResult =
  ClusterAuthenticatedManagementClientResult<ClusterWorkerManagementTransportResult>;

export function normalizeClusterWorkerManagementCommand(
  value: unknown,
): Readonly<ClusterWorkerManagementCommand> {
  const command = normalizeClusterWorkerCredentialManagementCommand(value);
  if (
    command.operation !== 'worker-session.inspect' &&
    command.operation !== 'worker-session.list'
  ) {
    throw new ClusterWorkerCredentialManagementTransportRequestError(
      'operation is not available through the read-only Worker client',
    );
  }
  return command;
}

function validateClusterWorkerManagementResult(
  value: unknown,
  command: Readonly<ClusterWorkerManagementCommand>,
): Readonly<ClusterWorkerManagementTransportResult> {
  const result = validateClusterWorkerCredentialManagementClientResult(
    value,
    command,
  );
  if (
    result.operation !== 'worker-session.inspect' &&
    result.operation !== 'worker-session.list'
  ) {
    throw new Error('Worker management response is invalid');
  }
  return result;
}

const PROTOCOL = Object.freeze({
  managementPath: MANAGEMENT_PATH,
  clientCertificate: 'required' as const,
  normalizeCommand: normalizeClusterWorkerManagementCommand,
  validateResult: validateClusterWorkerManagementResult,
});

export async function executeClusterWorkerManagementClient(
  execution: ClusterWorkerManagementClientExecution,
  connectionOptions?: ClusterWorkerManagementClientConnectionOptions,
): Promise<Readonly<ClusterWorkerManagementClientResult>> {
  return executeClusterAuthenticatedManagementClient(
    execution,
    PROTOCOL,
    connectionOptions,
  );
}
