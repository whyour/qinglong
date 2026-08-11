// Plugin Package owns recovery catalog publication and inspection commands.
import path from 'node:path';

import {
  collectLocalPluginPackageRecoveryCatalog,
  createLocalPluginPackagePublisherTrustRegistry,
  inspectLocalPluginPackageRecoveryCatalog,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
  publishLocalPluginPackageRecoveryCatalogEntry,
  type CollectLocalPluginPackageRecoveryCatalogOptions,
  type PublishLocalPluginPackageRecoveryCatalogOptions,
} from '@qinglong/local-admin/package-recovery-catalog';
import { assertLocalPluginPackagePublisherKeyPublicationAllowed } from '@qinglong/local-admin/package-publisher-trust';
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
import { LocalSqlitePluginPackageInstallRepository } from '@qinglong/local-sqlite/plugin-package-install';

export const LOCAL_PLUGIN_PACKAGE_RECOVERY_PUBLICATION_SCHEMA =
  'qinglong/local-plugin-package-recovery-publication@v1' as const;

const MAX_PATH_BYTES = 4_096;
const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const MAX_TRUST_BYTES = 256 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const COLLECTION_LIMITS = Object.freeze({
  edge: 4,
  standalone: 16,
} as const);

export interface LocalPluginPackageCatalogCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: LocalSqliteProfile;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly catalogRoot: string;
  readonly bundleRoot: string;
  readonly trustRoot: string;
  readonly busyTimeoutMs?: number;
}

interface MutationIdentity {
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
}

export interface PublishLocalPluginPackageCatalogCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.catalog.publish';
  readonly options: LocalPluginPackageCatalogCommandOptions;
  readonly request: MutationIdentity & {
    readonly projectId: string;
    readonly packageName: string;
    readonly descriptorFilePath: string;
  };
}

export interface CollectLocalPluginPackageCatalogCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.catalog.collect';
  readonly options: LocalPluginPackageCatalogCommandOptions;
  readonly request: MutationIdentity & {
    readonly limit?: number;
  };
}

export interface InspectLocalPluginPackageCatalogCommand {
  readonly schemaVersion: 1;
  readonly operation: 'plugin-package.catalog.inspect';
  readonly options: LocalPluginPackageCatalogCommandOptions;
  readonly request: Readonly<Record<never, never>>;
}

export type LocalPluginPackageCatalogCommand =
  | PublishLocalPluginPackageCatalogCommand
  | CollectLocalPluginPackageCatalogCommand
  | InspectLocalPluginPackageCatalogCommand;

export type LocalPluginPackageCatalogCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.catalog.publish';
      status: 'published' | 'existing';
      lockDigest: string;
      artifactDigest: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.catalog.collect';
      removedEntries: number;
      removedBundles: number;
      removedTransactions: number;
      remaining: boolean;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'plugin-package.catalog.inspect';
      entryCount: number;
      bundleCount: number;
      unresolvedTransactions: number;
      currentEntries: number;
      staleEntries: number;
    }>;

export interface LocalPluginPackageCatalogCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<Readonly<LocalPluginPackageCatalogCommandResult>>;
}

interface PublicationDescriptor {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_RECOVERY_PUBLICATION_SCHEMA;
  readonly bundlePath: string;
  readonly manifest: PublishLocalPluginPackageRecoveryCatalogOptions['manifest'];
  readonly signature: PublishLocalPluginPackageRecoveryCatalogOptions['signature'];
}

interface LocalPluginPackageCatalogCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteAuthenticatedManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly publish: typeof publishLocalPluginPackageRecoveryCatalogEntry;
  readonly inspect: typeof inspectLocalPluginPackageRecoveryCatalog;
  readonly collect: typeof collectLocalPluginPackageRecoveryCatalog;
  readonly now: () => number;
}

export class LocalPluginPackageCatalogCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_CATALOG_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Local Plugin Package catalog command configuration is invalid: ${message}`,
    );
    this.name = 'LocalPluginPackageCatalogCommandConfigurationError';
  }
}

export class LocalPluginPackageCatalogCommandConflictError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_CATALOG_COMMAND_CONFLICT';

  constructor(message: string) {
    super(
      `Local Plugin Package catalog command conflicts with durable state: ${message}`,
    );
    this.name = 'LocalPluginPackageCatalogCommandConflictError';
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
    throw new LocalPluginPackageCatalogCommandConfigurationError(
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
    throw new LocalPluginPackageCatalogCommandConfigurationError(
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
    throw new LocalPluginPackageCatalogCommandConfigurationError(
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
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function options(value: unknown): LocalPluginPackageCatalogCommandOptions {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  exactObject(
    value,
    [
      'bundleRoot',
      'catalogRoot',
      'credentialFilePath',
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
    catalogRoot: boundedPath(value.catalogRoot, 'catalogRoot'),
    bundleRoot: boundedPath(value.bundleRoot, 'bundleRoot'),
    trustRoot: boundedPath(value.trustRoot, 'trustRoot'),
    ...(hasBusyTimeout ? { busyTimeoutMs: value.busyTimeoutMs as number } : {}),
  };
  if (result.profile !== 'edge' && result.profile !== 'standalone') {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    hasBusyTimeout &&
    (!Number.isSafeInteger(result.busyTimeoutMs) ||
      (result.busyTimeoutMs as number) < 100 ||
      (result.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  const authorityPaths = [
    result.databasePath,
    result.ownerPepperKeyringDirectory,
    result.credentialFilePath,
    result.catalogRoot,
    result.bundleRoot,
    result.trustRoot,
  ];
  for (const [index, authorityPath] of authorityPaths.entries()) {
    descendant(deploymentRoot, authorityPath, `authority path ${index}`);
  }
  if (new Set(authorityPaths).size !== authorityPaths.length) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'authority paths must be distinct',
    );
  }
  return Object.freeze(result as LocalPluginPackageCatalogCommandOptions);
}

function mutationIdentity(
  value: Record<string, unknown>,
  extraKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> & MutationIdentity {
  exactObject(
    value,
    ['auditEventId', 'failureAuditEventId', 'requestId', ...extraKeys],
    label,
  );
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    typeof value.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.auditEventId) ||
    typeof value.failureAuditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.failureAuditEventId) ||
    value.auditEventId === value.failureAuditEventId
  ) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      `${label} identity is invalid`,
    );
  }
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalPluginPackageCatalogCommand> {
  exactObject(
    value,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (value.schemaVersion !== 1) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'schemaVersion is invalid',
    );
  }
  const commandOptions = options(value.options);
  if (value.operation === 'plugin-package.catalog.publish') {
    exactObject(
      value.request,
      [
        'auditEventId',
        'descriptorFilePath',
        'failureAuditEventId',
        'packageName',
        'projectId',
        'requestId',
      ],
      'publication request',
    );
    mutationIdentity(
      value.request,
      ['descriptorFilePath', 'packageName', 'projectId'],
      'publication request',
    );
    if (
      typeof value.request.projectId !== 'string' ||
      !PROJECT_ID_PATTERN.test(value.request.projectId) ||
      typeof value.request.packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(value.request.packageName)
    ) {
      throw new LocalPluginPackageCatalogCommandConfigurationError(
        'publication package identity is invalid',
      );
    }
    const descriptorFilePath = boundedPath(
      value.request.descriptorFilePath,
      'descriptorFilePath',
    );
    descendant(
      commandOptions.deploymentRoot,
      descriptorFilePath,
      'descriptorFilePath',
    );
    if (
      new Set([
        commandOptions.databasePath,
        commandOptions.credentialFilePath,
        commandOptions.catalogRoot,
        commandOptions.bundleRoot,
        commandOptions.trustRoot,
        descriptorFilePath,
      ]).size !== 6
    ) {
      throw new LocalPluginPackageCatalogCommandConfigurationError(
        'publication authority paths must be distinct',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options: commandOptions,
      request: Object.freeze({
        ...value.request,
        descriptorFilePath,
      }),
    } as PublishLocalPluginPackageCatalogCommand);
  }
  if (value.operation === 'plugin-package.catalog.collect') {
    const hasLimit =
      !!value.request &&
      typeof value.request === 'object' &&
      !Array.isArray(value.request) &&
      Object.hasOwn(value.request, 'limit');
    exactObject(
      value.request,
      [
        'auditEventId',
        'failureAuditEventId',
        'requestId',
        ...(hasLimit ? ['limit'] : []),
      ],
      'collection request',
    );
    mutationIdentity(
      value.request,
      hasLimit ? ['limit'] : [],
      'collection request',
    );
    const limit = value.request.limit;
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > COLLECTION_LIMITS[commandOptions.profile])
    ) {
      throw new LocalPluginPackageCatalogCommandConfigurationError(
        'collection limit is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options: commandOptions,
      request: Object.freeze({
        requestId: value.request.requestId,
        auditEventId: value.request.auditEventId,
        failureAuditEventId: value.request.failureAuditEventId,
        ...(limit === undefined ? {} : { limit: limit as number }),
      }),
    });
  }
  if (value.operation === 'plugin-package.catalog.inspect') {
    exactObject(value.request, [], 'inspection request');
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options: commandOptions,
      request: Object.freeze({}),
    });
  }
  throw new LocalPluginPackageCatalogCommandConfigurationError(
    'operation is invalid',
  );
}

function readCommandFile(
  commandFilePath: string,
): Readonly<LocalPluginPackageCatalogCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (error instanceof LocalPluginPackageCatalogCommandConfigurationError) {
      throw error;
    }
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalPluginPackageCatalogCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw error;
  }
}

function publicationDescriptor(
  filePath: string,
  deploymentRoot: string,
): Readonly<PublicationDescriptor> {
  let parsed: unknown;
  try {
    parsed = readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_DESCRIPTOR_BYTES,
    });
  } catch (error) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'publication descriptor cannot be read',
      error,
    );
  }
  exactObject(
    parsed,
    ['bundlePath', 'manifest', 'schema', 'signature'],
    'publication descriptor',
  );
  if (parsed.schema !== LOCAL_PLUGIN_PACKAGE_RECOVERY_PUBLICATION_SCHEMA) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'publication descriptor schema is invalid',
    );
  }
  const bundlePath = boundedPath(parsed.bundlePath, 'bundlePath');
  descendant(deploymentRoot, bundlePath, 'bundlePath');
  return Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_RECOVERY_PUBLICATION_SCHEMA,
    bundlePath,
    manifest:
      parsed.manifest as PublishLocalPluginPackageRecoveryCatalogOptions['manifest'],
    signature:
      parsed.signature as PublishLocalPluginPackageRecoveryCatalogOptions['signature'],
  });
}

function trustFile(
  filePath: string,
): ReturnType<typeof createLocalPluginPackagePublisherTrustRegistry> {
  let parsed: unknown;
  try {
    parsed = readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_TRUST_BYTES,
    });
  } catch (error) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'publisher trust file cannot be read',
      error,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { schema?: unknown }).schema !==
      LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA
  ) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'publisher trust file schema is invalid',
    );
  }
  return createLocalPluginPackagePublisherTrustRegistry(parsed);
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
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'audit clock is invalid',
    );
  }
  return value as number;
}

async function recordAuthorized(
  command:
    | Readonly<PublishLocalPluginPackageCatalogCommand>
    | Readonly<CollectLocalPluginPackageCatalogCommand>,
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
  projectId: string | null,
  now: () => number,
): Promise<void> {
  const audit: SecurityAudit = Object.freeze({
    eventId: command.request.auditEventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'plugin-package.catalog.publish'
        ? 'plugin_package_catalog_publish'
        : 'plugin_package_catalog_collect',
    projectId,
    subject: authenticated.principal.subject,
    authenticationId: authenticated.principal.authenticationId,
    outcome: 'allowed',
    reasons: Object.freeze(['catalog_mutation_authorized']),
    fence: null,
    occurredAtMs: databaseTime(database, command.request.auditEventId, now),
  });
  await database.securityAudit.record(audit);
}

async function staleLockDigests(
  repository: LocalSqlitePluginPackageInstallRepository,
  lockDigests: readonly string[],
): Promise<readonly string[]> {
  const stale: string[] = [];
  for (const lockDigest of lockDigests) {
    const lock = await repository.findLock(lockDigest);
    if (!lock) {
      stale.push(lockDigest);
      continue;
    }
    const head = await repository.find(lock.projectId, lock.packageName);
    if (!head || head.lockDigest !== lockDigest) stale.push(lockDigest);
  }
  return Object.freeze(stale);
}

async function execute(
  command: Readonly<LocalPluginPackageCatalogCommand>,
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
  adapters: Readonly<LocalPluginPackageCatalogCommandRunnerDependencies>,
): Promise<Readonly<LocalPluginPackageCatalogCommandResult>> {
  await confirmOwner(database, authenticated);
  const repository = new LocalSqlitePluginPackageInstallRepository(
    database.authority,
  );
  if (command.operation === 'plugin-package.catalog.publish') {
    const head = await repository.find(
      command.request.projectId,
      command.request.packageName,
    );
    if (!head || head.state === 'failed') {
      throw new LocalPluginPackageCatalogCommandConflictError(
        'the current install head is unavailable',
      );
    }
    const lock = await repository.findLock(head.lockDigest);
    if (
      !lock ||
      lock.projectId !== command.request.projectId ||
      lock.packageName !== command.request.packageName
    ) {
      throw new LocalPluginPackageCatalogCommandConflictError(
        'the current PackageLock is unavailable',
      );
    }
    const descriptor = publicationDescriptor(
      command.request.descriptorFilePath,
      command.options.deploymentRoot,
    );
    if (
      descriptor.bundlePath === command.request.descriptorFilePath ||
      descriptor.bundlePath === command.options.catalogRoot ||
      descriptor.bundlePath === command.options.bundleRoot ||
      descriptor.bundlePath === command.options.trustRoot
    ) {
      throw new LocalPluginPackageCatalogCommandConfigurationError(
        'publication descriptor authorities must be distinct',
      );
    }
    const trust = trustFile(
      path.join(command.options.trustRoot, 'current.json'),
    );
    const result = await adapters.publish({
      catalogRoot: command.options.catalogRoot,
      bundleRoot: command.options.bundleRoot,
      sourceBundlePath: descriptor.bundlePath,
      lock,
      manifest: descriptor.manifest,
      signature: descriptor.signature,
      trust,
      confirmPublicationAllowed() {
        assertLocalPluginPackagePublisherKeyPublicationAllowed({
          trustRoot: command.options.trustRoot,
          publisher: descriptor.signature.publisher,
          keyId: descriptor.signature.keyId,
        });
      },
      async beforePublish() {
        await confirmOwner(database, authenticated);
        await recordAuthorized(
          command,
          database,
          authenticated,
          lock.projectId,
          adapters.now,
        );
        await confirmOwner(database, authenticated);
      },
    } satisfies PublishLocalPluginPackageRecoveryCatalogOptions);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: result.status,
      lockDigest: result.lockDigest,
      artifactDigest: result.artifactDigest,
    });
  }

  const inspection = adapters.inspect({
    catalogRoot: command.options.catalogRoot,
    bundleRoot: command.options.bundleRoot,
  });
  const stale = await staleLockDigests(repository, inspection.lockDigests);
  if (command.operation === 'plugin-package.catalog.inspect') {
    await confirmOwner(database, authenticated);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      entryCount: inspection.entryCount,
      bundleCount: inspection.bundleCount,
      unresolvedTransactions: inspection.unresolvedTransactions,
      currentEntries: inspection.entryCount - stale.length,
      staleEntries: stale.length,
    });
  }
  const result = await adapters.collect({
    catalogRoot: command.options.catalogRoot,
    bundleRoot: command.options.bundleRoot,
    candidateLockDigests: stale,
    maxDeletes:
      command.request.limit ?? COLLECTION_LIMITS[command.options.profile],
    async beforeDelete() {
      await confirmOwner(database, authenticated);
      await recordAuthorized(
        command,
        database,
        authenticated,
        null,
        adapters.now,
      );
      await confirmOwner(database, authenticated);
    },
  } satisfies CollectLocalPluginPackageRecoveryCatalogOptions);
  return Object.freeze({
    schemaVersion: 1,
    operation: command.operation,
    ...result,
  });
}

function failureAudit(
  command: Readonly<LocalPluginPackageCatalogCommand>,
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  now: () => number,
): Readonly<SecurityAudit> | null {
  if (command.operation === 'plugin-package.catalog.inspect') return null;
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'plugin-package.catalog.publish'
        ? 'plugin_package_catalog_publish'
        : 'plugin_package_catalog_collect',
    projectId:
      command.operation === 'plugin-package.catalog.publish'
        ? command.request.projectId
        : null,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome: authenticated
      ? 'authorization_unavailable'
      : 'authentication_rejected',
    reasons: Object.freeze([
      authenticated ? 'catalog_mutation_failed' : 'credential_rejected',
    ]),
    fence: null,
    occurredAtMs: databaseTime(
      database,
      command.request.failureAuditEventId,
      now,
    ),
  });
}

function dependencies(
  value: LocalPluginPackageCatalogCommandRunnerDependencies,
): Readonly<LocalPluginPackageCatalogCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'collect', 'inspect', 'now', 'openDatabase', 'publish']
        .sort()
        .join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.publish !== 'function' ||
    typeof value.inspect !== 'function' ||
    typeof value.collect !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalPluginPackageCatalogCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function createLocalPluginPackageCatalogCommandRunner(
  candidateDependencies: LocalPluginPackageCatalogCommandRunnerDependencies = {
    openDatabase: openLocalSqliteAuthenticatedManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    publish: publishLocalPluginPackageRecoveryCatalogEntry,
    inspect: inspectLocalPluginPackageRecoveryCatalog,
    collect: collectLocalPluginPackageRecoveryCatalog,
    now: Date.now,
  },
): LocalPluginPackageCatalogCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
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
            authenticationNamespace: 'local_package_catalog',
          });
          return await execute(command, database, authenticated, adapters);
        } catch (error) {
          const audit = failureAudit(
            command,
            database,
            authenticated,
            adapters.now,
          );
          if (audit) await database.securityAudit.record(audit);
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalPluginPackageCatalogCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalPluginPackageCatalogCommandResult>> {
  return createLocalPluginPackageCatalogCommandRunner().run(commandFilePath);
}
