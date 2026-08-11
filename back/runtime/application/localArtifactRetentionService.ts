import type {
  LocalArtifactRetentionCandidate,
  LocalArtifactRetentionCursor,
} from '../domain/localArtifactRetention';
import {
  normalizeLocalArtifactRetentionCandidate,
  normalizeLocalArtifactRetentionCursor,
} from '../domain/localArtifactRetention';
import type { LocalArtifactCapacitySource } from '../ports/localArtifactCapacityProbe';
import type { LocalArtifactFileRetirementStore } from '../ports/localArtifactFileRetirementStore';
import type {
  LocalArtifactRetentionPage,
  LocalArtifactRetentionRepository,
} from '../ports/localArtifactRetentionRepository';
import { MAX_LOCAL_ARTIFACT_RETENTION_PAGE_SIZE } from '../ports/localArtifactRetentionRepository';

export const MIN_LOCAL_ARTIFACT_RETENTION_MS = 60_000;
export const MAX_LOCAL_ARTIFACT_RETENTION_MS = 365 * 24 * 60 * 60_000;

export interface LocalArtifactRetentionServiceOptions {
  normalRetentionMs: number;
  pressureRetentionMs: number;
  minimumFreeBytes: number;
  pageSize?: number;
  maximumDeletions?: number;
  clock?: { now(): number };
}

export interface LocalArtifactRetentionEntry {
  attemptId: string;
  logArtifactId: string;
  outcome: 'deleted' | 'already_absent' | 'file_failed' | 'record_failed';
  bytesReclaimed: number;
}

export interface LocalArtifactRetentionSweepResult {
  status: 'complete' | 'page_complete' | 'deletion_budget_exhausted';
  pressure: boolean;
  observedAtMs: number;
  retentionMs: number;
  availableBytes: bigint;
  totalBytes: bigint;
  candidatesScanned: number;
  deletionsAttempted: number;
  recordsWritten: number;
  failedCandidates: number;
  bytesReclaimed: number;
  entries: readonly LocalArtifactRetentionEntry[];
  nextCursor?: LocalArtifactRetentionCursor;
}

export class InvalidLocalArtifactRetentionPageError extends Error {
  constructor(message: string) {
    super(`Local Artifact retention page is invalid: ${message}`);
    this.name = 'InvalidLocalArtifactRetentionPageError';
  }
}

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

export class LocalArtifactRetentionService {
  private readonly normalRetentionMs: number;
  private readonly pressureRetentionMs: number;
  private readonly minimumFreeBytes: number;
  private readonly pageSize: number;
  private readonly maximumDeletions: number;
  private readonly clock: { now(): number };

