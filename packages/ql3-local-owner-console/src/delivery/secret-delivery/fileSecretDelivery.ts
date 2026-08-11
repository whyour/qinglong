import type {
  LocalOwnerBootstrapSecretDelivery,
  LocalOwnerBootstrapSecretDeliveryAcknowledgement,
  LocalOwnerBootstrapSecretDeliveryPreparation,
  LocalOwnerBootstrapSecretDeliveryRecord,
  LocalOwnerBootstrapService,
  LocalOwnerCredentialRecoveryDeliveryAcknowledgement,
} from './ceremonyContracts';
import type {
  ClaimLocalOwnerResult,
  LocalOwnerBootstrapRepository,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import type { LocalOwnerDeliveryBridgeClearEvidence } from '@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc';
import type { LocalOwnerCredentialRecoveryRepository } from '@qinglong/runtime-core/local-owner-credential-recovery';
import type {
  ClaimLocalOwnerFromDeliveriesRequest,
  LocalOwnerSecretDeliverySummary,
  LocalOwnerSecretRecoverySummary,
} from './contracts';
import { acknowledge, acknowledgeRecovery } from './acknowledgement';
import { claimOwnerFromDeliveries } from './bootstrapClaim';
import { SecretDeliveryPrivateFilesystemStore } from './privateFilesystemStore';
import { recover } from './recovery';

export class FileLocalOwnerBootstrapSecretDelivery
  implements LocalOwnerBootstrapSecretDelivery
{
  private readonly store: SecretDeliveryPrivateFilesystemStore;

  constructor(readonly directory: string) {
    this.store = new SecretDeliveryPrivateFilesystemStore(directory);
  }

  inspectBridgeClear(
    kind: 'credential' | 'challenge',
    mutationId: string,
  ): Readonly<LocalOwnerDeliveryBridgeClearEvidence> {
    return this.store.inspectBridgeClear(kind, mutationId);
  }

  async prepare(
    candidate: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  ): Promise<Readonly<LocalOwnerBootstrapSecretDeliveryPreparation>> {
    return this.store.prepare(candidate);
  }

  async publish(
    prepared: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  ): Promise<void> {
    return this.store.publish(prepared);
  }

  inspectReady(
    kind: 'credential' | 'challenge',
    mutationId: string,
  ): Readonly<LocalOwnerSecretDeliverySummary> {
    return this.store.inspectReady(kind, mutationId);
  }

  async claimOwnerFromDeliveries(
    repository: LocalOwnerBootstrapRepository,
    service: Pick<LocalOwnerBootstrapService, 'claim'>,
    candidate: ClaimLocalOwnerFromDeliveriesRequest,
  ): Promise<Readonly<ClaimLocalOwnerResult>> {
    return claimOwnerFromDeliveries(this.store, repository, service, candidate);
  }

  async acknowledge(
    repository: LocalOwnerBootstrapRepository,
    pepper: string,
    kind: 'credential' | 'challenge',
    mutationId: string,
    expectedDeliveryDigest: string,
    acknowledgedAtMs = Date.now(),
  ): Promise<Readonly<LocalOwnerBootstrapSecretDeliveryAcknowledgement>> {
    return acknowledge(
      this.store,
      repository,
      pepper,
      kind,
      mutationId,
      expectedDeliveryDigest,
      acknowledgedAtMs,
    );
  }

  async acknowledgeRecovery(
    repository: LocalOwnerCredentialRecoveryRepository,
    pepper: string,
    mutationId: string,
    expectedDeliveryDigest: string,
    acknowledgedAtMs = Date.now(),
  ): Promise<Readonly<LocalOwnerCredentialRecoveryDeliveryAcknowledgement>> {
    return acknowledgeRecovery(
      this.store,
      repository,
      pepper,
      mutationId,
      expectedDeliveryDigest,
      acknowledgedAtMs,
    );
  }

  async recover(
    repository: LocalOwnerBootstrapRepository,
    pepper: string,
    recoveryRepository?: LocalOwnerCredentialRecoveryRepository,
  ): Promise<Readonly<LocalOwnerSecretRecoverySummary>> {
    return recover(this.store, repository, pepper, recoveryRepository);
  }

  readyPath(kind: 'credential' | 'challenge', mutationId: string): string {
    return this.store.readyPath(kind, mutationId);
  }
}
