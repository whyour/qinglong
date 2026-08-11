import { randomUUID } from 'node:crypto';

import type {
  ApprovalRequestDetailSource,
  ApprovalRequestSource,
} from '@qinglong/runtime-core/approval-discovery';
import {
  BUILTIN_APPROVAL_GET_TOOL,
  BUILTIN_APPROVAL_GET_TOOL_DEFINITION,
  executeBuiltInApprovalGetTool,
} from '../tool-projection/approvalGet';
import {
  BUILTIN_APPROVAL_LIST_TOOL,
  BUILTIN_APPROVAL_LIST_TOOL_DEFINITION,
  executeBuiltInApprovalListTool,
} from '../tool-projection/approvalList';
import {
  BUILTIN_TASK_LIST_TOOL,
  BUILTIN_TASK_LIST_TOOL_DEFINITION,
  executeBuiltInTaskListTool,
} from '../tool-projection/taskList';
import {
  BUILTIN_TASK_GET_TOOL,
  BUILTIN_TASK_GET_TOOL_DEFINITION,
  executeBuiltInTaskGetTool,
} from '../tool-projection/taskGet';
import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';
import {
  BUILTIN_RUN_EVENT_LIST_TOOL,
  BUILTIN_RUN_EVENT_LIST_TOOL_DEFINITION,
  executeBuiltInRunEventListTool,
} from '../tool-projection/runEventList';
import {
  BUILTIN_RUN_LIST_TOOL,
  BUILTIN_RUN_LIST_TOOL_DEFINITION,
  executeBuiltInRunListTool,
} from '../tool-projection/runList';
import {
  BUILTIN_RUN_STEP_LIST_TOOL,
  BUILTIN_RUN_STEP_LIST_TOOL_DEFINITION,
  executeBuiltInRunStepListTool,
} from '../tool-projection/runStepList';
import {
  BUILTIN_RUN_READ_TOOL,
  BUILTIN_RUN_READ_TOOL_DEFINITION,
  executeBuiltInRunReadTool,
} from '@qinglong/runtime-core/builtin-run-read-projection';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';
import type { StepRunRepository } from '@qinglong/runtime-core/step-run';
import type { ProjectRunListReader } from '@qinglong/runtime-core/project-run-list';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import type { TaskDefinitionSource } from '@qinglong/runtime-core/task-definition';
import type { TriggerSource } from '@qinglong/runtime-core/trigger';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditOutcome,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  InvalidToolJsonValueError,
  ToolDefinitionRegistry,
  ToolPolicySnapshotConflictError,
  ToolPolicyUnavailableError,
  prepareToolInvocation,
  type ToolDefinition,
  type ToolJsonValue,
  type ToolPolicyAuthorizer,
} from '@qinglong/runtime-core/tool-registry';
import {
  BUILTIN_TRIGGER_LIST_TOOL,
  BUILTIN_TRIGGER_LIST_TOOL_DEFINITION,
  executeBuiltInTriggerListTool,
} from '../tool-projection/triggerList';

export const QINGLONG_LOCAL_MCP_SERVER = Object.freeze({
  name: 'qinglong-local',
  version: '3.0.0-alpha.0',
});

const MCP_OPERATION_ID = 'mcp.tool.call';

export interface AuthenticatedLocalMcpRequest {
  readonly principal: Readonly<SecurityPrincipal>;
  confirm(): Promise<void>;
}

