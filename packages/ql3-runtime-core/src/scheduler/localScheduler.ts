export const MAX_LOCAL_SCHEDULE_PAGE_SIZE = 256;
export const MAX_LOCAL_SCHEDULE_MISFIRE_GRACE_MS = 5 * 60_000;

export type LocalCronMisfirePolicy = 'skip' | 'fire_once';

export interface LocalCronSchedule {
  readonly expression: string;
  readonly timezone: string;
}

export type LocalCronNextOccurrence = (
  schedule: LocalCronSchedule,
  afterMs: number,
) => number;

export interface LocalScheduleCandidate {
  readonly projectId: string;
  readonly triggerId: string;
  readonly triggerRevision: number;
  readonly triggerContentDigest: string;
  readonly triggerUpdatedAtMs: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentDigest: string;
  readonly expression: string;
  readonly timezone: string;
  readonly misfirePolicy: LocalCronMisfirePolicy;
  readonly stateVersion: number;
  readonly nextFireAtMs: number | null;
}

export interface LocalScheduleDecision {
  readonly candidate: LocalScheduleCandidate;
  readonly observedAtMs: number;
  readonly nextFireAtMs: number;
  readonly scheduledForMs?: number;
  readonly disposition: 'initialize' | 'skip' | 'admit';
}

export interface LocalScheduleCandidatePage {
  readonly candidates: readonly LocalScheduleCandidate[];
  readonly truncated: boolean;
}

export interface CommitLocalScheduleDecisionCommand {
  readonly decision: LocalScheduleDecision;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly createdEventId?: string;
  readonly queuedEventId?: string;
}

export type CommitLocalScheduleDecisionResult = Readonly<
  | { status: 'advanced'; disposition: 'initialize' | 'skip' }
  | {
      status: 'admitted';
      disposition: 'admit';
      runId: string;
      attemptId: string;
    }
  | { status: 'raced' }
>;

export interface LocalScheduleStore {
  listLocalScheduleCandidates(options: {
    readonly observedAtMs: number;
    readonly limit: number;
  }): Promise<LocalScheduleCandidatePage>;
  commitLocalScheduleDecision(
    command: CommitLocalScheduleDecisionCommand,
  ): Promise<CommitLocalScheduleDecisionResult>;
}

export class InvalidLocalScheduleError extends TypeError {
  readonly code = 'LOCAL_SCHEDULE_INVALID';

  constructor(message: string) {
    super(`Local schedule is invalid: ${message}`);
    this.name = 'InvalidLocalScheduleError';
  }
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidLocalScheduleError(`${label} is invalid`);
  }
  return value as number;
}

function positiveRevision(value: unknown, label: string): number {
  const result = timestamp(value, label);
  if (result < 1 || result > 2_147_483_647) {
    throw new InvalidLocalScheduleError(`${label} is invalid`);
  }
  return result;
}

function text(value: unknown, label: string, maximumBytes = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new InvalidLocalScheduleError(`${label} is invalid`);
  }
  return value;
}

export function assertLocalSchedulePageSize(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOCAL_SCHEDULE_PAGE_SIZE
  ) {
    throw new RangeError(
      `Local schedule page size must be between 1 and ${MAX_LOCAL_SCHEDULE_PAGE_SIZE}`,
    );
  }
}

export function normalizeLocalScheduleCandidate(
  value: LocalScheduleCandidate,
): LocalScheduleCandidate {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'expression,misfirePolicy,nextFireAtMs,projectId,stateVersion,taskContentDigest,taskId,taskRevision,timezone,triggerContentDigest,triggerId,triggerRevision,triggerUpdatedAtMs'
  ) {
    throw new InvalidLocalScheduleError('candidate shape is invalid');
  }
  const triggerContentDigest = text(
    value.triggerContentDigest,
    'triggerContentDigest',
    64,
  );
  const taskContentDigest = text(
    value.taskContentDigest,
    'taskContentDigest',
    64,
  );
  if (
    !/^[0-9a-f]{64}$/.test(triggerContentDigest) ||
    !/^[0-9a-f]{64}$/.test(taskContentDigest) ||
    (value.misfirePolicy !== 'skip' && value.misfirePolicy !== 'fire_once') ||
    (value.nextFireAtMs !== null &&
      (!Number.isSafeInteger(value.nextFireAtMs) || value.nextFireAtMs < 0))
  ) {
    throw new InvalidLocalScheduleError('candidate content is invalid');
  }
  return Object.freeze({
    projectId: text(value.projectId, 'projectId'),
    triggerId: text(value.triggerId, 'triggerId'),
    triggerRevision: positiveRevision(value.triggerRevision, 'triggerRevision'),
    triggerContentDigest,
    triggerUpdatedAtMs: timestamp(
      value.triggerUpdatedAtMs,
      'triggerUpdatedAtMs',
    ),
    taskId: text(value.taskId, 'taskId'),
    taskRevision: positiveRevision(value.taskRevision, 'taskRevision'),
    taskContentDigest,
    expression: text(value.expression, 'expression', 768),
    timezone: text(value.timezone, 'timezone'),
    misfirePolicy: value.misfirePolicy,
    stateVersion: timestamp(value.stateVersion, 'stateVersion'),
    nextFireAtMs: value.nextFireAtMs === null ? null : value.nextFireAtMs,
  });
}