  constructor(
    private readonly repository: LocalArtifactRetentionRepository,
    private readonly files: LocalArtifactFileRetirementStore,
    private readonly capacity: LocalArtifactCapacitySource,
    options: LocalArtifactRetentionServiceOptions,
  ) {
    this.normalRetentionMs = options.normalRetentionMs;
    this.pressureRetentionMs = options.pressureRetentionMs;
    this.minimumFreeBytes = options.minimumFreeBytes;
    this.pageSize = options.pageSize ?? 16;
    this.maximumDeletions = options.maximumDeletions ?? 8;
    this.clock = options.clock ?? Date;
    assertIntegerBetween(
      'normalRetentionMs',
      this.normalRetentionMs,
      MIN_LOCAL_ARTIFACT_RETENTION_MS,
      MAX_LOCAL_ARTIFACT_RETENTION_MS,
    );
    assertIntegerBetween(
      'pressureRetentionMs',
      this.pressureRetentionMs,
      MIN_LOCAL_ARTIFACT_RETENTION_MS,
      this.normalRetentionMs,
    );
    assertIntegerBetween(
      'minimumFreeBytes',
      this.minimumFreeBytes,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    assertIntegerBetween(
      'pageSize',
      this.pageSize,
      1,
      MAX_LOCAL_ARTIFACT_RETENTION_PAGE_SIZE,
    );
    assertIntegerBetween(
      'maximumDeletions',
      this.maximumDeletions,
      1,
      this.pageSize,
    );
  }

  async sweep(
    cursor?: LocalArtifactRetentionCursor,
  ): Promise<LocalArtifactRetentionSweepResult> {
    const normalizedCursor = cursor
      ? normalizeLocalArtifactRetentionCursor(cursor)
      : undefined;
    const observedAtMs = this.now();
    const capacity = await this.capacity.inspect();
    if (
      typeof capacity?.availableBytes !== 'bigint' ||
      typeof capacity.totalBytes !== 'bigint' ||
      capacity.availableBytes < BigInt(0) ||
      capacity.totalBytes < BigInt(1) ||
      capacity.availableBytes > capacity.totalBytes
    ) {
      throw new TypeError('Local Artifact capacity snapshot is invalid');
    }
    const pressure = capacity.availableBytes < BigInt(this.minimumFreeBytes);
    const retentionMs = pressure
      ? this.pressureRetentionMs
      : this.normalRetentionMs;
    const cutoffMs = Math.max(0, observedAtMs - retentionMs);
    const page = await this.repository.list({
      cutoffMs,
      ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
      limit: this.pageSize,
    });
    this.assertPage(page, normalizedCursor);

    const entries: LocalArtifactRetentionEntry[] = [];
    let candidatesScanned = 0;
    let deletionsAttempted = 0;
    let recordsWritten = 0;
    let failedCandidates = 0;
    let bytesReclaimed = 0;
    let lastProcessed = normalizedCursor;

    for (const candidate of page.candidates) {
      if (deletionsAttempted >= this.maximumDeletions) {
        return this.result({
          status: 'deletion_budget_exhausted',
          pressure,
          observedAtMs,
          retentionMs,
          availableBytes: capacity.availableBytes,
          totalBytes: capacity.totalBytes,
          candidatesScanned,
          deletionsAttempted,
          recordsWritten,
          failedCandidates,
          bytesReclaimed,
          entries,
          nextCursor: lastProcessed,
        });
      }
      candidatesScanned += 1;
      deletionsAttempted += 1;
      lastProcessed = this.cursor(candidate);
      let retired;
      try {
        retired = await this.files.retire(candidate.logArtifactId);
      } catch {
        failedCandidates += 1;
        entries.push({
          attemptId: candidate.attemptId,
          logArtifactId: candidate.logArtifactId,
          outcome: 'file_failed',
          bytesReclaimed: 0,
        });
        continue;
      }
      try {
        await this.repository.record({
          ...candidate,
          eligibleAtMs: candidate.finishedAtMs + retentionMs,
          disposition: retired.disposition,
          bytesReclaimed: retired.bytesReclaimed,
          recordedAtMs: observedAtMs,
        });
        recordsWritten += 1;
        bytesReclaimed += retired.bytesReclaimed;
        entries.push({
          attemptId: candidate.attemptId,
          logArtifactId: candidate.logArtifactId,
          outcome: retired.disposition,
          bytesReclaimed: retired.bytesReclaimed,
        });
      } catch {
        failedCandidates += 1;
        entries.push({
          attemptId: candidate.attemptId,
          logArtifactId: candidate.logArtifactId,
          outcome: 'record_failed',
          bytesReclaimed: retired.bytesReclaimed,
        });
      }
    }

    return this.result({
      status: page.truncated ? 'page_complete' : 'complete',
      pressure,
      observedAtMs,
      retentionMs,
      availableBytes: capacity.availableBytes,
      totalBytes: capacity.totalBytes,
      candidatesScanned,
      deletionsAttempted,
      recordsWritten,
      failedCandidates,
      bytesReclaimed,
      entries,
      nextCursor: page.nextCursor,
    });
  }

  private assertPage(
    page: LocalArtifactRetentionPage,
    cursor: Readonly<LocalArtifactRetentionCursor> | undefined,
  ): void {
    if (
      !page ||
      !Array.isArray(page.candidates) ||
      page.candidates.length > this.pageSize ||
      typeof page.truncated !== 'boolean'
    ) {
      throw new InvalidLocalArtifactRetentionPageError(
        'candidate count exceeds pageSize',
      );
    }
    let previous = cursor;
    for (const candidate of page.candidates) {
      normalizeLocalArtifactRetentionCandidate(candidate);
      if (
        previous &&
        (candidate.finishedAtMs < previous.finishedAtMs ||
          (candidate.finishedAtMs === previous.finishedAtMs &&
            candidate.attemptId <= previous.attemptId))
      ) {
        throw new InvalidLocalArtifactRetentionPageError(
          'candidate cursor did not advance',
        );
      }
      previous = candidate;
    }
    const last = page.candidates[page.candidates.length - 1];
    if (
      page.truncated !== (page.nextCursor !== undefined) ||
      (page.nextCursor &&
        (!last ||
          page.nextCursor.finishedAtMs !== last.finishedAtMs ||
          page.nextCursor.attemptId !== last.attemptId))
    ) {
      throw new InvalidLocalArtifactRetentionPageError(
        'resume cursor is inconsistent',
      );
    }
  }

  private cursor(
    candidate: LocalArtifactRetentionCandidate,
  ): LocalArtifactRetentionCursor {
    return Object.freeze({
      finishedAtMs: candidate.finishedAtMs,
      attemptId: candidate.attemptId,
    });
  }

  private now(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Local Artifact retention clock is invalid');
    }
    return value;
  }

  private result(
    value: Omit<LocalArtifactRetentionSweepResult, 'entries'> & {
      entries: LocalArtifactRetentionEntry[];
    },
  ): LocalArtifactRetentionSweepResult {
    const { nextCursor, ...rest } = value;
    return Object.freeze({
      ...rest,
      entries: Object.freeze([...value.entries]),
      ...(nextCursor ? { nextCursor: Object.freeze({ ...nextCursor }) } : {}),
    });
  }
}
