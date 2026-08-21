import fs from 'node:fs';
import path from 'node:path';

import {
  acquireLocalSqliteActivation,
  type LocalSqliteActivationFence,
} from '@qinglong/local-admin/runtime';

import {
  LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
  LocalDataDirectoryAdoptionConfigurationError,
  type LocalDataDirectoryAdoptionSqliteBinding,
  type StageLocalDataDirectoryAdoptionCommand,
  type VerifyLocalDataDirectoryAdoptionCommand,
} from './contract';
import {
  copyCategory,
  rootAuthority,
  syncDirectory,
  writeExclusiveJson,
  type MutableCopyBudget,
} from './filesystem';
import {
  MANIFEST_NAME,
  PAYLOAD_GROUPS,
  inspectPayload,
  sha256Text,
  verifyStaticStage,
  type LocalDataDirectoryAdoptionManifest,
  type LocalDataDirectoryAdoptionManifestPayload,
  type LocalDataDirectoryPayloadEvidence,
} from './manifest';
import {
  inspectLocalDataDirectoryAdoption,
  type LocalDataDirectoryAdoptionEvidence,
} from './inventory';

const INCOMPLETE_NAME = '.incomplete';

export type {
  LocalDataDirectoryAdoptionManifest,
  LocalDataDirectoryPayloadEvidence,
} from './manifest';

export interface LocalDataDirectoryAdoptionMutationResult {
  readonly schemaVersion: 1;
  readonly operation:
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION;
  readonly status: 'staged' | 'verified';
  readonly evidence: Readonly<{
    profile: 'edge' | 'standalone';
    createdAtMs: number;
    planDigest: string;
    manifestDigest: string;
    sqliteActivationDigest: string;
    sqliteAdoptionManifestDigest: string;
    payload: readonly LocalDataDirectoryPayloadEvidence[];
  }>;
}

function inspectPlan(
  dataRoot: string,
  profile: 'edge' | 'standalone',
): Readonly<LocalDataDirectoryAdoptionEvidence> {
  return inspectLocalDataDirectoryAdoption({
    schemaVersion: 1,
    operation: 'local-data-directory.adoption.inspect',
    options: { dataRoot, profile },
  }).evidence;
}

function assertReviewablePlan(
  plan: Readonly<LocalDataDirectoryAdoptionEvidence>,
  expectedPlanDigest: string,
): void {
  const database = plan.categories.find((category) => category.name === 'db');
  if (
    plan.planDigest !== expectedPlanDigest ||
    plan.assessment !== 'reviewable' ||
    plan.totalUnsafeEntries !== 0 ||
    plan.unknownTopLevelEntries !== 0 ||
    !database ||
    database.primaryDatabaseFiles !== 1 ||
    plan.categories.some((category) => category.activeSqliteSidecars !== 0)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data directory no longer matches a reviewable migration plan',
    );
  }
}

async function acquireSqliteFence(
  binding: Readonly<LocalDataDirectoryAdoptionSqliteBinding>,
  profile: 'edge' | 'standalone',
): Promise<Readonly<LocalSqliteActivationFence>> {
  const fence = await acquireLocalSqliteActivation({
    sourcePath: binding.sourcePath,
    targetPath: binding.targetPath,
    recoveryPath: binding.recoveryPath,
    manifestPath: binding.manifestPath,
    activationPath: binding.activationPath,
    expectedActivationDigest: binding.expectedActivationDigest,
  });
  if (fence.activation.profile !== profile) {
    await fence.release();
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'SQLite activation profile does not match directory adoption',
    );
  }
  return fence;
}

function manifestPayload(
  command: Readonly<StageLocalDataDirectoryAdoptionCommand>,
  plan: Readonly<LocalDataDirectoryAdoptionEvidence>,
  fence: Readonly<LocalSqliteActivationFence>,
  payload: readonly LocalDataDirectoryPayloadEvidence[],
): Readonly<LocalDataDirectoryAdoptionManifestPayload> {
  const createdAtMs = Date.now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'system clock returned an invalid timestamp',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-data-directory-adoption',
    state: 'staged',
    profile: command.options.profile,
    createdAtMs,
    planDigest: plan.planDigest,
    sqliteActivationDigest: fence.activation.activationDigest,
    sqliteAdoptionManifestDigest: fence.adoption.manifestDigest,
    dataRootPathDigest: sha256Text(command.options.dataRoot),
    stagingRootPathDigest: sha256Text(command.options.stagingRoot),
    payload,
  });
}

