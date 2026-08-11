import path from 'node:path';
import {
  assertApiCredentialId,
  assertProjectPolicyProjectId,
  normalizeProjectPolicySubject,
  readPrivateLocalCommandFile,
  type SecuritySubject,
} from './codecAuthority';
import {
  LocalIdentityCredentialCommandConfigurationError,
  type BaseInspectionRequest,
  type BaseMutationRequest,
  type BaseTargetMutationRequest,
  type LocalIdentityCredentialCommand,
  type LocalIdentityCredentialCommandOptions,
} from './contracts';

export const MAX_PATH_BYTES = 4096;
export const MAX_VERSION = 2_147_483_647;
export const MIN_CREDENTIAL_LIFETIME_MS = 60_000;
export const MAX_CREDENTIAL_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000;
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

export function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

export function descendant(
  root: string,
  candidate: string,
  label: string,
): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

export function requiresDelivery(
  operation: LocalIdentityCredentialCommand['operation'],
) {
  return (
    operation === 'credential.issue' ||
    operation === 'credential.rotate' ||
    operation === 'credential.delivery.acknowledge'
  );
}

export function normalizeOptions(
  value: unknown,
  operation: LocalIdentityCredentialCommand['operation'],
): Readonly<LocalIdentityCredentialCommandOptions> {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  const deliveryRequired = requiresDelivery(operation);
  exactObject(
    value,
    [
      'deploymentRoot',
      'databasePath',
      'profile',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
      ...(deliveryRequired ? ['credentialDeliveryDirectory'] : []),
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  const databasePath = boundedPath(value.databasePath, 'databasePath');
  const ownerPepperKeyringDirectory = boundedPath(
    value.ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  const credentialFilePath = boundedPath(
    value.credentialFilePath,
    'credentialFilePath',
  );
  for (const [label, candidate] of [
    ['databasePath', databasePath],
    ['ownerPepperKeyringDirectory', ownerPepperKeyringDirectory],
    ['credentialFilePath', credentialFilePath],
  ] as const) {
    descendant(deploymentRoot, candidate, label);
  }
  let credentialDeliveryDirectory: string | undefined;
  if (deliveryRequired) {
    credentialDeliveryDirectory = boundedPath(
      value.credentialDeliveryDirectory,
      'credentialDeliveryDirectory',
    );
    descendant(
      deploymentRoot,
      credentialDeliveryDirectory,
      'credentialDeliveryDirectory',
    );
    if (
      credentialDeliveryDirectory === path.dirname(databasePath) ||
      credentialDeliveryDirectory === ownerPepperKeyringDirectory
    ) {
      throw new LocalIdentityCredentialCommandConfigurationError(
        'credentialDeliveryDirectory must not share database or keyring storage',
      );
    }
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze({
    deploymentRoot,
    databasePath,
    profile: value.profile,
    ownerPepperKeyringDirectory,
    credentialFilePath,
    ...(credentialDeliveryDirectory === undefined
      ? {}
      : { credentialDeliveryDirectory }),
    ...(value.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: value.busyTimeoutMs as number }),
  });
}

export function normalizeCommonRequest(
  value: Record<string, unknown>,
): Readonly<BaseMutationRequest> {
  try {
    assertProjectPolicyProjectId(value.projectId as string);
  } catch (error) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'projectId is invalid',
      error,
    );
  }
  if (
    typeof value.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(value.mutationId) ||
    typeof value.failureAuditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.failureAuditEventId) ||
    value.failureAuditEventId === value.mutationId ||
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'mutation or request identity is invalid',
    );
  }
  return Object.freeze({
    projectId: value.projectId as string,
    mutationId: value.mutationId,
    requestId: value.requestId,
    failureAuditEventId: value.failureAuditEventId,
  });
}

export function normalizeInspectionCommonRequest(
  value: Record<string, unknown>,
): Readonly<BaseInspectionRequest> {
  try {
    assertProjectPolicyProjectId(value.projectId as string);
  } catch (error) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'projectId is invalid',
      error,
    );
  }
  if (
    typeof value.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.auditEventId) ||
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'audit or request identity is invalid',
    );
  }
  return Object.freeze({
    projectId: value.projectId as string,
    requestId: value.requestId,
    auditEventId: value.auditEventId,
  });
}

export function normalizeInspectionTarget(
  value: unknown,
): Readonly<SecuritySubject> {
  let target: Readonly<SecuritySubject>;
  try {
    target = normalizeProjectPolicySubject(value as SecuritySubject);
  } catch (error) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'target is invalid',
      error,
    );
  }
  if (!['user', 'api_app', 'mcp_client', 'agent'].includes(target.type)) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'target is invalid',
    );
  }
  return target;
}

