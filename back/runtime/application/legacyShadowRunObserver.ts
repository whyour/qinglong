import type { ExecutionOrigin } from '../domain/run';
import type { RuntimeRolloutPolicy } from '../domain/runtimeRollout';
import type {
  LegacyExecutionAcceptedFact,
  LegacyExecutionCancelledFact,
  LegacyExecutionExitedFact,
  LegacyExecutionObservation,
  LegacyExecutionObserver,
  LegacyExecutionRunningFact,
  LegacyExecutionSpawnedFact,
  LegacyExecutionStartFailedFact,
} from '../ports/legacyExecutionObserver';
import type {
  LegacyShadowRunReference,
  LegacyShadowRunWriter,
} from './legacyShadowRunWriter';

export type ShadowObservationOperation =
  | 'accept'
  | 'spawned'
  | 'running'
  | 'start_failed'
  | 'exited'
  | 'cancelled';

export interface ShadowObservationFailure {
  origin: ExecutionOrigin;
  operation: ShadowObservationOperation;
  errorCode: string;
  runId?: string;
  attemptId?: string;
}

export interface ShadowObservationReporter {
  failure(failure: ShadowObservationFailure): void;
}

export interface TrackedLegacyExecutionObservation
  extends LegacyExecutionObservation {
  settled(): Promise<void>;
}

const NOOP_OBSERVATION: TrackedLegacyExecutionObservation = Object.freeze({
  spawned() {},
  running() {},
  startFailed() {},
  exited() {},
  cancelled() {},
  async settled() {},
});

function classifyError(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as Error & { code?: unknown }).code === 'string'
  ) {
    const code = (error as Error & { code: string }).code;
    return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'SHADOW_UNKNOWN';
  }
  return 'SHADOW_UNKNOWN';
}

class SerialLegacyExecutionObservation
  implements TrackedLegacyExecutionObservation
{
  private chain: Promise<LegacyShadowRunReference | null>;

  constructor(
    private readonly origin: ExecutionOrigin,
    private readonly writer: LegacyShadowRunWriter,
    accepted: LegacyExecutionAcceptedFact,
    private readonly reporter: ShadowObservationReporter,
  ) {
    this.chain = writer.accept(accepted).catch((error) => {
      this.report('accept', error);
      return null;
    });
  }

  spawned(fact: LegacyExecutionSpawnedFact): void {
    this.enqueue('spawned', (reference) =>
      this.writer.spawned(reference, fact),
    );
  }

  running(fact: LegacyExecutionRunningFact): void {
    this.enqueue('running', (reference) =>
      this.writer.running(reference, fact.atMs),
    );
  }

  startFailed(fact: LegacyExecutionStartFailedFact): void {
    this.enqueue('start_failed', (reference) =>
      this.writer.startFailed(reference, fact),
    );
  }

  exited(fact: LegacyExecutionExitedFact): void {
    this.enqueue('exited', (reference) => this.writer.exited(reference, fact));
  }

  cancelled(fact: LegacyExecutionCancelledFact): void {
    this.enqueue('cancelled', (reference) =>
      this.writer.cancelled(reference, fact),
    );
  }

  async settled(): Promise<void> {
    await this.chain;
  }

  private enqueue(
    operation: ShadowObservationOperation,
    write: (reference: LegacyShadowRunReference) => Promise<void>,
  ): void {
    this.chain = this.chain.then(async (reference) => {
      if (!reference) return null;
      try {
        await write(reference);
      } catch (error) {
        this.report(operation, error, reference);
      }
      return reference;
    });
  }

  private report(
    operation: ShadowObservationOperation,
    error: unknown,
    reference?: LegacyShadowRunReference,
  ): void {
    try {
      this.reporter.failure({
        origin: this.origin,
        operation,
        errorCode: classifyError(error),
        ...(reference === undefined ? {} : reference),
      });
    } catch {
      // Shadow reporting must not become a second failure path.
    }
  }
}

export class LegacyShadowRunObserver implements LegacyExecutionObserver {
  constructor(
    private readonly policy: RuntimeRolloutPolicy,
    private readonly writer: LegacyShadowRunWriter,
    private readonly reporter: ShadowObservationReporter,
  ) {}

  begin(fact: LegacyExecutionAcceptedFact): TrackedLegacyExecutionObservation {
    const decision = this.policy.decide(fact.origin);
    if (decision.mode === 'off') return NOOP_OBSERVATION;
    if (decision.mode === 'primary') {
      throw new Error(
        'Legacy observer cannot accept a Runtime-owned primary execution',
      );
    }
    return new SerialLegacyExecutionObservation(
      fact.origin,
      this.writer,
      fact,
      this.reporter,
    );
  }
}
