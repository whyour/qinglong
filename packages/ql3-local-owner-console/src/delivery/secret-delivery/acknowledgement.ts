import fs from 'node:fs';
import path from 'node:path';
import { apiCredentialSecretDigest } from '@qinglong/runtime-core/api-credential-token';
import {
  assertLocalOwnerBootstrapMutationId,
  localOwnerBootstrapTokenDigest,
  type LocalOwnerBootstrapRepository,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import type {
  LocalOwnerCredentialRecoveryRecord,
  LocalOwnerCredentialRecoveryRepository,
} from '@qinglong/runtime-core/local-owner-credential-recovery';
import type {
  LocalOwnerBootstrapSecretDeliveryAcknowledgement,
  LocalOwnerCredentialRecoveryDeliveryAcknowledgement,
} from './ceremonyContracts';
import { LocalOwnerSecretDeliveryError } from './contracts';
import {
  acknowledgementName,
  fileAcknowledgement,
  persistentAcknowledgement,
  sameAcknowledgementSemantic,
  type AcknowledgementRecord,
  type CredentialAcknowledgementRecord,
  type DeliveryFile,
} from './codec';
import { SecretDeliveryPrivateFilesystemStore } from './privateFilesystemStore';

export async function validateAcknowledgement(
  repository: LocalOwnerBootstrapRepository,
  pepper: string,
  acknowledgement: Readonly<AcknowledgementRecord>,
  ready: DeliveryFile | null,
): Promise<void> {
  if (ready) {
    if (
      ready.record.kind !== acknowledgement.kind ||
      ready.record.mutationId !== acknowledgement.mutationId ||
      ready.record.requestId !== acknowledgement.requestId ||
      ready.record.ttlMs !== acknowledgement.ttlMs ||
      ready.digest !== acknowledgement.deliveryDigest
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'acknowledgement does not bind the published record',
      );
    }
  }
  if (acknowledgement.kind === 'credential') {
    const provisioning = await repository.resolveProvisioning(
      acknowledgement.mutationId,
    );
    if (
      !provisioning ||
      provisioning.requestId !== acknowledgement.requestId ||
      provisioning.identity.subject.id !== acknowledgement.subjectId ||
      provisioning.credential.credentialId !== acknowledgement.credentialId ||
      provisioning.credential.secretDigest !== acknowledgement.factDigest ||
      provisioning.credential.expiresAtMs -
        provisioning.credential.notBeforeAtMs !==
        acknowledgement.ttlMs ||
      (ready &&
        (ready.record.kind !== 'credential' ||
          ready.record.subjectId !== acknowledgement.subjectId ||
          ready.record.credentialId !== acknowledgement.credentialId ||
          apiCredentialSecretDigest(
            pepper,
            ready.record.credentialId,
            ready.record.secret,
          ) !== acknowledgement.factDigest))
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'credential acknowledgement does not match its database fact',
      );
    }
    return;
  }
  const challenge = await repository.resolveIssuedChallenge(
    acknowledgement.mutationId,
  );
  if (
    !challenge ||
    challenge.projectId !== acknowledgement.projectId ||
    challenge.issueRequestId !== acknowledgement.requestId ||
    challenge.challengeId !== acknowledgement.challengeId ||
    challenge.tokenDigest !== acknowledgement.factDigest ||
    challenge.expiresAtMs - challenge.issuedAtMs !== acknowledgement.ttlMs ||
    (ready &&
      (ready.record.kind !== 'challenge' ||
        ready.record.projectId !== acknowledgement.projectId ||
        ready.record.challengeId !== acknowledgement.challengeId ||
        localOwnerBootstrapTokenDigest(
          ready.record.projectId,
          ready.record.challengeId,
          ready.record.secret,
        ) !== acknowledgement.factDigest))
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'challenge acknowledgement does not match its database fact',
    );
  }
}

