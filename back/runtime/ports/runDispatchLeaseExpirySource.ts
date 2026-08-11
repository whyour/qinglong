export const MAX_RUN_DISPATCH_LEASE_EXPIRY_PAGE_SIZE = 64;

export interface RunDispatchLeaseExpiryCursor {
  expiresAtMs: number;
  attemptId: string;
}

export interface ExpiredRunDispatchLeaseCandidate
  extends RunDispatchLeaseExpiryCursor {
  runId: string;
}

export interface ListExpiredRunDispatchLeasesOptions {
  observedAtMs: number;
  after?: RunDispatchLeaseExpiryCursor;
  limit?: number;
}

export interface RunDispatchLeaseExpirySource {
  listExpired(
    options: ListExpiredRunDispatchLeasesOptions,
  ): Promise<readonly ExpiredRunDispatchLeaseCandidate[]>;
}