function cronNext(
  candidate: LocalScheduleCandidate,
  afterMs: number,
  nextOccurrence: LocalCronNextOccurrence,
): number {
  try {
    if (
      candidate.expression.startsWith('@') ||
      typeof nextOccurrence !== 'function'
    ) {
      throw new Error('cron provider is invalid');
    }
    const value = timestamp(
      nextOccurrence(
        Object.freeze({
          expression: candidate.expression,
          timezone: candidate.timezone,
        }),
        afterMs,
      ),
      'next cron occurrence',
    );
    if (value <= afterMs) {
      throw new Error('cron provider did not advance time');
    }
    return value;
  } catch {
    throw new InvalidLocalScheduleError('cron calculation failed');
  }
}

export function initialLocalCronNextFireAt(
  candidate: Pick<
    LocalScheduleCandidate,
    'expression' | 'timezone' | 'triggerUpdatedAtMs'
  >,
  nextOccurrence: LocalCronNextOccurrence,
): number {
  const normalized = normalizeLocalScheduleCandidate({
    projectId: '_',
    triggerId: '_',
    triggerRevision: 1,
    triggerContentDigest: '0'.repeat(64),
    triggerUpdatedAtMs: candidate.triggerUpdatedAtMs,
    taskId: '_',
    taskRevision: 1,
    taskContentDigest: '0'.repeat(64),
    expression: candidate.expression,
    timezone: candidate.timezone,
    misfirePolicy: 'skip',
    stateVersion: 0,
    nextFireAtMs: null,
  });
  return cronNext(
    normalized,
    Math.max(0, normalized.triggerUpdatedAtMs - 1),
    nextOccurrence,
  );
}

export function resolveLocalScheduleDecision(
  value: LocalScheduleCandidate,
  observedAtMs: number,
  misfireGraceMs: number,
  nextOccurrence: LocalCronNextOccurrence,
): LocalScheduleDecision {
  const candidate = normalizeLocalScheduleCandidate(value);
  const observed = timestamp(observedAtMs, 'observedAtMs');
  if (
    !Number.isSafeInteger(misfireGraceMs) ||
    misfireGraceMs < 0 ||
    misfireGraceMs > MAX_LOCAL_SCHEDULE_MISFIRE_GRACE_MS
  ) {
    throw new RangeError(
      `Local schedule misfire grace must be between 0 and ${MAX_LOCAL_SCHEDULE_MISFIRE_GRACE_MS}`,
    );
  }
  const dueAtMs =
    candidate.nextFireAtMs ??
    initialLocalCronNextFireAt(candidate, nextOccurrence);
  if (dueAtMs > observed) {
    return Object.freeze({
      candidate,
      observedAtMs: observed,
      nextFireAtMs: dueAtMs,
      disposition: 'initialize' as const,
    });
  }
  const late = observed - dueAtMs > misfireGraceMs;
  if (late && candidate.misfirePolicy === 'skip') {
    return Object.freeze({
      candidate,
      observedAtMs: observed,
      nextFireAtMs: cronNext(candidate, observed, nextOccurrence),
      disposition: 'skip' as const,
    });
  }
  const scheduledForMs = dueAtMs;
  return Object.freeze({
    candidate,
    observedAtMs: observed,
    scheduledForMs,
    nextFireAtMs: cronNext(candidate, observed, nextOccurrence),
    disposition: 'admit' as const,
  });
}
