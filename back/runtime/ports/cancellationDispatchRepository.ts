import type {
  CancellationDispatchRecord,
  CancellationDispatchResult,
} from '../domain/cancellationDispatch';
import type { RunEventRecord } from '../domain/run';

export interface ClaimCancellationDispatchCommand {
  runId: string;
  attemptId: string;
  requestedAtMs: number;
  owner: string;
  leaseToken: string;
  nowMs: number;
  leaseDurationMs: number;
}

export type ClaimCancellationDispatchResult =
  | { status: 'claimed'; dispatch: CancellationDispatchRecord }
  | { status: 'not_eligible' }
  | {
      status: 'not_due' | 'leased' | 'dispatched' | 'blocked';
      dispatch: CancellationDispatchRecord;
    };

export interface RecordCancellationDispatchResultCommand {
  runId: string;
  attemptId: string;
  owner: string;
  leaseToken: string;
  expectedVersion: number;
  result: CancellationDispatchResult;
  atMs: number;
  nextAttemptAtMs?: number;
  eventId: string;
}

export interface RecordCancellationDispatchResult {
  dispatch: CancellationDispatchRecord;
  event: RunEventRecord;
}

export interface CancellationDispatchRepository {
  findByRunId(runId: string): Promise<CancellationDispatchRecord | null>;
  claim(
    command: ClaimCancellationDispatchCommand,
  ): Promise<ClaimCancellationDispatchResult>;
  recordResult(
    command: RecordCancellationDispatchResultCommand,
  ): Promise<RecordCancellationDispatchResult>;
}
