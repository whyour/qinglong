import { randomUUID } from 'node:crypto';

import type {
  RunAttemptRecord,
  RunRecord,
  RunRepository,
} from '@qinglong/runtime-core/run-repository';
import type {
  LocalPersistedExecutionInspector,
} from '@qinglong/local-process';

import type { LocalCompletionReceiptProcessor } from '../control/completion';
import type { LocalWorkflowTaskExecutionRepository } from '../execution/workflowTaskExecution';

export const MAX_LOCAL_WORKFLOW_TASK_RECOVERY_ITEMS = 64;

export interface LocalWorkflowTaskRecoveryCandidate {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptCreatedAtMs: number;
}

export interface LocalWorkflowTaskRecoveryPage {
  readonly candidates: readonly Readonly<LocalWorkflowTaskRecoveryCandidate>[];
  readonly truncated: boolean;
}

export interface LocalWorkflowTaskRecoveryRepository {
  listRecoveryCandidates(command: Readonly<{
    limit: number;
  }>): Promise<Readonly<LocalWorkflowTaskRecoveryPage>>;
  recover(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    reason: 'unstarted_claim_expired' | 'execution_not_running';
    observedAtMs: number;
  }>): Promise<'requeued' | 'failed' | 'already_recovered' | 'stale'>;
}

export interface LocalWorkflowTaskStartupRecoveryOptions {
  readonly receiptPublishGraceMs?: number;
  readonly clock?: { now(): number };
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly createEventId?: () => string;
}

export interface LocalWorkflowTaskStartupRecoverySummary {
  readonly safe: boolean;
  readonly scanned: number;
  readonly recovered: number;
  readonly verified: number;
  readonly remaining: number;
  readonly failed: number;
  readonly truncated: boolean;
}

interface ActiveSnapshot {
  readonly run: Readonly<RunRecord>;
  readonly attempt: Readonly<RunAttemptRecord>;
}

interface VerifiedFingerprint {
  readonly runId: string;
  readonly runVersion: number;
  readonly attemptId: string;
  readonly callbackSequence: number;
  readonly executorHandle: string;
  readonly pid: number;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
}

function validatePage(
  value: Readonly<LocalWorkflowTaskRecoveryPage>,
): Readonly<LocalWorkflowTaskRecoveryPage> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_LOCAL_WORKFLOW_TASK_RECOVERY_ITEMS ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new TypeError('Local Workflow Task recovery page is invalid');
  }
  const seen = new Set<string>();
  let previous:
    | Readonly<LocalWorkflowTaskRecoveryCandidate>
    | undefined;
  const candidates = value.candidates.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      typeof candidate.runId !== 'string' ||
      candidate.runId.length < 1 ||
      typeof candidate.attemptId !== 'string' ||
      candidate.attemptId.length < 1 ||
      seen.has(candidate.attemptId)
    ) {
      throw new TypeError(
        'Local Workflow Task recovery candidate is invalid',
      );
    }
    const attemptCreatedAtMs = timestamp(
      candidate.attemptCreatedAtMs,
      'Local Workflow Task recovery candidate timestamp',
    );
    const normalized = Object.freeze({
      runId: candidate.runId,
      attemptId: candidate.attemptId,
      attemptCreatedAtMs,
    });
    if (
      previous &&
      (normalized.attemptCreatedAtMs < previous.attemptCreatedAtMs ||
        (normalized.attemptCreatedAtMs === previous.attemptCreatedAtMs &&
          normalized.attemptId <= previous.attemptId))
    ) {
      throw new TypeError(
        'Local Workflow Task recovery candidates are not ordered',
      );
    }
    seen.add(normalized.attemptId);
    previous = normalized;
    return normalized;
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    truncated: value.truncated,
  });
}

function fingerprint(snapshot: ActiveSnapshot): VerifiedFingerprint {
  if (
    snapshot.run.status !== 'running' ||
    snapshot.attempt.status !== 'running' ||
    !snapshot.attempt.stepRunId ||
    !snapshot.attempt.executorHandle ||
    !Number.isSafeInteger(snapshot.attempt.pid) ||
    snapshot.attempt.pid! < 1
  ) {
    throw new TypeError(
      'Local Workflow Task recovery fingerprint is invalid',
    );
  }
  return Object.freeze({
    runId: snapshot.run.id,
    runVersion: snapshot.run.version,
    attemptId: snapshot.attempt.id,
    callbackSequence: snapshot.attempt.callbackSequence,
    executorHandle: snapshot.attempt.executorHandle,
    pid: snapshot.attempt.pid!,
  });
}

export class LocalWorkflowTaskStartupRecoveryCoordinator {
  private readonly clock: { now(): number };
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly receiptPublishGraceMs: number;
  private readonly createEventId: () => string;