export function validateRecoveryAcknowledgement(
  pepper: string,
  acknowledgement: Readonly<CredentialAcknowledgementRecord>,
  recovery: Readonly<LocalOwnerCredentialRecoveryRecord>,
  ready: DeliveryFile | null,
): void {
  if (
    recovery.issueMutationId !== acknowledgement.mutationId ||
    recovery.issueRequestId !== acknowledgement.requestId ||
    recovery.subjectId !== acknowledgement.subjectId ||
    recovery.replacementCredential.credentialId !==
      acknowledgement.credentialId ||
    recovery.replacementCredential.secretDigest !==
      acknowledgement.factDigest ||
    recovery.replacementCredential.expiresAtMs -
      recovery.replacementCredential.notBeforeAtMs !==
      acknowledgement.ttlMs ||
    (ready &&
      (ready.record.kind !== 'credential' ||
        ready.record.mutationId !== acknowledgement.mutationId ||
        ready.record.requestId !== acknowledgement.requestId ||
        ready.record.subjectId !== acknowledgement.subjectId ||
        ready.record.credentialId !== acknowledgement.credentialId ||
        ready.record.ttlMs !== acknowledgement.ttlMs ||
        ready.digest !== acknowledgement.deliveryDigest ||
        apiCredentialSecretDigest(
          pepper,
          ready.record.credentialId,
          ready.record.secret,
        ) !== acknowledgement.factDigest))
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'credential recovery acknowledgement does not match its database fact',
    );
  }
}

export async function acknowledge(
  store: SecretDeliveryPrivateFilesystemStore,
  repository: LocalOwnerBootstrapRepository,
  pepper: string,
  kind: 'credential' | 'challenge',
  mutationId: string,
  expectedDeliveryDigest: string,
  acknowledgedAtMs = Date.now(),
): Promise<Readonly<LocalOwnerBootstrapSecretDeliveryAcknowledgement>> {
  try {
    assertLocalOwnerBootstrapMutationId(mutationId);
  } catch (error) {
    throw new LocalOwnerSecretDeliveryError('mutationId is invalid', error);
  }
  if (
    !/^[0-9a-f]{64}$/.test(expectedDeliveryDigest) ||
    !Number.isSafeInteger(acknowledgedAtMs) ||
    acknowledgedAtMs < 0
  ) {
    throw new LocalOwnerSecretDeliveryError('acknowledgement input is invalid');
  }
  store.entries();
  const ackName = acknowledgementName(kind, mutationId);
  const existing = store.optionalAcknowledgement(ackName);
  const readyName = `${kind}-${mutationId}.ready.json`;
  const ready = store.optional(readyName);
  const persisted = await repository.resolveDeliveryAcknowledgement(mutationId);
  const persistedFile = persisted ? fileAcknowledgement(persisted) : null;
  if (
    persistedFile &&
    (persistedFile.kind !== kind ||
      persistedFile.deliveryDigest !== expectedDeliveryDigest)
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'database acknowledgement conflicts with the expected delivery',
    );
  }
  if (
    existing &&
    (existing.deliveryDigest !== expectedDeliveryDigest ||
      (persistedFile && !sameAcknowledgementSemantic(existing, persistedFile)))
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'acknowledgement digest conflicts with the published record',
    );
  }
  if (!existing && !ready && !persistedFile) {
    throw new LocalOwnerSecretDeliveryError('published record does not exist');
  }
  if (ready && ready.digest !== expectedDeliveryDigest) {
    throw new LocalOwnerSecretDeliveryError(
      'published record digest changed before acknowledgement',
    );
  }
  let record = existing ?? persistedFile;
  if (!record) {
    const delivery = ready!.record;
    if (delivery.kind === 'credential') {
      const provisioning = await repository.resolveProvisioning(mutationId);
      const factDigest = apiCredentialSecretDigest(
        pepper,
        delivery.credentialId,
        delivery.secret,
      );
      if (
        !provisioning ||
        provisioning.requestId !== delivery.requestId ||
        provisioning.identity.subject.id !== delivery.subjectId ||
        provisioning.credential.credentialId !== delivery.credentialId ||
        provisioning.credential.secretDigest !== factDigest ||
        provisioning.credential.expiresAtMs -
          provisioning.credential.notBeforeAtMs !==
          delivery.ttlMs
      ) {
        throw new LocalOwnerSecretDeliveryError(
          'published credential does not match its database fact',
        );
      }
      record = Object.freeze({
        state: 'acknowledged' as const,
        kind: 'credential' as const,
        mutationId,
        requestId: delivery.requestId,
        subjectId: delivery.subjectId,
        credentialId: delivery.credentialId,
        factDigest,
        ttlMs: delivery.ttlMs,
        deliveryDigest: expectedDeliveryDigest,
        acknowledgedAtMs,
      });
    } else {
      const challenge = await repository.resolveIssuedChallenge(mutationId);
      const factDigest = localOwnerBootstrapTokenDigest(
        delivery.projectId,
        delivery.challengeId,
        delivery.secret,
      );
      if (
        !challenge ||
        challenge.projectId !== delivery.projectId ||
        challenge.issueRequestId !== delivery.requestId ||
        challenge.challengeId !== delivery.challengeId ||
        challenge.tokenDigest !== factDigest ||
        challenge.expiresAtMs - challenge.issuedAtMs !== delivery.ttlMs
      ) {
        throw new LocalOwnerSecretDeliveryError(
          'published challenge does not match its database fact',
        );
      }
      record = Object.freeze({
        state: 'acknowledged' as const,
        kind: 'challenge' as const,
        projectId: delivery.projectId,
        mutationId,
        requestId: delivery.requestId,
        challengeId: delivery.challengeId,
        factDigest,
        ttlMs: delivery.ttlMs,
        deliveryDigest: expectedDeliveryDigest,
        acknowledgedAtMs,
      });
    }
    record = store.writeAcknowledgement(record);
  }
  await validateAcknowledgement(repository, pepper, record, ready);
  const stored = await repository.recordDeliveryAcknowledgement(
    persistentAcknowledgement(record),
  );
  const storedFile = fileAcknowledgement(stored.acknowledgement);
  if (!sameAcknowledgementSemantic(storedFile, record)) {
    throw new LocalOwnerSecretDeliveryError(
      'database acknowledgement conflicts with the published record',
    );
  }
  record = storedFile;
  const currentReady = store.optional(readyName);
  if (currentReady) {
    if (currentReady.digest !== record.deliveryDigest) {
      throw new LocalOwnerSecretDeliveryError(
        'published record changed during acknowledgement',
      );
    }
    fs.unlinkSync(path.join(store.directory, readyName));
    store.syncDirectory();
  }
  const currentAcknowledgement = store.optionalAcknowledgement(ackName);
  if (currentAcknowledgement) {
    if (!sameAcknowledgementSemantic(currentAcknowledgement, record)) {
      throw new LocalOwnerSecretDeliveryError(
        'file acknowledgement changed during cleanup',
      );
    }
    fs.unlinkSync(path.join(store.directory, ackName));
    store.syncDirectory();
  }
  return Object.freeze({
    state: 'acknowledged' as const,
    kind: record.kind,
    ...(record.kind === 'challenge' ? { projectId: record.projectId } : {}),
    mutationId: record.mutationId,
    requestId: record.requestId,
    ttlMs: record.ttlMs,
  }) as Readonly<LocalOwnerBootstrapSecretDeliveryAcknowledgement>;
}

