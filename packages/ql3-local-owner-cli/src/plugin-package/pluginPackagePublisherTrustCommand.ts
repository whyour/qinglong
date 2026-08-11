// Plugin Package owns publisher trust administration commands.
import path from 'node:path';

import {
  confirmLocalPluginPackagePublisherKeyRevocation,
  inspectLocalPluginPackagePublisherTrust,
  publishLocalPluginPackagePublisherTrust,
  proposeLocalPluginPackagePublisherKeyRevocation,
  retireLocalPluginPackagePublisherKey,
  type ConfirmLocalPluginPackagePublisherKeyRevocationOptions,
  type LocalPluginPackagePublisherKeyRevocationReceipt,
  type PublishLocalPluginPackagePublisherTrustOptions,
  type ProposeLocalPluginPackagePublisherKeyRevocationOptions,
  type RetireLocalPluginPackagePublisherKeyOptions,
} from '@qinglong/local-admin/package-publisher-trust';
import {
  createPluginPackageQuarantineEvent,
  pluginPackageQuarantineMutationId,
  type PluginPackageQuarantineTarget,
} from '@qinglong/runtime-core/plugin-package-quarantine';
import {
  analyzeLocalPluginPackageRecoveryCatalogPublisherKey,
  analyzeLocalPluginPackageRecoveryCatalogPublisherKeyImpact,
} from '@qinglong/local-admin/package-recovery-catalog';
import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
  readPrivateLocalJsonFile,
} from '@qinglong/local-command-file';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import {
  openLocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/authenticated-management';

const MAX_PATH_BYTES = 4_096;
const MAX_TRUST_BYTES = 256 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalPluginPackagePublisherTrustCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: LocalSqliteProfile;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly trustRoot: string;
  readonly catalogRoot: string;
  readonly bundleRoot: string;
  readonly busyTimeoutMs?: number;
}

interface MutationIdentity {
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
  readonly mutationId: string;
}

export interface InspectLocalPluginPackagePublisherTrustCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-trust.inspect';
  readonly options: LocalPluginPackagePublisherTrustCommandOptions;
  readonly request: Readonly<Record<never, never>>;
}

export interface MutateLocalPluginPackagePublisherTrustCommand {
  readonly schemaVersion: 1;
  readonly operation:
    | 'plugin-package.publisher-trust.provision'
    | 'plugin-package.publisher-trust.rotate';
  readonly options: LocalPluginPackagePublisherTrustCommandOptions;
  readonly request: MutationIdentity & {
    readonly expectedGeneration: number;
    readonly trustFilePath: string;
  };
}

export interface RetireLocalPluginPackagePublisherTrustCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-trust.retire';
  readonly options: LocalPluginPackagePublisherTrustCommandOptions;
  readonly request: MutationIdentity & {
    readonly expectedGeneration: number;
    readonly publisher: string;
    readonly keyId: string;
  };
}

export interface ProposeLocalPluginPackagePublisherRevocationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-trust.revoke.propose';
  readonly options: LocalPluginPackagePublisherTrustCommandOptions;
  readonly request: MutationIdentity & {
    readonly expectedGeneration: number;
    readonly publisher: string;
    readonly keyId: string;
  };
}

export interface ConfirmLocalPluginPackagePublisherRevocationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.publisher-trust.revoke.confirm';
  readonly options: LocalPluginPackagePublisherTrustCommandOptions;
  readonly request: MutationIdentity & {
    readonly expectedGeneration: number;
    readonly publisher: string;
    readonly keyId: string;
    readonly proposerSubjectId: string;
    readonly authorizationMode: 'dual_control' | 'break_glass';
    readonly reasonCode:
      | 'suspected_key_compromise'
      | 'confirmed_key_compromise';
    readonly expectedImpactDigest: string;
  };
}

export type LocalPluginPackagePublisherTrustCommand =
  | InspectLocalPluginPackagePublisherTrustCommand
  | MutateLocalPluginPackagePublisherTrustCommand
  | RetireLocalPluginPackagePublisherTrustCommand
  | ProposeLocalPluginPackagePublisherRevocationCommand
  | ConfirmLocalPluginPackagePublisherRevocationCommand;

export type LocalPluginPackagePublisherTrustCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-trust.inspect';
      generation: number;
      keyCount: number;
      activeKeyCount: number;
      snapshotCount: number;
      retirementCount: number;
      pendingRetirementCount: number;
      revocationCount: number;
      pendingRevocationCount: number;
      quarantinedLockCount: number;
      recoveryRequired: boolean;
      pendingGeneration: number | null;
      unresolvedTransactions: number;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation:
        | 'plugin-package.publisher-trust.provision'
        | 'plugin-package.publisher-trust.rotate'
        | 'plugin-package.publisher-trust.retire';
      status: 'published' | 'existing' | 'recovered';
      generation: number;
      keyCount: number;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-trust.revoke.propose';
      status: 'proposed' | 'existing';
      generation: number;
      proposalDigest: string;
      impactDigest: string;
      matchingEntryCount: number;
      runtimeAction: 'stop_required';
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.publisher-trust.revoke.confirm';
      status: 'published' | 'existing' | 'recovered';
      generation: number;
      keyCount: number;
      authorizationMode: 'dual_control' | 'break_glass';
      quarantinedLockCount: number;
      runtimeAction: 'restart_required';
    }>;

export interface LocalPluginPackagePublisherTrustCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<Readonly<LocalPluginPackagePublisherTrustCommandResult>>;
}

interface RunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteAuthenticatedManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly inspect: typeof inspectLocalPluginPackagePublisherTrust;
  readonly publish: typeof publishLocalPluginPackagePublisherTrust;
  readonly retire: typeof retireLocalPluginPackagePublisherKey;
  readonly analyzePublisherKey: typeof analyzeLocalPluginPackageRecoveryCatalogPublisherKey;
  readonly proposeRevocation: typeof proposeLocalPluginPackagePublisherKeyRevocation;
  readonly confirmRevocation: typeof confirmLocalPluginPackagePublisherKeyRevocation;
  readonly analyzePublisherKeyImpact: typeof analyzeLocalPluginPackageRecoveryCatalogPublisherKeyImpact;
  readonly now: () => number;
}

