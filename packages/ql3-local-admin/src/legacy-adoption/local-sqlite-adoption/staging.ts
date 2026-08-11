import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';

import {
  auditLocalSqlitePath,
  localSqliteMigrationManifest,
} from '@qinglong/local-sqlite/runtime';
import type { LegacyCrontabAdoptionInventory } from '../legacyCrontabAdoption';
import {
  DIGEST_PATTERN,
  MAX_MANIFEST_BYTES,
  MAX_SCHEMA_OBJECTS,
  LocalSqliteAdoptionError,
  type FileIdentity,
  type LegacySqliteCatalogEvidence,
  type LocalSqliteAdoptionManifest,
  type LocalSqliteAdoptionManifestPayload,
  type StageLocalSqliteAdoptionOptions,
  type VerifiedLocalSqliteAdoption,
  type VerifyLocalSqliteAdoptionOptions,
} from './contracts';
import {
  assertAbsolutePath,
  assertClock,
  assertDistinctPaths,
  assertMissing,
  assertProfile,
  assertRealParent,
  assertRegularFile,
  fileIdentity,
  removeCreatedFile,
  sha256File,
  sha256Text,
  writeManifestAtomically,
} from './filesystem';
import {
  catalogEvidence,
  inspectLegacySqlitePath,
  isCanonicalLegacyTimezone,
  legacyCrontabAdoptionModule,
  openLegacySource,
} from './inspection';

export async function verifyLegacyBackup(
  backupPath: string,
  expectedCatalogDigest: string,
  expectedTasks: LegacyCrontabAdoptionInventory,
): Promise<void> {
  assertRegularFile(backupPath, 'recovery backup');
  const client = openLegacySource(backupPath);
  try {
    const catalog = catalogEvidence(client);
    if (catalog.digest !== expectedCatalogDigest) {
      throw new LocalSqliteAdoptionError(
        'recovery backup catalog does not match the reviewed plan',
      );
    }
    const tasks = legacyCrontabAdoptionModule().inspectLegacyCrontabInventory(
      client,
      expectedTasks.timezone,
    );
    if (tasks.inventoryDigest !== expectedTasks.inventoryDigest) {
      throw new LocalSqliteAdoptionError(
        'recovery backup tasks do not match the reviewed plan',
      );
    }
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError(
      'recovery backup task inspection failed',
      error,
    );
  } finally {
    client.close();
  }
}

