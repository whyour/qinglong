import { RUN_ATTEMPT_STATUSES, type RunAttemptStatus } from '../run';
import type { RunRepositoryReader } from '../runRepository';
import {
  normalizeRunAttemptLogRetirementRecord,
  type RunAttemptLogRetentionStateReader,
  type RunAttemptLogRetirementRecord,
} from '../log-retention/runAttemptLogRetention';

export const MAX_RUN_ATTEMPT_LOG_READ_BYTES = 256 * 1024;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_ATTEMPT_STATUSES = new Set<RunAttemptStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

export interface RunAttemptLogReadRange {
  readonly offset: number;
  readonly length: number;
}

export interface RunAttemptLogReadIdentity {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly logArtifactId: string;
}

export interface RunAttemptLogTruncationView {
  readonly truncated: boolean | 'unknown';
  readonly maximumBytes?: number;
  readonly observedAtMs?: number;
}

export type RunAttemptLogRangeReadResult =
  | Readonly<{ readonly status: 'missing' }>
  | Readonly<{
      readonly status: 'available';
      readonly content: Uint8Array;
      readonly start: number;
      readonly endExclusive: number;
      readonly totalBytes: number;
      readonly nextOffset?: number;
      readonly truncation: Readonly<RunAttemptLogTruncationView>;
    }>;

export interface RunAttemptLogRangeReader {
  read(
    identity: Readonly<RunAttemptLogReadIdentity>,
    range: Readonly<RunAttemptLogReadRange>,
    signal?: AbortSignal,
  ): Promise<RunAttemptLogRangeReadResult>;
}

export interface RunAttemptLogReadRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly range: Readonly<RunAttemptLogReadRange>;
  readonly signal?: AbortSignal;
}

export type RunAttemptLogReadResult =
  | Readonly<{ readonly status: 'not_found' }>
  | Readonly<{
      readonly status: 'pending';
      readonly projectId: string;
      readonly runId: string;
      readonly attemptId: string;
      readonly logArtifactId?: string;
    }>
  | (Readonly<RunAttemptLogReadIdentity> &
      Readonly<{ readonly status: 'missing' }>)
  | (Readonly<RunAttemptLogReadIdentity> &
      Readonly<{
        readonly status: 'retired';
        readonly retiredAtMs: number;
        readonly byteLength: number;
        readonly truncation: Readonly<RunAttemptLogTruncationView>;
      }>)
  | (Readonly<RunAttemptLogReadIdentity> &
      Extract<RunAttemptLogRangeReadResult, { readonly status: 'available' }>);

export interface RunAttemptLogReadServiceOptions {
  readonly executorType: 'local_process' | 'remote_worker';
  readonly artifactIdPattern: RegExp;
  readonly maximumReadBytes: number;
  readonly activeMissingIsPending?: boolean;
}

export class InvalidRunAttemptLogReadError extends TypeError {
  constructor(message: string) {
    super(`Run Attempt log read is invalid: ${message}`);
    this.name = 'InvalidRunAttemptLogReadError';
  }
}

export class RunAttemptLogReadUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Run Attempt log read is unavailable', options);
    this.name = 'RunAttemptLogReadUnavailableError';
  }
}

function canonicalId(name: string, value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new InvalidRunAttemptLogReadError(`${name} is invalid`);
  }
  return value;
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
    throw new InvalidRunAttemptLogReadError(`${name} shape is invalid`);
  }
}

