import { createHash } from 'node:crypto';

import type {
  RunAttemptLogReadIdentity,
  RunAttemptLogTruncationView,
} from '../log-read/runAttemptLogRead';

export const MAX_RUN_ATTEMPT_LOG_RETENTION_PAGE_SIZE = 64;
export const MAX_RUN_ATTEMPT_LOG_RETENTION_DELETIONS = 16;
export const MIN_RUN_ATTEMPT_LOG_RETENTION_MS = 60_000;
export const MAX_RUN_ATTEMPT_LOG_RETENTION_MS = 365 * 24 * 60 * 60_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type RunAttemptLogRetirementDisposition = 'deleted' | 'already_absent';

export interface RunAttemptLogRetentionCursor {
  readonly finishedAtMs: number;
  readonly attemptId: string;
}

export interface RunAttemptLogRetentionCandidate
  extends RunAttemptLogReadIdentity,
    RunAttemptLogRetentionCursor {
  readonly executorType: 'local_process' | 'remote_worker';
}

export interface RunAttemptLogRetirementRecord
  extends RunAttemptLogRetentionCandidate {
  readonly schema: 'qinglong/run-attempt-log-retirement@v1';
  readonly eligibleAtMs: number;
  readonly retiredAtMs: number;
  readonly disposition: RunAttemptLogRetirementDisposition;
  readonly byteLength: number;
  readonly truncation: Readonly<RunAttemptLogTruncationView>;
  readonly recordDigest: string;
}

export type RunAttemptLogRetentionState =
  | Readonly<{ readonly status: 'active' }>
  | Readonly<{
      readonly status: 'retired';
      readonly record: Readonly<RunAttemptLogRetirementRecord>;
    }>;

export interface RunAttemptLogRetentionStateReader {
  inspect(
    identity: Readonly<RunAttemptLogReadIdentity>,
  ): Promise<RunAttemptLogRetentionState>;
}

export interface RunAttemptLogRetentionPage {
  readonly candidates: readonly RunAttemptLogRetentionCandidate[];
  readonly truncated: boolean;
  readonly nextCursor?: Readonly<RunAttemptLogRetentionCursor>;
}

export interface RunAttemptLogRetentionRepository
  extends RunAttemptLogRetentionStateReader {
  loadCursor(): Promise<Readonly<RunAttemptLogRetentionCursor> | undefined>;
  list(input: {
    readonly cutoffMs: number;
    readonly limit: number;
    readonly cursor?: Readonly<RunAttemptLogRetentionCursor>;
  }): Promise<RunAttemptLogRetentionPage>;
  record(
    record: Readonly<RunAttemptLogRetirementRecord>,
  ): Promise<'recorded' | 'existing'>;
  saveCursor(
    cursor: Readonly<RunAttemptLogRetentionCursor> | undefined,
    updatedAtMs: number,
  ): Promise<void>;
}

export interface RunAttemptLogRetirementStoreResult {
  readonly disposition: RunAttemptLogRetirementDisposition;
  readonly byteLength: number;
  readonly truncation: Readonly<RunAttemptLogTruncationView>;
}

export interface RunAttemptLogRetirementStore {
  retire(
    candidate: Readonly<RunAttemptLogRetentionCandidate>,
  ): Promise<Readonly<RunAttemptLogRetirementStoreResult>>;
}

export interface RunAttemptLogCapacitySnapshot {
  readonly availableBytes: bigint;
  readonly totalBytes: bigint;
}

export interface RunAttemptLogCapacitySource {
  inspect(): Promise<Readonly<RunAttemptLogCapacitySnapshot>>;
}

export interface RunAttemptLogRetentionServiceOptions {
  readonly normalRetentionMs: number;
  readonly pressureRetentionMs: number;
  readonly minimumFreeBytes: number;
  readonly pageSize: number;
  readonly maximumDeletions: number;
  readonly clock?: { now(): number };
}

