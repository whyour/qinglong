import type { RunDispatchLeaseRecord } from '../domain/runDispatchLease';

/** In-process lease renewal view used by the offer receiver. */
export interface WorkerRunLeaseTracker {
  track(lease: RunDispatchLeaseRecord): void;
  untrack(attemptId: string): RunDispatchLeaseRecord | undefined;
  leases(): RunDispatchLeaseRecord[];
}