export function normalizeTargetRequest(
  value: Record<string, unknown>,
): Readonly<BaseTargetMutationRequest> {
  const common = normalizeCommonRequest(value);
  let target: Readonly<SecuritySubject>;
  try {
    target = normalizeProjectPolicySubject(value.target as SecuritySubject);
  } catch (error) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'target is invalid',
      error,
    );
  }
  if (
    !['user', 'api_app', 'mcp_client', 'agent'].includes(target.type) ||
    !Number.isSafeInteger(value.expectedCurrentVersion) ||
    (value.expectedCurrentVersion as number) < 0 ||
    (value.expectedCurrentVersion as number) >= MAX_VERSION
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'target or expectedCurrentVersion is invalid',
    );
  }
  return Object.freeze({
    ...common,
    target,
    expectedCurrentVersion: value.expectedCurrentVersion as number,
  });
}

export function normalizeRequest(
  value: unknown,
  operation: LocalIdentityCredentialCommand['operation'],
): LocalIdentityCredentialCommand['request'] {
  const inspection =
    operation === 'identity.inspect' || operation === 'credential.inspect';
  if (inspection) {
    const identityInspection = operation === 'identity.inspect';
    exactObject(
      value,
      [
        'projectId',
        ...(identityInspection ? ['target'] : ['credentialId']),
        'requestId',
        'auditEventId',
      ],
      'request',
    );
    const common = normalizeInspectionCommonRequest(value);
    if (identityInspection) {
      return Object.freeze({
        ...common,
        target: normalizeInspectionTarget(value.target),
      });
    }
    try {
      assertApiCredentialId(value.credentialId as string);
    } catch (error) {
      throw new LocalIdentityCredentialCommandConfigurationError(
        'credentialId is invalid',
        error,
      );
    }
    return Object.freeze({
      ...common,
      credentialId: value.credentialId as string,
    });
  }
  const identity = operation.startsWith('identity.');
  const activeCredential =
    operation === 'credential.issue' || operation === 'credential.rotate';
  const revokeCredential = operation === 'credential.revoke';
  const acknowledge = operation === 'credential.delivery.acknowledge';
  exactObject(
    value,
    [
      'projectId',
      ...(acknowledge ? [] : ['target', 'expectedCurrentVersion']),
      ...(activeCredential || revokeCredential ? ['credentialId'] : []),
      ...(activeCredential ? ['lifetimeMs'] : []),
      ...(acknowledge
        ? ['credentialMutationId', 'expectedDeliveryDigest']
        : []),
      'mutationId',
      'requestId',
      'failureAuditEventId',
    ],
    'request',
  );
  if (acknowledge) {
    const common = normalizeCommonRequest(value);
    if (
      typeof value.credentialMutationId !== 'string' ||
      !UUID_V4_PATTERN.test(value.credentialMutationId) ||
      value.credentialMutationId === common.mutationId ||
      typeof value.expectedDeliveryDigest !== 'string' ||
      !DIGEST_PATTERN.test(value.expectedDeliveryDigest)
    ) {
      throw new LocalIdentityCredentialCommandConfigurationError(
        'delivery acknowledgement is invalid',
      );
    }
    return Object.freeze({
      ...common,
      credentialMutationId: value.credentialMutationId,
      expectedDeliveryDigest: value.expectedDeliveryDigest,
    });
  }
  const target = normalizeTargetRequest(value);
  if (identity) return target;
  try {
    assertApiCredentialId(value.credentialId as string);
  } catch (error) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'credentialId is invalid',
      error,
    );
  }
  if (
    activeCredential &&
    (!Number.isSafeInteger(value.lifetimeMs) ||
      (value.lifetimeMs as number) < MIN_CREDENTIAL_LIFETIME_MS ||
      (value.lifetimeMs as number) > MAX_CREDENTIAL_LIFETIME_MS)
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'lifetimeMs is invalid',
    );
  }
  return Object.freeze({
    ...target,
    credentialId: value.credentialId as string,
    ...(activeCredential ? { lifetimeMs: value.lifetimeMs as number } : {}),
  });
}

export function normalizeCommand(
  value: unknown,
): Readonly<LocalIdentityCredentialCommand> {
  exactObject(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    'command',
  );
  const operations: readonly LocalIdentityCredentialCommand['operation'][] = [
    'identity.inspect',
    'identity.register',
    'identity.enable',
    'identity.disable',
    'credential.inspect',
    'credential.issue',
    'credential.rotate',
    'credential.revoke',
    'credential.delivery.acknowledge',
  ];
  if (
    value.schemaVersion !== 1 ||
    typeof value.operation !== 'string' ||
    !operations.includes(
      value.operation as LocalIdentityCredentialCommand['operation'],
    )
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  const operation =
    value.operation as LocalIdentityCredentialCommand['operation'];
  return Object.freeze({
    schemaVersion: 1,
    operation,
    options: normalizeOptions(value.options, operation),
    request: normalizeRequest(value.request, operation),
  } as LocalIdentityCredentialCommand);
}

export function readCommandFile(
  candidatePath: string,
): Readonly<LocalIdentityCredentialCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalIdentityCredentialCommandConfigurationError) {
      throw error;
    }
    throw new LocalIdentityCredentialCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}
