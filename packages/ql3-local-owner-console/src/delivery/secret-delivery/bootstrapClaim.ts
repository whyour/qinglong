import { formatApiCredentialToken } from '@qinglong/runtime-core/api-credential-token';
import type {
  ClaimLocalOwnerResult,
  LocalOwnerBootstrapRepository,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import type { LocalOwnerBootstrapService } from './ceremonyContracts';
import {
  LocalOwnerSecretDeliveryError,
  type ClaimLocalOwnerFromDeliveriesRequest,
} from './contracts';
import { deliveryClaimRequest } from './codec';
import { SecretDeliveryPrivateFilesystemStore } from './privateFilesystemStore';

export async function claimOwnerFromDeliveries(
  store: SecretDeliveryPrivateFilesystemStore,
  repository: LocalOwnerBootstrapRepository,
  service: Pick<LocalOwnerBootstrapService, 'claim'>,
  candidate: ClaimLocalOwnerFromDeliveriesRequest,
): Promise<Readonly<ClaimLocalOwnerResult>> {
  if (
    !repository ||
    typeof repository.resolveIssuedChallenge !== 'function' ||
    typeof repository.resolveProvisioning !== 'function' ||
    !service ||
    typeof service.claim !== 'function'
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'Owner bootstrap boundary is invalid',
    );
  }
  const command = deliveryClaimRequest(candidate);
  const existing = await repository.resolveIssuedChallenge(
    command.challengeMutationId,
  );
  if (existing?.consumedAtMs !== undefined) {
    const provisioning = await repository.resolveProvisioning(
      command.credentialMutationId,
    );
    if (
      existing.projectId !== command.projectId ||
      existing.claimMutationId !== command.mutationId ||
      existing.claimRequestId !== command.requestId ||
      !existing.binding ||
      !provisioning ||
      provisioning.credential.credentialId !== existing.credentialId ||
      provisioning.credential.version !== existing.credentialVersion
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'delivery claim conflicts with the committed database fact',
      );
    }
    return Object.freeze({
      status: 'existing' as const,
      challenge: existing,
      binding: existing.binding,
    });
  }
  store.entries();
  const credential = store.read(
    `credential-${command.credentialMutationId}.ready.json`,
  ).record;
  const challenge = store.read(
    `challenge-${command.challengeMutationId}.ready.json`,
  ).record;
  if (
    credential.kind !== 'credential' ||
    challenge.kind !== 'challenge' ||
    challenge.projectId !== command.projectId
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'delivery claim records do not match the requested Project',
    );
  }
  return service.claim({
    projectId: command.projectId,
    mutationId: command.mutationId,
    requestId: command.requestId,
    challengeId: challenge.challengeId,
    challengeToken: challenge.secret,
    credentialToken: formatApiCredentialToken(
      credential.credentialId,
      credential.secret,
    ),
  });
}