export class LocalPluginPackagePublisherTrustCommandConfigurationError extends TypeError {
  readonly code =
    'LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Local Plugin Package publisher trust command configuration is invalid: ${message}`,
    );
    this.name = 'LocalPluginPackagePublisherTrustCommandConfigurationError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    ) ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function descendant(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function normalizeOptions(
  value: unknown,
): LocalPluginPackagePublisherTrustCommandOptions {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  exactObject(
    value,
    [
      'credentialFilePath',
      'bundleRoot',
      'catalogRoot',
      'databasePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'profile',
      'trustRoot',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  const result = {
    deploymentRoot,
    databasePath: boundedPath(value.databasePath, 'databasePath'),
    profile: value.profile,
    ownerPepperKeyringDirectory: boundedPath(
      value.ownerPepperKeyringDirectory,
      'ownerPepperKeyringDirectory',
    ),
    credentialFilePath: boundedPath(
      value.credentialFilePath,
      'credentialFilePath',
    ),
    trustRoot: boundedPath(value.trustRoot, 'trustRoot'),
    catalogRoot: boundedPath(value.catalogRoot, 'catalogRoot'),
    bundleRoot: boundedPath(value.bundleRoot, 'bundleRoot'),
    ...(hasBusyTimeout ? { busyTimeoutMs: value.busyTimeoutMs as number } : {}),
  };
  if (result.profile !== 'edge' && result.profile !== 'standalone') {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    hasBusyTimeout &&
    (!Number.isSafeInteger(result.busyTimeoutMs) ||
      (result.busyTimeoutMs as number) < 100 ||
      (result.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  const authorities = [
    result.databasePath,
    result.ownerPepperKeyringDirectory,
    result.credentialFilePath,
    result.trustRoot,
    result.catalogRoot,
    result.bundleRoot,
  ];
  for (const [index, authority] of authorities.entries()) {
    descendant(deploymentRoot, authority, `authority path ${index}`);
  }
  if (new Set(authorities).size !== authorities.length) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'authority paths must be distinct',
    );
  }
  return Object.freeze(
    result as LocalPluginPackagePublisherTrustCommandOptions,
  );
}

function normalizeMutation(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> &
  MutationIdentity & {
    readonly expectedGeneration: number;
  } {
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    typeof value.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.auditEventId) ||
    typeof value.failureAuditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.failureAuditEventId) ||
    value.auditEventId === value.failureAuditEventId ||
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId) ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    (value.expectedGeneration as number) < 0 ||
    (value.expectedGeneration as number) > 63
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'mutation request identity is invalid',
    );
  }
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalPluginPackagePublisherTrustCommand> {
  exactObject(
    value,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (value.schemaVersion !== 1) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'schemaVersion is invalid',
    );
  }
  const options = normalizeOptions(value.options);
  if (value.operation === 'plugin-package.publisher-trust.inspect') {
    exactObject(value.request, [], 'inspection request');
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: Object.freeze({}),
    });
  }
  if (
    value.operation === 'plugin-package.publisher-trust.retire' ||
    value.operation === 'plugin-package.publisher-trust.revoke.propose'
  ) {
    exactObject(
      value.request,
      [
        'auditEventId',
        'expectedGeneration',
        'failureAuditEventId',
        'keyId',
        'mutationId',
        'publisher',
        'requestId',
      ],
      value.operation === 'plugin-package.publisher-trust.retire'
        ? 'retirement request'
        : 'revocation proposal request',
    );
    normalizeMutation(value.request);
    if (
      typeof value.request.publisher !== 'string' ||
      value.request.publisher.length === 0 ||
      Buffer.byteLength(value.request.publisher, 'utf8') > 256 ||
      value.request.publisher.includes('\0') ||
      typeof value.request.keyId !== 'string' ||
      value.request.keyId.length === 0 ||
      Buffer.byteLength(value.request.keyId, 'utf8') > 256 ||
      value.request.keyId.includes('\0')
    ) {
      throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
        'publisher key identity is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: Object.freeze({
        requestId: value.request.requestId,
        auditEventId: value.request.auditEventId,
        failureAuditEventId: value.request.failureAuditEventId,
        mutationId: value.request.mutationId,
        expectedGeneration: value.request.expectedGeneration,
        publisher: value.request.publisher,
        keyId: value.request.keyId,
      }),
    });
  }
  if (value.operation === 'plugin-package.publisher-trust.revoke.confirm') {
    exactObject(
      value.request,
      [
        'auditEventId',
        'authorizationMode',
        'expectedGeneration',
        'expectedImpactDigest',
        'failureAuditEventId',
        'keyId',
        'mutationId',
        'proposerSubjectId',
        'publisher',
        'reasonCode',
        'requestId',
      ],
      'revocation confirmation request',
    );
    normalizeMutation(value.request);
    if (
      typeof value.request.publisher !== 'string' ||
      value.request.publisher.length === 0 ||
      Buffer.byteLength(value.request.publisher, 'utf8') > 256 ||
      value.request.publisher.includes('\0') ||
      typeof value.request.keyId !== 'string' ||
      value.request.keyId.length === 0 ||
      Buffer.byteLength(value.request.keyId, 'utf8') > 256 ||
      value.request.keyId.includes('\0') ||
      typeof value.request.proposerSubjectId !== 'string' ||
      value.request.proposerSubjectId.length === 0 ||
      Buffer.byteLength(value.request.proposerSubjectId, 'utf8') > 256 ||
      value.request.proposerSubjectId.includes('\0') ||
      (value.request.authorizationMode !== 'dual_control' &&
        value.request.authorizationMode !== 'break_glass') ||
      (value.request.reasonCode !== 'suspected_key_compromise' &&
        value.request.reasonCode !== 'confirmed_key_compromise') ||
      typeof value.request.expectedImpactDigest !== 'string' ||
      !DIGEST_PATTERN.test(value.request.expectedImpactDigest)
    ) {
      throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
        'revocation confirmation identity is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: Object.freeze({
        requestId: value.request.requestId,
        auditEventId: value.request.auditEventId,
        failureAuditEventId: value.request.failureAuditEventId,
        mutationId: value.request.mutationId,
        expectedGeneration: value.request.expectedGeneration,
        publisher: value.request.publisher,
        keyId: value.request.keyId,
        proposerSubjectId: value.request.proposerSubjectId,
        authorizationMode: value.request.authorizationMode,
        reasonCode: value.request.reasonCode,
        expectedImpactDigest: value.request.expectedImpactDigest,
      }),
    });
  }
  if (
    value.operation !== 'plugin-package.publisher-trust.provision' &&
    value.operation !== 'plugin-package.publisher-trust.rotate'
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'operation is invalid',
    );
  }
  exactObject(
    value.request,
    [
      'auditEventId',
      'expectedGeneration',
      'failureAuditEventId',
      'mutationId',
      'requestId',
      'trustFilePath',
    ],
    'mutation request',
  );
  normalizeMutation(value.request);
  const trustFilePath = boundedPath(
    value.request.trustFilePath,
    'trustFilePath',
  );
  descendant(options.deploymentRoot, trustFilePath, 'trustFilePath');
  if (
    [
      options.databasePath,
      options.ownerPepperKeyringDirectory,
      options.credentialFilePath,
      options.trustRoot,
    ].includes(trustFilePath)
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'trust candidate path aliases another authority',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: value.operation,
    options,
    request: Object.freeze({
      requestId: value.request.requestId,
      auditEventId: value.request.auditEventId,
      failureAuditEventId: value.request.failureAuditEventId,
      mutationId: value.request.mutationId,
      expectedGeneration: value.request.expectedGeneration,
      trustFilePath,
    }),
  });
}

