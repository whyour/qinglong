import {
  RUN_EVENT_ACTOR_TYPES,
  type RunEventRecord,
  type RunRecord,
} from '../run';
import type { RunRepositoryReader } from '../runRepository';

export const DEFAULT_BOUNDED_RUN_EVENT_LIST_LIMIT = 32;
export const MAX_BOUNDED_RUN_EVENT_LIST_LIMIT = 64;

const MAX_INT = 2_147_483_647;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface BoundedRunEventListInput {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface BoundedRunEventListItem {
  readonly sequence: number;
  readonly type: string;
  readonly actorType: RunEventRecord['actorType'];
  readonly createdAtMs: number;
}

export interface BoundedRunEventListProjection {
  readonly found: boolean;
  readonly events: readonly Readonly<BoundedRunEventListItem>[];
  readonly hasMore: boolean;
  readonly nextAfterSequence: number;
}

export class InvalidBoundedRunEventListProjectionError extends TypeError {
  readonly code = 'BOUNDED_RUN_EVENT_LIST_PROJECTION_INVALID';

  constructor() {
    super('Bounded Run event list projection input is invalid');
    this.name = 'InvalidBoundedRunEventListProjectionError';
  }
}

export class BoundedRunEventListProjectionUnavailableError extends Error {
  readonly code = 'BOUNDED_RUN_EVENT_LIST_PROJECTION_UNAVAILABLE';

  constructor() {
    super('Bounded Run event list projection is unavailable');
    this.name = 'BoundedRunEventListProjectionUnavailableError';
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

function normalizeInput(value: Readonly<BoundedRunEventListInput>): Readonly<{
  afterSequence: number;
  limit: number;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidBoundedRunEventListProjectionError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 2 ||
    keys.some((key) => key !== 'afterSequence' && key !== 'limit') ||
    (value.afterSequence !== undefined &&
      !integer(value.afterSequence, 0, MAX_INT)) ||
    (value.limit !== undefined &&
      !integer(value.limit, 1, MAX_BOUNDED_RUN_EVENT_LIST_LIMIT))
  ) {
    throw new InvalidBoundedRunEventListProjectionError();
  }
  return Object.freeze({
    afterSequence: value.afterSequence ?? 0,
    limit: value.limit ?? DEFAULT_BOUNDED_RUN_EVENT_LIST_LIMIT,
  });
}

function ownsRun(value: RunRecord, projectId: string, runId: string): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.projectId === projectId &&
    value.id === runId &&
    boundedText(value.projectId, 128) &&
    boundedText(value.id, 128)
  );
}

function projectEvent(
  value: RunEventRecord,
  runId: string,
  previousSequence: number,
): Readonly<BoundedRunEventListItem> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.runId !== runId ||
    !integer(value.sequence, previousSequence + 1, MAX_INT) ||
    !boundedText(value.type, 128) ||
    !RUN_EVENT_ACTOR_TYPES.includes(value.actorType) ||
    !integer(value.createdAtMs, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  return Object.freeze({
    sequence: value.sequence,
    type: value.type,
    actorType: value.actorType,
    createdAtMs: value.createdAtMs,
  });
}

export async function executeBoundedRunEventListProjection(
  runs: Pick<RunRepositoryReader, 'findRunById' | 'listEvents'>,
  projectId: string,
  runId: string,
  input: Readonly<BoundedRunEventListInput>,
): Promise<Readonly<BoundedRunEventListProjection>> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    typeof runs.listEvents !== 'function' ||
    !boundedText(projectId, 128) ||
    !boundedText(runId, 128)
  ) {
    throw new InvalidBoundedRunEventListProjectionError();
  }
  const normalized = normalizeInput(input);
  let run: RunRecord | null;
  try {
    run = await runs.findRunById(runId);
  } catch {
    throw new BoundedRunEventListProjectionUnavailableError();
  }
  if (!run || !ownsRun(run, projectId, runId)) {
    return Object.freeze({
      found: false,
      events: Object.freeze([]),
      hasMore: false,
      nextAfterSequence: normalized.afterSequence,
    });
  }

  let rows: RunEventRecord[];
  try {
    rows = await runs.listEvents(runId, {
      afterSequence: normalized.afterSequence,
      limit: normalized.limit + 1,
    });
  } catch {
    throw new BoundedRunEventListProjectionUnavailableError();
  }
  if (!Array.isArray(rows) || rows.length > normalized.limit + 1) {
    throw new BoundedRunEventListProjectionUnavailableError();
  }

  const events: Readonly<BoundedRunEventListItem>[] = [];
  let previousSequence = normalized.afterSequence;
  for (let index = 0; index < rows.length; index += 1) {
    const projected = projectEvent(rows[index]!, runId, previousSequence);
    if (!projected) throw new BoundedRunEventListProjectionUnavailableError();
    previousSequence = projected.sequence;
    if (index < normalized.limit) events.push(projected);
  }
  const lastReturned = events.at(-1);
  return Object.freeze({
    found: true,
    events: Object.freeze(events),
    hasMore: rows.length > normalized.limit,
    nextAfterSequence: lastReturned?.sequence ?? normalized.afterSequence,
  });
}
