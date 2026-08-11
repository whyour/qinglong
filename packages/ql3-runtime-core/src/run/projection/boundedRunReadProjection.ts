import { EXECUTION_ORIGINS, RUN_STATUSES, type RunRecord } from '../run';
import type { RunRepositoryReader } from '../runRepository';

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type BoundedRunReadProjection = Readonly<
  Record<string, boolean | string | number>
>;

export class BoundedRunReadProjectionUnavailableError extends Error {
  readonly code = 'BOUNDED_RUN_READ_PROJECTION_UNAVAILABLE';

  constructor() {
    super('Bounded Run read projection is unavailable');
    this.name = 'BoundedRunReadProjectionUnavailableError';
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function optionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || integer(value, 0, Number.MAX_SAFE_INTEGER);
}

function projectRun(
  value: RunRecord,
  projectId: string,
  runId: string,
): BoundedRunReadProjection | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.projectId !== projectId ||
    value.id !== runId ||
    !boundedText(value.id, 128) ||
    !boundedText(value.projectId, 128) ||
    !boundedText(value.taskId, 255) ||
    !boundedText(value.taskRevision, 255) ||
    !RUN_STATUSES.includes(value.status) ||
    !EXECUTION_ORIGINS.includes(value.executionOrigin) ||
    (value.executionOwner !== 'legacy' && value.executionOwner !== 'runtime') ||
    !integer(value.version, 0, MAX_INT) ||
    !integer(value.eventSequence, 0, MAX_INT) ||
    !integer(value.priority, MIN_INT, MAX_INT) ||
    !integer(value.createdAtMs, 0, Number.MAX_SAFE_INTEGER) ||
    !optionalTimestamp(value.queuedAtMs) ||
    !optionalTimestamp(value.startedAtMs) ||
    !optionalTimestamp(value.finishedAtMs)
  ) {
    return null;
  }
  return Object.freeze({
    found: true,
    id: value.id,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    status: value.status,
    version: value.version,
    eventSequence: value.eventSequence,
    priority: value.priority,
    executionOrigin: value.executionOrigin,
    executionOwner: value.executionOwner,
    createdAtMs: value.createdAtMs,
    ...(value.queuedAtMs === undefined ? {} : { queuedAtMs: value.queuedAtMs }),
    ...(value.startedAtMs === undefined
      ? {}
      : { startedAtMs: value.startedAtMs }),
    ...(value.finishedAtMs === undefined
      ? {}
      : { finishedAtMs: value.finishedAtMs }),
  });
}

export async function executeBoundedRunReadProjection(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  projectId: string,
  runId: string,
): Promise<BoundedRunReadProjection> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    !boundedText(projectId, 128) ||
    !boundedText(runId, 128)
  ) {
    throw new TypeError('Bounded Run read projection input is invalid');
  }
  let run: RunRecord | null;
  try {
    run = await runs.findRunById(runId);
  } catch {
    throw new BoundedRunReadProjectionUnavailableError();
  }
  if (!run || run.projectId !== projectId) {
    return Object.freeze({ found: false });
  }
  const projection = projectRun(run, projectId, runId);
  if (!projection) throw new BoundedRunReadProjectionUnavailableError();
  return projection;
}
