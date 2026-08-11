import type { RunDispatchLeaseRecord } from '../domain/runDispatchLease';
import type { ReleaseRunDispatchLeaseResult } from '../ports/runDispatchLeaseRepository';
import type { WorkerRunLeaseClient } from '../ports/workerRunLeaseClient';
import type {
  FencedRunDispatchLeaseRequest,
  ReleaseRunDispatchLeaseRequest,
} from './runDispatchLeaseService';
import { RunDispatchLeaseService } from './runDispatchLeaseService';
import type { AuthenticatedWorkerPrincipal } from './workerControlService';

/**
 * Transport seam: the authenticated principal is fixed when the client is
 * constructed and can never be supplied by a Worker request body.
 */
export class BoundWorkerRunLeaseClient implements WorkerRunLeaseClient {
  constructor(
    private readonly service: RunDispatchLeaseService,
    private readonly principal: AuthenticatedWorkerPrincipal,
  ) {}

  renew(
    request: FencedRunDispatchLeaseRequest,
  ): Promise<RunDispatchLeaseRecord> {
    return this.service.renew(this.principal, request);
  }

  release(
    request: ReleaseRunDispatchLeaseRequest,
  ): Promise<ReleaseRunDispatchLeaseResult> {
    return this.service.release(this.principal, request);
  }
}