function readCommand(
  commandFilePath: string,
): Readonly<LocalPluginPackagePublisherTrustCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (
      error instanceof LocalPluginPackagePublisherTrustCommandConfigurationError
    ) {
      throw error;
    }
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw error;
  }
}

async function confirmOwner(
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.confirmUserCredentialFence(authenticated.databaseFence);
  database.confirmDefaultProjectOwnerFence(authenticated.databaseFence);
}

type SecurityAudit = Parameters<
  LocalSqliteAuthenticatedManagementDatabase['securityAudit']['record']
>[0];

function databaseTime(
  database: LocalSqliteAuthenticatedManagementDatabase,
  eventId: string,
  now: () => number,
): number {
  const existing = database.authority.client
    .prepare(
      `SELECT "occurred_at_ms" AS "occurredAtMs"
         FROM "QingLong3SecurityAuditEvents"
        WHERE "event_id" = ?`,
    )
    .get(eventId) as { readonly occurredAtMs?: unknown } | undefined;
  const value = existing?.occurredAtMs ?? now();
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'audit clock is invalid',
    );
  }
  return value as number;
}

function audit(
  command:
    | Readonly<MutateLocalPluginPackagePublisherTrustCommand>
    | Readonly<RetireLocalPluginPackagePublisherTrustCommand>
    | Readonly<ProposeLocalPluginPackagePublisherRevocationCommand>
    | Readonly<ConfirmLocalPluginPackagePublisherRevocationCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  outcome: 'allowed' | 'authorization_unavailable' | 'authentication_rejected',
  eventId: string,
  occurredAtMs: number,
): Readonly<SecurityAudit> {
  return Object.freeze({
    eventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'plugin-package.publisher-trust.provision'
        ? 'plugin_package_publisher_trust_provision'
        : command.operation === 'plugin-package.publisher-trust.rotate'
        ? 'plugin_package_publisher_trust_rotate'
        : command.operation === 'plugin-package.publisher-trust.retire'
        ? 'plugin_package_publisher_trust_retire'
        : command.operation === 'plugin-package.publisher-trust.revoke.propose'
        ? 'plugin_package_publisher_trust_revoke_propose'
        : 'plugin_package_publisher_trust_revoke_confirm',
    projectId: null,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([
      outcome === 'allowed'
        ? 'publisher_trust_mutation_authorized'
        : outcome === 'authentication_rejected'
        ? 'credential_rejected'
        : 'publisher_trust_mutation_failed',
    ]),
    fence: null,
    occurredAtMs,
  });
}

