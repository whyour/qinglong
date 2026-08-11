// AI management owns Provider credential binding commands.
import path from 'node:path';

import {
  MODEL_PROVIDER_CREDENTIAL_INSPECTION_OPERATION_ID,
  ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
  ModelProviderCredentialAdministrationMutationConflictError,
  modelProviderCredentialAdministrationOperationId,
} from '@qinglong/ai/model-provider-credential-administration';
import {
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
  InvalidModelProviderCredentialTransitionError,
  ModelProviderCredentialCatalogUnavailableError,
  ModelProviderCredentialTransitionConflictError,
  createModelProviderCredentialTransitionCommand,
  type ModelProviderCredentialTransition,
} from '@qinglong/ai/model-provider-credential-catalog';
import { MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA } from '@qinglong/ai/provider-credential';
import {
  LocalModelProviderCredentialRepository,
  type LocalModelProviderCredentialAuthorizationInput,
} from '@qinglong/ai/local-model-provider-credential-storage';
import { assertLocalModelInvocationFeatureActive } from '@qinglong/ai/local-feature-activation';
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
  commitLocalSqliteSecurityAuditInTransaction,
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  confirmLocalSqliteProjectPolicyFence,
  openLocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteAuthenticatedUserCredentialFence,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/authenticated-management';
import { LocalSqliteProjectPolicyRepository } from '@qinglong/local-sqlite/project-policy';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const MAX_PATH_BYTES = 4_096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface LocalModelProviderCredentialCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: LocalSqliteProfile;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

interface BaseRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly failureAuditEventId: string;
}

export interface BindLocalModelProviderCredentialCommand {
  readonly schemaVersion: 1;
  readonly operation: 'model-credential.bind';
  readonly options: LocalModelProviderCredentialCommandOptions;
  readonly request: BaseRequest & {
    readonly mutationId: string;
    readonly expectedGeneration: number;
    readonly revision: string;
    readonly secretRef: string;
  };
}

export interface RevokeLocalModelProviderCredentialCommand {
  readonly schemaVersion: 1;
  readonly operation: 'model-credential.revoke';
  readonly options: LocalModelProviderCredentialCommandOptions;
  readonly request: BaseRequest & {
    readonly mutationId: string;
    readonly expectedGeneration: number;
  };
}

export interface InspectLocalModelProviderCredentialCommand {
  readonly schemaVersion: 1;
  readonly operation: 'model-credential.inspect';
  readonly options: LocalModelProviderCredentialCommandOptions;
  readonly request: BaseRequest & {
    readonly auditEventId: string;
  };
}

export type LocalModelProviderCredentialCommand =
  | BindLocalModelProviderCredentialCommand
  | RevokeLocalModelProviderCredentialCommand
  | InspectLocalModelProviderCredentialCommand;

export type LocalModelProviderCredentialCommandResult = Readonly<{
  schemaVersion: 1;
  operation: LocalModelProviderCredentialCommand['operation'];
  status?: 'created' | 'existing';
  projectId: string;
  provider: string;
  state: 'bound' | 'revoked' | 'absent';
  generation: number;
  bindingRevision: string | null;
  bindingDigest: string | null;
  transitionDigest: string | null;
  changedAtMs: number | null;
}>;

export class LocalModelProviderCredentialCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_MODEL_PROVIDER_CREDENTIAL_COMMAND_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local model provider credential command is invalid: ${message}`);
    this.name = 'LocalModelProviderCredentialCommandConfigurationError';
  }
}

export class LocalModelProviderCredentialAuthenticationError extends Error {
  readonly code = 'LOCAL_MODEL_PROVIDER_CREDENTIAL_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local model provider credential management requires a strong User');
    this.name = 'LocalModelProviderCredentialAuthenticationError';
  }
}

export class LocalModelProviderCredentialAuthorizationError extends Error {
  readonly code = 'LOCAL_MODEL_PROVIDER_CREDENTIAL_FORBIDDEN';

  constructor() {
    super('Local model provider credential management is forbidden');
    this.name = 'LocalModelProviderCredentialAuthorizationError';
  }
}

export class LocalModelProviderCredentialUnavailableError extends Error {
  readonly code = 'LOCAL_MODEL_PROVIDER_CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('Local model provider credential management is unavailable');
    this.name = 'LocalModelProviderCredentialUnavailableError';
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
    Object.keys(value).sort().join('\0') !==
      [...expectedKeys].sort().join('\0')
  ) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
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
    throw new LocalModelProviderCredentialCommandConfigurationError(
      `${label} is invalid`,
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
    throw new LocalModelProviderCredentialCommandConfigurationError(
      `${label} must be below deploymentRoot`,
    );
  }
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalModelProviderCredentialCommandOptions> {
  const optional =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs')
      ? ['busyTimeoutMs']
      : [];
  exactObject(
    value,
    [
      'credentialFilePath',
      'databasePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'profile',
      ...optional,
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
  for (const [candidate, label] of [
    [databasePath, 'databasePath'],
    [ownerPepperKeyringDirectory, 'ownerPepperKeyringDirectory'],
    [credentialFilePath, 'credentialFilePath'],
  ] as const) {
    descendant(deploymentRoot, candidate, label);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      'profile is invalid',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
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

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      `${label} is invalid`,
    );
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      `${label} must be a UUID v4`,
    );
  }
  return value;
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalModelProviderCredentialCommand> {
  exactObject(
    value,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    value.schemaVersion !== 1 ||
    (value.operation !== 'model-credential.bind' &&
      value.operation !== 'model-credential.revoke' &&
      value.operation !== 'model-credential.inspect')
  ) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      'operation is invalid',
    );
  }
  const operation = value.operation;
  const extra =
    operation === 'model-credential.bind'
      ? ['expectedGeneration', 'mutationId', 'revision', 'secretRef']
      : operation === 'model-credential.revoke'
        ? ['expectedGeneration', 'mutationId']
        : ['auditEventId'];
  exactObject(
    value.request,
    [
      'failureAuditEventId',
      'projectId',
      'provider',
      'requestId',
      ...extra,
    ],
    'request',
  );
  const request = value.request;
  const normalizedBase = {
    requestId: id(request.requestId, 'requestId'),
    projectId: id(request.projectId, 'projectId'),
    provider: id(request.provider, 'provider'),
    failureAuditEventId: uuid(
      request.failureAuditEventId,
      'failureAuditEventId',
    ),
  };
  if (operation === 'model-credential.inspect') {
    const auditEventId = uuid(request.auditEventId, 'auditEventId');
    if (auditEventId === normalizedBase.failureAuditEventId) {
      throw new LocalModelProviderCredentialCommandConfigurationError(
        'audit identities must be distinct',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation,
      options: normalizeOptions(value.options),
      request: Object.freeze({ ...normalizedBase, auditEventId }),
    });
  }
  const mutationId = uuid(request.mutationId, 'mutationId');
  if (mutationId === normalizedBase.failureAuditEventId) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      'audit identities must be distinct',
    );
  }
  if (
    !Number.isSafeInteger(request.expectedGeneration) ||
    (request.expectedGeneration as number) < 0 ||
    (request.expectedGeneration as number) > 2_147_483_646
  ) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      'expectedGeneration is invalid',
    );
  }
  const options = normalizeOptions(value.options);
  if (operation === 'model-credential.bind') {
    if (typeof request.secretRef !== 'string') {
      throw new LocalModelProviderCredentialCommandConfigurationError(
        'secretRef is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation,
      options,
      request: Object.freeze({
        ...normalizedBase,
        mutationId,
        expectedGeneration: request.expectedGeneration as number,
        revision: id(request.revision, 'revision'),
        secretRef: request.secretRef,
      }),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    operation,
    options,
    request: Object.freeze({
      ...normalizedBase,
      mutationId,
      expectedGeneration: request.expectedGeneration as number,
    }),
  });
}

function readCommandFile(
  candidatePath: string,
): Readonly<LocalModelProviderCredentialCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalModelProviderCredentialCommandConfigurationError) {
      throw error;
    }
    throw new LocalModelProviderCredentialCommandConfigurationError(
      'command file cannot be read',
      error instanceof PrivateLocalCommandFileError ? error : undefined,
    );
  }
}

function allowedAudit(
  command: Readonly<LocalModelProviderCredentialCommand>,
  principal: Readonly<SecurityPrincipal>,
  decision: Readonly<SecurityPolicyDecision>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  const eventId =
    command.operation === 'model-credential.inspect'
      ? command.request.auditEventId
      : command.request.mutationId;
  return Object.freeze({
    eventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'model-credential.inspect'
        ? MODEL_PROVIDER_CREDENTIAL_INSPECTION_OPERATION_ID
        : modelProviderCredentialAdministrationOperationId(
            command.operation === 'model-credential.bind' ? 'bind' : 'revoke',
          ),
    projectId: command.request.projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: decision.reasons,
    fence: decision.fence,
    occurredAtMs,
  });
}

function summary(
  command: Readonly<LocalModelProviderCredentialCommand>,
  transition: Readonly<ModelProviderCredentialTransition> | null,
  status?: 'created' | 'existing',
): LocalModelProviderCredentialCommandResult {
  return Object.freeze({
    schemaVersion: 1,
    operation: command.operation,
    ...(status === undefined ? {} : { status }),
    projectId: command.request.projectId,
    provider: command.request.provider,
    state:
      transition === null
        ? ('absent' as const)
        : transition.action === 'bind'
          ? ('bound' as const)
          : ('revoked' as const),
    generation: transition?.generation ?? 0,
    bindingRevision: transition?.activeBindingRevision ?? null,
    bindingDigest: transition?.activeBindingDigest ?? null,
    transitionDigest: transition?.transitionDigest ?? null,
    changedAtMs: transition?.changedAtMs ?? null,
  });
}

function now(value: () => number): number {
  const result = value();
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new LocalModelProviderCredentialUnavailableError();
  }
  return result;
}

async function authorize(
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
  command: Readonly<LocalModelProviderCredentialCommand>,
  nowMs: number,
): Promise<Readonly<SecurityPolicyDecision>> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(authenticated.principal, nowMs);
  } catch {
    throw new LocalModelProviderCredentialAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_USER_ASSURANCES.has(principal.assurance)
  ) {
    throw new LocalModelProviderCredentialAuthenticationError();
  }
  try {
    const decision = await new ProjectPolicyEngine(
      new LocalSqliteProjectPolicyRepository(database.authority),
    ).authorize(principal, command.request.projectId, 'secret.manage');
    if (
      decision.effect !== 'allow' ||
      !decision.fence ||
      decision.fence.bindingVersion === null
    ) {
      throw new LocalModelProviderCredentialAuthorizationError();
    }
    return decision;
  } catch (error) {
    if (error instanceof LocalModelProviderCredentialAuthorizationError) {
      throw error;
    }
    if (error instanceof ProjectPolicyUnavailableError) {
      throw new LocalModelProviderCredentialUnavailableError();
    }
    throw new LocalModelProviderCredentialUnavailableError();
  }
}

function confirmAuthorization(
  database: LocalSqliteAuthenticatedManagementDatabase,
  credentialFence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  input: LocalModelProviderCredentialAuthorizationInput,
): void {
  try {
    confirmLocalSqliteAuthenticatedUserCredentialFence(
      database.authority,
      credentialFence,
    );
    confirmLocalSqliteProjectPolicyFence(
      database.authority,
      input.kind === 'mutation'
        ? input.value.command.projectId
        : input.value.projectId,
      input.value.actor,
      input.value.fence,
    );
  } catch {
    throw new ModelProviderCredentialAdministrationAuthorizationFenceConflictError();
  }
  try {
    commitLocalSqliteSecurityAuditInTransaction(
      database.authority,
      input.value.audit,
      input.replay,
    );
  } catch {
    throw new ModelProviderCredentialAdministrationMutationConflictError();
  }
}

function failureAudit(
  command: Readonly<LocalModelProviderCredentialCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  let outcome: SecurityAuditRecord['outcome'];
  let reason: string;
  if (
    !authenticated ||
    error instanceof AuthenticatedLocalCommandAuthenticationError ||
    error instanceof LocalModelProviderCredentialAuthenticationError
  ) {
    outcome = 'authentication_rejected';
    reason = 'credential_rejected';
  } else if (
    error instanceof LocalModelProviderCredentialAuthorizationError ||
    error instanceof LocalSqliteAuthenticatedManagementFenceError ||
    error instanceof
      ModelProviderCredentialAdministrationAuthorizationFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (
    error instanceof LocalModelProviderCredentialCommandConfigurationError ||
    error instanceof InvalidModelProviderCredentialTransitionError ||
    error instanceof ModelProviderCredentialTransitionConflictError ||
    error instanceof ModelProviderCredentialAdministrationMutationConflictError
  ) {
    outcome = 'denied';
    reason = 'model_provider_credential_conflict';
  } else if (
    error instanceof ModelProviderCredentialCatalogUnavailableError ||
    error instanceof LocalModelProviderCredentialUnavailableError
  ) {
    outcome = 'authorization_unavailable';
    reason = 'model_provider_credential_unavailable';
  } else {
    return null;
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'model-credential.inspect'
        ? MODEL_PROVIDER_CREDENTIAL_INSPECTION_OPERATION_ID
        : modelProviderCredentialAdministrationOperationId(
            command.operation === 'model-credential.bind' ? 'bind' : 'revoke',
          ),
    projectId: command.request.projectId,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

export interface LocalModelProviderCredentialCommandRunner {
  run(commandFilePath: string): Promise<LocalModelProviderCredentialCommandResult>;
}

export interface LocalModelProviderCredentialCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteAuthenticatedManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly now: () => number;
}

export function createLocalModelProviderCredentialCommandRunner(
  dependencies: LocalModelProviderCredentialCommandRunnerDependencies = {
    openDatabase: openLocalSqliteAuthenticatedManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    now: Date.now,
  },
): Readonly<LocalModelProviderCredentialCommandRunner> {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies) ||
    Object.keys(dependencies).sort().join('\0') !==
      'authenticate\0now\0openDatabase' ||
    typeof dependencies.openDatabase !== 'function' ||
    typeof dependencies.authenticate !== 'function' ||
    typeof dependencies.now !== 'function'
  ) {
    throw new LocalModelProviderCredentialCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      const database = await dependencies.openDatabase({
        databasePath: command.options.databasePath,
        profile: command.options.profile,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      });
      let authenticated: Readonly<AuthenticatedLocalCommand> | undefined;
      try {
        assertLocalModelInvocationFeatureActive(database.authority.client);
        try {
          authenticated = await dependencies.authenticate(database, {
            deploymentRoot: command.options.deploymentRoot,
            databasePath: command.options.databasePath,
            ownerPepperKeyringDirectory:
              command.options.ownerPepperKeyringDirectory,
            credentialFilePath: command.options.credentialFilePath,
            authenticationNamespace: 'local_model_provider_credential',
          });
          await authenticated.confirm();
          const credentialFence =
            authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>;
          database.confirmUserCredentialFence(credentialFence);
          const observedAtMs = now(dependencies.now);
          const decision = await authorize(
            database,
            authenticated,
            command,
            observedAtMs,
          );
          const audit = allowedAudit(
            command,
            authenticated.principal,
            decision,
            observedAtMs,
          );
          const repository = new LocalModelProviderCredentialRepository(
            database.authority,
            {
              now: dependencies.now,
              authorization: Object.freeze({
                confirm(input: LocalModelProviderCredentialAuthorizationInput) {
                  confirmAuthorization(database, credentialFence, input);
                },
              }),
            },
          );
          if (command.operation === 'model-credential.inspect') {
            const transition = await repository.inspectAuthorized({
              projectId: command.request.projectId,
              provider: command.request.provider,
              actor: authenticated.principal.subject,
              fence: decision.fence!,
              audit,
            });
            return summary(command, transition);
          }
          const action =
            command.operation === 'model-credential.bind'
              ? ('bind' as const)
              : ('revoke' as const);
          const transitionCommand = createModelProviderCredentialTransitionCommand({
            schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
            mutationId: command.request.mutationId,
            projectId: command.request.projectId,
            provider: command.request.provider,
            expectedGeneration: command.request.expectedGeneration,
            action,
            binding:
              command.operation === 'model-credential.bind'
                ? Object.freeze({
                    schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
                    projectId: command.request.projectId,
                    provider: command.request.provider,
                    revision: command.request.revision,
                    secretRef: command.request.secretRef,
                    scheme: 'bearer' as const,
                  })
                : null,
            changedBy: authenticated.principal.subject,
          });
          const result = await repository.commitAuthorized({
            command: transitionCommand,
            actor: authenticated.principal.subject,
            fence: decision.fence!,
            audit,
          });
          return summary(command, result.transition, result.status);
        } catch (error) {
          const audit = failureAudit(
            command,
            authenticated,
            error,
            now(dependencies.now),
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

export function runLocalModelProviderCredentialCommandFile(
  commandFilePath: string,
): Promise<LocalModelProviderCredentialCommandResult> {
  return createLocalModelProviderCredentialCommandRunner().run(commandFilePath);
}
