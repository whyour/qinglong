// Security management owns authenticated Local Secret mutation commands.
import path from 'node:path';

import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
  readPrivateLocalJsonFile,
} from '@qinglong/local-command-file';
import {
  AuthenticatedLocalCommandAuthenticationError,
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import { LocalSecretKeyringFileProvider } from '@qinglong/local-secret';
import {
  LocalSecretAdministrationAuthenticationError,
  LocalSecretAdministrationAuthorizationError,
  LocalSecretAdministrationUnavailableError,
  createLocalSecretAdministrationService,
} from '@qinglong/local-admin/secret-administration';
import {
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '@qinglong/local-sqlite/authenticated-management';
import {
  openLocalSqliteSecretAdministrationDatabase,
  type LocalSqliteSecretAdministrationDatabase,
} from '@qinglong/local-sqlite/secret-administration';
import { LocalSecretAuthorizationFenceConflictError } from '@qinglong/runtime-core/local-secret-administration';
import {
  MAX_LOCAL_SECRET_PLAINTEXT_BYTES,
  LocalSecretMutationConflictError,
  LocalSecretVersionConflictError,
  assertLocalSecretExpectedVersion,
  assertLocalSecretName,
  assertLocalSecretPlaintext,
  assertLocalSecretProjectId,
} from '@qinglong/runtime-core/local-secret';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const MAX_PATH_BYTES = 4096;
const MAX_SECRET_VALUE_FILE_BYTES = MAX_LOCAL_SECRET_PLAINTEXT_BYTES + 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalSecretCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly secretKeyringPath: string;
  readonly busyTimeoutMs?: number;
}

export interface PutLocalSecretCommand {
  readonly schemaVersion: 1;
  readonly operation: 'secret.put';
  readonly options: LocalSecretCommandOptions;
  readonly request: {
    readonly projectId: string;
    readonly name: string;
    readonly secretValueFilePath: string;
    readonly mutationId: string;
    readonly requestId: string;
    readonly failureAuditEventId: string;
    readonly expectedCurrentVersion: number;
  };
}

export type LocalSecretCommand = PutLocalSecretCommand;

export type LocalSecretCommandResult = Readonly<{
  schemaVersion: 1;
  operation: LocalSecretCommand['operation'];
  status: 'inserted' | 'existing';
  version: number;
  secretRef: string;
}>;

export interface LocalSecretCommandRunner {
  run(commandFilePath: string): Promise<Readonly<LocalSecretCommandResult>>;
}

export interface LocalSecretCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteSecretAdministrationDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createService: typeof createLocalSecretAdministrationService;
  readonly now: () => number;
}