function confirmDistinctCurrentOwner(
  database: LocalSqliteAuthenticatedManagementDatabase,
  proposerSubjectId: string,
  confirmerSubjectId: string,
): void {
  if (proposerSubjectId === confirmerSubjectId) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'dual-control revocation requires a distinct Owner',
    );
  }
  const row = database.authority.client
    .prepare(
      `SELECT
         identity."status" AS "subjectStatus",
         project."status" AS "projectStatus",
         binding."state" AS "bindingState",
         binding."role" AS "role"
       FROM "QingLong3IdentitySubjects" AS identity
       JOIN "QingLong3Projects" AS project
         ON project."id" = 'default'
       JOIN "QingLong3ProjectRoleBindings" AS binding
         ON binding."project_id" = project."id"
        AND binding."subject_type" = identity."subject_type"
        AND binding."subject_id" = identity."subject_id"
       WHERE identity."subject_type" = 'user'
         AND identity."subject_id" = ?
         AND binding."version" = (
           SELECT max(latest."version")
           FROM "QingLong3ProjectRoleBindings" AS latest
           WHERE latest."project_id" = binding."project_id"
             AND latest."subject_type" = binding."subject_type"
             AND latest."subject_id" = binding."subject_id"
         )`,
    )
    .get(proposerSubjectId) as Record<string, unknown> | undefined;
  if (
    !row ||
    row.subjectStatus !== 'active' ||
    row.projectStatus !== 'active' ||
    row.bindingState !== 'active' ||
    row.role !== 'owner'
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'revocation proposer is no longer a current Owner',
    );
  }
}

