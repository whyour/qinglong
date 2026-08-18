import { v7 as uuidV7 } from 'uuid';
import type { RunAttemptRecord, RunRecord, RunStatus } from '../domain/run';
import {
  RUN_TRANSITIONS,
  isTerminalRunAttemptStatus,
  isTerminalRunStatus,
} from '../domain/runStateMachine';
import type {
  LegacyRunningInstanceEvidence,
  LegacyShadowStartupAttempt,
  LegacyShadowStartupCandidate,
  LegacyShadowStartupCursor,
  LegacyShadowStartupRecoverySource,
} from '../ports/legacyShadowStartupRecovery';
import { MAX_LEGACY_SHADOW_STARTUP_BATCH_SIZE } from '../ports/legacyShadowStartupRecovery';
import type { RunRepository } from '../ports/runRepository';
import type { LegacyShadowRunWriter } from './legacyShadowRunWriter';
import { RunCommandService } from './runCommandService';

export const MAX_LEGACY_SHADOW_STARTUP_PAGES = 64;

export interface LegacyShadowStartupClock {
  now(): number;
}

export interface LegacyShadowStartupReconcileSummary {
  scanned: number;
  completed: number;
  cancelled: number;
  abandoned: number;
  markedLost: number;
  repaired: number;
  pending: number;
  ambiguous: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  nextCursor?: LegacyShadowStartupCursor;
}

export type LegacyShadowStartupStopReason =
  | 'complete'
  | 'page_limit'
  | 'cursor_stalled';

export interface LegacyShadowStartupSummary
  extends Omit<
    LegacyShadowStartupReconcileSummary,
    'truncated' | 'nextCursor'
  > {
  pages: number;
  stopReason: LegacyShadowStartupStopReason;
  remaining: boolean;
  nextCursor?: LegacyShadowStartupCursor;
}

type EvidenceSelection =
  | { status: 'matched'; evidence: LegacyRunningInstanceEvidence }
  | { status: 'none' | 'ambiguous' };

function sameCursor(
  left: LegacyShadowStartupCursor | undefined,
  right: LegacyShadowStartupCursor,
): boolean {
  return (
    left !== undefined &&
    left.createdAtMs === right.createdAtMs &&
    left.runId === right.runId
  );
}

function selectEvidence(
  attempt: Pick<LegacyShadowStartupAttempt, 'pid' | 'logArtifactId'>,
  evidence: readonly LegacyRunningInstanceEvidence[],
): EvidenceSelection {
  const byLog =
    attempt.logArtifactId === undefined
      ? []
      : evidence.filter(
          (candidate) => candidate.logArtifactId === attempt.logArtifactId,
        );
  const byPid =
    attempt.pid === undefined
      ? []
      : evidence.filter((candidate) => candidate.pid === attempt.pid);

  if (attempt.logArtifactId !== undefined && attempt.pid !== undefined) {
    const byPidSet = new Set(byPid);
    const intersection = byLog.filter((candidate) => byPidSet.has(candidate));
    if (intersection.length === 1) {
      return { status: 'matched', evidence: intersection[0] };
    }
    if (
      intersection.length > 1 ||
      byLog.length > 1 ||
      byPid.length > 1 ||
      (byLog.length > 0 && byPid.length > 0)
    ) {
      return { status: 'ambiguous' };
    }
    if (byLog.length === 1) {
      return { status: 'matched', evidence: byLog[0] };
    }
    if (byPid.length === 1) {
      return { status: 'matched', evidence: byPid[0] };
    }
    return { status: 'none' };
  }
  if (attempt.logArtifactId !== undefined) {
    if (byLog.length === 1) {
      return { status: 'matched', evidence: byLog[0] };
    }
    return { status: byLog.length > 1 ? 'ambiguous' : 'none' };
  }
  if (attempt.pid !== undefined) {
    if (byPid.length === 1) {
      return { status: 'matched', evidence: byPid[0] };
    }
    return { status: byPid.length > 1 ? 'ambiguous' : 'none' };
  }
  if (evidence.length === 1) {
    return { status: 'matched', evidence: evidence[0] };
  }
  return { status: evidence.length > 1 ? 'ambiguous' : 'none' };
}

function terminalRunTarget(attempt: RunAttemptRecord): RunStatus | undefined {
  if (attempt.status === 'succeeded') return 'succeeded';
  if (attempt.status === 'failed') return 'failed';
  if (attempt.status === 'cancelled') return 'cancelled';
  if (attempt.status === 'timed_out') return 'timed_out';
  if (attempt.status === 'lost') return 'lost';
  return undefined;
}

/** Reconciles one bounded page after Legacy startup normalization. */
export class LegacyShadowStartupReconciler {
  private readonly commands: RunCommandService;
  private readonly clock: LegacyShadowStartupClock;

  constructor(
    private readonly repository: RunRepository,
    private readonly source: LegacyShadowStartupRecoverySource,
    private readonly writer: Pick<
      LegacyShadowRunWriter,
      'exited' | 'cancelled'
    >,
    options: {
      clock?: LegacyShadowStartupClock;
      createEventId?: () => string;
    } = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.commands = new RunCommandService(
      repository,
      options.createEventId ?? uuidV7,
    );
  }