export class LocalSecretCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_SECRET_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Secret command configuration is invalid: ${message}`);
    this.name = 'LocalSecretCommandConfigurationError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalSecretCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalSecretCommandConfigurationError(`${label} shape is invalid`);
  }
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalSecretCommandConfigurationError(
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
    throw new LocalSecretCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function normalizeOptions(value: unknown): Readonly<LocalSecretCommandOptions> {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  exactObject(
    value,
    [
      'deploymentRoot',
      'databasePath',
      'profile',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
      'secretKeyringPath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  for (const key of [
    'databasePath',
    'ownerPepperKeyringDirectory',
    'credentialFilePath',
    'secretKeyringPath',
  ] as const) {
    descendant(deploymentRoot, boundedPath(value[key], key), key);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalSecretCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalSecretCommandConfigurationError('busyTimeoutMs is invalid');
  }
  return Object.freeze(value as unknown as LocalSecretCommandOptions);
}

function normalizeRequest(
  value: unknown,
  deploymentRoot: string,
): Readonly<PutLocalSecretCommand['request']> {
  exactObject(
    value,
    [
      'projectId',
      'name',
      'secretValueFilePath',
      'mutationId',
      'requestId',
      'failureAuditEventId',
      'expectedCurrentVersion',
    ],
    'request',
  );
  const secretValueFilePath = boundedPath(
    value.secretValueFilePath,
    'secretValueFilePath',
  );
  descendant(deploymentRoot, secretValueFilePath, 'secretValueFilePath');
  try {
    assertLocalSecretProjectId(value.projectId);
    assertLocalSecretName(value.name);
    assertLocalSecretExpectedVersion(value.expectedCurrentVersion);
  } catch (error) {
    throw new LocalSecretCommandConfigurationError(
      'Secret identity or expected version is invalid',
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
    throw new LocalSecretCommandConfigurationError(
      'request identity is invalid',
    );
  }
  return Object.freeze(value as unknown as PutLocalSecretCommand['request']);
}

function normalizeCommand(value: unknown): Readonly<LocalSecretCommand> {
  exactObject(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    'command',
  );
  if (value.schemaVersion !== 1 || value.operation !== 'secret.put') {
    throw new LocalSecretCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  const options = normalizeOptions(value.options);
  const request = normalizeRequest(value.request, options.deploymentRoot);
  return Object.freeze({
    schemaVersion: 1,
    operation: 'secret.put',
    options,
    request,
  });
}

function readCommandFile(candidatePath: string): Readonly<LocalSecretCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalSecretCommandConfigurationError) throw error;
    throw new LocalSecretCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function readSecretValue(filePath: string): string {
  try {
    const value = readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_SECRET_VALUE_FILE_BYTES,
    });
    exactObject(value, ['kind', 'schemaVersion', 'value'], 'secret value');
    if (
      value.schemaVersion !== 1 ||
      value.kind !== 'qinglong3-local-secret-value'
    ) {
      throw new LocalSecretCommandConfigurationError(
        'secret value version or kind is invalid',
      );
    }
    assertLocalSecretPlaintext(value.value);
    return value.value;
  } catch (error) {
    if (error instanceof LocalSecretCommandConfigurationError) throw error;
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalSecretCommandConfigurationError(
        'secret value file cannot be read',
        error,
      );
    }
    throw new LocalSecretCommandConfigurationError(
      'secret value is invalid',
      error,
    );
  }
}

function failureAudit(
  command: Readonly<LocalSecretCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  if (
    error instanceof LocalSecretAdministrationAuthenticationError ||
    error instanceof LocalSecretAdministrationAuthorizationError ||
    error instanceof LocalSecretAdministrationUnavailableError
  ) {
    return null;
  }
  let outcome: SecurityAuditRecord['outcome'];
  let reason: string;
  if (
    !authenticated ||
    error instanceof AuthenticatedLocalCommandAuthenticationError
  ) {
    outcome = 'authentication_rejected';
    reason = 'credential_rejected';
  } else if (
    error instanceof LocalSqliteAuthenticatedManagementFenceError ||
    error instanceof LocalSecretAuthorizationFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (error instanceof LocalSecretVersionConflictError) {
    outcome = 'denied';
    reason = 'current_version_conflict';
  } else if (error instanceof LocalSecretMutationConflictError) {
    outcome = 'denied';
    reason = 'mutation_conflict';
  } else if (error instanceof LocalSecretCommandConfigurationError) {
    outcome = 'denied';
    reason = 'secret_value_rejected';
  } else {
    return null;
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId: 'secret.manage',
    projectId: command.request.projectId,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

function dependencies(
  value: LocalSecretCommandRunnerDependencies,
): Readonly<LocalSecretCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'createService', 'now', 'openDatabase']
        .sort()
        .join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.createService !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalSecretCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

async function activateFence(
  database: LocalSqliteSecretAdministrationDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.activateUserCredentialFence(
    authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  );
}

export function createLocalSecretCommandRunner(
  candidateDependencies: LocalSecretCommandRunnerDependencies = {
    openDatabase: openLocalSqliteSecretAdministrationDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createService: createLocalSecretAdministrationService,
    now: Date.now,
  },
): LocalSecretCommandRunner {
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
            authenticationNamespace: 'local_secret',
          });
          await activateFence(database, authenticated);
          const plaintext = readSecretValue(
            command.request.secretValueFilePath,
          );
          await activateFence(database, authenticated);
          const service = adapters.createService(
            database.projectPolicy,
            database.localSecretAdministration,
            database.securityAudit,
            new LocalSecretKeyringFileProvider(
              command.options.secretKeyringPath,
            ),
            { now: adapters.now },
          );
          const result = await service.put({
            projectId: command.request.projectId,
            name: command.request.name,
            plaintext,
            mutationId: command.request.mutationId,
            requestId: command.request.requestId,
            expectedCurrentVersion: command.request.expectedCurrentVersion,
            principal: authenticated.principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            version: result.version,
            secretRef: result.secretRef,
          });
        } catch (error) {
          const audit = failureAudit(
            command,
            authenticated,
            error,
            adapters.now(),
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

export function runLocalSecretCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalSecretCommandResult>> {
  return createLocalSecretCommandRunner().run(commandFilePath);
}