async function execute(
  command: Readonly<LocalPluginPackagePublisherTrustCommand>,
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
  adapters: Readonly<RunnerDependencies>,
): Promise<Readonly<LocalPluginPackagePublisherTrustCommandResult>> {
  await confirmOwner(database, authenticated);
  if (command.operation === 'plugin-package.publisher-trust.inspect') {
    const inspected = adapters.inspect({
      trustRoot: command.options.trustRoot,
      observedAtMs: adapters.now(),
    });
    await confirmOwner(database, authenticated);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      generation: inspected.generation,
      keyCount: inspected.keyCount,
      activeKeyCount: inspected.activeKeyCount,
      snapshotCount: inspected.snapshotCount,
      retirementCount: inspected.retirementCount,
      pendingRetirementCount: inspected.pendingRetirementCount,
      revocationCount: inspected.revocationCount,
      pendingRevocationCount: inspected.pendingRevocationCount,
      quarantinedLockCount: inspected.quarantinedLockCount,
      recoveryRequired: inspected.recoveryRequired,
      pendingGeneration: inspected.pendingGeneration,
      unresolvedTransactions: inspected.unresolvedTransactions,
    });
  }
  const occurredAtMs = databaseTime(
    database,
    command.request.auditEventId,
    adapters.now,
  );
  const beforePublish = async () => {
    await confirmOwner(database, authenticated);
    await database.securityAudit.record(
      audit(
        command,
        authenticated,
        'allowed',
        command.request.auditEventId,
        occurredAtMs,
      ),
    );
    await confirmOwner(database, authenticated);
  };
  if (command.operation === 'plugin-package.publisher-trust.revoke.propose') {
    const impact = adapters.analyzePublisherKeyImpact({
      catalogRoot: command.options.catalogRoot,
      bundleRoot: command.options.bundleRoot,
      publisher: command.request.publisher,
      keyId: command.request.keyId,
    });
    const result = await adapters.proposeRevocation({
      trustRoot: command.options.trustRoot,
      expectedGeneration: command.request.expectedGeneration,
      mutationId: command.request.mutationId,
      occurredAtMs,
      publisher: command.request.publisher,
      keyId: command.request.keyId,
      proposerSubjectId: authenticated.principal.subject.id,
      impact,
      beforePublish,
    } satisfies ProposeLocalPluginPackagePublisherKeyRevocationOptions);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: result.status,
      generation: result.generation,
      proposalDigest: result.proposalDigest,
      impactDigest: result.impactDigest,
      matchingEntryCount: result.matchingEntryCount,
      runtimeAction: result.runtimeAction,
    });
  }
  if (command.operation === 'plugin-package.publisher-trust.revoke.confirm') {
    const result = await adapters.confirmRevocation({
      trustRoot: command.options.trustRoot,
      expectedGeneration: command.request.expectedGeneration,
      mutationId: command.request.mutationId,
      confirmedAtMs: occurredAtMs,
      publisher: command.request.publisher,
      keyId: command.request.keyId,
      proposerSubjectId: command.request.proposerSubjectId,
      confirmerSubjectId: authenticated.principal.subject.id,
      authorizationMode: command.request.authorizationMode,
      reasonCode: command.request.reasonCode,
      expectedImpactDigest: command.request.expectedImpactDigest,
      async confirmAuthorization() {
        await confirmOwner(database, authenticated);
        if (command.request.authorizationMode === 'dual_control') {
          confirmDistinctCurrentOwner(
            database,
            command.request.proposerSubjectId,
            authenticated.principal.subject.id,
          );
        }
      },
      beforePublish,
      async afterReceiptPublished(
        receipt: Readonly<LocalPluginPackagePublisherKeyRevocationReceipt>,
      ) {
        const targets: Readonly<PluginPackageQuarantineTarget>[] = [];
        for (const lockDigest of receipt.impactedLockDigests) {
          targets.push(
            ...(await database.pluginPackageQuarantine.findTargetsByLockDigest(
              lockDigest,
            )),
          );
        }
        const uniqueTargets = [
          ...new Map(
            targets.map((target) => [
              `${target.projectId}\0${target.packageName}\0${target.installationId}\0${target.lockDigest}`,
              target,
            ]),
          ).values(),
        ];
        const targetLimit = database.profile === 'edge' ? 4 : 16;
        if (uniqueTargets.length > targetLimit) {
          throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
            'revocation quarantine targets exceed the local Profile limit',
          );
        }
        for (const target of uniqueTargets) {
          await confirmOwner(database, authenticated);
          await database.pluginPackageQuarantine.quarantine(
            createPluginPackageQuarantineEvent({
              mutationId: pluginPackageQuarantineMutationId(
                receipt.receiptDigest,
                target,
              ),
              revocationReceiptDigest: receipt.receiptDigest,
              impactDigest: receipt.impactDigest,
              target,
              proposer: {
                type: 'user',
                id: receipt.proposerSubjectId,
              },
              confirmer: {
                type: 'user',
                id: receipt.confirmerSubjectId,
              },
              authorizationMode: receipt.authorizationMode,
              reasonCode: receipt.reasonCode,
              occurredAtMs: receipt.confirmedAtMs,
            }),
            () => {
              database.confirmUserCredentialFence(authenticated.databaseFence);
              database.confirmDefaultProjectOwnerFence(
                authenticated.databaseFence,
              );
              if (receipt.authorizationMode === 'dual_control') {
                confirmDistinctCurrentOwner(
                  database,
                  receipt.proposerSubjectId,
                  receipt.confirmerSubjectId,
                );
              }
            },
          );
        }
      },
    } satisfies ConfirmLocalPluginPackagePublisherKeyRevocationOptions);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: result.status,
      generation: result.generation,
      keyCount: result.keyCount,
      authorizationMode: result.authorizationMode,
      quarantinedLockCount: result.quarantinedLockCount,
      runtimeAction: result.runtimeAction,
    });
  }
  const result =
    command.operation === 'plugin-package.publisher-trust.retire'
      ? await adapters.retire({
          trustRoot: command.options.trustRoot,
          expectedGeneration: command.request.expectedGeneration,
          mutationId: command.request.mutationId,
          occurredAtMs,
          publisher: command.request.publisher,
          keyId: command.request.keyId,
          beforePublish,
          proveRetirement() {
            return adapters.analyzePublisherKey({
              catalogRoot: command.options.catalogRoot,
              bundleRoot: command.options.bundleRoot,
              publisher: command.request.publisher,
              keyId: command.request.keyId,
            });
          },
        } satisfies RetireLocalPluginPackagePublisherKeyOptions)
      : await (async () => {
          let trust: unknown;
          try {
            trust = readPrivateLocalJsonFile(command.request.trustFilePath, {
              maxBytes: MAX_TRUST_BYTES,
            });
          } catch (error) {
            throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
              'publisher trust candidate cannot be read',
              error,
            );
          }
          return adapters.publish({
            trustRoot: command.options.trustRoot,
            mode:
              command.operation === 'plugin-package.publisher-trust.provision'
                ? 'provision'
                : 'rotate',
            expectedGeneration: command.request.expectedGeneration,
            mutationId: command.request.mutationId,
            occurredAtMs,
            trust,
            beforePublish,
          } satisfies PublishLocalPluginPackagePublisherTrustOptions);
        })();
  return Object.freeze({
    schemaVersion: 1,
    operation: command.operation,
    status: result.status,
    generation: result.generation,
    keyCount: result.keyCount,
  });
}

