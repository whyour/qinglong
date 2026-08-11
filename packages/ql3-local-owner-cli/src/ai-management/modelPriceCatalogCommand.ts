// AI management owns replay-safe model price catalog commands.
import path from 'node:path';

import { assertLocalModelInvocationFeatureActive } from '@qinglong/ai/local-feature-activation';
import {
  LocalModelPriceCatalogRepository,
  type LocalModelPriceCatalogRepositoryOptions,
} from '@qinglong/ai/local-price-catalog-storage';
import {
  createModelPriceCatalogPolicyDecision,
  type ModelPriceCatalogManagementOperation,
} from '@qinglong/ai/price-catalog-management';
import {
  bootstrapModelPriceCatalogManagementProfile,
  type ActiveModelPriceCatalogManagementCapability,
} from '@qinglong/ai/profile';
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
  openLocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/authenticated-management';

const MAX_PATH_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CATALOG_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MODEL_PRICE_RATE_MICROS = 1_000_000_000_000;
const MAX_MODEL_PRICE_CATALOG_GENERATION = 2_147_483_647;
const LOCAL_MODEL_PRICE_POLICY_REVISION = 'local_console_platform_owner_v1';
type SecurityAuditRecord = Parameters<
  LocalSqliteAuthenticatedManagementDatabase['securityAudit']['record']
>[0];
type SecurityAuditOutcome = SecurityAuditRecord['outcome'];

export interface LocalModelPriceCatalogCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: LocalSqliteProfile;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

interface BaseLocalModelPriceCatalogRequest {
  readonly requestId: string;
  readonly failureAuditEventId: string;
  readonly provider: string;
  readonly model: string;
}

interface BaseLocalModelPriceCatalogMutationRequest
  extends BaseLocalModelPriceCatalogRequest {
  readonly authorizationId: string;
  readonly mutationId: string;
}

export interface PublishLocalModelPriceCatalogCommand {
  readonly schemaVersion: 1;
  readonly operation: 'model-price.publish';
  readonly options: LocalModelPriceCatalogCommandOptions;
  readonly request: BaseLocalModelPriceCatalogMutationRequest & {
    readonly priceRevision: string;
    readonly currency: 'USD';
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
  };
}

export interface TransitionLocalModelPriceCatalogCommand {
  readonly schemaVersion: 1;
  readonly operation:
    | 'model-price.activate'
    | 'model-price.deactivate'
    | 'model-price.revoke';
  readonly options: LocalModelPriceCatalogCommandOptions;
  readonly request: BaseLocalModelPriceCatalogMutationRequest & {
    readonly expectedGeneration: number;
    readonly expectedHeadDigest: string | null;
    readonly priceRevision: string | null;
  };
}

export interface InspectLocalModelPriceCatalogCommand {
  readonly schemaVersion: 1;
  readonly operation: 'model-price.inspect';
  readonly options: LocalModelPriceCatalogCommandOptions;
  readonly request: BaseLocalModelPriceCatalogRequest & {
    readonly priceRevision: string | null;
  };
}

export type LocalModelPriceCatalogCommand =
  | PublishLocalModelPriceCatalogCommand
  | TransitionLocalModelPriceCatalogCommand
  | InspectLocalModelPriceCatalogCommand;

export type LocalModelPriceCatalogCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'model-price.publish';
      status: 'created' | 'existing';
      publication: ReturnType<typeof publicationSummary>;
      authorization: ReturnType<typeof authorizationSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation:
        | 'model-price.activate'
        | 'model-price.deactivate'
        | 'model-price.revoke';
      status: 'created' | 'existing';
      head: ReturnType<typeof headSummary>;
      authorization: ReturnType<typeof authorizationSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'model-price.inspect';
      head: ReturnType<typeof headSummary> | null;
      publication: ReturnType<typeof publicationSummary> | null;
    }>;

export interface LocalModelPriceCatalogCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<Readonly<LocalModelPriceCatalogCommandResult>>;
}

export class LocalModelPriceCatalogCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_MODEL_PRICE_CATALOG_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Model Price Catalog command is invalid: ${message}`);
    this.name = 'LocalModelPriceCatalogCommandConfigurationError';
  }
}

interface LocalModelPriceCatalogCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteAuthenticatedManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly now: () => number;
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalModelPriceCatalogCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalModelPriceCatalogCommandConfigurationError(
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
    throw new LocalModelPriceCatalogCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function options(value: unknown): LocalModelPriceCatalogCommandOptions {
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
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  for (const key of [
    'deploymentRoot',
    'databasePath',
    'ownerPepperKeyringDirectory',
    'credentialFilePath',
  ] as const) {
    boundedPath(value[key], key);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalModelPriceCatalogCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalModelPriceCatalogCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze(
    value as unknown as LocalModelPriceCatalogCommandOptions,
  );
}

function baseRequest(
  value: unknown,
  extraKeys: readonly string[],
  mutation: boolean,
): asserts value is Record<string, unknown> {
  exactObject(
    value,
    [
      'requestId',
      'failureAuditEventId',
      'provider',
      'model',
      ...(mutation ? ['authorizationId', 'mutationId'] : []),
      ...extraKeys,
    ],
    'request',
  );
  if (
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.failureAuditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.failureAuditEventId)
  ) {
    throw new LocalModelPriceCatalogCommandConfigurationError(
      'request audit identity is invalid',
    );
  }
  for (const key of [
    'provider',
    'model',
    ...(mutation ? ['authorizationId', 'mutationId'] : []),
  ]) {
    if (
      typeof value[key] !== 'string' ||
      !CATALOG_IDENTITY_PATTERN.test(value[key] as string)
    ) {
      throw new LocalModelPriceCatalogCommandConfigurationError(
        `${key} is invalid`,
      );
    }
  }
}

function priceRevision(value: unknown, nullable: boolean): void {
  if (
    (nullable && value === null) ||
    (typeof value === 'string' && CATALOG_IDENTITY_PATTERN.test(value))
  ) {
    return;
  }
  throw new LocalModelPriceCatalogCommandConfigurationError(
    'priceRevision is invalid',
  );
}

function priceRate(value: unknown, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_MODEL_PRICE_RATE_MICROS
  ) {
    throw new LocalModelPriceCatalogCommandConfigurationError(
      `${label} is invalid`,
    );
  }
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalModelPriceCatalogCommand> {
  exactObject(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    'command',
  );
  if (value.schemaVersion !== 1) {
    throw new LocalModelPriceCatalogCommandConfigurationError(
      'schemaVersion is invalid',
    );
  }
  const commandOptions = options(value.options);
  switch (value.operation) {
    case 'model-price.publish':
      baseRequest(
        value.request,
        [
          'priceRevision',
          'currency',
          'inputMicrosPerMillionTokens',
          'outputMicrosPerMillionTokens',
        ],
        true,
      );
      priceRevision(value.request.priceRevision, false);
      if (value.request.currency !== 'USD') {
        throw new LocalModelPriceCatalogCommandConfigurationError(
          'currency is invalid',
        );
      }
      priceRate(
        value.request.inputMicrosPerMillionTokens,
        'inputMicrosPerMillionTokens',
      );
      priceRate(
        value.request.outputMicrosPerMillionTokens,
        'outputMicrosPerMillionTokens',
      );
      break;
    case 'model-price.activate':
    case 'model-price.deactivate':
    case 'model-price.revoke':
      baseRequest(
        value.request,
        ['expectedGeneration', 'expectedHeadDigest', 'priceRevision'],
        true,
      );
      if (
        !Number.isSafeInteger(value.request.expectedGeneration) ||
        (value.request.expectedGeneration as number) < 0 ||
        (value.request.expectedGeneration as number) >=
          MAX_MODEL_PRICE_CATALOG_GENERATION ||
        (value.request.expectedHeadDigest !== null &&
          (typeof value.request.expectedHeadDigest !== 'string' ||
            !DIGEST_PATTERN.test(value.request.expectedHeadDigest)))
      ) {
        throw new LocalModelPriceCatalogCommandConfigurationError(
          'transition fence is invalid',
        );
      }
      if (
        ((value.request.expectedGeneration as number) === 0) !==
        (value.request.expectedHeadDigest === null)
      ) {
        throw new LocalModelPriceCatalogCommandConfigurationError(
          'transition generation and head digest are inconsistent',
        );
      }
      priceRevision(
        value.request.priceRevision,
        value.operation === 'model-price.deactivate',
      );
      if (
        (value.operation === 'model-price.deactivate' &&
          value.request.priceRevision !== null) ||
        (value.operation !== 'model-price.deactivate' &&
          value.request.priceRevision === null)
      ) {
        throw new LocalModelPriceCatalogCommandConfigurationError(
          'transition priceRevision is invalid',
        );
      }
      break;
    case 'model-price.inspect':
      baseRequest(value.request, ['priceRevision'], false);
      priceRevision(value.request.priceRevision, true);
      break;
    default:
      throw new LocalModelPriceCatalogCommandConfigurationError(
        'operation is invalid',
      );
  }
  return Object.freeze({
    ...value,
    options: commandOptions,
  } as unknown as LocalModelPriceCatalogCommand);
}

function readCommandFile(
  commandFilePath: string,
): Readonly<LocalModelPriceCatalogCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (error instanceof LocalModelPriceCatalogCommandConfigurationError) {
      throw error;
    }
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalModelPriceCatalogCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw error;
  }
}

function operation(
  value: LocalModelPriceCatalogCommand['operation'],
): ModelPriceCatalogManagementOperation | 'inspect' {
  switch (value) {
    case 'model-price.publish':
      return 'publish';
    case 'model-price.activate':
      return 'activate';
    case 'model-price.deactivate':
      return 'deactivate';
    case 'model-price.revoke':
      return 'revoke';
    case 'model-price.inspect':
      return 'inspect';
  }
}

function publicationSummary(
  publication: Awaited<
    ReturnType<LocalModelPriceCatalogRepository['findPublication']>
  > extends infer TValue
    ? NonNullable<TValue>
    : never,
) {
  return Object.freeze({
    provider: publication.entry.provider,
    model: publication.entry.model,
    priceRevision: publication.entry.priceRevision,
    currency: publication.entry.currency,
    inputMicrosPerMillionTokens: publication.entry.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens:
      publication.entry.outputMicrosPerMillionTokens,
    catalogDigest: publication.entry.catalogDigest,
    publishedAtMs: publication.entry.publishedAtMs,
    publicationDigest: publication.publicationDigest,
  });
}

function headSummary(
  head: Awaited<
    ReturnType<LocalModelPriceCatalogRepository['findCurrent']>
  > extends infer TValue
    ? NonNullable<TValue>
    : never,
) {
  return Object.freeze({
    provider: head.provider,
    model: head.model,
    generation: head.generation,
    previousHeadDigest: head.previousHeadDigest,
    activePriceRevision: head.activePriceRevision,
    activeCatalogDigest: head.activeCatalogDigest,
    revokedPriceRevision: head.revokedPriceRevision,
    revokedCatalogDigest: head.revokedCatalogDigest,
    action: head.action,
    changedAtMs: head.changedAtMs,
    headDigest: head.headDigest,
  });
}

function authorizationSummary(
  authorization: Awaited<
    ReturnType<LocalModelPriceCatalogRepository['findAuthorization']>
  > extends infer TValue
    ? NonNullable<TValue>
    : never,
) {
  return Object.freeze({
    authorizationId: authorization.authorizationId,
    requestId: authorization.requestId,
    operation: authorization.operation,
    policyRevision: authorization.policy.revision,
    decisionMode: authorization.decisionMode,
    committedAtMs: authorization.committedAtMs,
    authorizationDigest: authorization.authorizationDigest,
  });
}

function samePrincipal(
  authenticated: Readonly<AuthenticatedLocalCommand>,
  authorization: Parameters<
    NonNullable<
      LocalModelPriceCatalogRepositoryOptions['beforeAuthorizedMutation']
    >
  >[1],
): boolean {
  const left = authenticated.principal;
  const right = authorization.principal;
  return (
    right.subject.type === left.subject.type &&
    right.subject.id === left.subject.id &&
    right.authenticationId === left.authenticationId &&
    right.authenticatedAtMs === left.authenticatedAtMs &&
    right.expiresAtMs === left.expiresAtMs &&
    right.assurance === left.assurance
  );
}

async function execute(
  command: Readonly<LocalModelPriceCatalogCommand>,
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<Readonly<LocalModelPriceCatalogCommandResult>> {
  const repository = new LocalModelPriceCatalogRepository(database.authority, {
    beforeAuthorizedMutation(_client, authorization) {
      if (!samePrincipal(authenticated, authorization)) {
        throw new LocalSqliteAuthenticatedManagementFenceError();
      }
      database.confirmUserCredentialFence(authenticated.databaseFence);
      database.confirmDefaultProjectOwnerFence(authenticated.databaseFence);
      assertLocalModelInvocationFeatureActive(database.authority.client);
    },
  });
  if (command.operation === 'model-price.inspect') {
    await authenticated.confirm();
    database.confirmDefaultProjectOwnerFence(authenticated.databaseFence);
    const [head, publication] = await Promise.all([
      repository.findCurrent(command.request.provider, command.request.model),
      command.request.priceRevision === null
        ? Promise.resolve(null)
        : repository.findPublication({
            provider: command.request.provider,
            model: command.request.model,
            priceRevision: command.request.priceRevision,
          }),
    ]);
    await authenticated.confirm();
    database.confirmDefaultProjectOwnerFence(authenticated.databaseFence);
    assertLocalModelInvocationFeatureActive(database.authority.client);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      head: head ? headSummary(head) : null,
      publication: publication ? publicationSummary(publication) : null,
    });
  }

  let capability:
    | Readonly<ActiveModelPriceCatalogManagementCapability>
    | undefined;
  try {
    const profile = await bootstrapModelPriceCatalogManagementProfile({
      enabled: true,
      profile: command.options.profile,
      async loadAuthority() {
        return {
          repository,
          authorizer: {
            async authorize() {
              await authenticated.confirm();
              return createModelPriceCatalogPolicyDecision({
                effect: 'allow',
                revision: LOCAL_MODEL_PRICE_POLICY_REVISION,
                reasons: ['local_console_confirmed'],
              });
            },
          },
        };
      },
      audit() {},
    });
    if (profile.status !== 'active') {
      throw new LocalModelPriceCatalogCommandConfigurationError(
        'management profile did not activate',
      );
    }
    capability = profile.capability;
    if (command.operation === 'model-price.publish') {
      const result = await capability.publish({
        authorizationId: command.request.authorizationId,
        requestId: command.request.requestId,
        mutationId: command.request.mutationId,
        provider: command.request.provider,
        model: command.request.model,
        principal: authenticated.principal,
        priceRevision: command.request.priceRevision,
        currency: command.request.currency,
        inputMicrosPerMillionTokens:
          command.request.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens:
          command.request.outputMicrosPerMillionTokens,
      });
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        status: result.status,
        publication: publicationSummary(result.publication),
        authorization: authorizationSummary(result.authorization),
      });
    }
    const action = operation(command.operation);
    if (action === 'inspect' || action === 'publish') {
      throw new LocalModelPriceCatalogCommandConfigurationError(
        'transition action is invalid',
      );
    }
    const result = await capability.transition({
      authorizationId: command.request.authorizationId,
      requestId: command.request.requestId,
      mutationId: command.request.mutationId,
      provider: command.request.provider,
      model: command.request.model,
      principal: authenticated.principal,
      expectedGeneration: command.request.expectedGeneration,
      expectedHeadDigest: command.request.expectedHeadDigest,
      action,
      priceRevision: command.request.priceRevision,
    });
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: result.status,
      head: headSummary(result.head),
      authorization: authorizationSummary(result.authorization),
    });
  } finally {
    if (capability) await capability.stop();
  }
}

function causes(error: unknown): readonly unknown[] {
  const values: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== 'object') break;
    values.push(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return values;
}

function code(value: unknown): string | null {
  return value &&
    typeof value === 'object' &&
    'code' in value &&
    typeof value.code === 'string'
    ? value.code
    : null;
}

function failureAudit(
  command: Readonly<LocalModelPriceCatalogCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  const codes = new Set(causes(error).map(code).filter(Boolean));
  let outcome: SecurityAuditOutcome;
  let reason: string;
  if (
    error instanceof AuthenticatedLocalCommandAuthenticationError ||
    codes.has('AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED')
  ) {
    outcome = authenticated ? 'denied' : 'authentication_rejected';
    reason = authenticated
      ? 'credential_fence_rejected'
      : 'credential_rejected';
  } else if (
    codes.has('LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_FENCE_REJECTED')
  ) {
    outcome = 'denied';
    reason = 'credential_fence_rejected';
  } else if (
    codes.has('LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_OWNER_REJECTED')
  ) {
    outcome = 'denied';
    reason = 'platform_owner_required';
  } else if (
    codes.has('MODEL_PRICE_CATALOG_MANAGEMENT_AUTHENTICATION_REQUIRED')
  ) {
    outcome = 'denied';
    reason = 'strong_authentication_required';
  } else if (codes.has('MODEL_PRICE_CATALOG_MANAGEMENT_FORBIDDEN')) {
    outcome = 'denied';
    reason = 'policy_denied';
  } else if (codes.has('MODEL_PRICE_CATALOG_MANAGEMENT_QUOTA_EXCEEDED')) {
    outcome = 'denied';
    reason = 'quota_exhausted';
  } else {
    return null;
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId: `model_price_catalog.${operation(command.operation)}`,
    projectId: null,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

function dependencies(
  value: LocalModelPriceCatalogCommandRunnerDependencies,
): Readonly<LocalModelPriceCatalogCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'now', 'openDatabase'].sort().join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalModelPriceCatalogCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function createLocalModelPriceCatalogCommandRunner(
  candidateDependencies: LocalModelPriceCatalogCommandRunnerDependencies = {
    openDatabase: openLocalSqliteAuthenticatedManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    now: Date.now,
  },
): LocalModelPriceCatalogCommandRunner {
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
        assertLocalModelInvocationFeatureActive(database.authority.client);
        try {
          authenticated = await adapters.authenticate(database, {
            deploymentRoot: command.options.deploymentRoot,
            databasePath: command.options.databasePath,
            ownerPepperKeyringDirectory:
              command.options.ownerPepperKeyringDirectory,
            credentialFilePath: command.options.credentialFilePath,
            authenticationNamespace: 'local_model_price',
          });
          return await execute(command, database, authenticated);
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

export function runLocalModelPriceCatalogCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalModelPriceCatalogCommandResult>> {
  return createLocalModelPriceCatalogCommandRunner().run(commandFilePath);
}
