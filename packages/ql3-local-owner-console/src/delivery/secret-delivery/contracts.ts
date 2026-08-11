export interface LocalOwnerSecretDeliverySummary {
  readonly kind: 'credential' | 'challenge';
  readonly mutationId: string;
  readonly requestId: string;
  readonly deliveryDigest: string;
  readonly path: string;
}

export interface LocalOwnerSecretRecoverySummary {
  readonly inspectedPendingRecords: number;
  readonly publishedRecords: number;
  readonly retainedUncommittedRecords: number;
  readonly orphanTemporaryRecords: number;
}

export interface ClaimLocalOwnerFromDeliveriesRequest {
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly credentialMutationId: string;
  readonly challengeMutationId: string;
}

export class LocalOwnerSecretDeliveryError extends Error {
  readonly code = 'LOCAL_OWNER_SECRET_DELIVERY_FAILED';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Owner secret delivery failed: ${message}`);
    this.name = 'LocalOwnerSecretDeliveryError';
  }
}
