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
  RUN_MANUAL_RETRY_SCHEMA,
  RunManualRetryFenceRejectedError,
  RunManualRetryNotFoundError,
  RunManualRetryRateLimitedError,
  RunManualRetryUnavailableError,
  parseRunManualRetryRequestBody,
  type RunManualRetryResult,
  type RunManualRetrySourceStatus,
} from '@qinglong/runtime-core/run-manual-retry';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

const MAX_PATH_BYTES = 4_096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalRunRetryCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalRunRetryCommand {
  readonly schemaVersion: 1;
  readonly operation: 'run.retry';
  readonly options: LocalRunRetryCommandOptions;
  readonly request: Readonly<{
    projectId: string;
    sourceRunId: string;
    mutationId: string;
    expectedRunVersion: number;
    expectedRunStatus: RunManualRetrySourceStatus;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
    occurredAtMs: number;
  }>;
}

export interface LocalRunRetryCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'run.retry';
  readonly retry: Readonly<RunManualRetryResult>;
}

export interface LocalRunRetryCommandRunner {
  run(commandFilePath: string): Promise<Readonly<LocalRunRetryCommandResult>>;
}

export interface LocalRunRetryCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteRunManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly now: () => number;
  readonly randomUuid: () => string;
}

export class LocalRunRetryCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_RUN_RETRY_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `Local Run retry command configuration is invalid: ${message}`,
      options,
    );
    this.name = 'LocalRunRetryCommandConfigurationError';
  }
}

export class LocalRunRetryCommandAuthorizationError extends Error {
  readonly code = 'LOCAL_RUN_RETRY_COMMAND_AUTHORIZATION_REJECTED';

  constructor() {
    super('Local Run retry command authorization was rejected');
    this.name = 'LocalRunRetryCommandAuthorizationError';
  }
}

export class LocalRunRetryCommandUnavailableError extends Error {
  readonly code = 'LOCAL_RUN_RETRY_COMMAND_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Local Run retry command is unavailable', options);
    this.name = 'LocalRunRetryCommandUnavailableError';
  }
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRunRetryCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new LocalRunRetryCommandConfigurationError(
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
    throw new LocalRunRetryCommandConfigurationError(
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
    throw new LocalRunRetryCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new LocalRunRetryCommandConfigurationError(`${label} is invalid`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new LocalRunRetryCommandConfigurationError(`${label} is invalid`);
  }
  return value;
}

function options(value: unknown): Readonly<LocalRunRetryCommandOptions> {
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
    throw new LocalRunRetryCommandConfigurationError('options are invalid');
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

function normalizeCommand(value: unknown): Readonly<LocalRunRetryCommand> {
  exactRecord(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    [],
    'command',
  );
  if (value.schemaVersion !== 1 || value.operation !== 'run.retry') {
    throw new LocalRunRetryCommandConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  exactRecord(
    value.request,
    [
      'projectId',
      'sourceRunId',
      'mutationId',
      'expectedRunVersion',
      'expectedRunStatus',
      'requestId',
      'auditEventId',
      'failureAuditEventId',
      'occurredAtMs',
    ],
    [],
    'request',
  );
  let retry;
  try {
    retry = parseRunManualRetryRequestBody({
      schema: RUN_MANUAL_RETRY_SCHEMA,
      mutationId: value.request.mutationId,
      expectedRunVersion: value.request.expectedRunVersion,
      expectedRunStatus: value.request.expectedRunStatus,
    });
  } catch (error) {
    throw new LocalRunRetryCommandConfigurationError(
      'retry request is invalid',
      { cause: error },
    );
  }
  if (
    !Number.isSafeInteger(value.request.occurredAtMs) ||
    (value.request.occurredAtMs as number) < 0
  ) {
    throw new LocalRunRetryCommandConfigurationError(
      'request occurredAtMs is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'run.retry',
    options: options(value.options),
    request: Object.freeze({
      projectId: identifier(value.request.projectId, 'projectId'),
      sourceRunId: identifier(value.request.sourceRunId, 'sourceRunId'),
      mutationId: retry.mutationId,
      expectedRunVersion: retry.expectedRunVersion,
      expectedRunStatus: retry.expectedRunStatus,
      requestId: identifier(value.request.requestId, 'requestId'),
      auditEventId: uuid(value.request.auditEventId, 'auditEventId'),
      failureAuditEventId: uuid(
        value.request.failureAuditEventId,
        'failureAuditEventId',
      ),
      occurredAtMs: value.request.occurredAtMs as number,
    }),
  });
}

function readCommandFile(
  commandFilePath: string,
): Readonly<LocalRunRetryCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (error instanceof LocalRunRetryCommandConfigurationError) throw error;
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalRunRetryCommandConfigurationError(
        'private command file cannot be read',
        { cause: error },
      );
    }
    throw new LocalRunRetryCommandConfigurationError(
      'command file is invalid',
      { cause: error },
    );
  }
}