export interface RunAttemptLogRetentionEntry {
  readonly attemptId: string;
  readonly logArtifactId: string;
  readonly outcome:
    | RunAttemptLogRetirementDisposition
    | 'file_failed'
    | 'record_failed';
  readonly byteLength: number;
}

export interface RunAttemptLogRetentionSweepSummary {
  readonly status: 'complete' | 'page_complete' | 'deletion_budget_exhausted';
  readonly pressure: boolean;
  readonly observedAtMs: number;
  readonly retentionMs: number;
  readonly availableBytes: string;
  readonly totalBytes: string;
  readonly candidatesScanned: number;
  readonly deletionsAttempted: number;
  readonly recordsWritten: number;
  readonly failedCandidates: number;
  readonly bytesReclaimed: number;
  readonly entries: readonly RunAttemptLogRetentionEntry[];
  readonly nextCursor?: Readonly<RunAttemptLogRetentionCursor>;
}

export class InvalidRunAttemptLogRetentionError extends TypeError {
  constructor(message: string) {
    super(`Run Attempt log retention is invalid: ${message}`);
    this.name = 'InvalidRunAttemptLogRetentionError';
  }
}

export class RunAttemptLogRetentionUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Run Attempt log retention is unavailable', options);
    this.name = 'RunAttemptLogRetentionUnavailableError';
  }
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new InvalidRunAttemptLogRetentionError(`${name} shape is invalid`);
  }
}

function id(name: string, value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new InvalidRunAttemptLogRetentionError(`${name} is invalid`);
  }
  return value;
}

function timestamp(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new InvalidRunAttemptLogRetentionError(`${name} is invalid`);
  }
  return Number(value);
}

function nonNegativeInteger(name: string, value: unknown): number {
  return timestamp(name, value);
}

function normalizedTruncation(
  value: Readonly<RunAttemptLogTruncationView>,
): Readonly<RunAttemptLogTruncationView> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunAttemptLogRetentionError('truncation is invalid');
  }
  exactKeys(
    value,
    ['truncated'],
    ['maximumBytes', 'observedAtMs'],
    'truncation',
  );
  if (
    (value.truncated !== true &&
      value.truncated !== false &&
      value.truncated !== 'unknown') ||
    (value.maximumBytes !== undefined &&
      (!Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1)) ||
    (value.observedAtMs !== undefined &&
      (!Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0)) ||
    (value.truncated === 'unknown' &&
      (value.maximumBytes !== undefined || value.observedAtMs !== undefined))
  ) {
    throw new InvalidRunAttemptLogRetentionError('truncation is invalid');
  }
  return Object.freeze({ ...value });
}

export function normalizeRunAttemptLogRetentionCursor(
  value: Readonly<RunAttemptLogRetentionCursor>,
): Readonly<RunAttemptLogRetentionCursor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunAttemptLogRetentionError('cursor is invalid');
  }
  exactKeys(value, ['attemptId', 'finishedAtMs'], [], 'cursor');
  return Object.freeze({
    finishedAtMs: timestamp('finishedAtMs', value.finishedAtMs),
    attemptId: id('attemptId', value.attemptId),
  });
}

export function normalizeRunAttemptLogRetentionCandidate(
  value: Readonly<RunAttemptLogRetentionCandidate>,
): Readonly<RunAttemptLogRetentionCandidate> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunAttemptLogRetentionError('candidate is invalid');
  }
  exactKeys(
    value,
    [
      'attemptId',
      'executorType',
      'finishedAtMs',
      'logArtifactId',
      'projectId',
      'runId',
    ],
    [],
    'candidate',
  );
  if (
    value.executorType !== 'local_process' &&
    value.executorType !== 'remote_worker'
  ) {
    throw new InvalidRunAttemptLogRetentionError('executorType is invalid');
  }
  return Object.freeze({
    projectId: id('projectId', value.projectId),
    runId: id('runId', value.runId),
    attemptId: id('attemptId', value.attemptId),
    logArtifactId: id('logArtifactId', value.logArtifactId),
    executorType: value.executorType,
    finishedAtMs: timestamp('finishedAtMs', value.finishedAtMs),
  });
}