function result(
  operation:
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION
    | typeof LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
  status: 'staged' | 'verified',
  manifest: Readonly<LocalDataDirectoryAdoptionManifest>,
): Readonly<LocalDataDirectoryAdoptionMutationResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    evidence: Object.freeze({
      profile: manifest.profile,
      createdAtMs: manifest.createdAtMs,
      planDigest: manifest.planDigest,
      manifestDigest: manifest.manifestDigest,
      sqliteActivationDigest: manifest.sqliteActivationDigest,
      sqliteAdoptionManifestDigest: manifest.sqliteAdoptionManifestDigest,
      payload: manifest.payload,
    }),
  });
}

export async function stageLocalDataDirectoryAdoption(
  command: Readonly<StageLocalDataDirectoryAdoptionCommand>,
): Promise<Readonly<LocalDataDirectoryAdoptionMutationResult>> {
  try {
    const authority = rootAuthority(command.options, true);
    const before = inspectPlan(
      command.options.dataRoot,
      command.options.profile,
    );
    assertReviewablePlan(before, command.options.expectedPlanDigest);
    const fence = await acquireSqliteFence(
      command.options.sqlite,
      command.options.profile,
    );
    let payload: readonly LocalDataDirectoryPayloadEvidence[];
    try {
      fs.mkdirSync(command.options.stagingRoot, { mode: 0o700 });
      writeExclusiveJson(
        path.join(command.options.stagingRoot, INCOMPLETE_NAME),
        {
          schemaVersion: 1,
          kind: 'qinglong3-legacy-data-directory-adoption-incomplete',
        },
      );
      syncDirectory(command.options.stagingRoot);
      syncDirectory(path.dirname(command.options.stagingRoot));
      const payloadRoot = path.join(command.options.stagingRoot, 'payload');
      fs.mkdirSync(payloadRoot, { mode: 0o700 });
      const copyBudget: MutableCopyBudget = { entries: 0, bytes: 0 };
      for (const group of PAYLOAD_GROUPS) {
        const groupRoot = path.join(payloadRoot, group.directoryName);
        fs.mkdirSync(groupRoot, { mode: 0o700 });
        for (const category of group.categories) {
          copyCategory(
            command.options.dataRoot,
            groupRoot,
            category,
            authority.uid,
            before.budget,
            copyBudget,
          );
        }
        syncDirectory(groupRoot);
      }
      syncDirectory(payloadRoot);
      fence.assertTargetIdentity();
      payload = inspectPayload(command.options.stagingRoot, authority.uid);
    } finally {
      await fence.release();
    }
    const after = inspectPlan(
      command.options.dataRoot,
      command.options.profile,
    );
    assertReviewablePlan(after, command.options.expectedPlanDigest);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory changed during staging',
      );
    }
    const manifestBase = manifestPayload(command, after, fence, payload);
    const manifest = Object.freeze({
      ...manifestBase,
      manifestDigest: sha256Text(JSON.stringify(manifestBase)),
    });
    writeExclusiveJson(
      path.join(command.options.stagingRoot, MANIFEST_NAME),
      manifest,
    );
    syncDirectory(command.options.stagingRoot);
    fs.unlinkSync(path.join(command.options.stagingRoot, INCOMPLETE_NAME));
    syncDirectory(command.options.stagingRoot);
    const verified = verifyStaticStage(authority, manifest.manifestDigest);
    return result(
      LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION,
      'staged',
      verified,
    );
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data directory staging failed',
      error,
    );
  }
}

export async function verifyLocalDataDirectoryAdoption(
  command: Readonly<VerifyLocalDataDirectoryAdoptionCommand>,
): Promise<Readonly<LocalDataDirectoryAdoptionMutationResult>> {
  try {
    const authority = rootAuthority(command.options, false);
    const manifest = verifyStaticStage(
      authority,
      command.options.expectedManifestDigest,
    );
    if (
      manifest.profile !== command.options.profile ||
      manifest.sqliteActivationDigest !==
        command.options.sqlite.expectedActivationDigest
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staging manifest authority binding is invalid',
      );
    }
    const before = inspectPlan(
      command.options.dataRoot,
      command.options.profile,
    );
    assertReviewablePlan(before, manifest.planDigest);
    const fence = await acquireSqliteFence(
      command.options.sqlite,
      command.options.profile,
    );
    try {
      if (
        fence.activation.activationDigest !== manifest.sqliteActivationDigest ||
        fence.adoption.manifestDigest !== manifest.sqliteAdoptionManifestDigest
      ) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'SQLite activation no longer matches the staging manifest',
        );
      }
      verifyStaticStage(authority, command.options.expectedManifestDigest);
      fence.assertTargetIdentity();
    } finally {
      await fence.release();
    }
    const after = inspectPlan(
      command.options.dataRoot,
      command.options.profile,
    );
    assertReviewablePlan(after, manifest.planDigest);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory changed during verification',
      );
    }
    return result(
      LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
      'verified',
      manifest,
    );
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data directory verification failed',
      error,
    );
  }
}
