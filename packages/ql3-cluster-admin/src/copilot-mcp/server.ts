import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';

import {
  ClusterCopilotClientRemoteError,
  executeClusterCopilotCommand,
  type ClusterCopilotClientResult,
  type ClusterCopilotCommandExecution,
} from '../copilot-client/client';
import type { ClusterCopilotClientOperation } from '../copilot-client/contracts';
import type { ClusterCopilotMcpServerConfig } from './config';
import {
  CLUSTER_COPILOT_MCP_OUTPUT_SCHEMA,
  CLUSTER_COPILOT_MCP_RESULT_SCHEMA,
  CLUSTER_COPILOT_MCP_TOOLS,
  QINGLONG_CLUSTER_COPILOT_MCP_SERVER,
  clusterCopilotMcpInputToCommand,
} from './contracts';

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESPONSE_CODE = /^[a-z][a-z0-9_]{0,127}$/;

export interface ClusterCopilotMcpServerDependencies {
  readonly config: Readonly<ClusterCopilotMcpServerConfig>;
  readonly execute?: (
    execution: ClusterCopilotCommandExecution,
  ) => Promise<Readonly<ClusterCopilotClientResult>>;
}

function toolError(
  code: string,
  detail?: Readonly<Record<string, unknown>>,
): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ code, ...(detail ?? {}) }),
      },
    ],
  };
}

function validateDependencies(
  dependencies: ClusterCopilotMcpServerDependencies,
): void {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies) ||
    !dependencies.config ||
    typeof dependencies.config !== 'object' ||
    !Number.isSafeInteger(dependencies.config.maxConcurrentRequests) ||
    dependencies.config.maxConcurrentRequests < 1 ||
    dependencies.config.maxConcurrentRequests > 16 ||
    typeof dependencies.config.clientConfigFile !== 'string' ||
    typeof dependencies.config.credentialFile !== 'string' ||
    (dependencies.execute !== undefined &&
      typeof dependencies.execute !== 'function')
  ) {
    throw new TypeError('Cluster Copilot MCP server dependencies are invalid');
  }
}

function success(
  operation: ClusterCopilotClientOperation,
  response: Readonly<ClusterCopilotClientResult>,
): CallToolResult {
  const responseRecord = response as unknown as Record<string, unknown>;
  const resultPrototype =
    response?.result && typeof response.result === 'object'
      ? Object.getPrototypeOf(response.result)
      : undefined;
  if (
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    Object.keys(response).sort().join(',') !==
      'operation,requestId,result,schemaVersion' ||
    responseRecord.schemaVersion !== 1 ||
    response.operation !== operation ||
    !IDENTITY.test(response.requestId) ||
    !response.result ||
    typeof response.result !== 'object' ||
    Array.isArray(response.result) ||
    (resultPrototype !== Object.prototype && resultPrototype !== null)
  ) {
    throw new TypeError('Cluster Copilot MCP result is invalid');
  }
  const output = operation === 'output';
  const structuredContent = Object.freeze({
    schema: CLUSTER_COPILOT_MCP_RESULT_SCHEMA,
    operation,
    requestId: response.requestId,
    sensitivity: output ? 'potentially_sensitive' : 'low',
    trust: Object.freeze({
      classification: output
        ? 'untrusted_model_output'
        : 'cluster_api_result',
      instructionPolicy: 'data_only_never_execute',
      actionAuthority: 'none',
    }),
    result: response.result,
  });
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}

function failure(error: unknown): CallToolResult {
  if (error instanceof ClusterCopilotClientRemoteError) {
    if (
      !Number.isSafeInteger(error.statusCode) ||
      error.statusCode < 400 ||
      error.statusCode > 599 ||
      !RESPONSE_CODE.test(error.responseCode) ||
      !IDENTITY.test(error.requestId) ||
      (error.retryAfterSeconds !== null &&
        (!Number.isSafeInteger(error.retryAfterSeconds) ||
          error.retryAfterSeconds < 1 ||
          error.retryAfterSeconds > 3_600))
    ) {
      return toolError('copilot_request_failed');
    }
    return toolError('copilot_remote_rejected', {
      statusCode: error.statusCode,
      responseCode: error.responseCode,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  const candidate = error as { readonly code?: unknown };
  if (candidate?.code === 'QL3_CLUSTER_COPILOT_CLIENT_COMMAND_INVALID') {
    return toolError('invalid_tool_input');
  }
  if (candidate?.code === 'QL3_CLUSTER_COPILOT_CLIENT_CONFIG_INVALID') {
    return toolError('copilot_client_config_invalid');
  }
  return toolError('copilot_request_failed');
}

/** Creates a bounded stdio-capable Cluster Copilot MCP server. */
export function createQingLongClusterCopilotMcpServer(
  dependencies: ClusterCopilotMcpServerDependencies,
): McpServer {
  validateDependencies(dependencies);
  const execute = dependencies.execute ?? executeClusterCopilotCommand;
  let inFlight = 0;
  const server = new McpServer(QINGLONG_CLUSTER_COPILOT_MCP_SERVER, {
    capabilities: { tools: {} },
  });
  for (const descriptor of CLUSTER_COPILOT_MCP_TOOLS) {
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          descriptor.inputSchema as JsonSchemaType,
        ),
        outputSchema: fromJsonSchema<Record<string, unknown>>(
          CLUSTER_COPILOT_MCP_OUTPUT_SCHEMA as JsonSchemaType,
        ),
        annotations: descriptor.annotations,
      },
      async (argumentsValue): Promise<CallToolResult> => {
        if (inFlight >= dependencies.config.maxConcurrentRequests) {
          return toolError('copilot_mcp_busy');
        }
        inFlight += 1;
        try {
          const command = clusterCopilotMcpInputToCommand(
            descriptor.operation,
            argumentsValue,
          );
          return success(
            descriptor.operation,
            await execute({
              configFile: dependencies.config.clientConfigFile,
              credentialFile: dependencies.config.credentialFile,
              command,
            }),
          );
        } catch (error) {
          return failure(error);
        } finally {
          inFlight -= 1;
        }
      },
    );
  }
  return server;
}

export {
  CLUSTER_COPILOT_MCP_RESULT_SCHEMA,
  CLUSTER_COPILOT_MCP_TOOLS,
  QINGLONG_CLUSTER_COPILOT_MCP_SERVER,
} from './contracts';
export {
  CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA,
  ClusterCopilotMcpServerConfigError,
  normalizeClusterCopilotMcpServerConfig,
  readClusterCopilotMcpServerConfig,
  type ClusterCopilotMcpServerConfig,
} from './config';