export async function stageLocalSqliteAdoption(
  options: StageLocalSqliteAdoptionOptions,
): Promise<LocalSqliteAdoptionManifest> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError('staging options are invalid');
  }
  assertProfile(options.profile);
  for (const [label, value] of [
    ['sourcePath', options.sourcePath],
    ['targetPath', options.targetPath],
    ['recoveryPath', options.recoveryPath],
    ['manifestPath', options.manifestPath],
  ] as const) {
    assertAbsolutePath(value, label);
  }
  if (!DIGEST_PATTERN.test(options.expectedPlanDigest)) {
    throw new LocalSqliteAdoptionError('expectedPlanDigest is invalid');
  }
  assertDistinctPaths([
    options.sourcePath,
    options.targetPath,
    options.recoveryPath,
    options.manifestPath,
  ]);
  for (const [label, value] of [
    ['target', options.targetPath],
    ['recovery', options.recoveryPath],
    ['manifest', options.manifestPath],
  ] as const) {
    assertRealParent(value, label);
    assertMissing(value, label);
  }
  const plan = inspectLegacySqlitePath(options);
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LocalSqliteAdoptionError(
      'source no longer matches the reviewed plan',
    );
  }

  const temporaryBackupPath = path.join(
    path.dirname(options.recoveryPath),
    `.${path.basename(options.recoveryPath)}.${randomUUID()}.tmp`,
  );
  let recoveryCreated = false;
  let targetCreated = false;
  let manifestCreated = false;
  try {
    const source = openLegacySource(options.sourcePath);
    try {
      await backup(source, temporaryBackupPath, { rate: 64 });
    } finally {
      source.close();
    }
    await verifyLegacyBackup(
      temporaryBackupPath,
      plan.catalog.digest,
      plan.tasks,
    );
    await fs.promises.copyFile(
      temporaryBackupPath,
      options.recoveryPath,
      fs.constants.COPYFILE_EXCL,
    );
    recoveryCreated = true;
    await fs.promises.chmod(options.recoveryPath, 0o600);
    await fs.promises.copyFile(
      options.recoveryPath,
      options.targetPath,
      fs.constants.COPYFILE_EXCL,
    );
    targetCreated = true;
    await fs.promises.chmod(options.targetPath, 0o600);

    const { migrateLocalSqlitePath } = await import(
      '@qinglong/local-sqlite/migration'
    );
    const migrated = await migrateLocalSqlitePath({
      databasePath: options.targetPath,
      profile: options.profile,
    });
    const [recoverySha256, targetSha256] = await Promise.all([
      sha256File(options.recoveryPath),
      sha256File(options.targetPath),
    ]);
    const recoveryStat = fs.statSync(options.recoveryPath);
    const targetStat = fs.statSync(options.targetPath);
    const payload: LocalSqliteAdoptionManifestPayload = Object.freeze({
      schemaVersion: 2,
      kind: 'qinglong3-local-sqlite-adoption',
      state: 'staged',
      profile: options.profile,
      createdAtMs: assertClock(options.clock ?? Date.now),
      planDigest: plan.planDigest,
      source: plan.source,
      catalog: plan.catalog,
      tasks: plan.tasks,
      recovery: Object.freeze({
        fileName: path.basename(options.recoveryPath),
        bytes: recoveryStat.size,
        sha256: recoverySha256,
      }),
      target: Object.freeze({
        fileName: path.basename(options.targetPath),
        bytes: targetStat.size,
        sha256: targetSha256,
      }),
      migration: localSqliteMigrationManifest,
      readiness: migrated.readiness,
    });
    const manifest = Object.freeze({
      ...payload,
      manifestDigest: sha256Text(JSON.stringify(payload)),
    });
    await writeManifestAtomically(options.manifestPath, manifest);
    manifestCreated = true;
    return manifest;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const [created, filePath] of [
      [manifestCreated, options.manifestPath],
      [targetCreated, options.targetPath],
      [recoveryCreated, options.recoveryPath],
    ] as const) {
      if (!created) continue;
      try {
        await removeCreatedFile(filePath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new LocalSqliteAdoptionError(
        'staging failed and cleanup was incomplete',
        new AggregateError([error, ...cleanupErrors]),
      );
    }
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError('staging failed', error);
  } finally {
    await removeCreatedFile(temporaryBackupPath);
  }
}