export async function acknowledgeRecovery(
  store: SecretDeliveryPrivateFilesystemStore,
  repository: LocalOwnerCredentialRecoveryRepository,
  pepper: string,
  mutationId: string,
  expectedDeliveryDigest: string,
  acknowledgedAtMs = Date.now(),
): Promise<Readonly<LocalOwnerCredentialRecoveryDeliveryAcknowledgement>> {
  try {
    assertLocalOwnerBootstrapMutationId(mutationId);
  } catch (error) {
    throw new LocalOwnerSecretDeliveryError('mutationId is invalid', error);
  }
  if (
    !/^[0-9a-f]{64}$/.test(expectedDeliveryDigest) ||
    !Number.isSafeInteger(acknowledgedAtMs) ||
    acknowledgedAtMs < 0
  ) {
    throw new LocalOwnerSecretDeliveryError('acknowledgement input is invalid');
  }
  store.entries();
  const ackName = acknowledgementName('credential', mutationId);
  const existing = store.optionalAcknowledgement(ackName);
  if (existing && existing.kind !== 'credential') {
    throw new LocalOwnerSecretDeliveryError(
      'credential recovery acknowledgement kind is invalid',
    );
  }
  const readyName = `credential-${mutationId}.ready.json`;
  const ready = store.optional(readyName);
  const persisted = await repository.resolve(mutationId);
  if (!persisted) {
    throw new LocalOwnerSecretDeliveryError(
      'credential recovery database fact does not exist',
    );
  }
  const persistedFile =
    persisted.state === 'issued'
      ? null
      : fileAcknowledgement({
          kind: 'credential',
          mutationId: persisted.issueMutationId,
          requestId: persisted.issueRequestId,
          subjectId: persisted.subjectId,
          credentialId: persisted.replacementCredential.credentialId,
          factDigest: persisted.replacementCredential.secretDigest,
          ttlMs:
            persisted.replacementCredential.expiresAtMs -
            persisted.replacementCredential.notBeforeAtMs,
          deliveryDigest: persisted.deliveryDigest!,
          acknowledgedAtMs: persisted.acknowledgedAtMs!,
        });
  if (
    persistedFile &&
    persistedFile.deliveryDigest !== expectedDeliveryDigest
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'database recovery acknowledgement conflicts with expected delivery',
    );
  }
  if (
    existing &&
    (existing.deliveryDigest !== expectedDeliveryDigest ||
      (persistedFile && !sameAcknowledgementSemantic(existing, persistedFile)))
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'recovery acknowledgement conflicts with the published record',
    );
  }
  if (!existing && !ready && !persistedFile) {
    throw new LocalOwnerSecretDeliveryError(
      'published recovery credential does not exist',
    );
  }
  if (ready && ready.digest !== expectedDeliveryDigest) {
    throw new LocalOwnerSecretDeliveryError(
      'published recovery credential changed before acknowledgement',
    );
  }
  let record = existing ?? persistedFile;
  if (!record) {
    const delivery = ready!.record;
    if (delivery.kind !== 'credential') {
      throw new LocalOwnerSecretDeliveryError(
        'published recovery credential kind is invalid',
      );
    }
    const factDigest = apiCredentialSecretDigest(
      pepper,
      delivery.credentialId,
      delivery.secret,
    );
    record = Object.freeze({
      state: 'acknowledged' as const,
      kind: 'credential' as const,
      mutationId,
      requestId: delivery.requestId,
      subjectId: delivery.subjectId,
      credentialId: delivery.credentialId,
      factDigest,
      ttlMs: delivery.ttlMs,
      deliveryDigest: expectedDeliveryDigest,
      acknowledgedAtMs,
    });
    validateRecoveryAcknowledgement(pepper, record, persisted, ready);
    record = store.writeAcknowledgement(record);
  }
  if (record.kind !== 'credential') {
    throw new LocalOwnerSecretDeliveryError(
      'credential recovery acknowledgement kind is invalid',
    );
  }
  validateRecoveryAcknowledgement(pepper, record, persisted, ready);
  const stored = await repository.acknowledge({
    issueMutationId: record.mutationId,
    requestId: record.requestId,
    credentialId: record.credentialId,
    factDigest: record.factDigest,
    deliveryDigest: record.deliveryDigest,
    acknowledgedAtMs: record.acknowledgedAtMs,
  });
  if (
    stored.recovery.state === 'issued' ||
    stored.recovery.deliveryDigest !== record.deliveryDigest ||
    stored.recovery.acknowledgedAtMs !== record.acknowledgedAtMs
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'database recovery acknowledgement conflicts with published record',
    );
  }
  const currentReady = store.optional(readyName);
  if (currentReady) {
    if (currentReady.digest !== record.deliveryDigest) {
      throw new LocalOwnerSecretDeliveryError(
        'published recovery credential changed during acknowledgement',
      );
    }
    fs.unlinkSync(path.join(store.directory, readyName));
    store.syncDirectory();
  }
  const currentAcknowledgement = store.optionalAcknowledgement(ackName);
  if (currentAcknowledgement) {
    if (!sameAcknowledgementSemantic(currentAcknowledgement, record)) {
      throw new LocalOwnerSecretDeliveryError(
        'recovery acknowledgement file changed during cleanup',
      );
    }
    fs.unlinkSync(path.join(store.directory, ackName));
    store.syncDirectory();
  }
  return Object.freeze({
    state: 'acknowledged' as const,
    kind: 'credential' as const,
    mutationId: record.mutationId,
    requestId: record.requestId,
    ttlMs: record.ttlMs,
  });
}
