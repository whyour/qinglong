import type { ExecutionOrigin } from '../domain/run';
import { selectOneLegacyExecution } from '../domain/legacyExecutionSelection';
import type {
  LegacyExecutionCallbackFact,
  LegacyExecutionCancellationFact,
  LegacyExecutionSelector,
} from '../ports/legacyExecutionCorrelation';
import type {
  ActiveLegacyShadowRun,
  LegacyShadowRunLocator,
} from '../ports/legacyShadowRunLocator';
import type { LegacyShadowRunWriter } from './legacyShadowRunWriter';

export type LegacyCorrelationOperation =
  | 'cancel_all'
  | 'cancel_one'
  | 'callback';
export type LegacyCorrelationFailureReason =
  | 'ambiguous'
  | 'truncated'
  | 'unmatched'
  | 'write_failed';

export interface LegacyCorrelationFailure {
  operation: LegacyCorrelationOperation;
  reason: LegacyCorrelationFailureReason;
  legacyCronId: number;
  candidateCount: number;
}

export interface LegacyCorrelationReporter {
  failure(failure: LegacyCorrelationFailure): void;
}

export interface LegacyCorrelationResult {
  matched: number;
  truncated: boolean;
}

export class LegacyShadowRunCorrelator {
  constructor(
    private readonly locator: LegacyShadowRunLocator,
    private readonly writer: LegacyShadowRunWriter,
    private readonly reporter: LegacyCorrelationReporter,
  ) {}

  async cancel(
    fact: LegacyExecutionCancellationFact,
    origins: readonly ExecutionOrigin[],
  ): Promise<LegacyCorrelationResult> {
    const lookup = await this.locator.listActiveByLegacyCron({
      legacyCronId: fact.legacyCronId,
      origins,
    });
    const candidates =
      fact.scope === 'all'
        ? [...lookup.candidates]
        : this.selectOne(lookup.candidates, fact);
    if (lookup.truncated) {
      this.report({
        operation: fact.scope === 'all' ? 'cancel_all' : 'cancel_one',
        reason: 'truncated',
        legacyCronId: fact.legacyCronId,
        candidateCount: lookup.candidates.length,
      });
    }
    if (fact.scope === 'one' && candidates.length !== 1) {
      this.reportSelectionFailure('cancel_one', fact, lookup.candidates);
      return { matched: 0, truncated: lookup.truncated };
    }

    let matched = 0;
    for (const candidate of candidates) {
      try {
        await this.writer.cancelled(
          { runId: candidate.runId, attemptId: candidate.attemptId },
          { atMs: fact.atMs, reason: fact.reason },
        );
        matched += 1;
      } catch {
        this.report({
          operation: fact.scope === 'all' ? 'cancel_all' : 'cancel_one',
          reason: 'write_failed',
          legacyCronId: fact.legacyCronId,
          candidateCount: 1,
        });
      }
    }
    return { matched, truncated: lookup.truncated };
  }

  async callback(
    fact: LegacyExecutionCallbackFact,
    origins: readonly ExecutionOrigin[],
  ): Promise<LegacyCorrelationResult> {
    const lookup = await this.locator.listActiveByLegacyCron({
      legacyCronId: fact.legacyCronId,
      origins,
    });
    const candidates = this.selectOne(lookup.candidates, fact);
    if (lookup.truncated) {
      this.report({
        operation: 'callback',
        reason: 'truncated',
        legacyCronId: fact.legacyCronId,
        candidateCount: lookup.candidates.length,
      });
    }
    if (candidates.length !== 1) {
      this.reportSelectionFailure('callback', fact, lookup.candidates);
      return { matched: 0, truncated: lookup.truncated };
    }

    const [candidate] = candidates;
    const reference = {
      runId: candidate.runId,
      attemptId: candidate.attemptId,
    };
    try {
      if (fact.phase === 'running') {
        await this.writer.spawned(reference, {
          atMs: fact.atMs,
          ...(fact.pid === undefined ? {} : { pid: fact.pid }),
          ...(fact.logArtifactId === undefined
            ? {}
            : { logArtifactId: fact.logArtifactId }),
        });
        await this.writer.running(reference, fact.atMs);
      } else {
        await this.writer.spawned(reference, {
          atMs: fact.atMs,
          ...(fact.pid === undefined ? {} : { pid: fact.pid }),
          ...(fact.logArtifactId === undefined
            ? {}
            : { logArtifactId: fact.logArtifactId }),
        });
        await this.writer.exited(reference, {
          atMs: fact.atMs,
          exitCode: fact.exitCode ?? 0,
        });
      }
    } catch {
      this.report({
        operation: 'callback',
        reason: 'write_failed',
        legacyCronId: fact.legacyCronId,
        candidateCount: 1,
      });
      return { matched: 0, truncated: lookup.truncated };
    }
    return { matched: 1, truncated: lookup.truncated };
  }

  private selectOne(
    candidates: readonly ActiveLegacyShadowRun[],
    selector: LegacyExecutionSelector,
  ): ActiveLegacyShadowRun[] {
    return selectOneLegacyExecution(candidates, selector);
  }

  private reportSelectionFailure(
    operation: LegacyCorrelationOperation,
    selector: LegacyExecutionSelector,
    candidates: readonly ActiveLegacyShadowRun[],
  ): void {
    this.report({
      operation,
      reason: candidates.length === 0 ? 'unmatched' : 'ambiguous',
      legacyCronId: selector.legacyCronId,
      candidateCount: candidates.length,
    });
  }

  private report(failure: LegacyCorrelationFailure): void {
    try {
      this.reporter.failure(failure);
    } catch {
      // Correlation diagnostics must not affect legacy execution.
    }
  }
}
