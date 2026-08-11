import fs from 'node:fs';
import path from 'node:path';
import { apiCredentialSecretDigest } from '@qinglong/runtime-core/api-credential-token';
import {
  localOwnerBootstrapTokenDigest,
  type LocalOwnerBootstrapRepository,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import type { LocalOwnerCredentialRecoveryRepository } from '@qinglong/runtime-core/local-owner-credential-recovery';
import {
  LocalOwnerSecretDeliveryError,
  type LocalOwnerSecretRecoverySummary,
} from './contracts';
import {
  ACKNOWLEDGEMENT_NAME_PATTERN,
  RECORD_NAME_PATTERN,
  TEMP_NAME_PATTERN,
  fileAcknowledgement,
  persistentAcknowledgement,
  sameAcknowledgementSemantic,
} from './codec';
import {
  acknowledgeRecovery,
  validateAcknowledgement,
  validateRecoveryAcknowledgement,
} from './acknowledgement';
import { SecretDeliveryPrivateFilesystemStore } from './privateFilesystemStore';

export async function recover(
  store: SecretDeliveryPrivateFilesystemStore,
  repository: LocalOwnerBootstrapRepository,
  pepper: string,
  recoveryRepository?: LocalOwnerCredentialRecoveryRepository,
): Promise<Readonly<LocalOwnerSecretRecoverySummary>> {
  const initialEntries = store.entries();
  let inspectedPendingRecords = 0;
  let publishedRecords = 0;
  let retainedUncommittedRecords = 0;
  let orphanTemporaryRecords = 0;
  for (const fileName of initialEntries) {
    const match = ACKNOWLEDGEMENT_NAME_PATTERN.exec(fileName);
    if (!match) continue;
    const acknowledgement = store.readAcknowledgement(fileName);
    if (
      acknowledgement.kind === 'credential' &&
      recoveryRepository &&
      (await recoveryRepository.resolve(acknowledgement.mutationId))
    ) {
      await acknowledgeRecovery(
        store,
        recoveryRepository,
        pepper,
        acknowledgement.mutationId,
        acknowledgement.deliveryDigest,
        acknowledgement.acknowledgedAtMs,
      );
      continue;
    }
    const pendingName = `${acknowledgement.kind}-${acknowledgement.mutationId}.pending.json`;
    if (store.optional(pendingName)) {
      throw new LocalOwnerSecretDeliveryError(
        'acknowledged mutation still has a pending record',
      );
    }
    const readyName = `${acknowledgement.kind}-${acknowledgement.mutationId}.ready.json`;
    const ready = store.optional(readyName);
    await validateAcknowledgement(repository, pepper, acknowledgement, ready);
    const stored = await repository.recordDeliveryAcknowledgement(
      persistentAcknowledgement(acknowledgement),
    );
    if (
      !sameAcknowledgementSemantic(
        fileAcknowledgement(stored.acknowledgement),
        acknowledgement,
      )
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'database acknowledgement conflicts during recovery',
      );
    }
    if (ready) {
      fs.unlinkSync(path.join(store.directory, readyName));
      store.syncDirectory();
    }
    fs.unlinkSync(path.join(store.directory, fileName));
    store.syncDirectory();
  }
  const entries = store.entries();
  for (const fileName of entries) {
    if (TEMP_NAME_PATTERN.test(fileName)) {
      orphanTemporaryRecords += 1;
      continue;
    }
    const match = RECORD_NAME_PATTERN.exec(fileName);
    if (!match) continue;
    const stagedFile = store.read(fileName);
    const staged = stagedFile.record;
    const credentialRecovery =
      staged.kind === 'credential' && recoveryRepository
        ? await recoveryRepository.resolve(staged.mutationId)
        : null;
    if (credentialRecovery && credentialRecovery.state !== 'issued') {
      if (match[3] !== 'ready') {
        throw new LocalOwnerSecretDeliveryError(
          'database-acknowledged recovery still has a pending record',
        );
      }
      const recoveryAcknowledgement = fileAcknowledgement({
        kind: 'credential',
        mutationId: credentialRecovery.issueMutationId,
        requestId: credentialRecovery.issueRequestId,
        subjectId: credentialRecovery.subjectId,
        credentialId: credentialRecovery.replacementCredential.credentialId,
        factDigest: credentialRecovery.replacementCredential.secretDigest,
        ttlMs:
          credentialRecovery.replacementCredential.expiresAtMs -
          credentialRecovery.replacementCredential.notBeforeAtMs,
        deliveryDigest: credentialRecovery.deliveryDigest!,
        acknowledgedAtMs: credentialRecovery.acknowledgedAtMs!,
      });
      if (recoveryAcknowledgement.kind !== 'credential') {
        throw new LocalOwnerSecretDeliveryError(
          'database recovery acknowledgement kind is invalid',
        );
      }
      validateRecoveryAcknowledgement(
        pepper,
        recoveryAcknowledgement,
        credentialRecovery,
        stagedFile,
      );
      fs.unlinkSync(path.join(store.directory, fileName));
      store.syncDirectory();
      continue;
    }
    const acknowledged = await repository.resolveDeliveryAcknowledgement(
      staged.mutationId,
    );
    if (acknowledged) {
      if (match[3] !== 'ready') {
        throw new LocalOwnerSecretDeliveryError(
          'database-acknowledged mutation still has a pending record',
        );
      }
      await validateAcknowledgement(
        repository,
        pepper,
        fileAcknowledgement(acknowledged),
        stagedFile,
      );
      fs.unlinkSync(path.join(store.directory, fileName));
      store.syncDirectory();
      continue;
    }
    let committed = false;
    if (staged.kind === 'credential') {
      const provisioning = await repository.resolveProvisioning(
        staged.mutationId,
      );
      if (provisioning && credentialRecovery) {
        throw new LocalOwnerSecretDeliveryError(
          'credential mutation belongs to multiple database facts',
        );
      }
      if (provisioning) {
        if (
          provisioning.requestId !== staged.requestId ||
          provisioning.identity.subject.id !== staged.subjectId ||
          provisioning.credential.credentialId !== staged.credentialId ||
          provisioning.credential.secretDigest !==
            apiCredentialSecretDigest(
              pepper,
              staged.credentialId,
              staged.secret,
            ) ||
          provisioning.credential.expiresAtMs -
            provisioning.credential.notBeforeAtMs !==
            staged.ttlMs
        ) {
          throw new LocalOwnerSecretDeliveryError(
            'staged credential does not match committed provisioning',
          );
        }
        committed = true;
      } else if (credentialRecovery) {
        if (
          credentialRecovery.issueRequestId !== staged.requestId ||
          credentialRecovery.subjectId !== staged.subjectId ||
          credentialRecovery.replacementCredential.credentialId !==
            staged.credentialId ||
          credentialRecovery.replacementCredential.secretDigest !==
            apiCredentialSecretDigest(
              pepper,
              staged.credentialId,
              staged.secret,
            ) ||
          credentialRecovery.replacementCredential.expiresAtMs -
            credentialRecovery.replacementCredential.notBeforeAtMs !==
            staged.ttlMs
        ) {
          throw new LocalOwnerSecretDeliveryError(
            'staged credential does not match committed recovery',
          );
        }
        committed = true;
      }
    } else {
      const challenge = await repository.resolveIssuedChallenge(
        staged.mutationId,
      );
      if (challenge) {
        if (
          challenge.projectId !== staged.projectId ||
          challenge.issueRequestId !== staged.requestId ||
          challenge.challengeId !== staged.challengeId ||
          challenge.tokenDigest !==
            localOwnerBootstrapTokenDigest(
              staged.projectId,
              staged.challengeId,
              staged.secret,
            ) ||
          challenge.expiresAtMs - challenge.issuedAtMs !== staged.ttlMs
        ) {
          throw new LocalOwnerSecretDeliveryError(
            'staged challenge does not match committed issue',
          );
        }
        committed = true;
      }
    }
    if (match[3] === 'ready') {
      if (!committed) {
        throw new LocalOwnerSecretDeliveryError(
          'published secret has no committed database fact',
        );
      }
      continue;
    }
    inspectedPendingRecords += 1;
    if (!committed) {
      retainedUncommittedRecords += 1;
      continue;
    }
    await store.publish(staged);
    publishedRecords += 1;
  }
  return Object.freeze({
    inspectedPendingRecords,
    publishedRecords,
    retainedUncommittedRecords,
    orphanTemporaryRecords,
  });
}