  constructor(
    private readonly runs: RunRepository,
    private readonly recovery: LocalWorkflowTaskRecoveryRepository,
    private readonly workflowTasks: LocalWorkflowTaskExecutionRepository,
    private readonly completions: Pick<
      LocalCompletionReceiptProcessor,
      'process'
    >,
    private readonly inspector: LocalPersistedExecutionInspector,
    options: LocalWorkflowTaskStartupRecoveryOptions = {},
  ) {
    if (
      typeof recovery?.listRecoveryCandidates !== 'function' ||
      typeof recovery?.recover !== 'function' ||
      typeof workflowTasks?.recordRunning !== 'function' ||
      typeof completions?.process !== 'function' ||
      inspector?.executorType !== 'local_process'
    ) {
      throw new TypeError(
        'Local Workflow Task startup recovery dependencies are invalid',
      );
    }
    this.clock = options.clock ?? { now: Date.now };
    this.wait =
      options.wait ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.receiptPublishGraceMs = options.receiptPublishGraceMs ?? 0;
    if (
      !Number.isSafeInteger(this.receiptPublishGraceMs) ||
      this.receiptPublishGraceMs < 0 ||
      this.receiptPublishGraceMs > 5_000
    ) {
      throw new RangeError(
        'Local Workflow Task receipt grace is invalid',
      );
    }
    this.createEventId = options.createEventId ?? randomUUID;
  }