export interface QingLongLocalMcpServerDependencies {
  readonly projectId: string;
  readonly authenticate: () => Promise<Readonly<AuthenticatedLocalMcpRequest> | null>;
  readonly policy: ToolPolicyAuthorizer;
  readonly audit: SecurityAuditSink;
  readonly runs: LocalMcpRunReader;
  readonly stepRuns: Pick<StepRunRepository, 'listByRun'>;
  readonly taskDefinitions: LocalMcpTaskReader;
  readonly triggers: LocalMcpTriggerReader;
  readonly approvals: LocalMcpApprovalReader;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

type LocalMcpRunReader = Pick<
  RunRepositoryReader,
  'findRunById' | 'listEvents'
> &
  ProjectRunListReader;

type LocalMcpTaskReader = Pick<
  TaskDefinitionSource,
  'findCurrentTaskDefinition' | 'listTaskDefinitions'
>;
type LocalMcpTriggerReader = Pick<TriggerSource, 'listTriggers'>;
type LocalMcpApprovalReader = Pick<
  ApprovalRequestSource,
  'listApprovalRequests'
> &
  Pick<ApprovalRequestDetailSource, 'getApprovalRequestDetail'>;

interface LocalMcpReadAuthority {
  readonly runs: LocalMcpRunReader;
  readonly stepRuns: Pick<StepRunRepository, 'listByRun'>;
  readonly taskDefinitions: LocalMcpTaskReader;
  readonly triggers: LocalMcpTriggerReader;
  readonly approvals: LocalMcpApprovalReader;
}

export class LocalMcpAdmissionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('Local MCP Tool admission failed');
    this.name = 'LocalMcpAdmissionError';
    this.code = code;
  }
}

interface LocalMcpReadToolDescriptor {
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly definition: Readonly<ToolDefinition>;
  readonly title: string;
  readonly auditReason: string;
  readonly unavailableCode: string;
  execute(
    authority: LocalMcpReadAuthority,
    projectId: string,
    input: ToolJsonValue,
  ): Promise<Readonly<Record<string, ToolJsonValue>>>;
}

const LOCAL_MCP_READ_TOOLS: readonly LocalMcpReadToolDescriptor[] =
  Object.freeze([
    Object.freeze({
      tool: BUILTIN_RUN_LIST_TOOL,
      definition: BUILTIN_RUN_LIST_TOOL_DEFINITION,
      title: 'QingLong Runs',
      auditReason: 'tool_qinglong_run_list',
      unavailableCode: 'run_list_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) => executeBuiltInRunListTool(authority.runs, projectId, input),
    }),
    Object.freeze({
      tool: BUILTIN_RUN_READ_TOOL,
      definition: BUILTIN_RUN_READ_TOOL_DEFINITION,
      title: 'QingLong Run',
      auditReason: 'tool_qinglong_run_get',
      unavailableCode: 'run_query_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) => executeBuiltInRunReadTool(authority.runs, projectId, input),
    }),
    Object.freeze({
      tool: BUILTIN_RUN_EVENT_LIST_TOOL,
      definition: BUILTIN_RUN_EVENT_LIST_TOOL_DEFINITION,
      title: 'QingLong Run Events',
      auditReason: 'tool_qinglong_run_events_list',
      unavailableCode: 'run_event_query_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) => executeBuiltInRunEventListTool(authority.runs, projectId, input),
    }),
    Object.freeze({
      tool: BUILTIN_RUN_STEP_LIST_TOOL,
      definition: BUILTIN_RUN_STEP_LIST_TOOL_DEFINITION,
      title: 'QingLong Run Steps',
      auditReason: 'tool_qinglong_run_steps_list',
      unavailableCode: 'run_step_query_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) =>
        executeBuiltInRunStepListTool(
          authority.runs,
          authority.stepRuns,
          projectId,
          input,
        ),
    }),
    Object.freeze({
      tool: BUILTIN_TASK_GET_TOOL,
      definition: BUILTIN_TASK_GET_TOOL_DEFINITION,
      title: 'QingLong Task',
      auditReason: 'tool_qinglong_task_get',
      unavailableCode: 'task_query_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) =>
        executeBuiltInTaskGetTool(authority.taskDefinitions, projectId, input),
    }),
    Object.freeze({
      tool: BUILTIN_TASK_LIST_TOOL,
      definition: BUILTIN_TASK_LIST_TOOL_DEFINITION,
      title: 'QingLong Tasks',
      auditReason: 'tool_qinglong_task_list',
      unavailableCode: 'task_list_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) =>
        executeBuiltInTaskListTool(authority.taskDefinitions, projectId, input),
    }),
    Object.freeze({
      tool: BUILTIN_TRIGGER_LIST_TOOL,
      definition: BUILTIN_TRIGGER_LIST_TOOL_DEFINITION,
      title: 'QingLong Triggers',
      auditReason: 'tool_qinglong_trigger_list',
      unavailableCode: 'trigger_list_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) => executeBuiltInTriggerListTool(authority.triggers, projectId, input),
    }),
    Object.freeze({
      tool: BUILTIN_APPROVAL_LIST_TOOL,
      definition: BUILTIN_APPROVAL_LIST_TOOL_DEFINITION,
      title: 'QingLong Approvals',
      auditReason: 'tool_qinglong_approval_list',
      unavailableCode: 'approval_list_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) =>
        executeBuiltInApprovalListTool(authority.approvals, projectId, input),
    }),
    Object.freeze({
      tool: BUILTIN_APPROVAL_GET_TOOL,
      definition: BUILTIN_APPROVAL_GET_TOOL_DEFINITION,
      title: 'QingLong Approval',
      auditReason: 'tool_qinglong_approval_get',
      unavailableCode: 'approval_query_unavailable',
      execute: (
        authority: LocalMcpReadAuthority,
        projectId: string,
        input: ToolJsonValue,
      ) => executeBuiltInApprovalGetTool(authority.approvals, projectId, input),
    }),
  ]);