function parseManifest(value: unknown): LocalSqliteAdoptionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalSqliteAdoptionError('manifest is invalid');
  }
  const manifest = value as Partial<LocalSqliteAdoptionManifest>;
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [
    'catalog',
    'createdAtMs',
    'kind',
    'manifestDigest',
    'migration',
    'planDigest',
    'profile',
    'readiness',
    'recovery',
    'schemaVersion',
    'source',
    'state',
    'target',
    'tasks',
  ].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    manifest.schemaVersion !== 2 ||
    manifest.kind !== 'qinglong3-local-sqlite-adoption' ||
    manifest.state !== 'staged' ||
    !DIGEST_PATTERN.test(manifest.manifestDigest ?? '') ||
    !DIGEST_PATTERN.test(manifest.planDigest ?? '')
  ) {
    throw new LocalSqliteAdoptionError('manifest shape is invalid');
  }
  assertProfile(manifest.profile);
  if (
    !Number.isSafeInteger(manifest.createdAtMs) ||
    (manifest.createdAtMs as number) < 0 ||
    JSON.stringify(manifest.migration) !==
      JSON.stringify(localSqliteMigrationManifest)
  ) {
    throw new LocalSqliteAdoptionError('manifest authority is invalid');
  }
  const source = manifest.source as Partial<FileIdentity> | undefined;
  const catalog = manifest.catalog as
    | Partial<LegacySqliteCatalogEvidence>
    | undefined;
  const recovery = manifest.recovery as
    | Partial<LocalSqliteAdoptionManifest['recovery']>
    | undefined;
  const target = manifest.target as
    | Partial<LocalSqliteAdoptionManifest['target']>
    | undefined;
  const tasks = manifest.tasks as
    | Partial<LegacyCrontabAdoptionInventory>
    | undefined;
  if (
    !source ||
    JSON.stringify(Object.keys(source).sort()) !==
      JSON.stringify(
        [
          'bytes',
          'device',
          'fileName',
          'inode',
          'modifiedAtNs',
          'pathDigest',
        ].sort(),
      ) ||
    typeof source.fileName !== 'string' ||
    !Number.isSafeInteger(source.bytes) ||
    (source.bytes as number) < 0 ||
    typeof source.device !== 'string' ||
    typeof source.inode !== 'string' ||
    typeof source.modifiedAtNs !== 'string' ||
    !DIGEST_PATTERN.test(source.pathDigest ?? '')
  ) {
    throw new LocalSqliteAdoptionError('manifest source evidence is invalid');
  }
  if (
    !catalog ||
    JSON.stringify(Object.keys(catalog).sort()) !==
      JSON.stringify(['digest', 'objectCount', 'tableNames'].sort()) ||
    !DIGEST_PATTERN.test(catalog.digest ?? '') ||
    !Number.isSafeInteger(catalog.objectCount) ||
    (catalog.objectCount as number) < 1 ||
    !Array.isArray(catalog.tableNames) ||
    catalog.tableNames.length > MAX_SCHEMA_OBJECTS ||
    catalog.tableNames.some(
      (name) =>
        typeof name !== 'string' || name.length < 1 || name.length > 1024,
    ) ||
    JSON.stringify(catalog.tableNames) !==
      JSON.stringify([...catalog.tableNames].sort()) ||
    new Set(catalog.tableNames).size !== catalog.tableNames.length
  ) {
    throw new LocalSqliteAdoptionError('manifest catalog evidence is invalid');
  }
  const classifications = tasks?.classifications as
    | Partial<LegacyCrontabAdoptionInventory['classifications']>
    | undefined;
  const classificationValues = classifications
    ? [
        classifications.lossless,
        classifications.requires_shell_compatibility,
        classifications.requires_manual_action,
        classifications.malformed,
      ]
    : [];
  if (
    !tasks ||
    JSON.stringify(Object.keys(tasks).sort()) !==
      JSON.stringify(
        [
          'classifications',
          'inventoryDigest',
          'kind',
          'mutationReady',
          'rowCount',
          'schemaVersion',
          'timezone',
        ].sort(),
      ) ||
    tasks.schemaVersion !== 1 ||
    tasks.kind !== 'qinglong3-legacy-crontab-adoption-inventory' ||
    (tasks.timezone !== null && typeof tasks.timezone !== 'string') ||
    (typeof tasks.timezone === 'string' &&
      !isCanonicalLegacyTimezone(tasks.timezone)) ||
    !Number.isSafeInteger(tasks.rowCount) ||
    (tasks.rowCount as number) < 0 ||
    !DIGEST_PATTERN.test(tasks.inventoryDigest ?? '') ||
    typeof tasks.mutationReady !== 'boolean' ||
    !classifications ||
    JSON.stringify(Object.keys(classifications).sort()) !==
      JSON.stringify(
        [
          'lossless',
          'malformed',
          'requires_manual_action',
          'requires_shell_compatibility',
        ].sort(),
      ) ||
    classificationValues.some(
      (value) => !Number.isSafeInteger(value) || (value as number) < 0,
    ) ||
    classificationValues.reduce<number>(
      (sum, value) => sum + (value as number),
      0,
    ) !== tasks.rowCount ||
    tasks.mutationReady !==
      (classifications.requires_shell_compatibility === 0 &&
        classifications.requires_manual_action === 0 &&
        classifications.malformed === 0)
  ) {
    throw new LocalSqliteAdoptionError('manifest task evidence is invalid');
  }
  for (const [label, evidence] of [
    ['recovery', recovery],
    ['target', target],
  ] as const) {
    if (
      !evidence ||
      JSON.stringify(Object.keys(evidence).sort()) !==
        JSON.stringify(['bytes', 'fileName', 'sha256'].sort()) ||
      typeof evidence.fileName !== 'string' ||
      evidence.fileName.length < 1 ||
      evidence.fileName.length > 1024 ||
      !Number.isSafeInteger(evidence.bytes) ||
      (evidence.bytes as number) < 1 ||
      !DIGEST_PATTERN.test(evidence.sha256 ?? '')
    ) {
      throw new LocalSqliteAdoptionError(
        `manifest ${label} evidence is invalid`,
      );
    }
  }
  return manifest as LocalSqliteAdoptionManifest;
}

