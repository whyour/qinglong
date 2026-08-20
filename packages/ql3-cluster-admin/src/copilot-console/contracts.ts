import {
  CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
  type ClusterCopilotClientCommand,
} from '../copilot-client/contracts';

export const CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA =
  'qinglong/cluster-copilot-console-read-request@v1' as const;
export const CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-console-read-response@v1' as const;

export const CLUSTER_COPILOT_CONSOLE_READ_OPERATIONS = Object.freeze([
  'inspect',
  'output',
  'run_cancellation_status',
  'run_cancellation_blocked_list',
  'run_cancellation_inspect',
  'run_list',
  'run_read',
  'run_event_list',
  'run_step_list',
  'task_list',
  'task_read',
  'workflow_list',
  'workflow_run_list',
  'workflow_run_read',
  'workflow_event_list',
  'workflow_step_list',
] as const);

export type ClusterCopilotConsoleReadOperation =
  (typeof CLUSTER_COPILOT_CONSOLE_READ_OPERATIONS)[number];

interface BaseReadRequest<
  Operation extends ClusterCopilotConsoleReadOperation,
> {
  readonly schema: typeof CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA;
  readonly operation: Operation;
  readonly projectId: string;
  readonly requestId: string;
}

export type ClusterCopilotConsoleReadRequest =
  | (BaseReadRequest<'inspect'> & Readonly<{ sourceRunId: string }>)
  | (BaseReadRequest<'output'> & Readonly<{ sourceRunId: string }>)
  | BaseReadRequest<'run_cancellation_status'>
  | (BaseReadRequest<'run_cancellation_blocked_list'> &
      Readonly<{ cursor: string | null }>)
  | (BaseReadRequest<'run_cancellation_inspect'> & Readonly<{ runId: string }>)
  | (BaseReadRequest<'run_list'> &
      Readonly<{
        afterCreatedAtMs: number | null;
        afterRunId: string | null;
        limit: number;
      }>)
  | (BaseReadRequest<'run_read'> & Readonly<{ runId: string }>)
  | (BaseReadRequest<'run_event_list'> &
      Readonly<{ runId: string; afterSequence: number; limit: number }>)
  | (BaseReadRequest<'run_step_list'> &
      Readonly<{
        runId: string;
        afterStepKey: string | null;
        afterStepRunId: string | null;
        limit: number;
      }>)
  | (BaseReadRequest<'task_list'> &
      Readonly<{ afterTaskId: string | null; limit: number }>)
  | (BaseReadRequest<'task_read'> & Readonly<{ taskId: string }>)
  | (BaseReadRequest<'workflow_list'> & Readonly<{ packageName: string }>)
  | (BaseReadRequest<'workflow_run_list'> &
      Readonly<{
        packageName: string;
        workflowId: string;
        afterAdmittedAtMs: number | null;
        afterRunId: string | null;
        limit: number;
      }>)
  | (BaseReadRequest<'workflow_run_read'> &
      Readonly<{ packageName: string; workflowId: string; runId: string }>)
  | (BaseReadRequest<'workflow_event_list'> &
      Readonly<{
        packageName: string;
        workflowId: string;
        runId: string;
        afterSequence: number;
        limit: number;
      }>)
  | (BaseReadRequest<'workflow_step_list'> &
      Readonly<{
        packageName: string;
        workflowId: string;
        runId: string;
        afterStepKey: string | null;
        afterStepRunId: string | null;
        limit: number;
      }>);

export class InvalidClusterCopilotConsoleReadRequestError extends TypeError {
  readonly code = 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID';

  constructor() {
    super('Cluster Copilot Console read request is invalid');
    this.name = 'InvalidClusterCopilotConsoleReadRequestError';
  }
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COPILOT_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const RUN_CANCELLATION_CURSOR = /^v1\.[A-Za-z0-9_-]{1,512}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,62}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(): never {
  throw new InvalidClusterCopilotConsoleReadRequestError();
}

