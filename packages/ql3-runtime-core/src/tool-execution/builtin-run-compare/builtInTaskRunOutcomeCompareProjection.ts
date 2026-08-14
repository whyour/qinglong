import type { RunRepositoryReader } from '../../run/runRepository';
import {
  BoundedRunReadProjectionUnavailableError,
  executeBoundedRunReadProjection,
  type BoundedRunReadProjection,
} from '../../run/projection/boundedRunReadProjection';
import {
  MAX_TASK_RUN_OUTCOME_WINDOW_STORAGE_LIMIT,
  normalizeTaskRunOutcomeWindowQuery,
  normalizeTaskRunOutcomeWindowRecord,
  type TaskRunOutcomeWindowReader,
  type TaskRunOutcomeWindowRecord,
} from '../../run/outcome-comparison/taskRunOutcomeWindow';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '../tool-registry/toolRegistry';
import {
  BUILTIN_RUN_COMPARABLE_FIELDS,
  BUILTIN_RUN_PROJECTION_SCHEMA,
  compareBoundedRunProjections,
} from './builtInRunCompareProjection';

export const BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL = Object.freeze({
  name: 'qinglong.task.runs.compare',
  version: '1.0.0',
});
export const BUILTIN_TASK_RUN_OUTCOME_COMPARE_TIMEOUT_SECONDS = 5;
export const TASK_RUN_OUTCOME_SEARCH_LIMIT = 64;

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export const BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL_DEFINITION =
  normalizeToolDefinition({
    name: BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL.name,
    version: BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL.version,
    description:
      'Compare the latest succeeded and failed Runs found in one fixed bounded Task history window',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 255 },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 255 },
        baselineOutcome: {
          type: 'string',
          maxLength: 16,
          enum: ['succeeded'] as const,
        },
        candidateOutcome: {
          type: 'string',
          maxLength: 16,
          enum: ['failed'] as const,
        },
        baseline: BUILTIN_RUN_PROJECTION_SCHEMA,
        candidate: BUILTIN_RUN_PROJECTION_SCHEMA,
        comparable: { type: 'boolean' },
        sameTask: { type: 'boolean' },
        sameTaskRevision: { type: 'boolean' },
        changedFields: {
          type: 'array',
          items: {
            type: 'string',
            maxLength: 32,
            enum: BUILTIN_RUN_COMPARABLE_FIELDS,
          },
          maxItems: BUILTIN_RUN_COMPARABLE_FIELDS.length,
        },
        queueDelayDeltaMs: {
          type: 'integer',
          minimum: -Number.MAX_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        executionDurationDeltaMs: {
          type: 'integer',
          minimum: -Number.MAX_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        totalDurationDeltaMs: {
          type: 'integer',
          minimum: -Number.MAX_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        selection: {
          type: 'object',
          properties: {
            windowLimit: {
              type: 'integer',
              minimum: TASK_RUN_OUTCOME_SEARCH_LIMIT,
              maximum: TASK_RUN_OUTCOME_SEARCH_LIMIT,
            },
            searchedRunCount: {
              type: 'integer',
              minimum: 0,
              maximum: TASK_RUN_OUTCOME_SEARCH_LIMIT,
            },
            hasOlderRuns: { type: 'boolean' },
            complete: { type: 'boolean' },
            order: {
              type: 'string',
              maxLength: 32,
              enum: ['created_at_desc_id_desc'] as const,
            },
          },
          required: [
            'windowLimit',
            'searchedRunCount',
            'hasOlderRuns',
            'complete',
            'order',
          ],
          additionalProperties: false,
        },
        consistency: {
          type: 'string',
          maxLength: 64,
          enum: ['bounded_task_window_then_ordered_point_reads'] as const,
        },
      },
      required: [
        'taskId',
        'baselineOutcome',
        'candidateOutcome',
        'baseline',
        'candidate',
        'comparable',
        'sameTask',
        'sameTaskRevision',
        'changedFields',
        'selection',
        'consistency',
      ],
      additionalProperties: false,
    },
    effect: 'read',
    risk: 'low',
    requiredPermissions: ['run.read'],
    timeoutSeconds: BUILTIN_TASK_RUN_OUTCOME_COMPARE_TIMEOUT_SECONDS,
  });

export class InvalidBuiltInTaskRunOutcomeCompareToolError extends TypeError {
  readonly code = 'BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Task Run outcome compare Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInTaskRunOutcomeCompareToolError';
  }
}

export class BuiltInTaskRunOutcomeCompareToolUnavailableError extends Error {
  readonly code = 'BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Task Run outcome compare Tool is unavailable');
    this.name = 'BuiltInTaskRunOutcomeCompareToolUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidBuiltInTaskRunOutcomeCompareToolError(message);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

function isStrictlyOlder(
  value: Readonly<TaskRunOutcomeWindowRecord>,
  previous: Readonly<TaskRunOutcomeWindowRecord>,
): boolean {
  return (
    value.createdAtMs < previous.createdAtMs ||
    (value.createdAtMs === previous.createdAtMs && value.id < previous.id)
  );
}

