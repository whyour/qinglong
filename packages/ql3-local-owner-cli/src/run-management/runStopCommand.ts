import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from '@qinglong/local-command-file';
import {
  AuthenticatedLocalCommandAuthenticationError,
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import {
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '@qinglong/local-sqlite/authenticated-management';
import {
  openLocalSqliteRunManagementDatabase,
  type LocalSqliteRunManagementDatabase,
} from '@qinglong/local-sqlite/run-management';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  RUN_CANCELLATION_SCHEMA,
  RunCancellationFenceRejectedError,
  RunCancellationNotFoundError,
  RunCancellationUnavailableError,
  parseRunCancellationRequestBody,
  type RunCancellationResult,
} from '@qinglong/runtime-core/run-cancellation';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

const MAX_PATH_BYTES = 4_096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalRunStopCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalRunStopCommand {
  readonly schemaVersion: 1;
  readonly operation: 'run.stop';
  readonly options: LocalRunStopCommandOptions;
  readonly request: Readonly<{
    projectId: string;
    runId: string;
    mutationId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
    occurredAtMs: number;
  }>;
}

export interface LocalRunStopCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'run.stop';
  readonly stop: Readonly<RunCancellationResult>;
}

export interface LocalRunStopCommandRunner {
  run(commandFilePath: string): Promise<Readonly<LocalRunStopCommandResult>>;
}

export interface LocalRunStopCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteRunManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly now: () => number;
  readonly randomUuid: () => string;
}

export class LocalRunStopCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_RUN_STOP_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `Local Run stop command configuration is invalid: ${message}`,
      options,
    );
    this.name = 'LocalRunStopCommandConfigurationError';
  }
}

export class LocalRunStopCommandAuthorizationError extends Error {
  readonly code = 'LOCAL_RUN_STOP_COMMAND_AUTHORIZATION_REJECTED';

  constructor() {
    super('Local Run stop command authorization was rejected');
    this.name = 'LocalRunStopCommandAuthorizationError';
  }
}

export class LocalRunStopCommandUnavailableError extends Error {
  readonly code = 'LOCAL_RUN_STOP_COMMAND_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Local Run stop command is unavailable', options);
    this.name = 'LocalRunStopCommandUnavailableError';
  }
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRunStopCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new LocalRunStopCommandConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new LocalRunStopCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function descendant(root: string, value: string, label: string): void {
  const relative = path.relative(root, value);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalRunStopCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new LocalRunStopCommandConfigurationError(`${label} is invalid`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new LocalRunStopCommandConfigurationError(`${label} is invalid`);
  }
  return value;
}

function options(value: unknown): Readonly<LocalRunStopCommandOptions> {
  exactRecord(
    value,
    [
      'deploymentRoot',
      'databasePath',
      'profile',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
    ],
    ['busyTimeoutMs'],
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
  for (const [target, label] of [
    [databasePath, 'databasePath'],
    [ownerPepperKeyringDirectory, 'ownerPepperKeyringDirectory'],
    [credentialFilePath, 'credentialFilePath'],
  ] as const) {
    descendant(deploymentRoot, target, label);
  }
  if (
    new Set([databasePath, ownerPepperKeyringDirectory, credentialFilePath])
      .size !== 3 ||
    (value.profile !== 'edge' && value.profile !== 'standalone') ||
    (value.busyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(value.busyTimeoutMs) ||
        (value.busyTimeoutMs as number) < 1 ||
        (value.busyTimeoutMs as number) > 60_000))
  ) {
    throw new LocalRunStopCommandConfigurationError('options are invalid');
  }
  return Object.freeze({
    deploymentRoot,
    databasePath,
    profile: value.profile,
    ownerPepperKeyringDirectory,
    credentialFilePath,
    ...(value.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: value.busyTimeoutMs as number }),
  });
}

function normalizeCommand(value: unknown): Readonly<LocalRunStopCommand> {
  exactRecord(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    [],
    'command',
  );
  if (value.schemaVersion !== 1 || value.operation !== 'run.stop') {
    throw new LocalRunStopCommandConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  exactRecord(
    value.request,
    [
      'projectId',
      'runId',
      'mutationId',
      'requestId',
      'auditEventId',
      'failureAuditEventId',
      'occurredAtMs',
    ],
    [],
    'request',
  );
  const mutationId = uuid(value.request.mutationId, 'mutationId');
  try {
    parseRunCancellationRequestBody({
      schema: RUN_CANCELLATION_SCHEMA,
      mutationId,
    });
  } catch (error) {
    throw new LocalRunStopCommandConfigurationError('stop request is invalid', {
      cause: error,
    });
  }
  const auditEventId = uuid(value.request.auditEventId, 'auditEventId');
  const failureAuditEventId = uuid(
    value.request.failureAuditEventId,
    'failureAuditEventId',
  );
  if (
    auditEventId === failureAuditEventId ||
    !Number.isSafeInteger(value.request.occurredAtMs) ||
    (value.request.occurredAtMs as number) < 0
  ) {
    throw new LocalRunStopCommandConfigurationError('request is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'run.stop',
    options: options(value.options),
    request: Object.freeze({
      projectId: identifier(value.request.projectId, 'projectId'),
      runId: identifier(value.request.runId, 'runId'),
      mutationId,
      requestId: identifier(value.request.requestId, 'requestId'),
      auditEventId,
      failureAuditEventId,
      occurredAtMs: value.request.occurredAtMs as number,
    }),
  });
}

function readCommandFile(
  commandFilePath: string,
): Readonly<LocalRunStopCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (error instanceof LocalRunStopCommandConfigurationError) throw error;
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalRunStopCommandConfigurationError(
        'private command file cannot be read',
        { cause: error },
      );
    }
    throw new LocalRunStopCommandConfigurationError('command file is invalid', {
      cause: error,
    });
  }
}