function exact(
  record: Record<string, unknown>,
  operation: ClusterCopilotConsoleReadOperation,
  fields: readonly string[],
): void {
  const actual = Object.keys(record).sort();
  const expected = [
    'operation',
    'projectId',
    'requestId',
    'schema',
    ...fields,
  ].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    record.schema !== CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA ||
    record.operation !== operation ||
    typeof record.projectId !== 'string' ||
    !IDENTITY.test(record.projectId) ||
    typeof record.requestId !== 'string' ||
    !IDENTITY.test(record.requestId)
  )
    invalid();
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY.test(value);
}

function limit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 64
  );
}

function sequence(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= 2_147_483_647
  );
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function common(record: Record<string, unknown>) {
  return {
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    projectId: record.projectId as string,
    requestId: record.requestId as string,
  } as const;
}

function workflowTarget(
  record: Record<string, unknown>,
  requireRun: boolean,
): boolean {
  return (
    typeof record.packageName === 'string' &&
    PACKAGE_NAME.test(record.packageName) &&
    typeof record.workflowId === 'string' &&
    WORKFLOW_ID.test(record.workflowId) &&
    (!requireRun ||
      (typeof record.runId === 'string' && UUID_V4.test(record.runId)))
  );
}

export function normalizeClusterCopilotConsoleReadRequest(
  value: unknown,
): Readonly<ClusterCopilotConsoleReadRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const operation = record.operation;
  if (
    typeof operation !== 'string' ||
    !CLUSTER_COPILOT_CONSOLE_READ_OPERATIONS.includes(
      operation as ClusterCopilotConsoleReadOperation,
    )
  )
    invalid();
  const op = operation as ClusterCopilotConsoleReadOperation;

  if (op === 'inspect' || op === 'output') {
    exact(record, op, ['sourceRunId']);
    if (
      typeof record.sourceRunId !== 'string' ||
      !COPILOT_RUN_ID.test(record.sourceRunId)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      sourceRunId: record.sourceRunId,
    });
  }
  if (op === 'run_cancellation_status') {
    exact(record, op, []);
    return Object.freeze({
      ...common(record),
      operation: op,
    });
  }
  if (op === 'run_cancellation_blocked_list') {
    exact(record, op, ['cursor']);
    if (
      record.cursor !== null &&
      (typeof record.cursor !== 'string' ||
        !RUN_CANCELLATION_CURSOR.test(record.cursor))
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      cursor: record.cursor as string | null,
    });
  }
  if (op === 'run_cancellation_inspect') {
    exact(record, op, ['runId']);
    if (!identifier(record.runId)) invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      runId: record.runId,
    });
  }
  if (op === 'run_list') {
    exact(record, op, ['afterCreatedAtMs', 'afterRunId', 'limit']);
    if (
      (record.afterCreatedAtMs === null) !== (record.afterRunId === null) ||
      (record.afterCreatedAtMs !== null &&
        !timestamp(record.afterCreatedAtMs)) ||
      (record.afterRunId !== null && !identifier(record.afterRunId)) ||
      !limit(record.limit)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      afterCreatedAtMs: record.afterCreatedAtMs as number | null,
      afterRunId: record.afterRunId as string | null,
      limit: record.limit as number,
    });
  }
  if (op === 'run_read') {
    exact(record, op, ['runId']);
    if (!identifier(record.runId)) invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      runId: record.runId,
    });
  }
  if (op === 'run_event_list') {
    exact(record, op, ['afterSequence', 'limit', 'runId']);
    if (
      !identifier(record.runId) ||
      !sequence(record.afterSequence) ||
      !limit(record.limit)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      runId: record.runId,
      afterSequence: record.afterSequence as number,
      limit: record.limit as number,
    });
  }
  if (op === 'run_step_list') {
    exact(record, op, ['afterStepKey', 'afterStepRunId', 'limit', 'runId']);
    if (
      !identifier(record.runId) ||
      (record.afterStepKey === null) !== (record.afterStepRunId === null) ||
      (record.afterStepKey !== null && !identifier(record.afterStepKey)) ||
      (record.afterStepRunId !== null && !identifier(record.afterStepRunId)) ||
      !limit(record.limit)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      runId: record.runId,
      afterStepKey: record.afterStepKey as string | null,
      afterStepRunId: record.afterStepRunId as string | null,
      limit: record.limit as number,
    });
  }
  if (op === 'task_list') {
    exact(record, op, ['afterTaskId', 'limit']);
    if (
      (record.afterTaskId !== null && !identifier(record.afterTaskId)) ||
      !limit(record.limit)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      afterTaskId: record.afterTaskId as string | null,
      limit: record.limit as number,
    });
  }
  if (op === 'task_read') {
    exact(record, op, ['taskId']);
    if (!identifier(record.taskId)) invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      taskId: record.taskId,
    });
  }
  if (op === 'workflow_list') {
    exact(record, op, ['packageName']);
    if (
      typeof record.packageName !== 'string' ||
      !PACKAGE_NAME.test(record.packageName)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      packageName: record.packageName,
    });
  }
  if (op === 'workflow_run_list') {
    exact(record, op, [
      'afterAdmittedAtMs',
      'afterRunId',
      'limit',
      'packageName',
      'workflowId',
    ]);
    if (
      !workflowTarget(record, false) ||
      (record.afterAdmittedAtMs === null) !== (record.afterRunId === null) ||
      (record.afterAdmittedAtMs !== null &&
        !timestamp(record.afterAdmittedAtMs)) ||
      (record.afterRunId !== null &&
        (typeof record.afterRunId !== 'string' ||
          !UUID_V4.test(record.afterRunId))) ||
      !limit(record.limit)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      packageName: record.packageName as string,
      workflowId: record.workflowId as string,
      afterAdmittedAtMs: record.afterAdmittedAtMs as number | null,
      afterRunId: record.afterRunId as string | null,
      limit: record.limit as number,
    });
  }
  if (op === 'workflow_run_read') {
    exact(record, op, ['packageName', 'runId', 'workflowId']);
    if (!workflowTarget(record, true)) invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      packageName: record.packageName as string,
      workflowId: record.workflowId as string,
      runId: record.runId as string,
    });
  }
  if (op === 'workflow_event_list') {
    exact(record, op, [
      'afterSequence',
      'limit',
      'packageName',
      'runId',
      'workflowId',
    ]);
    if (
      !workflowTarget(record, true) ||
      !sequence(record.afterSequence) ||
      !limit(record.limit)
    )
      invalid();
    return Object.freeze({
      ...common(record),
      operation: op,
      packageName: record.packageName as string,
      workflowId: record.workflowId as string,
      runId: record.runId as string,
      afterSequence: record.afterSequence as number,
      limit: record.limit as number,
    });
  }
  exact(record, 'workflow_step_list', [
    'afterStepKey',
    'afterStepRunId',
    'limit',
    'packageName',
    'runId',
    'workflowId',
  ]);
  if (
    !workflowTarget(record, true) ||
    (record.afterStepKey === null) !== (record.afterStepRunId === null) ||
    (record.afterStepKey !== null &&
      (typeof record.afterStepKey !== 'string' ||
        !WORKFLOW_ID.test(record.afterStepKey))) ||
    (record.afterStepRunId !== null &&
      (typeof record.afterStepRunId !== 'string' ||
        !UUID_V4.test(record.afterStepRunId))) ||
    !limit(record.limit)
  )
    invalid();
  return Object.freeze({
    ...common(record),
    operation: 'workflow_step_list',
    packageName: record.packageName as string,
    workflowId: record.workflowId as string,
    runId: record.runId as string,
    afterStepKey: record.afterStepKey as string | null,
    afterStepRunId: record.afterStepRunId as string | null,
    limit: record.limit as number,
  });
}