async function selectOutcomeWindow(
  windows: TaskRunOutcomeWindowReader,
  projectId: string,
  taskId: string,
): Promise<
  Readonly<{
    latestSucceededRunId?: string;
    latestFailedRunId?: string;
    searchedRunCount: number;
    hasOlderRuns: boolean;
    complete: boolean;
  }>
> {
  let rows: readonly Readonly<TaskRunOutcomeWindowRecord>[];
  try {
    rows = await windows.listRecentRunsByTask(
      normalizeTaskRunOutcomeWindowQuery({
        projectId,
        taskId,
        limit: MAX_TASK_RUN_OUTCOME_WINDOW_STORAGE_LIMIT,
      }),
    );
  } catch {
    throw new BuiltInTaskRunOutcomeCompareToolUnavailableError();
  }
  if (
    !Array.isArray(rows) ||
    rows.length > MAX_TASK_RUN_OUTCOME_WINDOW_STORAGE_LIMIT
  ) {
    throw new BuiltInTaskRunOutcomeCompareToolUnavailableError();
  }

  let previous: Readonly<TaskRunOutcomeWindowRecord> | undefined;
  let latestSucceededRunId: string | undefined;
  let latestFailedRunId: string | undefined;
  for (const row of rows) {
    let normalized: Readonly<TaskRunOutcomeWindowRecord>;
    try {
      normalized = normalizeTaskRunOutcomeWindowRecord(row);
    } catch {
      throw new BuiltInTaskRunOutcomeCompareToolUnavailableError();
    }
    if (
      normalized.projectId !== projectId ||
      normalized.taskId !== taskId ||
      (previous !== undefined && !isStrictlyOlder(normalized, previous))
    ) {
      throw new BuiltInTaskRunOutcomeCompareToolUnavailableError();
    }
    previous = normalized;
  }

  const window = rows.slice(0, TASK_RUN_OUTCOME_SEARCH_LIMIT);
  for (const row of window) {
    if (row.status === 'succeeded' && latestSucceededRunId === undefined) {
      latestSucceededRunId = row.id;
    }
    if (row.status === 'failed' && latestFailedRunId === undefined) {
      latestFailedRunId = row.id;
    }
    if (latestSucceededRunId !== undefined && latestFailedRunId !== undefined) {
      break;
    }
  }
  const hasOlderRuns = rows.length > TASK_RUN_OUTCOME_SEARCH_LIMIT;
  const complete =
    !hasOlderRuns ||
    (latestSucceededRunId !== undefined && latestFailedRunId !== undefined);
  return Object.freeze({
    ...(latestSucceededRunId === undefined ? {} : { latestSucceededRunId }),
    ...(latestFailedRunId === undefined ? {} : { latestFailedRunId }),
    searchedRunCount: window.length,
    hasOlderRuns,
    complete,
  });
}

async function selectedProjection(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  projectId: string,
  taskId: string,
  expectedStatus: 'succeeded' | 'failed',
  runId: string | undefined,
): Promise<Readonly<BoundedRunReadProjection>> {
  if (runId === undefined) return Object.freeze({ found: false });
  const projection = await executeBoundedRunReadProjection(
    runs,
    projectId,
    runId,
  );
  if (
    projection.found !== true ||
    projection.taskId !== taskId ||
    projection.status !== expectedStatus
  ) {
    throw new BuiltInTaskRunOutcomeCompareToolUnavailableError();
  }
  return projection;
}

export async function executeBuiltInTaskRunOutcomeCompareTool(
  windows: TaskRunOutcomeWindowReader,
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const inputRecord =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  if (
    !windows ||
    typeof windows.listRecentRunsByTask !== 'function' ||
    !runs ||
    typeof runs.findRunById !== 'function' ||
    !boundedText(projectId, 128) ||
    !inputRecord ||
    Reflect.ownKeys(inputRecord).length !== 1 ||
    !boundedText(inputRecord.taskId, 255)
  ) {
    return invalid('execution context or input is invalid');
  }

  try {
    const selected = await selectOutcomeWindow(
      windows,
      projectId,
      inputRecord.taskId,
    );
    const baseline = await selectedProjection(
      runs,
      projectId,
      inputRecord.taskId,
      'succeeded',
      selected.latestSucceededRunId,
    );
    const candidate = await selectedProjection(
      runs,
      projectId,
      inputRecord.taskId,
      'failed',
      selected.latestFailedRunId,
    );
    const comparison = compareBoundedRunProjections(
      baseline,
      candidate,
      'bounded_task_window_then_ordered_point_reads',
    );
    return Object.freeze({
      taskId: inputRecord.taskId,
      baselineOutcome: 'succeeded',
      candidateOutcome: 'failed',
      ...comparison,
      selection: Object.freeze({
        windowLimit: TASK_RUN_OUTCOME_SEARCH_LIMIT,
        searchedRunCount: selected.searchedRunCount,
        hasOlderRuns: selected.hasOlderRuns,
        complete: selected.complete,
        order: 'created_at_desc_id_desc',
      }),
    });
  } catch (error) {
    if (
      error instanceof BuiltInTaskRunOutcomeCompareToolUnavailableError ||
      error instanceof BoundedRunReadProjectionUnavailableError
    ) {
      throw new BuiltInTaskRunOutcomeCompareToolUnavailableError();
    }
    return invalid('execution context or input is invalid');
  }
}