function dependencies(
  value: LocalRunStopCommandRunnerDependencies,
): LocalRunStopCommandRunnerDependencies {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'now', 'openDatabase', 'randomUuid'].sort().join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.now !== 'function' ||
    typeof value.randomUuid !== 'function'
  ) {
    throw new LocalRunStopCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

function failureReason(error: unknown): string {
  if (error instanceof RunCancellationNotFoundError) return 'run_not_found';
  if (
    error instanceof LocalRunStopCommandAuthorizationError ||
    error instanceof RunCancellationFenceRejectedError ||
    error instanceof LocalSqliteAuthenticatedManagementFenceError
  ) {
    return 'run_stop_fence_rejected';
  }
  return 'run_stop_unavailable';
}

function failureAudit(
  command: Readonly<LocalRunStopCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
): Readonly<SecurityAuditRecord> {
  const unauthenticated = authenticated === undefined;
  return normalizeSecurityAuditRecord({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId: 'run.stop',
    projectId: command.request.projectId,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome: unauthenticated ? 'authentication_rejected' : 'denied',
    reasons: [
      unauthenticated ? 'local_console_required' : failureReason(error),
    ],
    fence: null,
    occurredAtMs: command.request.occurredAtMs,
  });
}

export function createLocalRunStopCommandRunner(
  candidateDependencies: LocalRunStopCommandRunnerDependencies = {
    openDatabase: openLocalSqliteRunManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    now: Date.now,
    randomUuid: randomUUID,
  },
): Readonly<LocalRunStopCommandRunner> {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      const nowMs = adapters.now();
      if (
        !Number.isSafeInteger(nowMs) ||
        nowMs < command.request.occurredAtMs ||
        nowMs - command.request.occurredAtMs > 5 * 60_000
      ) {
        throw new LocalRunStopCommandConfigurationError(
          'request time is outside the accepted window',
        );
      }
      const database: LocalSqliteRunManagementDatabase =
        await adapters.openDatabase({
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
            authenticationNamespace: 'local_run_stop',
          });
          database.activateUserCredentialFence(
            authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
          );
          const decision = await new ProjectPolicyEngine(
            database.projectPolicy,
          ).authorize(
            authenticated.principal,
            command.request.projectId,
            'run.stop',
          );
          if (
            decision.effect !== 'allow' ||
            !decision.fence ||
            decision.fence.bindingVersion === null
          ) {
            throw new LocalRunStopCommandAuthorizationError();
          }
          await authenticated.confirm();
          const stop =
            await database.runCancellation.requestUserCancellationAudited({
              projectId: command.request.projectId,
              runId: command.request.runId,
              mutationId: command.request.mutationId,
              eventId: adapters.randomUuid(),
              requestId: command.request.requestId,
              auditEventId: command.request.auditEventId,
              principal: authenticated.principal,
              policyFence: decision.fence,
            });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: 'run.stop' as const,
            stop,
          });
        } catch (error) {
          try {
            await database.securityAudit.record(
              failureAudit(command, authenticated, error),
            );
          } catch (auditError) {
            throw new LocalRunStopCommandUnavailableError({
              cause: auditError,
            });
          }
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalRunStopCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalRunStopCommandResult>> {
  return createLocalRunStopCommandRunner().run(commandFilePath);
}

export function isLocalRunStopCommandError(error: unknown): boolean {
  return (
    error instanceof LocalRunStopCommandConfigurationError ||
    error instanceof LocalRunStopCommandAuthorizationError ||
    error instanceof LocalRunStopCommandUnavailableError ||
    error instanceof AuthenticatedLocalCommandAuthenticationError ||
    error instanceof LocalSqliteAuthenticatedManagementFenceError ||
    error instanceof RunCancellationNotFoundError ||
    error instanceof RunCancellationFenceRejectedError ||
    error instanceof RunCancellationUnavailableError
  );
}
