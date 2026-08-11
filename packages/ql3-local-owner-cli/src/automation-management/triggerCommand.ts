// Automation management owns Trigger authoring and inspection commands.
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
  LocalTriggerAdministrationAuthenticationError,
  LocalTriggerAdministrationAuthorizationError,
  LocalTriggerAdministrationConfigurationError,
  LocalTriggerAdministrationUnavailableError,
  createLocalTriggerAdministrationService,
} from '@qinglong/local-admin/trigger-administration';
import {
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '@qinglong/local-sqlite/authenticated-management';
import {
  openLocalSqliteTriggerAdministrationDatabase,
  type LocalSqliteTriggerAdministrationDatabase,
} from '@qinglong/local-sqlite/trigger-administration';
import {
  InvalidTriggerError,
  InvalidTriggerSpecSemanticError,
  TriggerConflictError,
  TriggerUnavailableError,
  UnsupportedTriggerSpecError,
  assertTriggerIdentifier,
  assertTriggerPageSize,
  normalizeAppendTriggerRevisionCommand,
  normalizeTriggerCursor,
  type AppendTriggerRevisionCommand,
  type TriggerRecord,
} from '@qinglong/runtime-core/trigger';
import {
  TriggerAdministrationAuthorizationFenceConflictError,
  TriggerAdministrationMutationConflictError,
} from '@qinglong/runtime-core/trigger-administration';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const MAX_PATH_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalTriggerCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

interface BaseTriggerCommandRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly failureAuditEventId: string;
}

export interface PutLocalTriggerCommand {
  readonly schemaVersion: 1;
  readonly operation: 'trigger.put';
  readonly options: LocalTriggerCommandOptions;
  readonly request: BaseTriggerCommandRequest &
    Omit<AppendTriggerRevisionCommand, 'projectId'>;
}

export interface InspectLocalTriggerCommand {
  readonly schemaVersion: 1;
  readonly operation: 'trigger.inspect';
  readonly options: LocalTriggerCommandOptions;
  readonly request: BaseTriggerCommandRequest & {
    readonly triggerId: string;
    readonly auditEventId: string;
  };
}

export interface ListLocalTriggersCommand {
  readonly schemaVersion: 1;
  readonly operation: 'trigger.list';
  readonly options: LocalTriggerCommandOptions;
  readonly request: BaseTriggerCommandRequest & {
    readonly limit: number;
    readonly after?: Readonly<{ readonly triggerId: string }>;
    readonly auditEventId: string;
  };
}

export type LocalTriggerCommand =
  | PutLocalTriggerCommand
  | InspectLocalTriggerCommand
  | ListLocalTriggersCommand;

export type LocalTriggerSummary = Readonly<{
  projectId: string;
  triggerId: string;
  revision: number;
  taskId: string;
  taskRevision: number;
  taskContentDigest: string;
  schema: string;
  enabled: boolean;
  contentDigest: string;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type LocalTriggerCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.put';
      status: 'created' | 'updated' | 'existing';
      trigger: LocalTriggerSummary;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.inspect';
      found: false;
      projectId: string;
      triggerId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.inspect';
      found: true;
      trigger: LocalTriggerSummary;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.list';
      projectId: string;
      triggers: readonly LocalTriggerSummary[];
      nextCursor: Readonly<{ readonly triggerId: string }> | null;
    }>;

export interface LocalTriggerCommandRunner {
  run(commandFilePath: string): Promise<LocalTriggerCommandResult>;
}

export interface LocalTriggerCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteTriggerAdministrationDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createService: typeof createLocalTriggerAdministrationService;
  readonly now: () => number;
}

