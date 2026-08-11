import type { RunRecord } from '../run';
import type { RunRepositoryReader } from '../runRepository';
import {
  normalizeListStepRunsResult,
  type StepRunKind,
  type StepRunRecord,
  type StepRunRepository,
  type StepRunStatus,
} from '../stepRun';

export const DEFAULT_BOUNDED_RUN_STEP_LIST_LIMIT = 32;
export const MAX_BOUNDED_RUN_STEP_LIST_LIMIT = 64;

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface BoundedRunStepListCursor {
  readonly stepKey: string;
  readonly stepRunId: string;
}

export interface BoundedRunStepListInput {
  readonly after?: Readonly<BoundedRunStepListCursor>;
  readonly limit?: number;
}

export interface BoundedRunStepListItem {
  readonly id: string;
  readonly parentStepRunId: string | null;
  readonly stepKey: string;
  readonly kind: StepRunKind;
  readonly required: boolean;
  readonly status: StepRunStatus;
  readonly version: number;
  readonly attemptCount: number;
  readonly readyAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly resultCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface BoundedRunStepListProjection {
  readonly found: boolean;
  readonly steps: readonly Readonly<BoundedRunStepListItem>[];
  readonly hasMore: boolean;
  readonly next: Readonly<BoundedRunStepListCursor> | null;
}

export class InvalidBoundedRunStepListProjectionError extends TypeError {
  readonly code = 'BOUNDED_RUN_STEP_LIST_PROJECTION_INVALID';

  constructor() {
    super('Bounded Run Step list projection input is invalid');
    this.name = 'InvalidBoundedRunStepListProjectionError';
  }
}

export class BoundedRunStepListProjectionUnavailableError extends Error {
  readonly code = 'BOUNDED_RUN_STEP_LIST_PROJECTION_UNAVAILABLE';

  constructor() {
    super('Bounded Run Step list projection is unavailable');
    this.name = 'BoundedRunStepListProjectionUnavailableError';
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

function normalizeInput(value: Readonly<BoundedRunStepListInput>): Readonly<{
  after?: Readonly<BoundedRunStepListCursor>;
  limit: number;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidBoundedRunStepListProjectionError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 2 ||
    keys.some((key) => key !== 'after' && key !== 'limit') ||
    (value.limit !== undefined &&
      (!Number.isSafeInteger(value.limit) ||
        value.limit < 1 ||
        value.limit > MAX_BOUNDED_RUN_STEP_LIST_LIMIT))
  ) {
    throw new InvalidBoundedRunStepListProjectionError();
  }
  let after: Readonly<BoundedRunStepListCursor> | undefined;
  if (value.after !== undefined) {
    if (
      !value.after ||
      typeof value.after !== 'object' ||
      Array.isArray(value.after) ||
      Reflect.ownKeys(value.after).length !== 2 ||
      !Object.hasOwn(value.after, 'stepKey') ||
      !Object.hasOwn(value.after, 'stepRunId') ||
      !boundedText(value.after.stepKey, 128) ||
      !boundedText(value.after.stepRunId, 128)
    ) {
      throw new InvalidBoundedRunStepListProjectionError();
    }
    after = Object.freeze({
      stepKey: value.after.stepKey,
      stepRunId: value.after.stepRunId,
    });
  }
  return Object.freeze({
    ...(after === undefined ? {} : { after }),
    limit: value.limit ?? DEFAULT_BOUNDED_RUN_STEP_LIST_LIMIT,
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

function projectStep(
  value: Readonly<StepRunRecord>,
): Readonly<BoundedRunStepListItem> {
  return Object.freeze({
    id: value.id,
    parentStepRunId: value.parentStepRunId,
    stepKey: value.stepKey,
    kind: value.kind,
    required: value.required,
    status: value.status,
    version: value.version,
    attemptCount: value.attemptCount,
    readyAtMs: value.readyAtMs,
    startedAtMs: value.startedAtMs,
    finishedAtMs: value.finishedAtMs,
    resultCode: value.resultCode,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

export async function executeBoundedRunStepListProjection(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  stepRuns: Pick<StepRunRepository, 'listByRun'>,
  projectId: string,
  runId: string,
  input: Readonly<BoundedRunStepListInput>,
): Promise<Readonly<BoundedRunStepListProjection>> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    !stepRuns ||
    typeof stepRuns.listByRun !== 'function' ||
    !boundedText(projectId, 128) ||
    !boundedText(runId, 128)
  ) {
    throw new InvalidBoundedRunStepListProjectionError();
  }
  const normalized = normalizeInput(input);
  let run: RunRecord | null;
  try {
    run = await runs.findRunById(runId);
  } catch {
    throw new BoundedRunStepListProjectionUnavailableError();
  }
  if (!run || !ownsRun(run, projectId, runId)) {
    return Object.freeze({
      found: false,
      steps: Object.freeze([]),
      hasMore: false,
      next: null,
    });
  }

  const query = Object.freeze({
    runId,
    limit: normalized.limit,
    ...(normalized.after === undefined
      ? {}
      : {
          after: Object.freeze({
            stepKey: normalized.after.stepKey,
            id: normalized.after.stepRunId,
          }),
        }),
  });
  try {
    const page = normalizeListStepRunsResult(
      await stepRuns.listByRun(query),
      query,
    );
    const ids = new Set<string>();
    const stepKeys = new Set<string>();
    for (const step of page.stepRuns) {
      if (ids.has(step.id) || stepKeys.has(step.stepKey)) {
        throw new BoundedRunStepListProjectionUnavailableError();
      }
      ids.add(step.id);
      stepKeys.add(step.stepKey);
    }
    return Object.freeze({
      found: true,
      steps: Object.freeze(page.stepRuns.map(projectStep)),
      hasMore: page.truncated,
      next:
        page.next === undefined
          ? null
          : Object.freeze({
              stepKey: page.next.stepKey,
              stepRunId: page.next.id,
            }),
    });
  } catch (error) {
    if (error instanceof BoundedRunStepListProjectionUnavailableError) {
      throw error;
    }
    throw new BoundedRunStepListProjectionUnavailableError();
  }
}