export async function verifyLocalSqliteAdoptionInternal(
  options: VerifyLocalSqliteAdoptionOptions,
  requireTargetSnapshot: boolean,
): Promise<VerifiedLocalSqliteAdoption> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError('verification options are invalid');
  }
  for (const [label, value] of [
    ['targetPath', options.targetPath],
    ['recoveryPath', options.recoveryPath],
    ['manifestPath', options.manifestPath],
  ] as const) {
    assertAbsolutePath(value, label);
    assertRealParent(value, label);
    assertRegularFile(value, label);
  }
  const manifestStat = fs.statSync(options.manifestPath);
  if (manifestStat.size < 1 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new LocalSqliteAdoptionError('manifest size is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await fs.promises.readFile(options.manifestPath, 'utf8'),
    );
  } catch (error) {
    throw new LocalSqliteAdoptionError('manifest JSON is invalid', error);
  }
  const manifest = parseManifest(parsed);
  const { manifestDigest, ...payload } = manifest;
  if (sha256Text(JSON.stringify(payload)) !== manifestDigest) {
    throw new LocalSqliteAdoptionError('manifest digest does not match');
  }
  if (
    manifest.recovery.fileName !== path.basename(options.recoveryPath) ||
    manifest.target.fileName !== path.basename(options.targetPath)
  ) {
    throw new LocalSqliteAdoptionError('manifest file identity does not match');
  }
  const targetIdentityBefore = fileIdentity(options.targetPath);
  const recoverySha256 = await sha256File(options.recoveryPath);
  const targetSha256 = requireTargetSnapshot
    ? await sha256File(options.targetPath)
    : undefined;
  const recoveryStat = fs.statSync(options.recoveryPath);
  if (
    recoverySha256 !== manifest.recovery.sha256 ||
    recoveryStat.size !== manifest.recovery.bytes
  ) {
    throw new LocalSqliteAdoptionError('staged database digest does not match');
  }
  if (requireTargetSnapshot) {
    const targetStat = fs.statSync(options.targetPath);
    if (
      targetSha256 !== manifest.target.sha256 ||
      targetStat.size !== manifest.target.bytes
    ) {
      throw new LocalSqliteAdoptionError(
        'staged database digest does not match',
      );
    }
  }
  await verifyLegacyBackup(
    options.recoveryPath,
    manifest.catalog.digest,
    manifest.tasks,
  );
  const readiness = await auditLocalSqlitePath({
    databasePath: options.targetPath,
    profile: manifest.profile,
  });
  const { tableCount: currentTableCount, ...currentContract } = readiness;
  const { tableCount: stagedTableCount, ...stagedContract } =
    manifest.readiness;
  const readinessMatches =
    JSON.stringify(readiness) === JSON.stringify(manifest.readiness);
  const activatedReadinessIsCompatible =
    currentTableCount >= stagedTableCount &&
    JSON.stringify(currentContract) === JSON.stringify(stagedContract);
  if (
    requireTargetSnapshot ? !readinessMatches : !activatedReadinessIsCompatible
  ) {
    throw new LocalSqliteAdoptionError('target readiness evidence has drifted');
  }
  const targetIdentityAfter = fileIdentity(options.targetPath);
  if (
    targetIdentityBefore.pathDigest !== targetIdentityAfter.pathDigest ||
    targetIdentityBefore.device !== targetIdentityAfter.device ||
    targetIdentityBefore.inode !== targetIdentityAfter.inode
  ) {
    throw new LocalSqliteAdoptionError(
      'target database identity changed during verification',
    );
  }
  return Object.freeze({
    manifest,
    targetIdentity: targetIdentityAfter,
  });
}

export async function verifyLocalSqliteAdoption(
  options: VerifyLocalSqliteAdoptionOptions,
): Promise<LocalSqliteAdoptionManifest> {
  return (await verifyLocalSqliteAdoptionInternal(options, true)).manifest;
}