function recordPayload(
  value: Omit<RunAttemptLogRetirementRecord, 'recordDigest'>,
): string {
  return JSON.stringify([
    value.schema,
    value.projectId,
    value.runId,
    value.attemptId,
    value.logArtifactId,
    value.executorType,
    value.finishedAtMs,
    value.eligibleAtMs,
    value.retiredAtMs,
    value.disposition,
    value.byteLength,
    value.truncation.truncated,
    value.truncation.maximumBytes ?? null,
    value.truncation.observedAtMs ?? null,
  ]);
}

export function digestRunAttemptLogRetirementRecord(
  value: Omit<RunAttemptLogRetirementRecord, 'recordDigest'>,
): string {
  return createHash('sha256')
    .update('qinglong/run-attempt-log-retirement@v1\0', 'utf8')
    .update(recordPayload(value), 'utf8')
    .digest('hex');
}

export function createRunAttemptLogRetirementRecord(
  input: Omit<RunAttemptLogRetirementRecord, 'recordDigest' | 'schema'>,
): Readonly<RunAttemptLogRetirementRecord> {
  const value = {
    schema: 'qinglong/run-attempt-log-retirement@v1' as const,
    ...input,
  };
  return normalizeRunAttemptLogRetirementRecord({
    ...value,
    recordDigest: digestRunAttemptLogRetirementRecord(value),
  });
}

export function normalizeRunAttemptLogRetirementRecord(
  value: Readonly<RunAttemptLogRetirementRecord>,
): Readonly<RunAttemptLogRetirementRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunAttemptLogRetentionError('record is invalid');
  }
  exactKeys(
    value,
    [
      'attemptId',
      'byteLength',
      'disposition',
      'eligibleAtMs',
      'executorType',
      'finishedAtMs',
      'logArtifactId',
      'projectId',
      'recordDigest',
      'retiredAtMs',
      'runId',
      'schema',
      'truncation',
    ],
    [],
    'record',
  );
  const candidate = normalizeRunAttemptLogRetentionCandidate({
    projectId: value.projectId,
    runId: value.runId,
    attemptId: value.attemptId,
    logArtifactId: value.logArtifactId,
    executorType: value.executorType,
    finishedAtMs: value.finishedAtMs,
  });
  const record = Object.freeze({
    schema: value.schema,
    ...candidate,
    eligibleAtMs: timestamp('eligibleAtMs', value.eligibleAtMs),
    retiredAtMs: timestamp('retiredAtMs', value.retiredAtMs),
    disposition: value.disposition,
    byteLength: nonNegativeInteger('byteLength', value.byteLength),
    truncation: normalizedTruncation(value.truncation),
    recordDigest: value.recordDigest,
  });
  if (
    record.schema !== 'qinglong/run-attempt-log-retirement@v1' ||
    (record.disposition !== 'deleted' &&
      record.disposition !== 'already_absent') ||
    record.eligibleAtMs < record.finishedAtMs ||
    record.retiredAtMs < record.eligibleAtMs ||
    (record.disposition === 'already_absent' && record.byteLength !== 0) ||
    typeof record.recordDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.recordDigest) ||
    digestRunAttemptLogRetirementRecord(record) !== record.recordDigest
  ) {
    throw new InvalidRunAttemptLogRetentionError('record evidence is invalid');
  }
  return record;
}