function validateDependencies(
  dependencies: QingLongLocalMcpServerDependencies,
): void {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies) ||
    typeof dependencies.projectId !== 'string' ||
    typeof dependencies.authenticate !== 'function' ||
    typeof dependencies.policy?.authorize !== 'function' ||
    typeof dependencies.audit?.record !== 'function' ||
    typeof dependencies.runs?.listRunsByProject !== 'function' ||
    typeof dependencies.runs?.findRunById !== 'function' ||
    typeof dependencies.runs?.listEvents !== 'function' ||
    typeof dependencies.stepRuns?.listByRun !== 'function' ||
    typeof dependencies.taskDefinitions?.findCurrentTaskDefinition !==
      'function' ||
    typeof dependencies.taskDefinitions?.listTaskDefinitions !== 'function' ||
    typeof dependencies.triggers?.listTriggers !== 'function' ||
    typeof dependencies.approvals?.listApprovalRequests !== 'function' ||
    typeof dependencies.approvals?.getApprovalRequestDetail !== 'function' ||
    (dependencies.now !== undefined &&
      typeof dependencies.now !== 'function') ||
    (dependencies.randomUuid !== undefined &&
      typeof dependencies.randomUuid !== 'function')
  ) {
    throw new TypeError('Local MCP server dependencies are invalid');
  }
}

function toolError(code: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ code }) }],
  };
}

function timestamp(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    throw new LocalMcpAdmissionError('clock_unavailable');
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalMcpAdmissionError('clock_unavailable');
  }
  return value;
}

async function recordAudit(
  dependencies: QingLongLocalMcpServerDependencies,
  requestId: string,
  outcome: SecurityAuditOutcome,
  reasons: readonly string[],
  principal: Readonly<SecurityPrincipal> | null,
  fence: Readonly<{
    projectVersion: number;
    bindingVersion: number | null;
  }> | null,
  now: () => number,
  uuid: () => string,
): Promise<void> {
  try {
    await dependencies.audit.record(
      normalizeSecurityAuditRecord({
        eventId: uuid(),
        requestId,
        operationId: MCP_OPERATION_ID,
        projectId: dependencies.projectId,
        subject: principal?.subject ?? null,
        authenticationId: principal?.authenticationId ?? null,
        outcome,
        reasons,
        fence,
        occurredAtMs: timestamp(now),
      }),
    );
  } catch {
    throw new LocalMcpAdmissionError('security_audit_unavailable');
  }
}

/**
 * Creates one read-only MCP endpoint. Every Tool call re-authenticates, passes
 * the shared Tool Registry and Project Policy, records durable admission,
 * confirms the credential fence, and only then performs a bounded read.
 */