  async recover(): Promise<Readonly<LocalWorkflowTaskStartupRecoverySummary>> {
    const initial = validatePage(
      await this.recovery.listRecoveryCandidates({
        limit: MAX_LOCAL_WORKFLOW_TASK_RECOVERY_ITEMS,
      }),
    );
    if (initial.truncated) {
      return Object.freeze({
        safe: false,
        scanned: initial.candidates.length,
        recovered: 0,
        verified: 0,
        remaining: initial.candidates.length,
        failed: 0,
        truncated: true,
      });
    }
    let recovered = 0;
    let remaining = 0;
    let failed = 0;
    const verified = new Map<string, VerifiedFingerprint>();
    for (const candidate of initial.candidates) {
      try {
        const result = await this.reconcile(candidate);
        if (result.status === 'recovered') recovered += 1;
        else if (result.status === 'verified') {
          verified.set(candidate.attemptId, result.fingerprint);
        } else if (result.status === 'remaining') remaining += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    if (remaining === 0 && failed === 0) {
      const final = await this.verify(verified);
      remaining += final.remaining;
      failed += final.failed;
    }
    return Object.freeze({
      safe: remaining === 0 && failed === 0,
      scanned: initial.candidates.length,
      recovered,
      verified: verified.size,
      remaining,
      failed,
      truncated: false,
    });
  }

  private async reconcile(
    candidate: Readonly<LocalWorkflowTaskRecoveryCandidate>,
  ): Promise<
    | Readonly<{ status: 'recovered' }>
    | Readonly<{
        status: 'verified';
        fingerprint: VerifiedFingerprint;
      }>
    | Readonly<{ status: 'remaining' }>
    | Readonly<{ status: 'failed' }>
  > {
    let snapshot = await this.load(candidate);
    if (!snapshot) return Object.freeze({ status: 'remaining' as const });
    const completion = await this.completions.process(candidate.attemptId);
    if (completion === 'completed' || completion === 'already_terminal') {
      return Object.freeze({ status: 'recovered' as const });
    }
    if (completion === 'invalid') {
      return Object.freeze({ status: 'remaining' as const });
    }
    if (snapshot.attempt.status === 'claimed') {
      const result = await this.recovery.recover({
        ...snapshot,
        reason: 'unstarted_claim_expired',
        observedAtMs: Math.max(
          timestamp(
            this.clock.now(),
            'Local Workflow Task recovery clock',
          ),
          snapshot.attempt.createdAtMs,
        ),
      });
      return result === 'requeued' || result === 'already_recovered'
        ? Object.freeze({ status: 'recovered' as const })
        : Object.freeze({ status: 'remaining' as const });
    }
    if (
      (snapshot.attempt.status !== 'starting' &&
        snapshot.attempt.status !== 'running') ||
      !snapshot.attempt.executorHandle ||
      !Number.isSafeInteger(snapshot.attempt.pid) ||
      snapshot.attempt.pid! < 1
    ) {
      return Object.freeze({ status: 'remaining' as const });
    }
    const inspection = await this.inspector.inspect(
      snapshot.attempt.executorHandle,
    );
    if (inspection.status === 'unknown') {
      return inspection.reason === 'provider_unavailable'
        ? Object.freeze({ status: 'failed' as const })
        : Object.freeze({ status: 'remaining' as const });
    }
    if (inspection.identityPid !== snapshot.attempt.pid) {
      return Object.freeze({ status: 'remaining' as const });
    }
    if (inspection.status === 'running') {
      if (snapshot.attempt.status === 'starting') {
        if (!snapshot.attempt.callbackTokenHash) {
          return Object.freeze({ status: 'remaining' as const });
        }
        const marked = await this.workflowTasks.recordRunning({
          run: snapshot.run,
          attempt: snapshot.attempt,
          callbackTokenHash: snapshot.attempt.callbackTokenHash,
          executorHandle: snapshot.attempt.executorHandle,
          pid: snapshot.attempt.pid,
          startedAtMs: Math.max(
            timestamp(
              this.clock.now(),
              'Local Workflow Task recovery clock',
            ),
            snapshot.attempt.createdAtMs,
          ),
          attemptEventId: this.createEventId(),
          stepMutationId: this.createEventId(),
        });
        if (marked.status !== 'applied') {
          return Object.freeze({ status: 'remaining' as const });
        }
        snapshot = await this.load(candidate);
        if (!snapshot || snapshot.attempt.status !== 'running') {
          return Object.freeze({ status: 'remaining' as const });
        }
      }
      return Object.freeze({
        status: 'verified' as const,
        fingerprint: fingerprint(snapshot),
      });
    }
    if (this.receiptPublishGraceMs > 0) {
      await this.wait(this.receiptPublishGraceMs);
      const late = await this.completions.process(candidate.attemptId);
      if (late === 'completed' || late === 'already_terminal') {
        return Object.freeze({ status: 'recovered' as const });
      }
      if (late === 'invalid') {
        return Object.freeze({ status: 'remaining' as const });
      }
      snapshot = await this.load(candidate);
      if (!snapshot) return Object.freeze({ status: 'recovered' as const });
    }
    const result = await this.recovery.recover({
      ...snapshot,
      reason: 'execution_not_running',
      observedAtMs: Math.max(
        timestamp(
          this.clock.now(),
          'Local Workflow Task recovery clock',
        ),
        snapshot.attempt.createdAtMs,
        snapshot.attempt.startedAtMs ?? 0,
      ),
    });
    return result === 'failed' || result === 'already_recovered'
      ? Object.freeze({ status: 'recovered' as const })
      : Object.freeze({ status: 'remaining' as const });
  }

  private async verify(
    expected: ReadonlyMap<string, VerifiedFingerprint>,
  ): Promise<Readonly<{ remaining: number; failed: number }>> {
    let page: Readonly<LocalWorkflowTaskRecoveryPage>;
    try {
      page = validatePage(
        await this.recovery.listRecoveryCandidates({
          limit: MAX_LOCAL_WORKFLOW_TASK_RECOVERY_ITEMS,
        }),
      );
    } catch {
      return Object.freeze({ remaining: 0, failed: 1 });
    }
    if (page.truncated) {
      return Object.freeze({
        remaining: page.candidates.length,
        failed: 0,
      });
    }
    let remaining = 0;
    let failed = 0;
    for (const candidate of page.candidates) {
      const fingerprintValue = expected.get(candidate.attemptId);
      if (!fingerprintValue) {
        remaining += 1;
        continue;
      }
      try {
        const snapshot = await this.load(candidate);
        if (
          !snapshot ||
          snapshot.run.version !== fingerprintValue.runVersion ||
          snapshot.attempt.status !== 'running' ||
          snapshot.attempt.callbackSequence !==
            fingerprintValue.callbackSequence ||
          snapshot.attempt.executorHandle !==
            fingerprintValue.executorHandle ||
          snapshot.attempt.pid !== fingerprintValue.pid
        ) {
          remaining += 1;
          continue;
        }
        const inspection = await this.inspector.inspect(
          fingerprintValue.executorHandle,
        );
        if (
          inspection.status !== 'running' ||
          inspection.identityPid !== fingerprintValue.pid
        ) {
          remaining += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ remaining, failed });
  }

  private load(
    candidate: Readonly<LocalWorkflowTaskRecoveryCandidate>,
  ): Promise<ActiveSnapshot | null> {
    return this.runs.transaction(async (transaction) => {
      const [run, attempt] = await Promise.all([
        transaction.findRunById(candidate.runId),
        transaction.findAttemptById(candidate.attemptId),
      ]);
      if (
        !run ||
        !attempt ||
        run.status !== 'running' ||
        run.executionOwner !== 'runtime' ||
        run.cancelRequestedAtMs !== undefined ||
        attempt.runId !== run.id ||
        !attempt.stepRunId ||
        attempt.executorType !== 'local_process' ||
        !['claimed', 'starting', 'running'].includes(attempt.status) ||
        attempt.createdAtMs !== candidate.attemptCreatedAtMs
      ) {
        return null;
      }
      return Object.freeze({ run, attempt });
    });
  }
}