export function normalizeRunAttemptLogReadRange(
  value: Readonly<RunAttemptLogReadRange>,
  maximumReadBytes = MAX_RUN_ATTEMPT_LOG_READ_BYTES,
): Readonly<RunAttemptLogReadRange> {
  if (
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 1 ||
    maximumReadBytes > MAX_RUN_ATTEMPT_LOG_READ_BYTES
  ) {
    throw new InvalidRunAttemptLogReadError('maximum read bytes is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunAttemptLogReadError('range is invalid');
  }
  exactKeys(value, ['length', 'offset'], [], 'range');
  if (!Number.isSafeInteger(value.offset) || value.offset < 0) {
    throw new InvalidRunAttemptLogReadError('offset is invalid');
  }
  if (
    !Number.isSafeInteger(value.length) ||
    value.length < 1 ||
    value.length > maximumReadBytes
  ) {
    throw new InvalidRunAttemptLogReadError('length is invalid');
  }
  return Object.freeze({ offset: value.offset, length: value.length });
}

function prepareOptions(
  options: RunAttemptLogReadServiceOptions,
): Readonly<RunAttemptLogReadServiceOptions> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (options.executorType !== 'local_process' &&
      options.executorType !== 'remote_worker') ||
    !(options.artifactIdPattern instanceof RegExp) ||
    options.artifactIdPattern.global ||
    options.artifactIdPattern.sticky ||
    (options.activeMissingIsPending !== undefined &&
      typeof options.activeMissingIsPending !== 'boolean')
  ) {
    throw new InvalidRunAttemptLogReadError('service options are invalid');
  }
  exactKeys(
    options,
    ['artifactIdPattern', 'executorType', 'maximumReadBytes'],
    ['activeMissingIsPending'],
    'service options',
  );
  normalizeRunAttemptLogReadRange(
    { offset: 0, length: options.maximumReadBytes },
    options.maximumReadBytes,
  );
  return Object.freeze({ ...options });
}

function truncation(
  value: Readonly<RunAttemptLogTruncationView>,
): Readonly<RunAttemptLogTruncationView> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
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
    throw new RunAttemptLogReadUnavailableError();
  }
  return Object.freeze({ ...value });
}

function available(
  identity: Readonly<RunAttemptLogReadIdentity>,
  range: Readonly<RunAttemptLogReadRange>,
  result: Extract<
    RunAttemptLogRangeReadResult,
    { readonly status: 'available' }
  >,
): RunAttemptLogReadResult {
  if (
    !(result.content instanceof Uint8Array) ||
    !Number.isSafeInteger(result.start) ||
    !Number.isSafeInteger(result.endExclusive) ||
    !Number.isSafeInteger(result.totalBytes) ||
    result.start !== Math.min(range.offset, result.totalBytes) ||
    result.endExclusive !== result.start + result.content.byteLength ||
    result.endExclusive > result.totalBytes ||
    result.content.byteLength > range.length ||
    (result.nextOffset === undefined) !==
      (result.endExclusive === result.totalBytes) ||
    (result.nextOffset !== undefined &&
      result.nextOffset !== result.endExclusive)
  ) {
    throw new RunAttemptLogReadUnavailableError();
  }
  return Object.freeze({
    status: 'available' as const,
    ...identity,
    content: result.content,
    start: result.start,
    endExclusive: result.endExclusive,
    totalBytes: result.totalBytes,
    ...(result.nextOffset === undefined
      ? {}
      : { nextOffset: result.nextOffset }),
    truncation: truncation(result.truncation),
  });
}

export class RunAttemptLogReadService {
  private readonly options: Readonly<RunAttemptLogReadServiceOptions>;

  constructor(
    private readonly runs: Pick<
      RunRepositoryReader,
      'findRunById' | 'findAttemptById'
    >,
    private readonly reader: RunAttemptLogRangeReader,
    options: RunAttemptLogReadServiceOptions,
    private readonly retention?: RunAttemptLogRetentionStateReader,
  ) {
    if (
      !runs ||
      typeof runs.findRunById !== 'function' ||
      typeof runs.findAttemptById !== 'function' ||
      !reader ||
      typeof reader.read !== 'function' ||
      (retention !== undefined && typeof retention.inspect !== 'function')
    ) {
      throw new InvalidRunAttemptLogReadError('dependencies are invalid');
    }
    this.options = prepareOptions(options);
  }

