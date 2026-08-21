import fs from 'node:fs';
import path from 'node:path';

import {
  LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
  LocalDataDirectoryAdoptionConfigurationError,
  type TransformLocalDataDirectoryAdoptionCommand,
  type VerifyLocalDataDirectoryAdoptionCommand,
  type VerifyLocalDataDirectoryAdoptionTransformationCommand,
} from '../contract';
import { syncDirectory } from '../filesystem';
import { sha256Text } from '../manifest';
import { verifyLocalDataDirectoryAdoption } from '../staging';
import { transformLegacyConfig } from './config';
import {
  finishPrivateDirectory,
  transformationAuthority,
  writePrivateJson,
} from './files';
import { transformLegacyKeyv } from './keyv';
import {
  TRANSFORMATION_MANIFEST_NAME,
  verifyStaticTransformation,
} from './manifest';
import {
  writeTransformationModel,
  type LocalDataDirectoryTransformationManifest,
  type LocalDataDirectoryTransformationManifestPayload,
  type TransformationModelEvidence,
  type TransformationSourceEvidence,
} from './model';
import { transformLegacySsh } from './ssh';

const INCOMPLETE_NAME = '.incomplete';

export interface LocalDataDirectoryTransformationResult {
  readonly schemaVersion: 1;
  readonly operation:
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION;
  readonly status: 'prepared' | 'verified';
  readonly evidence: Readonly<{
    profile: 'edge' | 'standalone';
    createdAtMs: number;
    sourceStageManifestDigest: string;
    transformationDigest: string;
    assessment: 'ready' | 'manual_required';
    sources: readonly TransformationSourceEvidence[];
    model: Readonly<TransformationModelEvidence>;
  }>;
}

type TransformationCommand =
  | Readonly<TransformLocalDataDirectoryAdoptionCommand>
  | Readonly<VerifyLocalDataDirectoryAdoptionTransformationCommand>;

async function verifySource(command: TransformationCommand) {
  const sourceCommand: VerifyLocalDataDirectoryAdoptionCommand = {
    schemaVersion: 1,
    operation: LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
    options: {
      deploymentRoot: command.options.deploymentRoot,
      dataRoot: command.options.dataRoot,
      stagingRoot: command.options.stagingRoot,
      profile: command.options.profile,
      sqlite: command.options.sqlite,
      expectedManifestDigest: command.options.expectedManifestDigest,
    },
  };
  return verifyLocalDataDirectoryAdoption(sourceCommand);
}

function unchangedSource(
  before: Awaited<ReturnType<typeof verifySource>>,
  after: Awaited<ReturnType<typeof verifySource>>,
): void {
  if (JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staged source changed during transformation',
    );
  }
}

function createdAtMs(): number {
  const value = Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'system clock returned an invalid timestamp',
    );
  }
  return value;
}

function result(
  operation:
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION,
  status: 'prepared' | 'verified',
  manifest: Readonly<LocalDataDirectoryTransformationManifest>,
): Readonly<LocalDataDirectoryTransformationResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    evidence: Object.freeze({
      profile: manifest.profile,
      createdAtMs: manifest.createdAtMs,
      sourceStageManifestDigest: manifest.sourceStageManifestDigest,
      transformationDigest: manifest.transformationDigest,
      assessment: manifest.assessment,
      sources: manifest.sources,
      model: manifest.model,
    }),
  });
}

export async function transformLocalDataDirectoryAdoption(
  command: Readonly<TransformLocalDataDirectoryAdoptionCommand>,
): Promise<Readonly<LocalDataDirectoryTransformationResult>> {
  try {
    const authority = transformationAuthority(command.options, true);
    const before = await verifySource(command);
    fs.mkdirSync(authority.transformationRoot, { mode: 0o700 });
    writePrivateJson(path.join(authority.transformationRoot, INCOMPLETE_NAME), {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-data-directory-transformation-incomplete',
    });
    finishPrivateDirectory(authority.transformationRoot);
    syncDirectory(path.dirname(authority.transformationRoot));

    const inputRoot = path.join(
      authority.stagingRoot,
      'payload',
      'transform-input',
    );
    const config = transformLegacyConfig(
      path.join(inputRoot, 'config'),
      authority.uid,
    );
    const keyv = transformLegacyKeyv(
      path.join(inputRoot, 'db'),
      authority.uid,
      command.options.profile,
    );
    const ssh = transformLegacySsh(
      path.join(inputRoot, 'ssh.d'),
      authority.uid,
    );
    const prepared = writeTransformationModel({
      modelRoot: path.join(authority.transformationRoot, 'model'),
      uid: authority.uid,
      projectId: command.options.projectId,
      profile: command.options.profile,
      config,
      keyv,
      ssh,
    });
    const after = await verifySource(command);
    unchangedSource(before, after);

    const payload: LocalDataDirectoryTransformationManifestPayload = {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-data-directory-transformation',
      state: 'prepared',
      profile: command.options.profile,
      createdAtMs: createdAtMs(),
      projectIdDigest: sha256Text(command.options.projectId),
      sourceStageManifestDigest: command.options.expectedManifestDigest,
      transformationRootPathDigest: sha256Text(authority.transformationRoot),
      assessment: prepared.assessment,
      sources: prepared.sources,
      model: prepared.model,
    };
    const manifest: LocalDataDirectoryTransformationManifest = {
      ...payload,
      transformationDigest: sha256Text(JSON.stringify(payload)),
    };
    writePrivateJson(
      path.join(authority.transformationRoot, TRANSFORMATION_MANIFEST_NAME),
      manifest,
    );
    finishPrivateDirectory(authority.transformationRoot);
    fs.unlinkSync(path.join(authority.transformationRoot, INCOMPLETE_NAME));
    finishPrivateDirectory(authority.transformationRoot);
    const verified = verifyStaticTransformation({
      authority,
      profile: command.options.profile,
      projectId: command.options.projectId,
      sourceStageManifestDigest: command.options.expectedManifestDigest,
      expectedTransformationDigest: manifest.transformationDigest,
    });
    return result(
      LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION,
      'prepared',
      verified,
    );
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data directory transformation failed',
      error,
    );
  }
}

export async function verifyLocalDataDirectoryAdoptionTransformation(
  command: Readonly<VerifyLocalDataDirectoryAdoptionTransformationCommand>,
): Promise<Readonly<LocalDataDirectoryTransformationResult>> {
  try {
    const authority = transformationAuthority(command.options, false);
    const before = await verifySource(command);
    const manifest = verifyStaticTransformation({
      authority,
      profile: command.options.profile,
      projectId: command.options.projectId,
      sourceStageManifestDigest: command.options.expectedManifestDigest,
      expectedTransformationDigest:
        command.options.expectedTransformationDigest,
    });
    const after = await verifySource(command);
    unchangedSource(before, after);
    verifyStaticTransformation({
      authority,
      profile: command.options.profile,
      projectId: command.options.projectId,
      sourceStageManifestDigest: command.options.expectedManifestDigest,
      expectedTransformationDigest:
        command.options.expectedTransformationDigest,
    });
    return result(
      LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION,
      'verified',
      manifest,
    );
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data directory transformation verification failed',
      error,
    );
  }
}
