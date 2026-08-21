import {
  applyReviewedLocalDataDirectoryAdoption,
  LocalDataDirectoryAdoptionApplicationConfigurationError,
} from '@qinglong/local-admin/data-directory-adoption';
import { LocalSecretKeyringFileProvider } from '@qinglong/local-secret';
import { openLocalSqliteBootstrapDatabase } from '@qinglong/local-sqlite/bootstrap';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';

import {
  LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
  LocalDataDirectoryAdoptionConfigurationError,
  type ApplyLocalDataDirectoryAdoptionCommand,
  type VerifyLocalDataDirectoryAdoptionApplicationCommand,
  type VerifyLocalDataDirectoryAdoptionCommand,
} from '../contract';
import { verifyLocalDataDirectoryAdoption } from '../staging';
import { transformationAuthority } from '../transformation/files';
import {
  loadStaticTransformation,
  verifyTransformationManifestBinding,
} from '../transformation/manifest';
import {
  reclaimCommittedTransformationModel,
  verifyCommittedTransformationModel,
} from './cleanup';

export interface LocalDataDirectoryApplicationResult {
  readonly schemaVersion: 1;
  readonly operation:
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION;
  readonly status: 'committed' | 'verified';
  readonly evidence: Readonly<{
    profile: 'edge' | 'standalone';
    databaseStatus: 'inserted' | 'existing';
    sourceStageManifestDigest: string;
    transformationDigest: string;
    modelDigest: string;
    publicationDigest: string;
    receiptDigest: string;
    commitDigest: string;
    secretCount: number;
    environmentSecretCount: number;
    sshSecretCount: number;
    committedAtMs: number;
    modelReclaimed: true;
    plaintextFilesRemoved: true;
    physicalErasureGuaranteed: false;
  }>;
}

type ApplicationCommand =
  | Readonly<ApplyLocalDataDirectoryAdoptionCommand>
  | Readonly<VerifyLocalDataDirectoryAdoptionApplicationCommand>;

function sourceVerificationCommand(
  command: ApplicationCommand,
): Readonly<VerifyLocalDataDirectoryAdoptionCommand> {
  return Object.freeze({
    schemaVersion: 1,
    operation: LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
    options: Object.freeze({
      deploymentRoot: command.options.deploymentRoot,
      dataRoot: command.options.dataRoot,
      stagingRoot: command.options.stagingRoot,
      profile: command.options.profile,
      sqlite: command.options.sqlite,
      expectedManifestDigest: command.options.expectedManifestDigest,
    }),
  });
}

async function loadPreparedModel(
  command: ApplicationCommand,
  authority: ReturnType<typeof transformationAuthority>,
) {
  const before = await verifyLocalDataDirectoryAdoption(
    sourceVerificationCommand(command),
  );
  const loaded = loadStaticTransformation({
    authority,
    profile: command.options.profile,
    projectId: command.options.projectId,
    sourceStageManifestDigest: command.options.expectedManifestDigest,
    expectedTransformationDigest: command.options.expectedTransformationDigest,
  });
  if (
    loaded.manifest.assessment !== 'ready' ||
    loaded.manifest.model.manualCategories !== 0 ||
    (loaded.prepared.model.manualReview as { readonly required?: unknown })
      .required !== false
  ) {
    throw new LocalDataDirectoryAdoptionApplicationConfigurationError(
      'manual review must be resolved in a new transformation before apply',
    );
  }
  const after = await verifyLocalDataDirectoryAdoption(
    sourceVerificationCommand(command),
  );
  if (JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staged source changed while preparing the application transaction',
    );
  }
  return loaded.prepared;
}

function result(
  operation: LocalDataDirectoryApplicationResult['operation'],
  status: LocalDataDirectoryApplicationResult['status'],
  databaseStatus: 'inserted' | 'existing',
  adoption: Awaited<
    ReturnType<typeof applyReviewedLocalDataDirectoryAdoption>
  >['adoption'],
  commit: ReturnType<typeof reclaimCommittedTransformationModel>,
): Readonly<LocalDataDirectoryApplicationResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    evidence: Object.freeze({
      profile: adoption.profile,
      databaseStatus,
      sourceStageManifestDigest: adoption.sourceStageManifestDigest,
      transformationDigest: adoption.transformationDigest,
      modelDigest: adoption.modelDigest,
      publicationDigest: adoption.publicationDigest,
      receiptDigest: adoption.receiptDigest,
      commitDigest: commit.commitDigest,
      secretCount: adoption.receipt.secretCount,
      environmentSecretCount: adoption.receipt.environmentSecretCount,
      sshSecretCount: adoption.receipt.sshSecretCount,
      committedAtMs: adoption.committedAtMs,
      modelReclaimed: true,
      plaintextFilesRemoved: true,
      physicalErasureGuaranteed: false,
    }),
  });
}