  async reconcileBatch(options: {
    origins: readonly RunRecord['executionOrigin'][];
    cursor?: LegacyShadowStartupCursor;
    limit?: number;
  }): Promise<LegacyShadowStartupReconcileSummary> {
    const enabledOrigins = [...new Set(options.origins)];
    const page = await this.source.listCandidates({
      origins: enabledOrigins,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const summary: LegacyShadowStartupReconcileSummary = {
      scanned: page.candidates.length,
      completed: 0,
      cancelled: 0,
      abandoned: 0,
      markedLost: 0,
      repaired: 0,
      pending: 0,
      ambiguous: 0,
      skipped: 0,
      failed: 0,
      truncated: page.truncated,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
    const origins = new Set(enabledOrigins);
    for (const candidate of page.candidates) {
      try {
        await this.reconcileCandidate(candidate, origins, summary);
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }

  private async reconcileCandidate(
    candidate: LegacyShadowStartupCandidate,
    origins: ReadonlySet<RunRecord['executionOrigin']>,
    summary: LegacyShadowStartupReconcileSummary,
  ): Promise<void> {
    const run = await this.repository.findRunById(candidate.runId);
    if (
      !run ||
      run.executionOwner !== 'legacy' ||
      !origins.has(run.executionOrigin) ||
      isTerminalRunStatus(run.status) ||
      run.status === 'lost'
    ) {
      summary.skipped += 1;
      return;
    }
    if (candidate.activeAttemptCount === 0) {
      await this.repairTerminalAttempt(run, summary);
      return;
    }
    if (candidate.activeAttemptCount !== 1 || !candidate.attempt) {
      summary.ambiguous += 1;
      return;
    }
    const attempt = await this.repository.findAttemptById(
      candidate.attempt.attemptId,
    );
    if (
      !attempt ||
      attempt.runId !== run.id ||
      isTerminalRunAttemptStatus(attempt.status)
    ) {
      summary.skipped += 1;
      return;
    }

    const evidence =
      candidate.legacyCronId === undefined
        ? { evidence: [], truncated: false }
        : await this.source.listRunningInstanceEvidence({
            legacyCronId: candidate.legacyCronId,
          });
    if (evidence.truncated) {
      summary.ambiguous += 1;
      return;
    }
    const selected = selectEvidence(attempt, evidence.evidence);
    if (selected.status === 'ambiguous') {
      summary.ambiguous += 1;
      return;
    }
    if (
      selected.status === 'matched' &&
      selected.evidence.finishedAtMs !== undefined
    ) {
      const atMs = this.atOrAfter(run, attempt, selected.evidence.finishedAtMs);
      if (selected.evidence.outcome === 'stopped') {
        await this.writer.cancelled(
          { runId: run.id, attemptId: attempt.id },
          { atMs, reason: 'reconcile' },
        );
        summary.cancelled += 1;
        return;
      }
      if (
        selected.evidence.outcome === 'succeeded' ||
        selected.evidence.outcome === 'failed'
      ) {
        const succeeded = selected.evidence.outcome === 'succeeded';
        await this.writer.exited(
          { runId: run.id, attemptId: attempt.id },
          {
            atMs,
            exitCode: succeeded
              ? 0
              : selected.evidence.exitCode === undefined ||
                selected.evidence.exitCode === 0
              ? 1
              : selected.evidence.exitCode,
          },
        );
        summary.completed += 1;
        return;
      }
    }

    if (run.executionOrigin === 'scheduled_system') {
      summary.pending += 1;
      return;
    }
    if (run.status === 'queued' && attempt.status === 'claimed') {
      await this.abandon(run, attempt);
      summary.abandoned += 1;
      return;
    }
    if (
      (run.status === 'dispatching' || run.status === 'running') &&
      ['claimed', 'starting', 'running'].includes(attempt.status)
    ) {
      await this.markLost(run, attempt);
      summary.markedLost += 1;
      return;
    }
    summary.ambiguous += 1;
  }

  private async repairTerminalAttempt(
    run: RunRecord,
    summary: LegacyShadowStartupReconcileSummary,
  ): Promise<void> {
    const attempt = await this.repository.findLatestAttemptByRunId(run.id);
    const target = attempt ? terminalRunTarget(attempt) : undefined;
    if (
      !attempt ||
      target === undefined ||
      !RUN_TRANSITIONS[run.status].includes(target)
    ) {
      summary.ambiguous += 1;
      return;
    }
    await this.commands.transitionRun({
      runId: run.id,
      to: target,
      expectedVersion: run.version,
      atMs: this.atOrAfter(run, attempt),
      ...(attempt.errorCode === undefined
        ? {}
        : { errorCode: attempt.errorCode }),
      ...(attempt.errorSummary === undefined
        ? {}
        : { errorSummary: attempt.errorSummary }),
      actor: { type: 'reconciler' },
      dedupeKey: `legacy-startup-repair:${attempt.id}:${target}`,
    });
    summary.repaired += 1;
  }

  private async abandon(
    run: RunRecord,
    attempt: RunAttemptRecord,
  ): Promise<void> {
    const atMs = this.atOrAfter(run, attempt);
    const attemptResult = await this.commands.transitionRunAttempt({
      runId: run.id,
      attemptId: attempt.id,
      to: 'cancelled',
      expectedRunVersion: run.version,
      atMs,
      errorCode: 'LEGACY_RECONCILE_ACCEPTANCE_ABANDONED',
      errorSummary: 'Legacy owner restarted before spawn was observed',
      actor: { type: 'reconciler' },
      dedupeKey: `legacy-startup-abandoned-attempt:${attempt.id}`,
    });
    await this.commands.transitionRun({
      runId: run.id,
      to: 'cancelled',
      expectedVersion: attemptResult.run.version,
      atMs,
      errorCode: 'LEGACY_RECONCILE_ACCEPTANCE_ABANDONED',
      errorSummary: 'Legacy owner restarted before spawn was observed',
      actor: { type: 'reconciler' },
      dedupeKey: `legacy-startup-abandoned-run:${attempt.id}`,
    });
  }

  private async markLost(
    run: RunRecord,
    attempt: RunAttemptRecord,
  ): Promise<void> {
    const atMs = this.atOrAfter(run, attempt);
    const attemptResult = await this.commands.transitionRunAttempt({
      runId: run.id,
      attemptId: attempt.id,
      to: 'lost',
      expectedRunVersion: run.version,
      atMs,
      errorCode: 'LEGACY_RECONCILE_OWNER_LOST',
      errorSummary: 'Legacy worker restarted without terminal evidence',
      actor: { type: 'reconciler' },
      dedupeKey: `legacy-startup-lost-attempt:${attempt.id}`,
    });
    await this.commands.transitionRun({
      runId: run.id,
      to: 'lost',
      expectedVersion: attemptResult.run.version,
      atMs,
      errorCode: 'LEGACY_RECONCILE_OWNER_LOST',
      errorSummary: 'Legacy worker restarted without terminal evidence',
      actor: { type: 'reconciler' },
      dedupeKey: `legacy-startup-lost-run:${attempt.id}`,
    });
  }

  private atOrAfter(
    run: RunRecord,
    attempt: RunAttemptRecord,
    evidenceAtMs?: number,
  ): number {
    return Math.max(
      this.clock.now(),
      run.createdAtMs,
      run.startedAtMs ?? 0,
      attempt.createdAtMs,
      attempt.startedAtMs ?? 0,
      evidenceAtMs ?? 0,
    );
  }
}

/** Runs a complete but Profile-bounded, timer-free startup pass. */
export class LegacyShadowStartupSupervisor {
  constructor(
    private readonly reconciler: Pick<
      LegacyShadowStartupReconciler,
      'reconcileBatch'
    >,
  ) {}

  async run(options: {
    origins: readonly RunRecord['executionOrigin'][];
    cursor?: LegacyShadowStartupCursor;
    pageSize?: number;
    maxPages?: number;
  }): Promise<LegacyShadowStartupSummary> {
    const pageSize = options.pageSize ?? 8;
    const maxPages = options.maxPages ?? 1;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_LEGACY_SHADOW_STARTUP_BATCH_SIZE
    ) {
      throw new RangeError(
        'pageSize must be between 1 and MAX_LEGACY_SHADOW_STARTUP_BATCH_SIZE',
      );
    }
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > MAX_LEGACY_SHADOW_STARTUP_PAGES
    ) {
      throw new RangeError(
        'maxPages must be between 1 and MAX_LEGACY_SHADOW_STARTUP_PAGES',
      );
    }

    const total: LegacyShadowStartupSummary = {
      pages: 0,
      scanned: 0,
      completed: 0,
      cancelled: 0,
      abandoned: 0,
      markedLost: 0,
      repaired: 0,
      pending: 0,
      ambiguous: 0,
      skipped: 0,
      failed: 0,
      stopReason: 'complete',
      remaining: false,
    };
    let cursor = options.cursor;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.reconciler.reconcileBatch({
        origins: options.origins,
        ...(cursor === undefined ? {} : { cursor }),
        limit: pageSize,
      });
      total.pages += 1;
      total.scanned += page.scanned;
      total.completed += page.completed;
      total.cancelled += page.cancelled;
      total.abandoned += page.abandoned;
      total.markedLost += page.markedLost;
      total.repaired += page.repaired;
      total.pending += page.pending;
      total.ambiguous += page.ambiguous;
      total.skipped += page.skipped;
      total.failed += page.failed;
      if (!page.truncated) return total;
      if (!page.nextCursor || sameCursor(cursor, page.nextCursor)) {
        total.stopReason = 'cursor_stalled';
        total.remaining = true;
        return total;
      }
      cursor = page.nextCursor;
      if (pageNumber === maxPages - 1) {
        total.stopReason = 'page_limit';
        total.remaining = true;
        total.nextCursor = cursor;
        return total;
      }
    }
    return total;
  }
}