export function clusterCopilotConsoleClientCommand(
  request: Readonly<ClusterCopilotConsoleReadRequest>,
): Readonly<ClusterCopilotClientCommand> {
  const normalized = normalizeClusterCopilotConsoleReadRequest(request);
  if (normalized.operation !== 'inspect' && normalized.operation !== 'output')
    invalid();
  return Object.freeze({
    schema: CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
    operation: normalized.operation,
    projectId: normalized.projectId,
    sourceRunId: normalized.sourceRunId,
    requestId: normalized.requestId,
  });
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function query(
  entries: readonly (readonly [string, string | number])[],
): string {
  return entries.length === 0
    ? ''
    : '?' +
        entries
          .map(([key, value]) => encoded(key) + '=' + encoded(String(value)))
          .join('&');
}

export function clusterCopilotConsoleProjectReadPath(
  request: Readonly<ClusterCopilotConsoleReadRequest>,
): string {
  const normalized = normalizeClusterCopilotConsoleReadRequest(request);
  if (
    normalized.operation === 'inspect' ||
    normalized.operation === 'output' ||
    normalized.operation === 'run_cancellation_status' ||
    normalized.operation === 'run_cancellation_blocked_list' ||
    normalized.operation === 'run_cancellation_inspect'
  )
    invalid();
  const project = '/api/v3/projects/' + encoded(normalized.projectId);
  if (normalized.operation === 'run_list') {
    const cursor: (readonly [string, string | number])[] =
      normalized.afterCreatedAtMs === null
        ? []
        : [
            ['after_created_at_ms', normalized.afterCreatedAtMs],
            ['after_run_id', normalized.afterRunId!],
          ];
    return project + '/runs' + query([...cursor, ['limit', normalized.limit]]);
  }
  if (normalized.operation === 'run_read')
    return project + '/runs/' + encoded(normalized.runId);
  if (normalized.operation === 'run_event_list')
    return (
      project +
      '/runs/' +
      encoded(normalized.runId) +
      '/events' +
      query([
        ['after_sequence', normalized.afterSequence],
        ['limit', normalized.limit],
      ])
    );
  if (normalized.operation === 'run_step_list') {
    const cursor: (readonly [string, string | number])[] =
      normalized.afterStepKey === null
        ? []
        : [
            ['after_step_key', normalized.afterStepKey],
            ['after_step_run_id', normalized.afterStepRunId!],
          ];
    return (
      project +
      '/runs/' +
      encoded(normalized.runId) +
      '/steps' +
      query([...cursor, ['limit', normalized.limit]])
    );
  }
  if (normalized.operation === 'task_list') {
    const cursor: (readonly [string, string | number])[] =
      normalized.afterTaskId === null
        ? []
        : [['after_task_id', normalized.afterTaskId]];
    return project + '/tasks' + query([...cursor, ['limit', normalized.limit]]);
  }
  if (normalized.operation === 'task_read')
    return project + '/tasks/' + encoded(normalized.taskId);
  const packageRoot = project + '/packages/' + encoded(normalized.packageName);
  if (normalized.operation === 'workflow_list')
    return packageRoot + '/workflows';
  const workflowRoot =
    packageRoot + '/workflows/' + encoded(normalized.workflowId);
  if (normalized.operation === 'workflow_run_list') {
    const cursor: (readonly [string, string | number])[] =
      normalized.afterAdmittedAtMs === null
        ? []
        : [
            ['after_admitted_at_ms', normalized.afterAdmittedAtMs],
            ['after_run_id', normalized.afterRunId!],
          ];
    return (
      workflowRoot + '/runs' + query([...cursor, ['limit', normalized.limit]])
    );
  }
  const runRoot = workflowRoot + '/runs/' + encoded(normalized.runId);
  if (normalized.operation === 'workflow_run_read') return runRoot;
  if (normalized.operation === 'workflow_event_list')
    return (
      runRoot +
      '/events' +
      query([
        ['after_sequence', normalized.afterSequence],
        ['limit', normalized.limit],
      ])
    );
  const cursor: (readonly [string, string | number])[] =
    normalized.afterStepKey === null
      ? []
      : [
          ['after_step_key', normalized.afterStepKey],
          ['after_step_run_id', normalized.afterStepRunId!],
        ];
  return runRoot + '/steps' + query([...cursor, ['limit', normalized.limit]]);
}