function dependencies(value: RunnerDependencies): Readonly<RunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'analyzePublisherKeyImpact',
        'analyzePublisherKey',
        'authenticate',
        'confirmRevocation',
        'inspect',
        'now',
        'openDatabase',
        'publish',
        'proposeRevocation',
        'retire',
      ]
        .sort()
        .join('\0') ||
    Object.values(value).some((candidate) => typeof candidate !== 'function')
  ) {
    throw new LocalPluginPackagePublisherTrustCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function createLocalPluginPackagePublisherTrustCommandRunner(
  candidateDependencies: RunnerDependencies = {
    openDatabase: openLocalSqliteAuthenticatedManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    inspect: inspectLocalPluginPackagePublisherTrust,
    publish: publishLocalPluginPackagePublisherTrust,
    retire: retireLocalPluginPackagePublisherKey,
    analyzePublisherKey: analyzeLocalPluginPackageRecoveryCatalogPublisherKey,
    proposeRevocation: proposeLocalPluginPackagePublisherKeyRevocation,
    confirmRevocation: confirmLocalPluginPackagePublisherKeyRevocation,
    analyzePublisherKeyImpact:
      analyzeLocalPluginPackageRecoveryCatalogPublisherKeyImpact,
    now: Date.now,
  },
): LocalPluginPackagePublisherTrustCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommand(commandFilePath);
      const database = await adapters.openDatabase({
        databasePath: command.options.databasePath,
        profile: command.options.profile,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      });
      let authenticated: Readonly<AuthenticatedLocalCommand> | undefined;
      try {
        try {
          authenticated = await adapters.authenticate(database, {
            deploymentRoot: command.options.deploymentRoot,
            databasePath: command.options.databasePath,
            ownerPepperKeyringDirectory:
              command.options.ownerPepperKeyringDirectory,
            credentialFilePath: command.options.credentialFilePath,
            authenticationNamespace: 'local_package_publisher_trust',
          });
          return await execute(command, database, authenticated, adapters);
        } catch (error) {
          if (command.operation !== 'plugin-package.publisher-trust.inspect') {
            const failureOccurredAtMs = databaseTime(
              database,
              command.request.failureAuditEventId,
              adapters.now,
            );
            await database.securityAudit.record(
              audit(
                command,
                authenticated,
                authenticated
                  ? 'authorization_unavailable'
                  : 'authentication_rejected',
                command.request.failureAuditEventId,
                failureOccurredAtMs,
              ),
            );
          }
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalPluginPackagePublisherTrustCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalPluginPackagePublisherTrustCommandResult>> {
  return createLocalPluginPackagePublisherTrustCommandRunner().run(
    commandFilePath,
  );
}