export class LocalTriggerCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_TRIGGER_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Trigger command configuration is invalid: ${message}`);
    this.name = 'LocalTriggerCommandConfigurationError';
  }
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalTriggerCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new LocalTriggerCommandConfigurationError(
      `${label} shape is invalid`,
    );
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
    throw new LocalTriggerCommandConfigurationError(
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
    throw new LocalTriggerCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalTriggerCommandOptions> {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  exactObject(
    value,
    [
      'credentialFilePath',
      'databasePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'profile',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    [],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  for (const key of [
    'databasePath',
    'ownerPepperKeyringDirectory',
    'credentialFilePath',
  ] as const) {
    const candidate = boundedPath(value[key], key);
    descendant(deploymentRoot, candidate, key);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalTriggerCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalTriggerCommandConfigurationError('busyTimeoutMs is invalid');
  }
  return Object.freeze(value as unknown as LocalTriggerCommandOptions);
}

function requestIdentity(
  value: Record<string, unknown>,
  eventKeys: readonly string[],
): void {
  if (
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    eventKeys.some(
      (key) =>
        typeof value[key] !== 'string' ||
        !UUID_V4_PATTERN.test(value[key] as string),
    ) ||
    new Set(eventKeys.map((key) => value[key])).size !== eventKeys.length
  ) {
    throw new LocalTriggerCommandConfigurationError(
      'request identity is invalid',
    );
  }
}

function normalizePutRequest(
  value: unknown,
): Readonly<PutLocalTriggerCommand['request']> {
  exactObject(
    value,
    [
      'enabled',
      'expectedRevision',
      'failureAuditEventId',
      'mutationId',
      'occurredAtMs',
      'projectId',
      'requestId',
      'spec',
      'taskContentDigest',
      'taskId',
      'taskRevision',
      'triggerId',
    ],
    [],
    'request',
  );
  requestIdentity(value, ['failureAuditEventId', 'mutationId']);
  try {
    const {
      failureAuditEventId: _failure,
      requestId: _request,
      ...command
    } = value;
    normalizeAppendTriggerRevisionCommand(
      command as unknown as AppendTriggerRevisionCommand,
    );
  } catch (error) {
    throw new LocalTriggerCommandConfigurationError(
      'Trigger request is invalid',
      error,
    );
  }
  return Object.freeze(value as unknown as PutLocalTriggerCommand['request']);
}

function normalizeInspectRequest(
  value: unknown,
): Readonly<InspectLocalTriggerCommand['request']> {
  exactObject(
    value,
    [
      'auditEventId',
      'failureAuditEventId',
      'projectId',
      'requestId',
      'triggerId',
    ],
    [],
    'request',
  );
  requestIdentity(value, ['auditEventId', 'failureAuditEventId']);
  try {
    assertTriggerIdentifier(value.projectId, 'projectId');
    assertTriggerIdentifier(value.triggerId, 'triggerId');
  } catch (error) {
    throw new LocalTriggerCommandConfigurationError(
      'Trigger identity is invalid',
      error,
    );
  }
  return Object.freeze(
    value as unknown as InspectLocalTriggerCommand['request'],
  );
}

function normalizeListRequest(
  value: unknown,
): Readonly<ListLocalTriggersCommand['request']> {
  exactObject(
    value,
    ['auditEventId', 'failureAuditEventId', 'limit', 'projectId', 'requestId'],
    ['after'],
    'request',
  );
  requestIdentity(value, ['auditEventId', 'failureAuditEventId']);
  try {
    assertTriggerIdentifier(value.projectId, 'projectId');
    assertTriggerPageSize(value.limit as number);
    const after =
      value.after === undefined
        ? undefined
        : normalizeTriggerCursor(
            value.after as Readonly<{ readonly triggerId: string }>,
          );
    return Object.freeze({
      ...(value as unknown as ListLocalTriggersCommand['request']),
      ...(after ? { after } : {}),
    });
  } catch (error) {
    throw new LocalTriggerCommandConfigurationError(
      'Trigger list request is invalid',
      error,
    );
  }
}

function normalizeCommand(value: unknown): Readonly<LocalTriggerCommand> {
  exactObject(
    value,
    ['operation', 'options', 'request', 'schemaVersion'],
    [],
    'command',
  );
  if (
    value.schemaVersion !== 1 ||
    !['trigger.inspect', 'trigger.list', 'trigger.put'].includes(
      value.operation as string,
    )
  ) {
    throw new LocalTriggerCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  const options = normalizeOptions(value.options);
  if (value.operation === 'trigger.put') {
    return Object.freeze({
      schemaVersion: 1,
      operation: 'trigger.put',
      options,
      request: normalizePutRequest(value.request),
    });
  }
  if (value.operation === 'trigger.inspect') {
    return Object.freeze({
      schemaVersion: 1,
      operation: 'trigger.inspect',
      options,
      request: normalizeInspectRequest(value.request),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'trigger.list',
    options,
    request: normalizeListRequest(value.request),
  });
}

function readCommandFile(candidatePath: string): Readonly<LocalTriggerCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalTriggerCommandConfigurationError) throw error;
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalTriggerCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw new LocalTriggerCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function summary(value: Readonly<TriggerRecord>): LocalTriggerSummary {
  return Object.freeze({
    projectId: value.projectId,
    triggerId: value.triggerId,
    revision: value.revision,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    taskContentDigest: value.taskContentDigest,
    schema: value.spec.schema,
    enabled: value.enabled,
    contentDigest: value.contentDigest,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

function failureAudit(
  command: Readonly<LocalTriggerCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  if (
    error instanceof LocalTriggerAdministrationAuthenticationError ||
    error instanceof LocalTriggerAdministrationAuthorizationError ||
    error instanceof LocalTriggerAdministrationUnavailableError
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
    error instanceof TriggerAdministrationAuthorizationFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (
    error instanceof TriggerConflictError ||
    error instanceof TriggerAdministrationMutationConflictError
  ) {
    outcome = 'denied';
    reason = 'trigger_conflict';
  } else if (
    error instanceof InvalidTriggerError ||
    error instanceof InvalidTriggerSpecSemanticError ||
    error instanceof UnsupportedTriggerSpecError ||
    error instanceof LocalTriggerAdministrationConfigurationError ||
    error instanceof LocalTriggerCommandConfigurationError
  ) {
    outcome = 'denied';
    reason = 'trigger_rejected';
  } else if (error instanceof TriggerUnavailableError) {
    return null;
  } else {
    return null;
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'trigger.put'
        ? command.request.expectedRevision === null
          ? 'trigger.create'
          : 'trigger.update'
        : 'trigger.read',
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
  value: LocalTriggerCommandRunnerDependencies,
): Readonly<LocalTriggerCommandRunnerDependencies> {
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
    throw new LocalTriggerCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

async function activateFence(
  database: LocalSqliteTriggerAdministrationDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.activateUserCredentialFence(
    authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  );
}

export function createLocalTriggerCommandRunner(
  candidateDependencies: LocalTriggerCommandRunnerDependencies = {
    openDatabase: openLocalSqliteTriggerAdministrationDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createService: createLocalTriggerAdministrationService,
    now: Date.now,
  },
): LocalTriggerCommandRunner {
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
            authenticationNamespace: 'local_trigger',
          });
          await activateFence(database, authenticated);
          const service = adapters.createService(
            database.projectPolicy,
            database.triggerAdministration,
            database.triggers,
            database.securityAudit,
            { now: adapters.now },
          );
          if (command.operation === 'trigger.put') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const result = await service.put({
              ...request,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              status: result.status,
              trigger: summary(result.trigger),
            });
          }
          if (command.operation === 'trigger.inspect') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const trigger = await service.inspect({
              ...request,
              principal: authenticated.principal,
            });
            return trigger
              ? Object.freeze({
                  schemaVersion: 1 as const,
                  operation: command.operation,
                  found: true as const,
                  trigger: summary(trigger),
                })
              : Object.freeze({
                  schemaVersion: 1 as const,
                  operation: command.operation,
                  found: false as const,
                  projectId: command.request.projectId,
                  triggerId: command.request.triggerId,
                });
          }
          const { failureAuditEventId: _failure, ...request } = command.request;
          const page = await service.list({
            ...request,
            principal: authenticated.principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            projectId: command.request.projectId,
            triggers: Object.freeze(page.triggers.map(summary)),
            nextCursor: page.next ?? null,
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

export function runLocalTriggerCommandFile(
  commandFilePath: string,
): Promise<LocalTriggerCommandResult> {
  return createLocalTriggerCommandRunner().run(commandFilePath);
}