export function createQingLongLocalMcpServer(
  dependencies: QingLongLocalMcpServerDependencies,
): McpServer {
  validateDependencies(dependencies);
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.randomUuid ?? randomUUID;
  const registry = new ToolDefinitionRegistry(
    LOCAL_MCP_READ_TOOLS.map(({ definition }) => definition),
  );
  const server = new McpServer(QINGLONG_LOCAL_MCP_SERVER, {
    capabilities: { tools: {} },
  });
  for (const descriptor of LOCAL_MCP_READ_TOOLS) {
    const definition = registry.resolve(
      descriptor.tool.name,
      descriptor.tool.version,
    );
    const inputSchema = fromJsonSchema<Record<string, unknown>>(
      definition.inputSchema as unknown as JsonSchemaType,
    );
    const outputSchema = fromJsonSchema<Record<string, unknown>>(
      definition.outputSchema as unknown as JsonSchemaType,
    );
    server.registerTool(
      definition.name,
      {
        title: descriptor.title,
        description: definition.description,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (argumentsValue): Promise<CallToolResult> => {
        const requestId = `mcp:${uuid()}`;
        let authenticated: Readonly<AuthenticatedLocalMcpRequest> | null;
        try {
          authenticated = await dependencies.authenticate();
        } catch {
          try {
            await recordAudit(
              dependencies,
              requestId,
              'authentication_unavailable',
              ['authentication_unavailable', descriptor.auditReason],
              null,
              null,
              now,
              uuid,
            );
          } catch (error) {
            return toolError((error as LocalMcpAdmissionError).code);
          }
          return toolError('authentication_unavailable');
        }
        if (!authenticated) {
          try {
            await recordAudit(
              dependencies,
              requestId,
              'authentication_rejected',
              ['authentication_rejected', descriptor.auditReason],
              null,
              null,
              now,
              uuid,
            );
          } catch (error) {
            return toolError((error as LocalMcpAdmissionError).code);
          }
          return toolError('authentication_required');
        }

        let plan;
        try {
          plan = await prepareToolInvocation(
            registry,
            {
              projectId: dependencies.projectId,
              principal: authenticated.principal,
              nowMs: timestamp(now),
              tool: descriptor.tool,
              input: argumentsValue,
            },
            dependencies.policy,
          );
        } catch (error) {
          const code =
            error instanceof InvalidToolJsonValueError
              ? 'invalid_tool_input'
              : error instanceof ToolPolicySnapshotConflictError
              ? 'policy_fence_conflict'
              : error instanceof ToolPolicyUnavailableError
              ? 'authorization_unavailable'
              : 'authorization_unavailable';
          try {
            await recordAudit(
              dependencies,
              requestId,
              'authorization_unavailable',
              [code, descriptor.auditReason],
              authenticated.principal,
              null,
              now,
              uuid,
            );
          } catch (auditError) {
            return toolError((auditError as LocalMcpAdmissionError).code);
          }
          return toolError(code);
        }

        if (plan.status === 'denied' || plan.status === 'approval_required') {
          const approvalRequired = plan.status === 'approval_required';
          try {
            await recordAudit(
              dependencies,
              requestId,
              approvalRequired ? 'approval_required' : 'denied',
              [
                approvalRequired
                  ? 'tool_approval_required'
                  : 'tool_invocation_denied',
                descriptor.auditReason,
              ],
              authenticated.principal,
              plan.status === 'denied' ? null : plan.fence,
              now,
              uuid,
            );
          } catch (error) {
            return toolError((error as LocalMcpAdmissionError).code);
          }
          return toolError(
            approvalRequired ? 'approval_required' : 'forbidden',
          );
        }

        try {
          await recordAudit(
            dependencies,
            requestId,
            'allowed',
            ['tool_invocation_allowed', descriptor.auditReason],
            authenticated.principal,
            plan.fence,
            now,
            uuid,
          );
          await authenticated.confirm();
          const output = registry.normalizeOutput(
            definition.name,
            definition.version,
            await descriptor.execute(
              dependencies,
              dependencies.projectId,
              plan.input,
            ),
          );
          if (!output || typeof output !== 'object' || Array.isArray(output)) {
            return toolError(descriptor.unavailableCode);
          }
          const structuredContent = output as Record<string, ToolJsonValue>;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(structuredContent),
              },
            ],
            structuredContent,
          };
        } catch (error) {
          if (error instanceof LocalMcpAdmissionError) {
            return toolError(error.code);
          }
          return toolError(descriptor.unavailableCode);
        }
      },
    );
  }
  return server;
}