function assertOptions(options: RunAttemptLogRetentionServiceOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new InvalidRunAttemptLogRetentionError('options are invalid');
  }
  const integer = (value: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (
    !integer(
      options.normalRetentionMs,
      MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
      MAX_RUN_ATTEMPT_LOG_RETENTION_MS,
    ) ||
    !integer(
      options.pressureRetentionMs,
      MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
      options.normalRetentionMs,
    ) ||
    !integer(options.minimumFreeBytes, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(options.pageSize, 1, MAX_RUN_ATTEMPT_LOG_RETENTION_PAGE_SIZE) ||
    !integer(
      options.maximumDeletions,
      1,
      Math.min(options.pageSize, MAX_RUN_ATTEMPT_LOG_RETENTION_DELETIONS),
    ) ||
    (options.clock !== undefined && typeof options.clock.now !== 'function')
  ) {
    throw new InvalidRunAttemptLogRetentionError('options are invalid');
  }
}

export class RunAttemptLogRetentionService {
  private readonly clock: { now(): number };

  constructor(
    private readonly repository: RunAttemptLogRetentionRepository,
    private readonly store: RunAttemptLogRetirementStore,
    private readonly capacity: RunAttemptLogCapacitySource,
    private readonly options: RunAttemptLogRetentionServiceOptions,
  ) {
    if (
      !repository ||
      typeof repository.inspect !== 'function' ||
      typeof repository.loadCursor !== 'function' ||
      typeof repository.list !== 'function' ||
      typeof repository.record !== 'function' ||
      typeof repository.saveCursor !== 'function' ||
      !store ||
      typeof store.retire !== 'function' ||
      !capacity ||
      typeof capacity.inspect !== 'function'
    ) {
      throw new InvalidRunAttemptLogRetentionError('dependencies are invalid');
    }
    assertOptions(options);
    this.clock = options.clock ?? { now: Date.now };
  }

  async sweep(): Promise<RunAttemptLogRetentionSweepSummary> {
    const observedAtMs = timestamp('clock', this.clock.now());
    const snapshot = await this.capacity.inspect();
    if (
      typeof snapshot?.availableBytes !== 'bigint' ||
      typeof snapshot.totalBytes !== 'bigint' ||
      snapshot.availableBytes < 0n ||
      snapshot.totalBytes < 1n ||
      snapshot.availableBytes > snapshot.totalBytes
    ) {
      throw new RunAttemptLogRetentionUnavailableError();
    }
    const pressure =
      snapshot.availableBytes < BigInt(this.options.minimumFreeBytes);
    const retentionMs = pressure
      ? this.options.pressureRetentionMs
      : this.options.normalRetentionMs;
    const cutoffMs = Math.max(0, observedAtMs - retentionMs);
    const cursor = await this.repository.loadCursor();
    const page = await this.repository.list({
      cutoffMs,
      limit: this.options.pageSize,
      ...(cursor === undefined ? {} : { cursor }),
    });
    this.assertPage(page, cursor);

    const entries: RunAttemptLogRetentionEntry[] = [];
    let deletionsAttempted = 0;
    let recordsWritten = 0;
    let failedCandidates = 0;
    let bytesReclaimed = 0;
    let lastProcessed = cursor;

    for (const rawCandidate of page.candidates) {
      if (deletionsAttempted >= this.options.maximumDeletions) break;
      const candidate = normalizeRunAttemptLogRetentionCandidate(rawCandidate);
      deletionsAttempted += 1;
      lastProcessed = Object.freeze({
        finishedAtMs: candidate.finishedAtMs,
        attemptId: candidate.attemptId,
      });
      let retired: Readonly<RunAttemptLogRetirementStoreResult>;
      try {
        retired = this.normalizeRetirement(await this.store.retire(candidate));
      } catch {
        failedCandidates += 1;
        entries.push(
          Object.freeze({
            attemptId: candidate.attemptId,
            logArtifactId: candidate.logArtifactId,
            outcome: 'file_failed' as const,
            byteLength: 0,
          }),
        );
        continue;
      }
      try {
        const result = await this.repository.record(
          createRunAttemptLogRetirementRecord({
            ...candidate,
            eligibleAtMs: candidate.finishedAtMs + retentionMs,
            retiredAtMs: observedAtMs,
            ...retired,
          }),
        );
        if (result !== 'recorded' && result !== 'existing') {
          throw new RunAttemptLogRetentionUnavailableError();
        }
        recordsWritten += result === 'recorded' ? 1 : 0;
        bytesReclaimed += retired.byteLength;
        entries.push(
          Object.freeze({
            attemptId: candidate.attemptId,
            logArtifactId: candidate.logArtifactId,
            outcome: retired.disposition,
            byteLength: retired.byteLength,
          }),
        );
      } catch {
        failedCandidates += 1;
        entries.push(
          Object.freeze({
            attemptId: candidate.attemptId,
            logArtifactId: candidate.logArtifactId,
            outcome: 'record_failed' as const,
            byteLength: retired.byteLength,
          }),
        );
      }
    }

    const budgetExhausted =
      deletionsAttempted < page.candidates.length &&
      deletionsAttempted >= this.options.maximumDeletions;
    const nextCursor = budgetExhausted
      ? lastProcessed
      : page.truncated
      ? page.nextCursor
      : undefined;
    await this.repository.saveCursor(nextCursor, observedAtMs);
    return Object.freeze({
      status: budgetExhausted
        ? ('deletion_budget_exhausted' as const)
        : page.truncated
        ? ('page_complete' as const)
        : ('complete' as const),
      pressure,
      observedAtMs,
      retentionMs,
      availableBytes: snapshot.availableBytes.toString(10),
      totalBytes: snapshot.totalBytes.toString(10),
      candidatesScanned: deletionsAttempted,
      deletionsAttempted,
      recordsWritten,
      failedCandidates,
      bytesReclaimed,
      entries: Object.freeze(entries),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  }

  private normalizeRetirement(
    value: Readonly<RunAttemptLogRetirementStoreResult>,
  ): Readonly<RunAttemptLogRetirementStoreResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RunAttemptLogRetentionUnavailableError();
    }
    exactKeys(
      value,
      ['byteLength', 'disposition', 'truncation'],
      [],
      'retirement result',
    );
    const byteLength = nonNegativeInteger('byteLength', value.byteLength);
    if (
      (value.disposition !== 'deleted' &&
        value.disposition !== 'already_absent') ||
      (value.disposition === 'already_absent' && byteLength !== 0)
    ) {
      throw new RunAttemptLogRetentionUnavailableError();
    }
    return Object.freeze({
      disposition: value.disposition,
      byteLength,
      truncation: normalizedTruncation(value.truncation),
    });
  }

  private assertPage(
    page: RunAttemptLogRetentionPage,
    cursor: Readonly<RunAttemptLogRetentionCursor> | undefined,
  ): void {
    if (
      !page ||
      !Array.isArray(page.candidates) ||
      page.candidates.length > this.options.pageSize ||
      typeof page.truncated !== 'boolean'
    ) {
      throw new RunAttemptLogRetentionUnavailableError();
    }
    let previous = cursor;
    for (const raw of page.candidates) {
      const candidate = normalizeRunAttemptLogRetentionCandidate(raw);
      if (
        previous &&
        (candidate.finishedAtMs < previous.finishedAtMs ||
          (candidate.finishedAtMs === previous.finishedAtMs &&
            candidate.attemptId <= previous.attemptId))
      ) {
        throw new RunAttemptLogRetentionUnavailableError();
      }
      previous = candidate;
    }
    const last = page.candidates.at(-1);
    if (
      page.truncated !== (page.nextCursor !== undefined) ||
      (page.nextCursor !== undefined &&
        (!last ||
          page.nextCursor.finishedAtMs !== last.finishedAtMs ||
          page.nextCursor.attemptId !== last.attemptId))
    ) {
      throw new RunAttemptLogRetentionUnavailableError();
    }
  }
}
