import {
  MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
  MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
  MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE,
  InvalidPluginPackageInstallError,
  PluginPackageInstallTransitionConflictError,
  type PluginPackageInstallRecoveryAction,
  type PluginPackageLock,
  type PluginPackageInstallRecord,
  type PluginPackageInstallHeadExpectation,
  type PluginPackageInstallCreate,
  type PluginPackageInstallRecoveryCursor,
  type PluginPackageInstallInventoryCursor,
} from './contracts';
import {
  PACKAGE_NAME_PATTERN,
  exactKeys,
  installObject,
  identifier,
  boundedText,
  digest,
  positiveInteger,
  contentDigest,
} from './codec';
import {
  normalizePluginPackageLock,
} from './lock';
import {
  initialMutationDigest,
  normalizePluginPackageInstallRecord,
  assertRecordMatchesLock,
} from './record';

export function normalizePluginPackageInstallHeadExpectation(
  value: PluginPackageInstallHeadExpectation,
): Readonly<PluginPackageInstallHeadExpectation> {
  const expectation = installObject(value, 'head expectation');
  exactKeys(
    expectation,
    ['installationId', 'version', 'recordDigest'],
    [],
    'head expectation',
    InvalidPluginPackageInstallError,
  );
  return Object.freeze({
    installationId: identifier(
      value.installationId,
      'head installation id',
      InvalidPluginPackageInstallError,
    ),
    version: positiveInteger(
      value.version,
      'head version',
      MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
      InvalidPluginPackageInstallError,
    ),
    recordDigest: digest(
      value.recordDigest,
      'head record digest',
      InvalidPluginPackageInstallError,
    ),
  });
}

export function normalizePluginPackageInstallCreate(
  value: PluginPackageInstallCreate,
): Readonly<PluginPackageInstallCreate> {
  const command = installObject(value, 'create command');
  exactKeys(
    command,
    [
      'installationId',
      'mutationId',
      'mutationDigest',
      'expectedHead',
      'lock',
      'record',
    ],
    [],
    'create command',
    InvalidPluginPackageInstallError,
  );
  const lock = normalizePluginPackageLock(value.lock);
  const record = normalizePluginPackageInstallRecord(value.record);
  assertRecordMatchesLock(record, lock);
  const expectedHead =
    value.expectedHead === null
      ? null
      : normalizePluginPackageInstallHeadExpectation(value.expectedHead);
  const installationId = identifier(
    value.installationId,
    'installation id',
    InvalidPluginPackageInstallError,
  );
  const mutationId = identifier(
    value.mutationId,
    'mutation id',
    InvalidPluginPackageInstallError,
  );
  const mutationDigest = digest(
    value.mutationDigest,
    'create mutation digest',
    InvalidPluginPackageInstallError,
  );
  if (
    installationId !== record.installationId ||
    mutationId !== record.lastMutationId ||
    mutationDigest !==
      contentDigest({
        type: 'install_create_commit',
        installationId,
        mutationId,
        lockDigest: lock.lockDigest,
        recordDigest: record.recordDigest,
        expectedHead,
      })
  ) {
    throw new InvalidPluginPackageInstallError(
      'create command is detached from its record or head',
    );
  }
  return Object.freeze({
    installationId,
    mutationId,
    mutationDigest,
    expectedHead,
    lock,
    record,
  });
}

export function pluginPackageInstallRecoveryAction(
  value: PluginPackageInstallRecord,
): PluginPackageInstallRecoveryAction {
  const record = normalizePluginPackageInstallRecord(value);
  switch (record.state) {
    case 'queued':
      return 'resume_stage';
    case 'staged':
      return 'resume_activation';
    case 'activating':
      return 'inspect_activation';
    case 'active':
    case 'failed':
      return 'none';
  }
}

export function assertPluginPackageInstallRecoveryPageSize(
  value: number,
): void {
  positiveInteger(
    value,
    'recovery page size',
    MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
    InvalidPluginPackageInstallError,
  );
}

export function assertPluginPackageInstallInventoryPageSize(
  value: number,
): void {
  positiveInteger(
    value,
    'inventory page size',
    MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE,
    InvalidPluginPackageInstallError,
  );
}

