import type { RunDispatchLeaseRecord } from '../domain/runDispatchLease';
import type {
  FencedRunDispatchLeaseRequest,
  ReleaseRunDispatchLeaseRequest,
} from '../application/runDispatchLeaseService';
import type { ReleaseRunDispatchLeaseResult } from './runDispatchLeaseRepository';

export interface WorkerRunLeaseClient {
  renew(
    request: FencedRunDispatchLeaseRequest,
  ): Promise<RunDispatchLeaseRecord>;
  release(
    request: ReleaseRunDispatchLeaseRequest,
  ): Promise<ReleaseRunDispatchLeaseResult>;
}
