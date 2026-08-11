// Automation management owns TaskDefinition authoring and inspection commands.
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
  LocalTaskDefinitionAdministrationAuthenticationError,
  LocalTaskDefinitionAdministrationAuthorizationError,
  LocalTaskDefinitionAdministrationConfigurationError,
  LocalTaskDefinitionAdministrationUnavailableError,
  createLocalTaskDefinitionAdministrationService,
} from '@qinglong/local-admin/task-definition-administration';
import {
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '@qinglong/local-sqlite/authenticated-management';
import {
  openLocalSqliteTaskDefinitionAdministrationDatabase,
  type LocalSqliteTaskDefinitionAdministrationDatabase,
} from '@qinglong/local-sqlite/task-definition-administration';
import {
  InvalidTaskDefinitionError,
  TaskDefinitionConflictError,
  TaskDefinitionUnavailableError,
  assertTaskDefinitionIdentifier,
  assertTaskDefinitionPageSize,
  normalizeAppendTaskDefinitionRevisionCommand,
  normalizeTaskDefinitionCursor,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  TaskDefinitionAdministrationAuthorizationFenceConflictError,
  TaskDefinitionAdministrationMutationConflictError,
} from '@qinglong/runtime-core/task-definition-administration';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const MAX_PATH_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalTaskDefinitionCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

interface BaseTaskDefinitionCommandRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly failureAuditEventId: string;
}

export interface PutLocalTaskDefinitionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'task.put';
  readonly options: LocalTaskDefinitionCommandOptions;
  readonly request: BaseTaskDefinitionCommandRequest &
    Omit<AppendTaskDefinitionRevisionCommand, 'projectId'>;
}

export interface InspectLocalTaskDefinitionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'task.inspect';
  readonly options: LocalTaskDefinitionCommandOptions;
  readonly request: BaseTaskDefinitionCommandRequest & {
    readonly taskId: string;
    readonly auditEventId: string;
  };
}

export interface ListLocalTaskDefinitionsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'task.list';
  readonly options: LocalTaskDefinitionCommandOptions;
  readonly request: BaseTaskDefinitionCommandRequest & {
    readonly limit: number;
    readonly after?: Readonly<{ readonly taskId: string }>;
    readonly auditEventId: string;
  };
}

export type LocalTaskDefinitionCommand =
  | PutLocalTaskDefinitionCommand
  | InspectLocalTaskDefinitionCommand
  | ListLocalTaskDefinitionsCommand;

export type LocalTaskDefinitionSummary = Readonly<{
  projectId: string;
  taskId: string;
  revision: number;
  name: string;
  kind: TaskDefinitionRecord['kind'];
  schema: string;
  enabled: boolean;
  contentDigest: string;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type LocalTaskDefinitionCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.put';
      status: 'created' | 'updated' | 'existing';
      task: LocalTaskDefinitionSummary;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.inspect';
      found: false;
      projectId: string;
      taskId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.inspect';
      found: true;
      task: LocalTaskDefinitionSummary;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.list';
      projectId: string;
      tasks: readonly LocalTaskDefinitionSummary[];
      nextCursor: Readonly<{ readonly taskId: string }> | null;
    }>;

export interface LocalTaskDefinitionCommandRunner {
  run(commandFilePath: string): Promise<LocalTaskDefinitionCommandResult>;
}

export interface LocalTaskDefinitionCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteTaskDefinitionAdministrationDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createService: typeof createLocalTaskDefinitionAdministrationService;
  readonly now: () => number;
}