export function normalizePluginPackageInstallInventoryCursor(
  value: PluginPackageInstallInventoryCursor,
): Readonly<PluginPackageInstallInventoryCursor> {
  const cursor = installObject(value, 'inventory cursor');
  exactKeys(
    cursor,
    ['packageName'],
    [],
    'inventory cursor',
    InvalidPluginPackageInstallError,
  );
  const normalizedPackageName = boundedText(
    value.packageName,
    'package name',
    253,
    InvalidPluginPackageInstallError,
  );
  if (!PACKAGE_NAME_PATTERN.test(normalizedPackageName)) {
    throw new InvalidPluginPackageInstallError('package name is invalid');
  }
  return Object.freeze({ packageName: normalizedPackageName });
}

export function normalizePluginPackageInstallRecoveryCursor(
  value: PluginPackageInstallRecoveryCursor,
): Readonly<PluginPackageInstallRecoveryCursor> {
  const cursor = installObject(value, 'recovery cursor');
  exactKeys(
    cursor,
    ['packageName', 'installationId'],
    [],
    'recovery cursor',
    InvalidPluginPackageInstallError,
  );
  const normalizedPackageName = boundedText(
    value.packageName,
    'package name',
    253,
    InvalidPluginPackageInstallError,
  );
  if (!PACKAGE_NAME_PATTERN.test(normalizedPackageName)) {
    throw new InvalidPluginPackageInstallError('package name is invalid');
  }
  return Object.freeze({
    packageName: normalizedPackageName,
    installationId: identifier(
      value.installationId,
      'installation id',
      InvalidPluginPackageInstallError,
    ),
  });
}

export function pluginPackageInstallCreate(
  lockValue: PluginPackageLock,
  recordValue: PluginPackageInstallRecord,
  previousHeadValue: PluginPackageInstallRecord | null,
): Readonly<PluginPackageInstallCreate> {
  const lock = normalizePluginPackageLock(lockValue);
  const record = normalizePluginPackageInstallRecord(recordValue);
  assertRecordMatchesLock(record, lock);
  const previousHead =
    previousHeadValue === null
      ? null
      : normalizePluginPackageInstallRecord(previousHeadValue);
  if (
    record.state !== 'queued' ||
    record.version !== 1 ||
    record.createdAtMs !== record.updatedAtMs ||
    record.stageReceipt !== null ||
    record.activationReceipt !== null ||
    record.failure !== null ||
    record.activeLockDigest !== record.previousActiveLockDigest ||
    record.lastMutationDigest !==
      initialMutationDigest(record.lockDigest, {
        installationId: record.installationId,
        mutationId: record.lastMutationId,
        occurredAtMs: record.createdAtMs,
      })
  ) {
    throw new InvalidPluginPackageInstallError(
      'initial install record is invalid',
    );
  }
  if (previousHead === null) {
    if (
      record.previousActiveLockDigest !== null ||
      record.operation !== 'install' ||
      record.targetGeneration !== 1
    ) {
      throw new PluginPackageInstallTransitionConflictError();
    }
  } else if (
    previousHead.projectId !== record.projectId ||
    previousHead.packageName !== record.packageName ||
    previousHead.installationId === record.installationId ||
    !['active', 'failed'].includes(previousHead.state) ||
    previousHead.activeLockDigest !== record.previousActiveLockDigest
  ) {
    throw new PluginPackageInstallTransitionConflictError();
  }
  const expectedHead =
    previousHead === null
      ? null
      : Object.freeze({
          installationId: previousHead.installationId,
          version: previousHead.version,
          recordDigest: previousHead.recordDigest,
        });
  return normalizePluginPackageInstallCreate({
    installationId: record.installationId,
    mutationId: record.lastMutationId,
    mutationDigest: contentDigest({
      type: 'install_create_commit',
      installationId: record.installationId,
      mutationId: record.lastMutationId,
      lockDigest: lock.lockDigest,
      recordDigest: record.recordDigest,
      expectedHead,
    }),
    expectedHead,
    lock,
    record,
  });
}