  async read(
    request: Readonly<RunAttemptLogReadRequest>,
  ): Promise<RunAttemptLogReadResult> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new InvalidRunAttemptLogReadError('request is invalid');
    }
    exactKeys(
      request,
      ['attemptId', 'projectId', 'range', 'runId'],
      ['signal'],
      'request',
    );
    const projectId = canonicalId('projectId', request.projectId);
    const runId = canonicalId('runId', request.runId);
    const attemptId = canonicalId('attemptId', request.attemptId);
    const range = normalizeRunAttemptLogReadRange(
      request.range,
      this.options.maximumReadBytes,
    );
    if (request.signal?.aborted) {
      throw new RunAttemptLogReadUnavailableError({
        cause: request.signal.reason,
      });
    }

    try {
      const run = await this.runs.findRunById(runId);
      if (
        !run ||
        run.id !== runId ||
        run.projectId !== projectId ||
        run.executionOwner !== 'runtime'
      ) {
        return Object.freeze({ status: 'not_found' as const });
      }
      const attempt = await this.runs.findAttemptById(attemptId);
      if (
        !attempt ||
        attempt.id !== attemptId ||
        attempt.runId !== runId ||
        attempt.executorType !== this.options.executorType ||
        !RUN_ATTEMPT_STATUSES.includes(attempt.status)
      ) {
        return Object.freeze({ status: 'not_found' as const });
      }
      if (attempt.logArtifactId === undefined) {
        return Object.freeze({
          status: 'pending' as const,
          projectId,
          runId,
          attemptId,
        });
      }
      if (!this.options.artifactIdPattern.test(attempt.logArtifactId)) {
        return Object.freeze({ status: 'not_found' as const });
      }
      const identity = Object.freeze({
        projectId,
        runId,
        attemptId,
        logArtifactId: attempt.logArtifactId,
      });
      const retiredBeforeRead = await this.retired(identity);
      if (retiredBeforeRead) return retiredBeforeRead;
      const result = await this.reader.read(identity, range, request.signal);
      if (result.status === 'missing') {
        const retiredAfterMissing = await this.retired(identity);
        if (retiredAfterMissing) return retiredAfterMissing;
        if (
          this.options.activeMissingIsPending === true &&
          !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
        ) {
          return Object.freeze({ status: 'pending' as const, ...identity });
        }
        return Object.freeze({ status: 'missing' as const, ...identity });
      }
      return available(identity, range, result);
    } catch (error) {
      if (
        error instanceof InvalidRunAttemptLogReadError ||
        error instanceof RunAttemptLogReadUnavailableError
      ) {
        throw error;
      }
      throw new RunAttemptLogReadUnavailableError({ cause: error });
    }
  }

  private async retired(identity: Readonly<RunAttemptLogReadIdentity>): Promise<
    | (Readonly<RunAttemptLogReadIdentity> &
        Readonly<{
          readonly status: 'retired';
          readonly retiredAtMs: number;
          readonly byteLength: number;
          readonly truncation: Readonly<RunAttemptLogTruncationView>;
        }>)
    | undefined
  > {
    if (!this.retention) return undefined;
    const state = await this.retention.inspect(identity);
    if (!state || (state.status !== 'active' && state.status !== 'retired')) {
      throw new RunAttemptLogReadUnavailableError();
    }
    if (state.status === 'active') return undefined;
    const record: Readonly<RunAttemptLogRetirementRecord> =
      normalizeRunAttemptLogRetirementRecord(state.record);
    if (
      record.projectId !== identity.projectId ||
      record.runId !== identity.runId ||
      record.attemptId !== identity.attemptId ||
      record.logArtifactId !== identity.logArtifactId
    ) {
      throw new RunAttemptLogReadUnavailableError();
    }
    return Object.freeze({
      status: 'retired' as const,
      ...identity,
      retiredAtMs: record.retiredAtMs,
      byteLength: record.byteLength,
      truncation: record.truncation,
    });
  }
}