export class LocalTaskDefinitionCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_TASK_DEFINITION_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local TaskDefinition command configuration is invalid: ${message}`);
    this.name = 'LocalTaskDefinitionCommandConfigurationError';
  }
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalTaskDefinitionCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new LocalTaskDefinitionCommandConfigurationError(
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
    throw new LocalTaskDefinitionCommandConfigurationError(
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
    throw new LocalTaskDefinitionCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalTaskDefinitionCommandOptions> {
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
    throw new LocalTaskDefinitionCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalTaskDefinitionCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze(value as unknown as LocalTaskDefinitionCommandOptions);
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
    throw new LocalTaskDefinitionCommandConfigurationError(
      'request identity is invalid',
    );
  }
}

function normalizePutRequest(
  value: unknown,
): Readonly<PutLocalTaskDefinitionCommand['request']> {
  exactObject(
    value,
    [
      'enabled',
      'expectedRevision',
      'failureAuditEventId',
      'kind',
      'labels',
      'mutationId',
      'name',
      'occurredAtMs',
      'projectId',
      'requestId',
      'spec',
      'taskId',
    ],
    ['description'],
    'request',
  );
  requestIdentity(value, ['failureAuditEventId', 'mutationId']);
  try {
    const { failureAuditEventId: _failure, requestId: _request, ...command } =
      value;
    normalizeAppendTaskDefinitionRevisionCommand(
      command as unknown as AppendTaskDefinitionRevisionCommand,
    );
  } catch (error) {
    throw new LocalTaskDefinitionCommandConfigurationError(
      'TaskDefinition request is invalid',
      error,
    );
  }
  return Object.freeze(value as unknown as PutLocalTaskDefinitionCommand['request']);
}

function normalizeInspectRequest(
  value: unknown,
): Readonly<InspectLocalTaskDefinitionCommand['request']> {
  exactObject(
    value,
    [
      'auditEventId',
      'failureAuditEventId',
      'projectId',
      'requestId',
      'taskId',
    ],
    [],
    'request',
  );
  requestIdentity(value, ['auditEventId', 'failureAuditEventId']);
  try {
    assertTaskDefinitionIdentifier(value.projectId, 'projectId');
    assertTaskDefinitionIdentifier(value.taskId, 'taskId');
  } catch (error) {
    throw new LocalTaskDefinitionCommandConfigurationError(
      'TaskDefinition identity is invalid',
      error,
    );
  }
  return Object.freeze(
    value as unknown as InspectLocalTaskDefinitionCommand['request'],
  );
}

function normalizeListRequest(
  value: unknown,
): Readonly<ListLocalTaskDefinitionsCommand['request']> {
  exactObject(
    value,
    [
      'auditEventId',
      'failureAuditEventId',
      'limit',
      'projectId',
      'requestId',
    ],
    ['after'],
    'request',
  );
  requestIdentity(value, ['auditEventId', 'failureAuditEventId']);
  try {
    assertTaskDefinitionIdentifier(value.projectId, 'projectId');
    assertTaskDefinitionPageSize(value.limit as number);
    const after =
      value.after === undefined
        ? undefined
        : normalizeTaskDefinitionCursor(
            value.after as Readonly<{ readonly taskId: string }>,
          );
    return Object.freeze({
      ...(value as unknown as ListLocalTaskDefinitionsCommand['request']),
      ...(after ? { after } : {}),
    });
  } catch (error) {
    throw new LocalTaskDefinitionCommandConfigurationError(
      'TaskDefinition list request is invalid',
      error,
    );
  }
}

function normalizeCommand(value: unknown): Readonly<LocalTaskDefinitionCommand> {
  exactObject(
    value,
    ['operation', 'options', 'request', 'schemaVersion'],
    [],
    'command',
  );
  if (
    value.schemaVersion !== 1 ||
    !['task.inspect', 'task.list', 'task.put'].includes(
      value.operation as string,
    )
  ) {
    throw new LocalTaskDefinitionCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  const options = normalizeOptions(value.options);
  if (value.operation === 'task.put') {
    return Object.freeze({
      schemaVersion: 1,
      operation: 'task.put',
      options,
      request: normalizePutRequest(value.request),
    });
  }
  if (value.operation === 'task.inspect') {
    return Object.freeze({
      schemaVersion: 1,
      operation: 'task.inspect',
      options,
      request: normalizeInspectRequest(value.request),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'task.list',
    options,
    request: normalizeListRequest(value.request),
  });
}

function readCommandFile(candidatePath: string): Readonly<LocalTaskDefinitionCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalTaskDefinitionCommandConfigurationError) {
      throw error;
    }
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalTaskDefinitionCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw new LocalTaskDefinitionCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function summary(value: Readonly<TaskDefinitionRecord>): LocalTaskDefinitionSummary {
  return Object.freeze({
    projectId: value.projectId,
    taskId: value.taskId,
    revision: value.revision,
    name: value.name,
    kind: value.kind,
    schema: value.spec.schema,
    enabled: value.enabled,
    contentDigest: value.contentDigest,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

function failureAudit(
  command: Readonly<LocalTaskDefinitionCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  if (
    error instanceof LocalTaskDefinitionAdministrationAuthenticationError ||
    error instanceof LocalTaskDefinitionAdministrationAuthorizationError ||
    error instanceof LocalTaskDefinitionAdministrationUnavailableError
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
    error instanceof
      TaskDefinitionAdministrationAuthorizationFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (
    error instanceof TaskDefinitionConflictError ||
    error instanceof TaskDefinitionAdministrationMutationConflictError
  ) {
    outcome = 'denied';
    reason = 'task_definition_conflict';
  } else if (
    error instanceof InvalidTaskDefinitionError ||
    error instanceof LocalTaskDefinitionAdministrationConfigurationError ||
    error instanceof LocalTaskDefinitionCommandConfigurationError
  ) {
    outcome = 'denied';
    reason = 'task_definition_rejected';
  } else if (error instanceof TaskDefinitionUnavailableError) {
    return null;
  } else {
    return null;
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'task.put'
        ? command.request.expectedRevision === null
          ? 'task.create'
          : 'task.update'
        : 'task.read',
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
  value: LocalTaskDefinitionCommandRunnerDependencies,
): Readonly<LocalTaskDefinitionCommandRunnerDependencies> {
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
    throw new LocalTaskDefinitionCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

async function activateFence(
  database: LocalSqliteTaskDefinitionAdministrationDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.activateUserCredentialFence(
    authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  );
}

export function createLocalTaskDefinitionCommandRunner(
  candidateDependencies: LocalTaskDefinitionCommandRunnerDependencies = {
    openDatabase: openLocalSqliteTaskDefinitionAdministrationDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createService: createLocalTaskDefinitionAdministrationService,
    now: Date.now,
  },
): LocalTaskDefinitionCommandRunner {
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
            authenticationNamespace: 'local_task_definition',
          });
          await activateFence(database, authenticated);
          const service = adapters.createService(
            database.projectPolicy,
            database.taskDefinitionAdministration,
            database.taskDefinitions,
            database.securityAudit,
            { now: adapters.now },
          );
          if (command.operation === 'task.put') {
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
              task: summary(result.definition),
            });
          }
          if (command.operation === 'task.inspect') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const definition = await service.inspect({
              ...request,
              principal: authenticated.principal,
            });
            return definition
              ? Object.freeze({
                  schemaVersion: 1 as const,
                  operation: command.operation,
                  found: true as const,
                  task: summary(definition),
                })
              : Object.freeze({
                  schemaVersion: 1 as const,
                  operation: command.operation,
                  found: false as const,
                  projectId: command.request.projectId,
                  taskId: command.request.taskId,
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
            tasks: Object.freeze(page.definitions.map(summary)),
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

export function runLocalTaskDefinitionCommandFile(
  commandFilePath: string,
): Promise<LocalTaskDefinitionCommandResult> {
  return createLocalTaskDefinitionCommandRunner().run(commandFilePath);
}
