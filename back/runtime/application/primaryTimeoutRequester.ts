import type { RunCancellationReason } from '../domain/run';
import type {
  PrimaryTimeoutCursor,
  PrimaryTimeoutSource,
} from '../ports/primaryTimeoutSource';
import type {
  RequestRunCancellationCommand,
  RequestRunCancellationResult,
} from './runCommandService';

export interface PrimaryTimeoutClock {
  now(): number;
}

export interface PrimaryTimeoutCommandPort {
  requestCancellation(
    command: RequestRunCancellationCommand,
  ): Promise<RequestRunCancellationResult>;
}

export interface PrimaryTimeoutRequestSummary {
  scanned: number;
  accepted: number;
  alreadyRequested: number;
  alreadyTerminal: number;
  failed: number;
  truncated: boolean;
  nextCursor?: PrimaryTimeoutCursor;
}

/** One bounded timeout-intent pass. It never calls an Executor or sends signal. */
export class PrimaryTimeoutRequester {
  private readonly clock: PrimaryTimeoutClock;

  constructor(
    private readonly source: PrimaryTimeoutSource,
    private readonly commands: PrimaryTimeoutCommandPort,
    clock: PrimaryTimeoutClock = { now: Date.now },
  ) {
    this.clock = clock;
  }

  async requestBatch(
    options: {
      nowMs?: number;
      cursor?: PrimaryTimeoutCursor;
      limit?: number;
    } = {},
  ): Promise<PrimaryTimeoutRequestSummary> {
    const nowMs = options.nowMs ?? this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError('nowMs must be a non-negative safe integer');
    }
    const page = await this.source.listOverdue({
      nowMs,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const summary: PrimaryTimeoutRequestSummary = {
      scanned: page.candidates.length,
      accepted: 0,
      alreadyRequested: 0,
      alreadyTerminal: 0,
      failed: 0,
      truncated: page.truncated,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };

    for (const candidate of page.candidates) {
      if (candidate.deadlineAtMs > nowMs) {
        summary.failed += 1;
        continue;
      }
      try {
        const result = await this.commands.requestCancellation({
          runId: candidate.runId,
          attemptId: candidate.attemptId,
          atMs: nowMs,
          reason: 'timeout' satisfies RunCancellationReason,
          actor: { type: 'system', id: 'runtime:timeout' },
        });
        if (result.status === 'accepted') summary.accepted += 1;
        else if (result.status === 'already_requested') {
          summary.alreadyRequested += 1;
        } else {
          summary.alreadyTerminal += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }
}