async function authenticatedAuthority(command: ApplicationCommand): Promise<
  Readonly<{
    authenticated: Readonly<AuthenticatedLocalCommand>;
    close(): Promise<void>;
  }>
> {
  const database = await openLocalSqliteBootstrapDatabase({
    databasePath: command.options.sqlite.targetPath,
    profile: command.options.profile,
    ...(command.options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: command.options.busyTimeoutMs }),
  });
  try {
    const authenticated = await establishAuthenticatedLocalCommand(database, {
      deploymentRoot: command.options.deploymentRoot,
      databasePath: command.options.sqlite.targetPath,
      ownerPepperKeyringDirectory: command.options.ownerPepperKeyringDirectory,
      credentialFilePath: command.options.credentialFilePath,
      authenticationNamespace: 'local_data_adoption',
    });
    return Object.freeze({
      authenticated,
      close: () => database.close(),
    });
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function apply(
  command: ApplicationCommand,
  verifyOnly: boolean,
): Promise<Readonly<LocalDataDirectoryApplicationResult>> {
  const authority = transformationAuthority(command.options, false);
  const manifest = verifyTransformationManifestBinding({
    authority,
    profile: command.options.profile,
    projectId: command.options.projectId,
    sourceStageManifestDigest: command.options.expectedManifestDigest,
    expectedTransformationDigest: command.options.expectedTransformationDigest,
  });
  const authentication = await authenticatedAuthority(command);
  try {
    const applied = await applyReviewedLocalDataDirectoryAdoption({
      databasePath: command.options.sqlite.targetPath,
      profile: command.options.profile,
      projectId: command.options.projectId,
      mutationId: command.options.mutationId,
      failureAuditEventId: command.options.failureAuditEventId,
      requestId: command.options.requestId,
      sourceStageManifestDigest: command.options.expectedManifestDigest,
      transformationDigest: command.options.expectedTransformationDigest,
      modelDigest: manifest.model.digest,
      principal: authentication.authenticated.principal,
      keyProvider: new LocalSecretKeyringFileProvider(
        command.options.secretKeyringPath,
      ),
      observedAtMs: Date.now(),
      ...(command.options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: command.options.busyTimeoutMs }),
      loadPreparedModel: verifyOnly
        ? () => {
            throw new LocalDataDirectoryAdoptionConfigurationError(
              'application receipt does not exist',
            );
          }
        : () => loadPreparedModel(command, authority),
      confirmAuthenticationAuthority: () =>
        authentication.authenticated.confirm(),
      async confirmPreparedAuthority() {
        await loadPreparedModel(command, authority);
      },
    });
    if (
      applied.adoption.modelDigest !== manifest.model.digest ||
      applied.adoption.transformationDigest !== manifest.transformationDigest
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'database application does not match the transformation manifest',
      );
    }
    if (verifyOnly) {
      const verifyCommand =
        command as Readonly<VerifyLocalDataDirectoryAdoptionApplicationCommand>;
      const commit = verifyCommittedTransformationModel({
        authority,
        adoption: applied.adoption,
        expectedReceiptDigest: verifyCommand.options.expectedReceiptDigest,
      });
      return result(
        LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION,
        'verified',
        applied.status,
        applied.adoption,
        commit,
      );
    }
    const commit = reclaimCommittedTransformationModel({
      authority,
      adoption: applied.adoption,
    });
    return result(
      LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION,
      'committed',
      applied.status,
      applied.adoption,
      commit,
    );
  } finally {
    await authentication.close();
  }
}

export function applyLocalDataDirectoryAdoption(
  command: Readonly<ApplyLocalDataDirectoryAdoptionCommand>,
): Promise<Readonly<LocalDataDirectoryApplicationResult>> {
  return apply(command, false);
}

export function verifyLocalDataDirectoryAdoptionApplication(
  command: Readonly<VerifyLocalDataDirectoryAdoptionApplicationCommand>,
): Promise<Readonly<LocalDataDirectoryApplicationResult>> {
  return apply(command, true);
}