function dependencies(
  value: LocalRunRetryCommandRunnerDependencies,
): LocalRunRetryCommandRunnerDependencies {
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
    throw new LocalRunRetryCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

function failureReason(error: unknown): string {
  if (error instanceof RunManualRetryRateLimitedError) {
    return 'run_retry_rate_limited';
  }
  if (error instanceof RunManualRetryNotFoundError) return 'run_not_found';
  if (
    error instanceof LocalRunRetryCommandAuthorizationError ||
    error instanceof RunManualRetryFenceRejectedError ||
    error instanceof LocalSqliteAuthenticatedManagementFenceError
  ) {
    return 'run_retry_fence_rejected';
  }
  return 'run_retry_unavailable';
}

function failureAudit(
  command: Readonly<LocalRunRetryCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
): Readonly<SecurityAuditRecord> {
  const unauthenticated = authenticated === undefined;
  return normalizeSecurityAuditRecord({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId: 'run.retry',
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

export function createLocalRunRetryCommandRunner(
  candidateDependencies: LocalRunRetryCommandRunnerDependencies = {
    openDatabase: openLocalSqliteRunManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    now: Date.now,
    randomUuid: randomUUID,
  },
): Readonly<LocalRunRetryCommandRunner> {
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
        throw new LocalRunRetryCommandConfigurationError(
          'request time is outside the accepted window',
        );
      }
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
            authenticationNamespace: 'local_run_retry',
          });
          database.activateUserCredentialFence(
            authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
          );
          const decision = await new ProjectPolicyEngine(
            database.projectPolicy,
          ).authorize(
            authenticated.principal,
            command.request.projectId,
            'run.retry',
          );
          if (
            decision.effect !== 'allow' ||
            !decision.fence ||
            decision.fence.bindingVersion === null
          ) {
            throw new LocalRunRetryCommandAuthorizationError();
          }
          await authenticated.confirm();
          const result = await database.runManualRetry.retryRun({
            projectId: command.request.projectId,
            sourceRunId: command.request.sourceRunId,
            mutationId: command.request.mutationId,
            expectedRunVersion: command.request.expectedRunVersion,
            expectedRunStatus: command.request.expectedRunStatus,
            runId: adapters.randomUuid(),
            attemptId: adapters.randomUuid(),
            createdEventId: adapters.randomUuid(),
            queuedEventId: adapters.randomUuid(),
            auditEventId: command.request.auditEventId,
            requestId: command.request.requestId,
            principal: authenticated.principal,
            policyFence: decision.fence,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: 'run.retry' as const,
            retry: result,
          });
        } catch (error) {
          try {
            await database.securityAudit.record(
              failureAudit(command, authenticated, error),
            );
          } catch (auditError) {
            throw new LocalRunRetryCommandUnavailableError({
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

export function runLocalRunRetryCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalRunRetryCommandResult>> {
  return createLocalRunRetryCommandRunner().run(commandFilePath);
}

export function isLocalRunRetryCommandError(error: unknown): boolean {
  return (
    error instanceof LocalRunRetryCommandConfigurationError ||
    error instanceof LocalRunRetryCommandAuthorizationError ||
    error instanceof LocalRunRetryCommandUnavailableError ||
    error instanceof AuthenticatedLocalCommandAuthenticationError ||
    error instanceof LocalSqliteAuthenticatedManagementFenceError ||
    error instanceof RunManualRetryNotFoundError ||
    error instanceof RunManualRetryFenceRejectedError ||
    error instanceof RunManualRetryRateLimitedError ||
    error instanceof RunManualRetryUnavailableError
  );
}
