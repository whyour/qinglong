import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  validateClusterCopilotClientConfiguration,
  validateClusterCopilotClientCredentialFile,
} from '../copilot-client/client';
import { readCanonicalFile } from '../management-support/managementClientConfiguration';

export const CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA =
  'qinglong/cluster-copilot-mcp-server@v1' as const;

const MAXIMUM_CONFIG_BYTES = 16 * 1024;
const MAXIMUM_PATH_BYTES = 4_096;

export interface ClusterCopilotMcpServerConfig {
  readonly schema: typeof CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA;
  readonly clientConfigFile: string;
  readonly credentialFile: string;
  readonly maxConcurrentRequests: number;
}

export class ClusterCopilotMcpServerConfigError extends TypeError {
  readonly code = 'QL3_CLUSTER_COPILOT_MCP_CONFIG_INVALID';

  constructor() {
    super('Cluster Copilot MCP configuration is invalid');
    this.name = 'ClusterCopilotMcpServerConfigError';
  }
}

function invalid(): never {
  throw new ClusterCopilotMcpServerConfigError();
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > MAXIMUM_PATH_BYTES ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    return invalid();
  }
  return value;
}

export function normalizeClusterCopilotMcpServerConfig(
  value: unknown,
): Readonly<ClusterCopilotMcpServerConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'clientConfigFile',
    'credentialFile',
    'maxConcurrentRequests',
    'schema',
  ];
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    record.schema !== CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA ||
    !Number.isSafeInteger(record.maxConcurrentRequests) ||
    (record.maxConcurrentRequests as number) < 1 ||
    (record.maxConcurrentRequests as number) > 16
  ) {
    return invalid();
  }
  const clientConfigFile = absolutePath(record.clientConfigFile);
  const credentialFile = absolutePath(record.credentialFile);
  if (clientConfigFile === credentialFile) return invalid();
  return Object.freeze({
    schema: CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA,
    clientConfigFile,
    credentialFile,
    maxConcurrentRequests: record.maxConcurrentRequests as number,
  });
}

export function readClusterCopilotMcpServerConfig(
  configFile: string,
): Readonly<ClusterCopilotMcpServerConfig> {
  let bytes: Buffer | undefined;
  try {
    bytes = readCanonicalFile(configFile, MAXIMUM_CONFIG_BYTES, 'private');
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    const config = normalizeClusterCopilotMcpServerConfig(value);
    validateClusterCopilotClientConfiguration(config.clientConfigFile);
    validateClusterCopilotClientCredentialFile(config.credentialFile);
    return config;
  } catch (error) {
    if (error instanceof ClusterCopilotMcpServerConfigError) throw error;
    throw new ClusterCopilotMcpServerConfigError();
  } finally {
    bytes?.fill(0);
  }
}
